const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// userData-relative image directories and the copy/unlink helpers the main
// process uses to store imported photos and firm logos. Kept as pure functions
// (the userData directory is passed in) so they can be exercised against a temp
// directory without booting Electron.

function assetImagesDir(userDataDir) {
  return path.join(userDataDir, 'asset-images')
}

function buildingImagesDir(userDataDir) {
  return path.join(userDataDir, 'building-images')
}

function firmAssetsDir(userDataDir) {
  return path.join(userDataDir, 'firm-assets')
}

/**
 * Copy `sourcePath` into `imagesDir` under a collision-proof name
 * (`<prefix>-<ownerId>-<uuid><ext>`), creating the directory if needed.
 * Returns the absolute path of the copy.
 */
function copyImageInto(imagesDir, prefix, ownerId, sourcePath) {
  fs.mkdirSync(imagesDir, { recursive: true })
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg'
  const fileName = `${prefix}-${ownerId}-${randomUUID()}${ext}`
  const targetPath = path.join(imagesDir, fileName)
  fs.copyFileSync(sourcePath, targetPath)
  return targetPath
}

/** Delete a file if it exists; a missing file or bad path is not an error. */
function safeUnlink(filePath) {
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    // file may already be gone or path may be invalid; ignore
  }
}

module.exports = {
  assetImagesDir,
  buildingImagesDir,
  firmAssetsDir,
  copyImageInto,
  safeUnlink,
}
