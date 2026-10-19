const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** Best-effort durability for the directory entry created by rename. */
function fsyncDirectory(dirPath, fsImpl) {
  let handle
  try {
    handle = fsImpl.openSync(dirPath, 'r')
    fsImpl.fsyncSync(handle)
  } catch {
    // Windows and some filesystems do not allow directory fsync. The report
    // bytes themselves were already flushed; never turn a completed rename
    // into a reported failure that can no longer preserve the old name.
  } finally {
    if (handle != null) {
      try {
        fsImpl.closeSync(handle)
      } catch {
        // Same policy: no fallible work after the destination was committed.
      }
    }
  }
}

/**
 * Replace one file without ever exposing partially written bytes at its final
 * path. The pending file is adjacent so rename stays on the same filesystem.
 *
 * @param {string} destinationPath
 * @param {Buffer|string|Uint8Array} bytes
 * @param {object} [options] test seams only
 */
function writeFileAtomically(
  destinationPath,
  bytes,
  { fsImpl = fs, createId = randomUUID } = {},
) {
  if (typeof destinationPath !== 'string' || !destinationPath.trim()) {
    throw new TypeError('Atomic file destination must be a non-empty path.')
  }
  const destination = path.resolve(destinationPath)
  const destinationDir = path.dirname(destination)
  const pendingPath = path.join(
    destinationDir,
    `.condition-assessment-report-${process.pid}-${createId()}.pending`,
  )

  let handle
  try {
    handle = fsImpl.openSync(pendingPath, 'wx')
    fsImpl.writeFileSync(handle, bytes)
    fsImpl.fsyncSync(handle)
    fsImpl.closeSync(handle)
    handle = undefined

    // Until this succeeds, an existing destination is untouched. A successful
    // same-directory rename replaces it as one namespace operation.
    fsImpl.renameSync(pendingPath, destination)
  } catch (error) {
    if (handle != null) {
      try {
        fsImpl.closeSync(handle)
      } catch {
        // Preserve the operation's original error.
      }
    }
    try {
      fsImpl.rmSync(pendingPath, { force: true })
    } catch {
      // Cleanup failure must not hide the write/flush/rename failure.
    }
    throw error
  }

  // There is deliberately no throwing work after rename: every reported
  // failure occurs while the old destination is still in place.
  fsyncDirectory(destinationDir, fsImpl)
}

module.exports = { writeFileAtomically }
