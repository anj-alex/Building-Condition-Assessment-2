const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  assetImagesDir,
  buildingImagesDir,
  firmAssetsDir,
  copyImageInto,
  safeUnlink,
} = require('../src/main/paths')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'main-paths-'))
}

test('the image directories hang off userData by name', () => {
  assert.equal(assetImagesDir('/ud'), path.join('/ud', 'asset-images'))
  assert.equal(buildingImagesDir('/ud'), path.join('/ud', 'building-images'))
  assert.equal(firmAssetsDir('/ud'), path.join('/ud', 'firm-assets'))
})

test('copyImageInto creates the directory, keeps the extension, and copies bytes', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, 'source.PNG')
  fs.writeFileSync(src, 'image-bytes')

  const target = copyImageInto(path.join(dir, 'asset-images'), 'asset', 42, src)
  assert.ok(fs.existsSync(target))
  assert.equal(fs.readFileSync(target, 'utf8'), 'image-bytes')
  const name = path.basename(target)
  assert.match(name, /^asset-42-[0-9a-f-]+\.png$/) // extension lower-cased
})

test('copyImageInto never collides on repeated copies of the same owner', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, 'photo.jpg')
  fs.writeFileSync(src, 'x')
  const imagesDir = path.join(dir, 'building-images')

  const first = copyImageInto(imagesDir, 'building', 7, src)
  const second = copyImageInto(imagesDir, 'building', 7, src)
  assert.notEqual(first, second)
  assert.equal(fs.readdirSync(imagesDir).length, 2)
})

test('copyImageInto falls back to .jpg for an extensionless source', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const src = path.join(dir, 'noext')
  fs.writeFileSync(src, 'x')
  const target = copyImageInto(path.join(dir, 'firm-assets'), 'firm-logo', 1, src)
  assert.match(path.basename(target), /\.jpg$/)
})

test('safeUnlink removes a file and shrugs off a missing one', (t) => {
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'gone.txt')
  fs.writeFileSync(file, 'x')
  safeUnlink(file)
  assert.equal(fs.existsSync(file), false)

  // Already gone, empty, and null are all no-ops rather than throws.
  assert.doesNotThrow(() => safeUnlink(file))
  assert.doesNotThrow(() => safeUnlink(''))
  assert.doesNotThrow(() => safeUnlink(null))
})
