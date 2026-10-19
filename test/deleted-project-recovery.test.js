const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Must load before src/db (which requires electron).
const { setUserDataPath } = require('./helpers/electron-stub')
const db = require('../src/db')

function openWorkspace(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-project-recovery-'))
  db.closeDatabase()
  setUserDataPath(userData)
  const database = db.openDatabase()
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(userData, { recursive: true, force: true })
  })
  return database
}

function scalar(database, sql, ...params) {
  return database.prepare(sql).get(...params).hidden
}

test('Settings recovery survives restart and restores only the project graph visible at deletion', (t) => {
  let database = openWorkspace(t)
  const projectId = db.createProject({ client: 'Recoverable client' }).id
  const visibleBuildingId = Number(
    database
      .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
      .run(projectId, 'Visible property').lastInsertRowid,
  )
  const deletedBuildingId = Number(
    database
      .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
      .run(projectId, 'Already deleted property').lastInsertRowid,
  )
  const visibleAssetId = Number(
    database
      .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
      .run(visibleBuildingId, 'Visible roof').lastInsertRowid,
  )
  const deletedAssetId = Number(
    database
      .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
      .run(visibleBuildingId, 'Already deleted boiler').lastInsertRowid,
  )
  const visibleAssetImageId = Number(
    database
      .prepare('INSERT INTO asset_image (asset_id, file_path) VALUES (?, ?)')
      .run(visibleAssetId, '/tmp/visible-asset.jpg').lastInsertRowid,
  )
  const deletedAssetImageId = Number(
    database
      .prepare('INSERT INTO asset_image (asset_id, file_path) VALUES (?, ?)')
      .run(deletedAssetId, '/tmp/deleted-asset.jpg').lastInsertRowid,
  )
  const visibleBuildingImageId = Number(
    database
      .prepare('INSERT INTO building_image (building_id, file_path) VALUES (?, ?)')
      .run(visibleBuildingId, '/tmp/visible-building.jpg').lastInsertRowid,
  )

  database
    .prepare('INSERT INTO executive_summary (building_id, facility_overview) VALUES (?, ?)')
    .run(visibleBuildingId, 'Visible summary')
  database
    .prepare('INSERT INTO executive_summary (building_id, facility_overview) VALUES (?, ?)')
    .run(deletedBuildingId, 'Deleted summary')

  // These rows were intentionally deleted before the whole project was deleted.
  db.deleteAsset(deletedAssetId)
  db.deleteBuilding(deletedBuildingId)

  const snapshot = db.deleteProject(projectId)
  assert.equal(snapshot.projectId, projectId)
  assert.deepEqual(snapshot.buildings.map((building) => building.buildingId), [visibleBuildingId])
  assert.deepEqual(db.listProjects(), [])
  assert.deepEqual(db.listDeletedProjects(), [{ id: projectId, client: 'Recoverable client' }])
  assert.equal(
    JSON.parse(
      database.prepare('SELECT deletion_snapshot FROM project WHERE id = ?').get(projectId)
        .deletion_snapshot,
    ).projectId,
    projectId,
  )

  db.closeDatabase()
  database = db.openDatabase()
  const restored = db.restoreDeletedProject(projectId)
  assert.equal(restored.id, projectId)
  assert.equal(restored.client, 'Recoverable client')
  assert.deepEqual(db.listProjects(), [{ id: projectId, client: 'Recoverable client' }])
  assert.deepEqual(
    db.listBuildings(projectId).map((building) => building.id),
    [visibleBuildingId],
  )
  assert.deepEqual(db.listDeletedProjects(), [])

  assert.equal(scalar(database, 'SELECT hidden FROM project WHERE id = ?', projectId), 0)
  assert.equal(
    database.prepare('SELECT deletion_snapshot FROM project WHERE id = ?').get(projectId)
      .deletion_snapshot,
    null,
  )
  assert.equal(scalar(database, 'SELECT hidden FROM building WHERE id = ?', visibleBuildingId), 0)
  assert.equal(scalar(database, 'SELECT hidden FROM building WHERE id = ?', deletedBuildingId), 1)
  assert.equal(scalar(database, 'SELECT hidden FROM asset WHERE id = ?', visibleAssetId), 0)
  assert.equal(scalar(database, 'SELECT hidden FROM asset WHERE id = ?', deletedAssetId), 1)
  assert.equal(
    scalar(database, 'SELECT hidden FROM asset_image WHERE id = ?', visibleAssetImageId),
    0,
  )
  assert.equal(
    scalar(database, 'SELECT hidden FROM asset_image WHERE id = ?', deletedAssetImageId),
    1,
  )
  assert.equal(
    scalar(database, 'SELECT hidden FROM building_image WHERE id = ?', visibleBuildingImageId),
    0,
  )
  assert.equal(
    scalar(database, 'SELECT hidden FROM executive_summary WHERE building_id = ?', visibleBuildingId),
    0,
  )
  assert.equal(
    scalar(database, 'SELECT hidden FROM executive_summary WHERE building_id = ?', deletedBuildingId),
    1,
  )
})

test('projects deleted before recovery snapshots can still be recovered', (t) => {
  const database = openWorkspace(t)
  const projectId = db.createProject({ client: 'Legacy deleted project' }).id
  const buildingId = Number(
    database
      .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
      .run(projectId, 'Stored property').lastInsertRowid,
  )
  const assetId = Number(
    database
      .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
      .run(buildingId, 'Stored asset').lastInsertRowid,
  )

  // This mirrors a pre-v8 soft deletion, which had no persisted snapshot.
  database.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(assetId)
  database.prepare('UPDATE building SET hidden = 1 WHERE id = ?').run(buildingId)
  database.prepare('UPDATE project SET hidden = 1 WHERE id = ?').run(projectId)

  const restored = db.restoreDeletedProject(projectId)
  assert.equal(restored.id, projectId)
  assert.equal(scalar(database, 'SELECT hidden FROM project WHERE id = ?', projectId), 0)
  assert.equal(scalar(database, 'SELECT hidden FROM building WHERE id = ?', buildingId), 0)
  assert.equal(scalar(database, 'SELECT hidden FROM asset WHERE id = ?', assetId), 0)
  assert.equal(db.restoreDeletedProject(projectId), null)
})
