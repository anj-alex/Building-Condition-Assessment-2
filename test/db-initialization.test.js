const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const Database = require('better-sqlite3')
const {
  initializeDatabase,
  readSchemaSql,
  seedUniformatPricingRecords,
} = require('../src/db')
const { parseUniformatPricingRows } = require('../src/lib/csv-utils')

const pricingCsvPath = path.join(
  __dirname,
  '..',
  'data',
  'uniformat_pricing.csv',
)

function openTestDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  return database
}

function initializeForTest(database, options = {}) {
  initializeDatabase(database, {
    pricingCsvPath,
    seedDummyData: false,
    ...options,
  })
}

function tableExists(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  )
}

function insertBuilding(database) {
  const project = database
    .prepare('INSERT INTO project (client) VALUES (?)')
    .run('Init test client')
  return database
    .prepare(
      'INSERT INTO building (project_id, property_name) VALUES (?, ?)',
    )
    .run(project.lastInsertRowid, 'Init test building')
    .lastInsertRowid
}

test('initializes a fresh database and remains safe to initialize again', (t) => {
  const database = openTestDatabase()
  t.after(() => database.close())

  initializeForTest(database)

  assert.equal(tableExists(database, 'asset'), true)
  assert.equal(tableExists(database, 'asset_image'), true)
  assert.equal(tableExists(database, 'element'), false)
  assert.ok(
    database.prepare('SELECT COUNT(*) AS count FROM uniformat_pricing').get()
      .count > 0,
  )
  assert.deepEqual(
    database
      .prepare(
        `SELECT pricing_id, level_2_code, level_3_code, mean_service_life,
                unit_price, unit_of_measure
         FROM uniformat_pricing
         WHERE pricing_id = 'SUPP-C3300-01'`,
      )
      .get(),
    {
      pricing_id: 'SUPP-C3300-01',
      level_2_code: 'C33',
      level_3_code: 'C3300',
      mean_service_life: 12,
      unit_price: null,
      unit_of_measure: 'Each',
    },
  )
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM project').get().count,
    0,
  )

  const buildingId = insertBuilding(database)
  database
    .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
    .run(buildingId, 'Roof')

  initializeForTest(database)

  assert.deepEqual(
    database.prepare('SELECT asset_name FROM asset').all(),
    [{ asset_name: 'Roof' }],
  )
  assert.deepEqual(database.pragma('foreign_key_check'), [])
})

test('seeds the catalogue from records in memory, identically to seeding from a path', (t) => {
  // The in-memory seed must match the path seed so tests and the CSV
  // importer share one write.
  const fromPath = openTestDatabase()
  const fromRecords = openTestDatabase()
  t.after(() => {
    fromPath.close()
    fromRecords.close()
  })

  initializeForTest(fromPath)
  fromRecords.exec(readSchemaSql())
  seedUniformatPricingRecords(
    fromRecords,
    parseUniformatPricingRows(fs.readFileSync(pricingCsvPath, 'utf8')),
  )

  const dump = (database) =>
    database.prepare('SELECT * FROM uniformat_pricing ORDER BY pricing_id').all()
  assert.ok(dump(fromRecords).length > 1000)
  assert.deepEqual(dump(fromRecords), dump(fromPath))
  assert.throws(() => seedUniformatPricingRecords(fromRecords, null), TypeError)
})

test('seeds dummy data only when explicitly enabled', (t) => {
  const withoutDummy = openTestDatabase()
  t.after(() => withoutDummy.close())
  initializeForTest(withoutDummy, { seedDummyData: false })
  assert.equal(
    withoutDummy.prepare('SELECT COUNT(*) AS count FROM project').get().count,
    0,
  )

  const withDummy = openTestDatabase()
  t.after(() => withDummy.close())
  initializeForTest(withDummy, { seedDummyData: true })
  assert.ok(
    withDummy.prepare('SELECT COUNT(*) AS count FROM project').get().count > 0,
  )
  assert.ok(
    withDummy.prepare('SELECT COUNT(*) AS count FROM building').get().count > 0,
  )
  assert.ok(
    withDummy.prepare('SELECT COUNT(*) AS count FROM asset').get().count > 0,
  )
})

test('refuses databases with legacy tables (no migration)', (t) => {
  const database = openTestDatabase()
  t.after(() => database.close())

  initializeForTest(database)
  database.exec(`
    CREATE TABLE element (
      id INTEGER PRIMARY KEY,
      building_id INTEGER,
      element_name TEXT
    );
  `)

  assert.throws(
    () => initializeForTest(database),
    /legacy table|Incompatible database/i,
  )
})

test('refuses databases missing required columns (no migration)', (t) => {
  const database = openTestDatabase()
  t.after(() => database.close())

  // Minimal incomplete shape — not created via schema.sql.
  database.exec(`
    CREATE TABLE project (id INTEGER PRIMARY KEY, client TEXT);
    CREATE TABLE firm (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE building (
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      property_name TEXT
    );
    CREATE TABLE executive_summary (building_id INTEGER);
    CREATE TABLE asset (id INTEGER PRIMARY KEY, building_id INTEGER);
    CREATE TABLE asset_image (id INTEGER PRIMARY KEY, asset_id INTEGER, file_path TEXT);
    CREATE TABLE building_image (id INTEGER PRIMARY KEY, building_id INTEGER, file_path TEXT);
    CREATE TABLE uniformat_pricing (pricing_id TEXT PRIMARY KEY, level_1_code TEXT, level_2_code TEXT);
  `)

  assert.throws(
    () => initializeForTest(database),
    /missing column|Incompatible database/i,
  )
})

test('refuses a current database with existing foreign-key violations', (t) => {
  const database = openTestDatabase()
  t.after(() => database.close())
  initializeForTest(database)

  database.pragma('foreign_keys = OFF')
  database
    .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
    .run(999_999, 'Orphan asset')
  database.pragma('foreign_keys = ON')

  assert.throws(
    () => initializeForTest(database),
    /foreign-key check found 1 violation/i,
  )
})
