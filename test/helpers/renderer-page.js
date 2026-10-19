// One DOM harness for renderer unit tests. Loads a real page's HTML into jsdom,
// runs its <script src> files in document order into a single shared realm (the
// way a browser loads classic scripts), and injects a recording stub for
// window.electronAPI. The hand-rolled vm-context stubs that predate this could
// not dispatch events or carry focus, which is most of what renderer code does.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..', '..')
const PAGES = path.join(ROOT, 'pages')

/** Local <script src> paths for a page, in document order (skips remote). */
function pageScriptPaths(pageFile) {
  const html = fs.readFileSync(path.join(PAGES, pageFile), 'utf8')
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !/^[a-z]+:|^\/\//i.test(src))
    .map((src) => path.join(PAGES, src))
}

/**
 * A recording window.electronAPI. Every method is an async function that logs
 * `{ method, args }` into `calls` and resolves to a default (list* -> [], get* /
 * everything else -> null) unless `overrides[method]` supplies a value or fn.
 */
function makeElectronApi(calls, overrides = {}) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        return (...args) => {
          calls.push({ method: prop, args })
          const override = overrides[prop]
          const value = typeof override === 'function' ? override(...args) : override
          if (value !== undefined) return Promise.resolve(value)
          if (prop.startsWith('list')) return Promise.resolve([])
          return Promise.resolve(null)
        }
      },
      has() {
        return true // renderer guards like `api?.getProject` must see the method
      },
    },
  )
}

/** An in-memory Storage, since jsdom does not provide one for a file:// origin. */
function installStorage(window, name, seed) {
  const store = new Map(Object.entries(seed))
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true })
}

/** A macrotask flush so page bootstraps that await electronAPI settle. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Load a page into jsdom and run its scripts.
 *
 * @param {string} pageFile e.g. 'project-setup.html'
 * @param {object} [opts]
 * @param {string} [opts.hash] location hash without '#', e.g. '123' or '1:2'
 * @param {object} [opts.electronAPI] per-method overrides (value or function)
 * @param {Record<string,string>} [opts.localStorage] seed values
 * @param {boolean} [opts.matchMediaLight] what matchMedia('light') returns
 * @param {(details: {scriptPath: string, window: Window}) => void} [opts.beforeScript]
 *   hook for replacing a bundled browser dependency immediately before a page
 *   script consumes it
 * @returns {{ dom, window, document, calls, flush }}
 */
function loadPage(pageFile, opts = {}) {
  const html = fs.readFileSync(path.join(PAGES, pageFile), 'utf8')
  const hash = opts.hash ? `#${opts.hash}` : ''
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `file://${path.join(PAGES, pageFile)}${hash}`,
  })
  const { window } = dom

  // Globals jsdom does not implement (or does not expose for a file:// origin)
  // that renderer code touches as bare globals.
  window.matchMedia = () => ({
    matches: Boolean(opts.matchMediaLight),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!window.CSS) window.CSS = {}
  if (typeof window.CSS.escape !== 'function') {
    // Enough for selectors built from field identifiers; not the full spec.
    window.CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
  }
  installStorage(window, 'localStorage', opts.localStorage ?? {})
  installStorage(window, 'sessionStorage', {})

  const calls = []
  window.electronAPI = makeElectronApi(calls, opts.electronAPI ?? {})

  const context = dom.getInternalVMContext()
  for (const scriptPath of pageScriptPaths(pageFile)) {
    opts.beforeScript?.({ scriptPath, window })
    const source = fs.readFileSync(scriptPath, 'utf8')
    vm.runInContext(source, context, { filename: scriptPath })
  }

  // Classic scripts run before DOMContentLoaded; fire it for handlers that wait.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }))

  return { dom, window, document: window.document, calls, flush }
}

module.exports = { loadPage, pageScriptPaths, makeElectronApi, flush }
