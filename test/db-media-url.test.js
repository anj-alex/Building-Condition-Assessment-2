const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Must intercept require('electron') before db.js loads it.
const electronStub = require('./helpers/electron-stub')

const db = require('../src/db')
const { toFileUrl } = require('../src/shared')

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-media-url-'))
  // Close the shared DB handle before removing the dir: Windows refuses to
  // delete a file (or its parent) while an sqlite handle is still open, so the
  // close and the removal have to happen in one ordered teardown.
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function insertBuildingWithImage(handle, { assetImagePath, buildingImagePath }) {
  const projectId = handle.prepare('INSERT INTO project (client) VALUES (?)').run('Client').lastInsertRowid
  const buildingId = handle
    .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
    .run(projectId, 'Building')
    .lastInsertRowid
  const assetId = handle
    .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
    .run(buildingId, 'Roof')
    .lastInsertRowid
  const assetImageId = handle
    .prepare('INSERT INTO asset_image (asset_id, file_path) VALUES (?, ?)')
    .run(assetId, assetImagePath)
    .lastInsertRowid
  const buildingImageId = handle
    .prepare('INSERT INTO building_image (building_id, file_path) VALUES (?, ?)')
    .run(buildingId, buildingImagePath)
    .lastInsertRowid
  return { assetId, assetImageId, buildingId, buildingImageId }
}

test('image APIs answer the file:// URLs renderers always built', (t) => {
  electronStub.setUserDataPath(makeTempDir(t))
  db.openDatabase()

  // The firm fallback (no row) carries a null media_url rather than blowing up.
  assert.equal(db.getFirm().media_url, null)

  const ids = insertBuildingWithImage(db.openDatabase(), {
    assetImagePath: '/tmp/photos/one two.jpg',
    buildingImagePath: '/tmp/photos/exterior#1.png',
  })
  db.openDatabase()
    .prepare('INSERT INTO firm (id, name, logo_path) VALUES (1, ?, ?)')
    .run('Firm', '/tmp/firm logo.png')

  assert.equal(db.listAssetImages(ids.assetId)[0].media_url, toFileUrl('/tmp/photos/one two.jpg'))
  assert.equal(db.listBuildingImages(ids.buildingId)[0].media_url, toFileUrl('/tmp/photos/exterior#1.png'))
  assert.equal(db.getAssetImageRow(ids.assetImageId).media_url, toFileUrl('/tmp/photos/one two.jpg'))
  assert.equal(db.getBuildingImageRow(ids.buildingImageId).media_url, toFileUrl('/tmp/photos/exterior#1.png'))
  assert.equal(db.getImageRowByKind('asset', ids.assetImageId).media_url, toFileUrl('/tmp/photos/one two.jpg'))
  assert.equal(db.getImageRowByKind('building', ids.buildingImageId).media_url, toFileUrl('/tmp/photos/exterior#1.png'))
  assert.equal(db.getFirm().media_url, toFileUrl('/tmp/firm logo.png'))
})
