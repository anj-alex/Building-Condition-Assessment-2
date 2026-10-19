const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pagesDirectory = path.join(__dirname, '..', 'pages')

/**
 * Local `<script src>` paths for a page, in document order. Skips inline scripts
 * and anything remote — only bundled files share the renderer's global scope.
 */
function pageScriptPaths(pageFile) {
  const html = fs.readFileSync(path.join(pagesDirectory, pageFile), 'utf8')
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1])
  return sources
    .filter((source) => !/^[a-z]+:|^\/\//i.test(source))
    .map((source) => path.join(pagesDirectory, source))
}

/**
 * Globals the browser provides and a bare `vm` context does not. A script
 * tripping over one of these has only reached the DOM; anything else missing at
 * load time means the scripts are ordered wrong.
 */
const HOST_GLOBALS = new Set([
  'CustomEvent',
  'Event',
  'FormData',
  'ResizeObserver',
  'clearTimeout',
  'document',
  'fetch',
  'getComputedStyle',
  'localStorage',
  'location',
  'matchMedia',
  'navigator',
  'requestAnimationFrame',
  'sessionStorage',
  'setTimeout',
  'window',
])

/**
 * Reproduce how a browser loads classic scripts: every file shares one global
 * scope, in document order. Two things go wrong there and nowhere else.
 *
 * A collision — global `let`/`const`/`class` in a later file against a
 * `function` or `var` of the same name from an earlier one — stops the later
 * file from instantiating, so nothing in it runs.
 *
 * A forward read — a top-level statement reading a binding that a later script
 * declares — throws where it stands and leaves every declaration below it in the
 * temporal dead zone.
 *
 * Declarations are instantiated before a script's first statement, so a runtime
 * throw against the missing DOM or preload bridge still leaves the bindings in
 * place. Those are expected here; the two above are not.
 */
function findScriptLoadError(scriptPaths) {
  const context = vm.createContext({})
  for (const scriptPath of scriptPaths) {
    const source = fs.readFileSync(scriptPath, 'utf8')
    let script
    try {
      script = new vm.Script(source, { filename: scriptPath })
    } catch (error) {
      return `${path.basename(scriptPath)} failed to parse: ${error.message}`
    }
    try {
      script.runInContext(context)
    } catch (error) {
      // `instanceof` is useless here: the vm context is a separate realm with its
      // own SyntaxError constructor, so match on the error's own name instead.
      if (error?.name === 'SyntaxError' && /already been declared/.test(error.message)) {
        return `${path.basename(scriptPath)}: ${error.message}`
      }
      // Host globals are the only names legitimately missing at this point.
      const missing = /^(\w+) is not defined$/.exec(error?.message ?? '')?.[1]
      if (missing && !HOST_GLOBALS.has(missing)) {
        return `${path.basename(scriptPath)}: ${error.message} — declared by a later script?`
      }
      // The second-order symptom of the same mistake, if the order differs.
      if (/before initialization/.test(error?.message ?? '')) {
        return `${path.basename(scriptPath)}: ${error.message}`
      }
    }
  }
  return null
}

for (const pageFile of fs.readdirSync(pagesDirectory).filter((file) => file.endsWith('.html'))) {
  test(`${pageFile} scripts share one global scope without collisions or forward reads`, () => {
    const scriptPaths = pageScriptPaths(pageFile)
    assert.ok(scriptPaths.length > 0, `${pageFile} loads no local scripts`)
    for (const scriptPath of scriptPaths) {
      assert.ok(fs.existsSync(scriptPath), `${pageFile} references a missing script: ${scriptPath}`)
    }
    assert.equal(findScriptLoadError(scriptPaths), null)
  })
}

test('every renderer page loads the shared graceful-close listener', () => {
  const pageFiles = fs
    .readdirSync(pagesDirectory)
    .filter((file) => file.endsWith('.html'))
  assert.ok(pageFiles.length > 0)

  for (const pageFile of pageFiles) {
    const scripts = pageScriptPaths(pageFile).map((file) => path.basename(file))
    const rendererApiIndex = scripts.indexOf('renderer-api.js')
    const sharedIndex = scripts.indexOf('shared.js')
    assert.ok(rendererApiIndex >= 0, `${pageFile} does not load renderer-api.js`)
    assert.ok(sharedIndex > rendererApiIndex, `${pageFile} must load shared.js after renderer-api.js`)
  }
})
