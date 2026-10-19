const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const { createIpcSurface } = require('../src/ipc-surface')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const PAGES = path.join(ROOT, 'pages')

function recordingTransport() {
  const calls = []
  const listeners = new Map()
  return {
    calls,
    listeners,
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return Promise.resolve({ channel, args })
    },
    on(channel, listener) {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  }
}

function loadScriptInto(context, file) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8')
  new vm.Script(source, { filename: file }).runInContext(context)
}

function channelsFromSet(source, setName) {
  const body = new RegExp(
    `const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`,
  ).exec(source)?.[1]
  assert.ok(body, `could not find ${setName} in preload.js`)
  return new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]))
}

function loadPreloadBridge() {
  let bridge
  const calls = []
  const listeners = new Map()
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return Promise.resolve({ channel, args })
    },
    on(channel, listener) {
      listeners.set(channel, listener)
    },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
  }
  const context = vm.createContext({
    require(request) {
      assert.equal(request, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'appBridge')
            bridge = value
          },
        },
        ipcRenderer,
      }
    },
  })
  const source = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8')
  new vm.Script(source, { filename: 'preload.js' }).runInContext(context)
  return { bridge, calls, listeners }
}

/** Collect renderer script paths from `src="../src/..."` tags in pages/*.html. */
function collectRendererAssets() {
  const assets = []
  if (!fs.existsSync(PAGES)) return assets
  for (const name of fs.readdirSync(PAGES)) {
    if (!name.endsWith('.html')) continue
    const html = fs.readFileSync(path.join(PAGES, name), 'utf8')
    for (const match of html.matchAll(/src="\.\.\/(src\/[^"]+)"/g)) {
      assets.push(match[1])
    }
  }
  return assets
}

test('the surface factory needs a real transport', () => {
  assert.throws(() => createIpcSurface(null), TypeError)
  assert.throws(() => createIpcSurface({}), TypeError)
  assert.throws(() => createIpcSurface({ invoke: () => {} }), TypeError)
})

test('named methods invoke their channels with arguments passed through', async () => {
  const transport = recordingTransport()
  const api = createIpcSurface(transport)

  await api.getFirm()
  await api.updateBuilding(7, { property_name: 'X' })
  await api.listUniformatLevel4Groups('A', 'A10', 'A1010')
  await api.preparePropertyReport(3, [7])
  await api.chooseReportExportPath('report.docx')
  await api.exportPropertyReport('preview-id', 'opaque-export-id', {
    allowValidationErrors: true,
  })
  await api.listDeletedProjects()
  await api.restoreDeletedProject(12)
  await api.undoLastAction()
  await api.completeCloseRequest(9, { ok: true })

  assert.deepEqual(transport.calls, [
    { channel: 'db:getFirm', args: [] },
    { channel: 'db:updateBuilding', args: [7, { property_name: 'X' }] },
    { channel: 'db:listUniformatLevel4Groups', args: ['A', 'A10', 'A1010'] },
    { channel: 'property-report:prepare', args: [3, [7]] },
    { channel: 'property-report:chooseExportPath', args: ['report.docx'] },
    {
      channel: 'property-report:export',
      args: ['preview-id', 'opaque-export-id', { allowValidationErrors: true }],
    },
    { channel: 'db:listDeletedProjects', args: [] },
    { channel: 'db:restoreDeletedProject', args: [12] },
    { channel: 'history:undo', args: [] },
    { channel: 'app:close-response', args: [9, { ok: true }] },
  ])

  transport.calls.length = 0
  await api.openProjectSetup(null)
  await api.openProjectSetup(12)
  assert.deepEqual(transport.calls, [
    { channel: 'project-setup:open', args: [] },
    { channel: 'project-setup:edit', args: [12] },
  ])
})

test('subscriptions go through the transport and unsubscribe cleanly', () => {
  const transport = recordingTransport()
  const api = createIpcSurface(transport)

  const seen = []
  const offCaption = api.onCaptionUpdated((payload) => seen.push(payload))
  assert.equal(typeof transport.listeners.get('ai:caption-updated'), 'function')
  transport.listeners.get('ai:caption-updated')({ id: 1 })
  assert.deepEqual(seen, [{ id: 1 }])
  offCaption()
  assert.equal(transport.listeners.has('ai:caption-updated'), false)

  api.onSummaryUpdated(() => {})
  assert.equal(transport.listeners.has('ai:summary-updated'), true)
  api.onCloseRequested(() => {})
  assert.equal(transport.listeners.has('app:close-requested'), true)
})

test('the shim builds window.electronAPI over whatever appBridge exists', async () => {
  const bridgeCalls = []
  const sandbox = {
    window: {
      appBridge: {
        invoke: (channel, ...args) => {
          bridgeCalls.push({ channel, args })
          return Promise.resolve('from-bridge')
        },
        on: () => () => {},
      },
    },
  }
  const context = vm.createContext(sandbox)
  loadScriptInto(context, 'ipc-surface.js')
  loadScriptInto(context, 'renderer-api.js')

  const { window } = sandbox
  assert.equal(typeof window.electronAPI, 'object')
  assert.equal(await window.electronAPI.getFirm(), 'from-bridge')
  assert.deepEqual(bridgeCalls, [{ channel: 'db:getFirm', args: [] }])
})

