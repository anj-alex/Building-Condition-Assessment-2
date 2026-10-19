const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { writeFileAtomically } = require('../src/main/atomic-file')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-atomic-file-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function trackingFs(calls, { failRename = false } = {}) {
  const pathsByHandle = new Map()
  return {
    openSync(filePath, flags, mode) {
      const handle = fs.openSync(filePath, flags, mode)
      pathsByHandle.set(handle, filePath)
      return handle
    },
    writeFileSync: (...args) => fs.writeFileSync(...args),
    fsyncSync(handle) {
      calls.push({ type: 'fsync', path: pathsByHandle.get(handle) })
      fs.fsyncSync(handle)
    },
    closeSync(handle) {
      pathsByHandle.delete(handle)
      fs.closeSync(handle)
    },
    renameSync(source, destination) {
      calls.push({ type: 'rename', source, destination })
      if (failRename) {
        const error = new Error('injected rename failure')
        error.code = 'EACCES'
        throw error
      }
      fs.renameSync(source, destination)
    },
    rmSync: (...args) => fs.rmSync(...args),
  }
}

test('atomic file replacement fsyncs adjacent bytes before renaming them', (t) => {
  const dir = tempDir(t)
  const destination = path.join(dir, 'report.docx')
  fs.writeFileSync(destination, 'OLD REPORT')
  const calls = []

  writeFileAtomically(destination, Buffer.from('NEW REPORT'), {
    fsImpl: trackingFs(calls),
    createId: () => 'success',
  })

  assert.equal(fs.readFileSync(destination, 'utf8'), 'NEW REPORT')
  const renameIndex = calls.findIndex((call) => call.type === 'rename')
  const pendingFsyncIndex = calls.findIndex(
    (call) => call.type === 'fsync' && String(call.path).endsWith('.pending'),
  )
  assert.ok(pendingFsyncIndex >= 0 && pendingFsyncIndex < renameIndex)
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.pending')),
    [],
  )
})

test('a failed atomic rename preserves the existing report and removes its temp', (t) => {
  const dir = tempDir(t)
  const destination = path.join(dir, 'report.docx')
  fs.writeFileSync(destination, 'PREVIOUS GOOD REPORT')

  assert.throws(
    () =>
      writeFileAtomically(destination, Buffer.from('PARTIAL REPLACEMENT'), {
        fsImpl: trackingFs([], { failRename: true }),
        createId: () => 'failure',
      }),
    /injected rename failure/,
  )

  assert.equal(fs.readFileSync(destination, 'utf8'), 'PREVIOUS GOOD REPORT')
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.pending')),
    [],
  )
})
