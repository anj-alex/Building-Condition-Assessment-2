const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')

const { setUserDataPath, setIsPackaged } = require('./helpers/electron-stub')
setIsPackaged(true)
const db = require('../src/db')

function openWorkspace(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-db-write-'))
  setUserDataPath(userData)
  db.closeDatabase()
  const database = db.openDatabase()
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(userData, { recursive: true, force: true })
  })
  return database
}

function seedAsset(t) {
  const database = openWorkspace(t)
  const projectId = db.createProject({ client: 'Write safety' }).id
  const buildingId = db.createBuilding({
    project_id: projectId,
    property_name: 'Safety House',
  }).id
  const assetId = db.createAsset(buildingId, 'A').id
  return { database, buildingId, assetId }
}

test('updateAsset persists include_as_not_assessed', (t) => {
  const { database, assetId } = seedAsset(t)

  db.updateAsset(assetId, { include_as_not_assessed: 1 })
  assert.equal(
    database.prepare('SELECT include_as_not_assessed FROM asset WHERE id = ?').get(assetId)
      .include_as_not_assessed,
    1,
  )

  db.updateAsset(assetId, { include_as_not_assessed: 0 })
  assert.equal(
    database.prepare('SELECT include_as_not_assessed FROM asset WHERE id = ?').get(assetId)
      .include_as_not_assessed,
    0,
  )
})

test('createAsset rejects a missing building instead of returning a stale row id', (t) => {
  const { database } = seedAsset(t)
  const before = database.prepare('SELECT count(*) AS count FROM asset').get().count

  assert.throws(
    () => db.createAsset(999_999, 'A'),
    /Building 999999 was not found/,
  )
  assert.equal(
    database.prepare('SELECT count(*) AS count FROM asset').get().count,
    before,
  )
})

test('an arbitrary first DB read cannot consume an out-of-band replacement signal', (t) => {
  const originalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-db-original-'))
  const replacementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-db-replacement-'))
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(originalDir, { recursive: true, force: true })
    fs.rmSync(replacementDir, { recursive: true, force: true })
  })

  setUserDataPath(originalDir)
  db.closeDatabase()
  db.openDatabase()
  db.createProject({ client: 'Original workspace' })
  assert.equal(db.ensureDatabaseCurrent().changed, false)

  const replacement = new Database(path.join(replacementDir, 'app.db'))
  db.initializeDatabase(replacement, { seedDummyData: false })
  replacement.prepare('INSERT INTO project (client) VALUES (?)').run('Replacement workspace')
  replacement.close()

  // Home bootstrap/list APIs can beat the focus-time ensure call. This first
  // read must reopen the new file without erasing the replacement signal.
  setUserDataPath(replacementDir)
  assert.deepEqual(
    db.listProjects().map((project) => project.client),
    ['Replacement workspace'],
  )
  assert.equal(db.ensureDatabaseCurrent().changed, true)
  assert.equal(db.ensureDatabaseCurrent().changed, false, 'the latch is consumed once')
})
