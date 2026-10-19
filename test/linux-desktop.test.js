const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  quoteDesktopExecArg,
  buildDesktopEntry,
  ensureLinuxDesktopIntegration,
} = require('../src/main/linux-desktop')

test('quoteDesktopExecArg leaves plain args alone', () => {
  assert.equal(quoteDesktopExecArg('/usr/bin/app'), '/usr/bin/app')
  assert.equal(quoteDesktopExecArg('simple'), 'simple')
})

test('quoteDesktopExecArg quotes and escapes special characters', () => {
  assert.equal(quoteDesktopExecArg('/opt/My App/app'), '"/opt/My App/app"')
  assert.equal(quoteDesktopExecArg('a"b'), '"a\\"b"')
  assert.equal(quoteDesktopExecArg('a\\b'), '"a\\\\b"')
  assert.equal(quoteDesktopExecArg('a$b'), '"a\\$b"')
  assert.equal(quoteDesktopExecArg('a`b'), '"a\\`b"')
})

test('buildDesktopEntry stamps the id into Icon, StartupWMClass, and Exec', () => {
  const entry = buildDesktopEntry({ appDesktopId: 'my-app', execLine: '/usr/bin/my-app' })
  assert.match(entry, /^\[Desktop Entry\]/)
  assert.match(entry, /^Exec=\/usr\/bin\/my-app$/m)
  assert.match(entry, /^Icon=my-app$/m)
  assert.match(entry, /^StartupWMClass=my-app$/m)
  assert.ok(entry.endsWith('\n')) // trailing newline
})

test('ensureLinuxDesktopIntegration is a no-op off Linux or in smoke tests', () => {
  assert.deepEqual(
    ensureLinuxDesktopIntegration({ platform: 'win32', appDesktopId: 'x' }),
    { installed: false, reason: 'skipped' },
  )
  assert.deepEqual(
    ensureLinuxDesktopIntegration({ platform: 'linux', isSmokeTest: true, appDesktopId: 'x' }),
    { installed: false, reason: 'skipped' },
  )
})

test('ensureLinuxDesktopIntegration reports a missing source icon', () => {
  const result = ensureLinuxDesktopIntegration({
    platform: 'linux',
    isSmokeTest: false,
    iconSrc: '/does/not/exist.png',
    appDesktopId: 'x',
  })
  assert.deepEqual(result, { installed: false, reason: 'no-icon' })
})

test('ensureLinuxDesktopIntegration writes the entry and icon into $HOME', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-desktop-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const iconSrc = path.join(home, 'icon.png')
  fs.writeFileSync(iconSrc, 'PNGDATA')

  const spawned = []
  const result = ensureLinuxDesktopIntegration({
    platform: 'linux',
    isSmokeTest: false,
    homeDir: home,
    iconSrc,
    appDesktopId: 'cara-app',
    isPackaged: false,
    execPath: '/opt/Electron App/electron',
    appPath: '/opt/app',
    spawnFn: (...args) => {
      spawned.push(args[0])
      return { unref() {} }
    },
  })

  assert.equal(result.installed, true)
  const desktopPath = path.join(home, '.local', 'share', 'applications', 'cara-app.desktop')
  const iconPath = path.join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'cara-app.png')
  assert.equal(result.desktopPath, desktopPath)
  assert.equal(result.iconPath, iconPath)

  const contents = fs.readFileSync(desktopPath, 'utf8')
  // Dev build: electron + app path, and the spaced electron path is quoted.
  assert.match(contents, /^Exec="\/opt\/Electron App\/electron" \/opt\/app$/m)
  assert.equal(fs.readFileSync(iconPath, 'utf8'), 'PNGDATA')
  // Best-effort cache refresh helpers are invoked.
  assert.deepEqual(spawned, ['update-desktop-database', 'gtk-update-icon-cache'])
})

test('ensureLinuxDesktopIntegration uses just the binary for a packaged build', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-desktop-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const iconSrc = path.join(home, 'icon.png')
  fs.writeFileSync(iconSrc, 'PNG')

  ensureLinuxDesktopIntegration({
    platform: 'linux',
    homeDir: home,
    iconSrc,
    appDesktopId: 'cara-app',
    isPackaged: true,
    execPath: '/usr/bin/cara-app',
    appPath: '/ignored',
    spawnFn: () => ({ unref() {} }),
  })

  const contents = fs.readFileSync(
    path.join(home, '.local', 'share', 'applications', 'cara-app.desktop'),
    'utf8',
  )
  assert.match(contents, /^Exec=\/usr\/bin\/cara-app$/m)
})

test('ensureLinuxDesktopIntegration survives a cache helper that fails to spawn', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-desktop-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const iconSrc = path.join(home, 'icon.png')
  fs.writeFileSync(iconSrc, 'PNG')

  // Reproduce headless CI, where update-desktop-database is not installed: spawn
  // returns a child that later emits 'error' (ENOENT). With no listener attached
  // Node rethrows that as an uncaught exception and the app crashes before its
  // window ever opens. The child here is a real EventEmitter, so emitting 'error'
  // below throws synchronously unless integration attached an 'error' listener.
  const children = []
  const result = ensureLinuxDesktopIntegration({
    platform: 'linux',
    homeDir: home,
    iconSrc,
    appDesktopId: 'cara-app',
    isPackaged: true,
    execPath: '/usr/bin/cara-app',
    spawnFn: () => {
      const child = new EventEmitter()
      child.unref = () => {}
      children.push(child)
      return child
    },
  })

  assert.equal(result.installed, true)
  assert.equal(children.length, 2)
  for (const child of children) {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    assert.doesNotThrow(() => child.emit('error', enoent))
  }
})
