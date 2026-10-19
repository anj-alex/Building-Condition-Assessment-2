/**
 * extract-zip (via yauzl + stream.pipeline) can hang mid-entry on some Node
 * versions (observed on Node 26), which aborts electron-packager after a few
 * megabytes. Prefer system unzip tools when available so `npm run package`
 * remains reliable.
 *
 * Loaded with: node --require ./scripts/fix-extract-zip.cjs ...
 */
'use strict'

const Module = require('node:module')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')

function canRun(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    return result.status === 0 || result.status === 1
  } catch {
    return false
  }
}

function extractWithSystemTools(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })

  if (canRun('bsdtar', ['--version'])) {
    execFileSync('bsdtar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' })
    return true
  }

  if (canRun('unzip', ['-v'])) {
    execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'ignore' })
    return true
  }

  for (const python of ['python3', 'python']) {
    if (!canRun(python, ['-c', 'import zipfile'])) continue
    execFileSync(
      python,
      [
        '-c',
        'import zipfile, sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
        zipPath,
        destDir,
      ],
      { stdio: 'ignore' },
    )
    return true
  }

  return false
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments)
  if (request !== 'extract-zip') return exported

  const originalExtract = exported
  return async function extractZipFixed(zipPath, opts = {}) {
    if (!opts.dir) {
      return originalExtract(zipPath, opts)
    }
    if (extractWithSystemTools(zipPath, opts.dir)) {
      return
    }
    return originalExtract(zipPath, opts)
  }
}
