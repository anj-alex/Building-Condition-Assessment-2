const assert = require('node:assert/strict')
const test = require('node:test')

const { fsyncFile } = require('../src/file-durability')

test('file durability uses the write-capable handle Windows requires', () => {
  const calls = []
  const fakeFs = {
    openSync(filePath, flags) {
      calls.push(['open', filePath, flags])
      if (flags === 'r') {
        const error = new Error('Windows rejects read-only fsync')
        error.code = 'EPERM'
        throw error
      }
      return 41
    },
    fsyncSync(handle) {
      calls.push(['fsync', handle])
    },
    closeSync(handle) {
      calls.push(['close', handle])
    },
  }

  fsyncFile('archive.pending', fakeFs)

  assert.deepEqual(calls, [
    ['open', 'archive.pending', 'r+'],
    ['fsync', 41],
    ['close', 41],
  ])
})

test('a failed file flush remains fatal and still closes its handle', () => {
  const calls = []
  const failure = new Error('injected flush failure')
  const fakeFs = {
    openSync() {
      calls.push('open')
      return 42
    },
    fsyncSync() {
      calls.push('fsync')
      throw failure
    },
    closeSync() {
      calls.push('close')
    },
  }

  assert.throws(() => fsyncFile('workspace.db', fakeFs), failure)
  assert.deepEqual(calls, ['open', 'fsync', 'close'])
})
