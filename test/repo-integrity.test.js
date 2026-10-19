// Cheap structural checks that catch the class of breakage a large removal or
// refactor produces: a dangling require, a page pointing at a script that was
// renamed, a renderer calling an IPC method that no longer exists, a doc link
// to a moved file. These were done by hand during the Temporary Shares audit;
// here they are standing tests.
const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createIpcSurface } = require('../src/ipc-surface')

const ROOT = path.join(__dirname, '..')

function gitFiles(...patterns) {
  return execSync(`git ls-files ${patterns.map((p) => `'${p}'`).join(' ')}`, {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Does a module specifier resolve to a real file from `fromFile`'s directory? */
function requireResolves(fromFile, spec) {
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec)
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, path.join(base, 'index.js')]
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

test('every relative require() in src/ and scripts/ resolves', () => {
  const broken = []
  for (const file of gitFiles('src/*.js', 'src/**/*.js', 'scripts/*.js')) {
    const source = read(file)
    for (const match of source.matchAll(/\brequire\(\s*'(\.[^']+)'\s*\)/g)) {
      if (!requireResolves(file, match[1])) broken.push(`${file} -> ${match[1]}`)
    }
  }
  assert.deepEqual(broken, [], `unresolved relative requires:\n${broken.join('\n')}`)
})

test('every <script src> and <link href> in pages/ resolves', () => {
  const broken = []
  for (const file of gitFiles('pages/*.html')) {
    const html = read(file)
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1]
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue
      const resolved = path.resolve(path.dirname(path.join(ROOT, file)), ref.split('#')[0].split('?')[0])
      if (!fs.existsSync(resolved)) broken.push(`${file} -> ${ref}`)
    }
  }
  assert.deepEqual(broken, [], `pages reference missing assets:\n${broken.join('\n')}`)
})

test('the renderer IPC surface and the registered handlers are in exact parity', () => {
  const surfaceChannels = new Set()
  for (const match of read('src/ipc-surface.js').matchAll(/\binvoke\(\s*'([^']+)'/g)) {
    surfaceChannels.add(match[1])
  }

  // `\s*` spans the newline for the three handlers whose channel string sits on
  // the line after handleChannel( — parse them properly, do not regex one line.
  const handlerChannels = new Set()
  for (const match of read('src/main/ipc-handlers.js').matchAll(/\bhandleChannel\(\s*'([^']+)'/g)) {
    handlerChannels.add(match[1])
  }

  assert.ok(surfaceChannels.size > 50, `expected the whole surface, found ${surfaceChannels.size}`)
  assert.deepEqual(
    [...surfaceChannels].filter((c) => !handlerChannels.has(c)),
    [],
    'surface methods with no registered handler',
  )
  assert.deepEqual(
    [...handlerChannels].filter((c) => !surfaceChannels.has(c)),
    [],
    'registered handlers no surface method reaches',
  )
})

test('every window.electronAPI.<method> call names a real surface method', () => {
  const surface = createIpcSurface({ invoke: () => Promise.resolve(), on: () => () => {} })
  const missing = new Set()
  for (const file of gitFiles('src/*.js', 'src/**/*.js')) {
    const source = read(file)
    for (const match of source.matchAll(/electronAPI(?:\?\.)?\.([A-Za-z_$][\w$]*)/g)) {
      const method = match[1]
      if (!(method in surface)) missing.add(`${file}: electronAPI.${method}`)
    }
  }
  assert.deepEqual([...missing], [], 'renderer calls to methods the surface does not define')
})

test('every relative link in *.md points at a file that exists', () => {
  const broken = []
  for (const file of gitFiles('*.md', '**/*.md')) {
    const md = read(file)
    for (const match of md.matchAll(/\]\(([^)]+)\)/g)) {
      let ref = match[1].trim()
      if (/^(https?:|mailto:|#)/.test(ref) || ref.startsWith('<')) continue
      ref = ref.split('#')[0]
      if (!ref) continue
      const resolved = path.resolve(path.dirname(path.join(ROOT, file)), ref)
      if (!fs.existsSync(resolved)) broken.push(`${file} -> ${match[1]}`)
    }
  }
  assert.deepEqual(broken, [], `markdown links to missing files:\n${broken.join('\n')}`)
})