test('the shim leaves an existing surface alone and tolerates having no bridge', () => {
  const existing = { marker: true }
  const withExisting = vm.createContext({ window: { electronAPI: existing, appBridge: {} } })
  loadScriptInto(withExisting, 'ipc-surface.js')
  loadScriptInto(withExisting, 'renderer-api.js')

  const bare = vm.createContext({ window: {} })
  loadScriptInto(bare, 'ipc-surface.js')
  loadScriptInto(bare, 'renderer-api.js')
})

test('the shim is loud when the markup forgot ipc-surface.js', () => {
  const context = vm.createContext({ window: { appBridge: { invoke() {}, on() {} } } })
  assert.throws(
    () => loadScriptInto(context, 'renderer-api.js'),
    /must load after src\/ipc-surface\.js/,
  )
})

test('preload exposes an allowlisted bridge that matches the named surface', async () => {
  const source = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8')
  assert.match(source, /exposeInMainWorld\('appBridge'/)
  assert.match(source, /ipcRenderer\.invoke\(channel, \.\.\.args\)/)
  assert.match(source, /ipcRenderer\.on\(channel, handler\)/)

  const surfaceSource = fs.readFileSync(path.join(SRC, 'ipc-surface.js'), 'utf8')
  const invokedBySurface = new Set(
    [...surfaceSource.matchAll(/\binvoke\(\s*'([^']+)'/g)].map((match) => match[1]),
  )
  const subscribedBySurface = new Set(
    [...surfaceSource.matchAll(/\bon\(\s*'([^']+)'/g)].map((match) => match[1]),
  )
  assert.deepEqual(channelsFromSet(source, 'INVOKE_CHANNELS'), invokedBySurface)
  assert.deepEqual(channelsFromSet(source, 'SUBSCRIBE_CHANNELS'), subscribedBySurface)

  const { bridge, calls, listeners } = loadPreloadBridge()
  await bridge.invoke('app:getVersion')
  assert.deepEqual(calls, [{ channel: 'app:getVersion', args: [] }])
  await assert.rejects(bridge.invoke('not:allowed'), /Blocked renderer invoke channel/)
  assert.throws(
    () => bridge.on('not:allowed', () => {}),
    /Blocked renderer subscription channel/,
  )

  const seen = []
  const off = bridge.on('app:close-requested', (requestId) => seen.push(requestId))
  listeners.get('app:close-requested')({ sender: 'must not cross preload' }, 12)
  assert.deepEqual(seen, [12])
  off()
  assert.equal(listeners.has('app:close-requested'), false)
})

test('every window.electronAPI method a page uses exists on the shared surface', () => {
  // Renderer assets are discovered from page markup, so this scans exactly
  // the scripts pages load — no more, no less.
  const assets = collectRendererAssets()
  const used = new Set()
  const patterns = [
    /\belectronAPI(?:\?\.)?\.([A-Za-z_$][\w$]*)/g,
    /\bapi(?:\?\.)?\.([A-Za-z_$][\w$]*)/g,
  ]
  for (const asset of assets) {
    if (!asset.endsWith('.js')) continue
    const file = path.join(ROOT, asset)
    if (!fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) used.add(match[1])
    }
  }
  // `*-api.js` filename literals read as an `api.js` member access; the
  // captures they produce are file extensions, not methods.
  used.delete('js')
  used.delete('css')
  assert.ok(used.size > 30, `expected to find the surface in use, found ${used.size}`)

  const api = createIpcSurface(recordingTransport())
  const missing = [...used].filter((name) => !(name in api)).sort()
  assert.deepEqual(missing, [])
})

test('the named surface and main-process channel registrations cannot drift', () => {
  // Every channel the surface invokes must have a handler registered in the
  // main process, and every registered handler must be reachable through the
  // surface. A method without a handler rejects at runtime; a handler without a
  // method is unreachable. The handlers live in src/main/ipc-handlers.js.
  const surfaceSource = fs.readFileSync(path.join(SRC, 'ipc-surface.js'), 'utf8')
  const surfaceChannels = new Set()
  for (const match of surfaceSource.matchAll(/\binvoke\(\s*'([^']+)'/g)) {
    surfaceChannels.add(match[1])
  }

  const handlerSource = fs.readFileSync(path.join(SRC, 'main', 'ipc-handlers.js'), 'utf8')
  const mainChannels = new Set()
  for (const match of handlerSource.matchAll(/\bhandleChannel\(\s*'([^']+)'/g)) {
    mainChannels.add(match[1])
  }

  assert.ok(surfaceChannels.size > 50, `expected the whole surface, found ${surfaceChannels.size}`)
  const missingHandlers = [...surfaceChannels].filter((channel) => !mainChannels.has(channel))
  const unreachable = [...mainChannels].filter((channel) => !surfaceChannels.has(channel))
  assert.deepEqual(missingHandlers, [], 'surface methods with no registered handler')
  assert.deepEqual(unreachable, [], 'handlers no surface method reaches')
})
