const fs = require('node:fs')

/**
 * Flush an existing regular file without truncating it.
 *
 * Windows' FlushFileBuffers requires a write-capable handle, so opening with
 * `r` works on Unix but fails with EPERM on Windows. `r+` preserves the bytes
 * while giving every supported platform a handle it can actually flush.
 */
function fsyncFile(filePath, fsImpl = fs) {
  const handle = fsImpl.openSync(filePath, 'r+')
  try {
    fsImpl.fsyncSync(handle)
  } finally {
    fsImpl.closeSync(handle)
  }
}

module.exports = { fsyncFile }
