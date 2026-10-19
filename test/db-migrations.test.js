/**
 * Upgrade-path coverage.
 *
 * The v1.0.2 Windows release started and immediately exited on any machine that
 * already had a database, because CI only ever launched the app against an
 * empty userData directory. These tests exercise the path a real upgrade takes:
 * a database written by an older release, opened by this build.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const Database = require('better-sqlite3')

// Must load before src/db (which requires electron).
const { setUserDataPath } = require('./helpers/electron-stub')

const db = require('../src/db')
const {
  SCHEMA_VERSION,
  DatabaseMigrationRequiredError,
  IncompatibleDatabaseError,
  initializeDatabase,
  inspectDatabase,
  pendingMigrations,
} = db

const pricingCsvPath = path.join(
  __dirname,
  '..',
  'data',
  'uniformat_pricing.csv',
)
const v1SchemaPath = path.join(__dirname, 'fixtures', 'schema', 'v1.sql')
const devCapitalPlanningSchemaPath = path.join(
  __dirname,
  'fixtures',
  'schema',
  'v1-dev-capital-planning.sql',
)

/** assert.throws checks the error but does not hand it back; this does both. */
function captureThrow(fn, ErrorType) {
  let caught = null
  assert.throws(fn, (error) => {
    caught = error
    assert.ok(
      error instanceof ErrorType,
      `expected ${ErrorType.name}, got ${error?.name}: ${error?.message}`,
    )
    return true
  })
  return caught
}

function initializeForTest(database, options = {}) {
  initializeDatabase(database, {
    pricingCsvPath,
    seedDummyData: false,
    ...options,
  })
}

/** A database in the shape shipped by releases 1.0.0–1.0.2 (no user_version). */
function openRelease1Database() {
  const database = new Database(':memory:')
  database.exec(fs.readFileSync(v1SchemaPath, 'utf8'))
  assert.equal(
    database.pragma('user_version', { simple: true }),
    0,
    'fixture must predate schema versioning',
  )
  return database
}

function openCurrentDatabase() {
  const database = new Database(':memory:')
  initializeForTest(database)
  return database
}

/**
 * Structural fingerprint: tables, their columns (name -> type/notnull/default/pk),
 * foreign keys, and indexes. Column order is deliberately ignored — every query
 * is by name, and ALTER TABLE ADD COLUMN can only append.
 *
 * Written independently of `src/db.js`'s own shape comparison on purpose. Two
 * implementations that must agree catch a bug in either; sharing one helper
 * would let a blind spot hide itself.
 */
function schemaFingerprint(database) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)

  const fingerprint = {}
  for (const table of tables) {
    const columns = {}
    for (const column of database.pragma(`table_info(${table})`)) {
      columns[column.name] = {
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }
    }
    // index_list covers UNIQUE/PK autoindexes too, which have no CREATE INDEX
    // text in sqlite_master and would otherwise go uncompared.
    const indexes = database
      .pragma(`index_list(${table})`)
      .map(
        (index) =>
          `${index.name} unique=${index.unique} origin=${index.origin} (` +
          database
            .pragma(`index_info(${index.name})`)
            .map((entry) => entry.name)
            .join(',') +
          ')',
      )
      .sort()
    const foreignKeys = database
      .pragma(`foreign_key_list(${table})`)
      .map(
        (key) =>
          `${key.from} -> ${key.table}.${key.to} ` +
          `on_update=${key.on_update} on_delete=${key.on_delete}`,
      )
      .sort()
    fingerprint[table] = { columns, indexes, foreignKeys }
  }

  return fingerprint
}

/** Every asset row, for comparing a database against its pre-migration copy. */
function readAssets(database) {
  return database.prepare('SELECT * FROM asset ORDER BY id').all()
}

/** Representative rows covering every column the v1 -> v2 migration touches. */
function seedRelease1Data(database) {
  database
    .prepare('INSERT INTO project (id, client) VALUES (1, ?)')
    .run('Northern Health')
  database
    .prepare(
      `INSERT INTO building (id, project_id, property_name, city, num_floors)
       VALUES (1, 1, ?, ?, 3)`,
    )
    .run('ASHC Lodge South', 'Prince George')
  database
    .prepare(
      `INSERT INTO executive_summary (building_id, accessibility, capital_needs)
       VALUES (1, ?, ?)`,
    )
    .run('Ramp non-compliant', 'Roof replacement in 2029')
  database
    .prepare(
      `INSERT INTO uniformat_pricing (
         pricing_id, level_1_code, level_1_description, level_2_code,
         level_2_description, level_3_code, level_3_description, level_4_code,
         level_4_description
       ) VALUES ('B3010.10', 'B', 'Shell', 'B30', 'Roofing', 'B3010', 'Roof Coverings', 'B3010.10', 'Membrane')`,
    )
    .run()

  const insertAsset = database.prepare(
    `INSERT INTO asset (
       id, building_id, uniformat_pricing_id, asset_name, vintage, service_life,
       description, condition_rating, unit_measure, action_year,
       opinion_of_probable_cost, hidden
     ) VALUES (?, 1, 'B3010.10', ?, 1998, 25, ?, ?, 'm2', ?, ?, ?)`,
  )
  // Numeric-looking text: must come back as real numbers after the retype.
  insertAsset.run(1, 'Roof membrane', 'SBS two-ply', 'Fair', '2029', '185000.50', 0)
  // Free text that was never a number: must survive untouched, not become 0.
  insertAsset.run(2, 'Boiler', 'Cast iron', 'Poor', 'TBD', 'Allowance', 0)
  // Empty and null values.
  insertAsset.run(3, 'Windows', 'Aluminium', 'Good', '', null, 1)

  database
    .prepare(
      `INSERT INTO asset_image (id, asset_id, file_path, caption, sort_order)
       VALUES (1, 1, ?, ?, 0)`,
    )
    .run('/images/roof.jpg', 'Membrane blistering')
  database
    .prepare(
      `INSERT INTO building_image (id, building_id, file_path, caption, sort_order)
       VALUES (1, 1, ?, ?, 0)`,
    )
    .run('/images/front.jpg', 'South elevation')
}

test('a release 1.0.x database is detected as migratable, not broken', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())

  const status = inspectDatabase(database)
  assert.equal(status.state, 'needs-migration')
  assert.equal(status.version, 1)
})

test('opening an older database never migrates it without approval', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)

  const error = captureThrow(
    () => initializeForTest(database),
    DatabaseMigrationRequiredError,
  )
  assert.equal(error.fromVersion, 1)
  assert.equal(error.toVersion, SCHEMA_VERSION)
  assert.ok(
    error.changes.length > 0,
    'the prompt needs something to tell the user',
  )

  // The database must be untouched: the user has not agreed to anything yet.
  assert.equal(database.pragma('user_version', { simple: true }), 0)
  assert.equal(
    Object.keys(schemaFingerprint(database).asset.columns).includes('quantity'),
    false,
  )
})

test('an approved migration produces exactly a current database', (t) => {
  const migrated = openRelease1Database()
  const fresh = openCurrentDatabase()
  t.after(() => {
    migrated.close()
    fresh.close()
  })
  seedRelease1Data(migrated)

  initializeForTest(migrated, { migrate: true })

  assert.deepEqual(schemaFingerprint(migrated), schemaFingerprint(fresh))
  assert.equal(migrated.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  assert.deepEqual(migrated.pragma('foreign_key_check'), [])
})

test('a current database missing a table or index is rejected without silent repair', (t) => {
  for (const [type, name, drop] of [
    ['table', 'firm', 'DROP TABLE firm'],
    ['index', 'idx_asset_building_import_key', 'DROP INDEX idx_asset_building_import_key'],
  ]) {
    const database = openCurrentDatabase()
    t.after(() => database.close())
    database.exec(drop)

    assert.throws(() => initializeForTest(database), IncompatibleDatabaseError)
    assert.equal(
      database
        .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
        .get(type, name),
      undefined,
      `${type} ${name} was silently recreated`,
    )
  }
})

test('migrating preserves every row and retypes the columns that changed', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)
  database.prepare("UPDATE asset SET fci = 'Poor' WHERE id = 1").run()

  initializeForTest(database, { migrate: true })

  const building = database.prepare('SELECT * FROM building WHERE id = 1').get()
  assert.equal(building.property_name, 'ASHC Lodge South')
  assert.equal(building.city, 'Prince George')
  // NOT NULL DEFAULT 1 must be filled in for pre-existing rows.
  assert.equal(building.location_factor, 1)
  assert.equal(building.current_replacement_value, null)

  const summary = database
    .prepare('SELECT * FROM executive_summary WHERE building_id = 1')
    .get()
  assert.equal(summary.accessibility, 'Ramp non-compliant')
  assert.equal(summary.capital_needs, 'Roof replacement in 2029')
  assert.equal(summary.immediate_concerns, null)

  const assets = database.prepare('SELECT * FROM asset ORDER BY id').all()
  assert.equal(assets.length, 3, 'no asset rows may be dropped')
  assert.deepEqual(
    assets.map((asset) => asset.asset_name),
    ['Roof membrane', 'Boiler', 'Windows'],
  )

  // Numeric text becomes real numbers under the new column affinity.
  assert.equal(assets[0].action_year, 2029)
  assert.equal(typeof assets[0].action_year, 'number')
  assert.equal(assets[0].opinion_of_probable_cost, 185000.5)
  assert.equal(typeof assets[0].opinion_of_probable_cost, 'number')

  // Text that was never a number is kept as-is rather than coerced to 0.
  assert.equal(assets[1].action_year, 'TBD')
  assert.equal(assets[1].opinion_of_probable_cost, 'Allowance')

  // New columns land on their declared defaults.
  assert.equal(assets[0].life_adjustment_years, 0)
  assert.equal(assets[0].quantity, null)
  assert.equal(assets[0].unit_cost_override, null)
  assert.equal(assets[0].allowance_interval_years, null)
  assert.equal(
    Object.hasOwn(assets[0], 'fci'),
    false,
    'the obsolete per-asset FCI column must be intentionally removed',
  )

  // Soft-delete flags and other preserved state survive the table rebuild.
  assert.equal(assets[2].hidden, 1)
  assert.equal(assets[0].uniformat_pricing_id, 'B3010.10')

  const assetImage = database
    .prepare('SELECT * FROM asset_image WHERE id = 1')
    .get()
  assert.equal(assetImage.caption, 'Membrane blistering')
  assert.equal(assetImage.bounding_boxes, null)
  assert.equal(assetImage.include_in_report, 1)
  // The rebuilt asset table must keep the id its images point at.
  assert.equal(assetImage.asset_id, 1)

  const buildingImage = database
    .prepare('SELECT * FROM building_image WHERE id = 1')
    .get()
  assert.equal(buildingImage.caption, 'South elevation')
  assert.equal(buildingImage.bounding_boxes, null)

  assert.deepEqual(database.pragma('foreign_key_check'), [])
})

test('AUTOINCREMENT keeps running past the highest migrated id', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)

  initializeForTest(database, { migrate: true })

  const inserted = database
    .prepare('INSERT INTO asset (building_id, asset_name) VALUES (1, ?)')
    .run('Post-migration asset')
  assert.ok(
    Number(inserted.lastInsertRowid) > 3,
    'a rebuilt table must not reuse ids that migrated rows already hold',
  )
})

test('a migrated database is stable when opened again', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)

  initializeForTest(database, { migrate: true })
  const afterMigration = schemaFingerprint(database)

  // Second launch: already current, so it must not prompt or change anything.
  assert.equal(inspectDatabase(database).state, 'current')
  initializeForTest(database)
  assert.deepEqual(schemaFingerprint(database), afterMigration)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM asset').get().n, 3)
})

test('an unstamped database already in the current shape is adopted silently', (t) => {
  const database = new Database(':memory:')
  t.after(() => database.close())

  // Dev databases built from schema.sql before versioning existed.
  database.exec(fs.readFileSync(path.join(__dirname, '..', 'data', 'schema.sql'), 'utf8'))
  assert.equal(database.pragma('user_version', { simple: true }), 0)

  assert.equal(inspectDatabase(database).state, 'current')
  initializeForTest(database)
  assert.equal(database.pragma('user_version', { simple: true }), SCHEMA_VERSION)
})

test('a database from a newer app version is refused, not downgraded', (t) => {
  const database = openCurrentDatabase()
  t.after(() => database.close())

  database.pragma(`user_version = ${SCHEMA_VERSION + 1}`)

  const error = captureThrow(
    () => initializeForTest(database),
    IncompatibleDatabaseError,
  )
  assert.match(error.message, /newer version/i)
})

test('pre-release shapes are refused rather than migrated', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  database.exec('CREATE TABLE element (id INTEGER PRIMARY KEY, element_name TEXT)')

  const error = captureThrow(
    () => initializeForTest(database, { migrate: true }),
    IncompatibleDatabaseError,
  )
  assert.match(error.message, /element/)
})

test('migration steps are ordered and reach the declared schema version', () => {
  const all = pendingMigrations(0)
  assert.ok(all.length > 0)

  const versions = all.map((migration) => migration.to)
  assert.deepEqual(
    versions,
    [...versions].sort((a, b) => a - b),
    'migrations must be listed in ascending order',
  )
  assert.equal(
    new Set(versions).size,
    versions.length,
    'two migrations must not claim the same version',
  )
  assert.equal(
    versions.at(-1),
    SCHEMA_VERSION,
    'SCHEMA_VERSION was bumped without adding the matching migration step',
  )
  for (const migration of all) {
    assert.ok(
      typeof migration.summary === 'string' && migration.summary.length > 0,
      `migration ${migration.to} needs a summary for the upgrade prompt`,
    )
  }
})

test('migration failure leaves the on-disk database untouched', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-migrate-'))
  // Every sqlite handle opened against this dir must close before it is removed:
  // Windows refuses to delete a file (or its parent) while a handle is still
  // open, so one ordered teardown closes them all and only then removes the dir.
  const handles = []
  t.after(() => {
    db.closeDatabase()
    for (const handle of handles) {
      try {
        handle.close()
      } catch {
        // Already closed.
      }
    }
    fs.rmSync(userData, { force: true, recursive: true })
  })
  setUserDataPath(userData)

  const dbPath = path.join(userData, 'app.db')
  const seed = new Database(dbPath)
  seed.exec(fs.readFileSync(v1SchemaPath, 'utf8'))
  seedRelease1Data(seed)
  // A stray table with the rebuild's working name makes the asset rebuild fail.
  seed.exec('CREATE TABLE asset_migration_v2 (id INTEGER PRIMARY KEY)')
  seed.close()

  // What the user had before the attempt, to compare the restored file against.
  const reference = openRelease1Database()
  handles.push(reference)
  seedRelease1Data(reference)
  reference.exec('CREATE TABLE asset_migration_v2 (id INTEGER PRIMARY KEY)')

  assert.throws(() => db.migrateDatabaseWithBackup())

  // The restored file is a copy of the snapshot, so it is equal in content
  // rather than byte-for-byte: assert on what the user would actually lose.
  const restored = new Database(dbPath, { readonly: true })
  handles.push(restored)
  assert.equal(
    restored.pragma('user_version', { simple: true }),
    0,
    'a failed migration must not leave the database claiming a new version',
  )
  assert.deepEqual(
    schemaFingerprint(restored),
    schemaFingerprint(reference),
    'a failed migration must restore the shape the user started with',
  )
  assert.deepEqual(
    readAssets(restored),
    readAssets(reference),
    'a failed migration must restore every row the user started with',
  )

  const backups = fs
    .readdirSync(userData)
    .filter((name) => name.endsWith('.bak'))
  assert.equal(backups.length, 1, 'the pre-migration copy must be kept')

  // The restore stages through a temp file and renames it into place. A leftover
  // would be swept into every later export, so it must not survive the restore.
  assert.deepEqual(
    fs.readdirSync(userData).filter((name) => name.endsWith('.restoring')),
    [],
    'the restore must leave no staging file behind',
  )

  const backup = new Database(path.join(userData, backups[0]), { readonly: true })
  handles.push(backup)
  assert.deepEqual(
    readAssets(backup),
    readAssets(reference),
    'the backup must be an openable database holding the original rows',
  )
})

test('migrating a dev-build shape keeps the columns it already had', (t) => {
  // A database from commit 43337a9: unversioned, so it is detected by shape as
  // release 1, but its asset table already has the capital-planning columns.
  // Rebuilding that table from a hardcoded legacy column list silently wiped
  // them; the rebuild copies whatever the two shapes have in common instead.
  const database = new Database(':memory:')
  t.after(() => database.close())
  database.exec(fs.readFileSync(devCapitalPlanningSchemaPath, 'utf8'))
  seedRelease1Data(database)
  database
    .prepare(
      `UPDATE asset
          SET quantity = ?, unit_cost_override = ?,
              life_adjustment_years = ?, allowance_interval_years = ?
        WHERE id = 1`,
    )
    .run(7.5, 123.45, 4, 12)

  assert.equal(inspectDatabase(database).state, 'needs-migration')
  initializeForTest(database, { migrate: true })

  const asset = database.prepare('SELECT * FROM asset WHERE id = 1').get()
  assert.equal(asset.quantity, 7.5)
  assert.equal(asset.unit_cost_override, 123.45)
  assert.equal(asset.life_adjustment_years, 4)
  assert.equal(asset.allowance_interval_years, 12)
})

test('migrating never reissues an id that was already used', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)

  // Highest id ever issued is 3. Deleting it leaves max(id) = 2, so a rebuild
  // that lets SQLite recompute the sequence would hand out 3 again — exactly
  // what AUTOINCREMENT exists to prevent.
  database.exec('DELETE FROM asset_image')
  database.exec('DELETE FROM asset WHERE id = 3')
  assert.equal(
    database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'asset'").get().seq,
    3,
  )

  initializeForTest(database, { migrate: true })

  const inserted = database
    .prepare("INSERT INTO asset (building_id, asset_name) VALUES (1, 'New')")
    .run()
  assert.equal(
    inserted.lastInsertRowid,
    4,
    'the next asset must not reuse the id of a deleted one',
  )
})

test('an unstamped database missing any current column is not adopted', (t) => {
  // The compatibility check used to be a hand-maintained column list, so a
  // column it forgot to name (bounding_boxes) let an unusable database be
  // stamped current and then fail at query time — the original bug, again.
  // Whether such a database is repaired or refused is a judgement call; being
  // waved through as already-current is not.
  const fresh = openCurrentDatabase()
  t.after(() => fresh.close())
  const currentFingerprint = schemaFingerprint(fresh)

  for (const [table, column] of [
    ['asset_image', 'bounding_boxes'],
    ['asset_image', 'include_in_report'],
    ['building_image', 'bounding_boxes'],
    ['building', 'current_replacement_value'],
    ['executive_summary', 'facility_overview'],
  ]) {
    const database = openCurrentDatabase()
    t.after(() => database.close())
    database.pragma('user_version = 0')
    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)

    assert.notEqual(
      inspectDatabase(database).state,
      'current',
      `a database missing ${table}.${column} must not be adopted as current`,
    )
    assert.throws(
      () => initializeForTest(database),
      `opening a database missing ${table}.${column} must not silently succeed`,
    )

    // Whatever route it takes, what comes out has to be genuinely current.
    initializeForTest(database, { migrate: true })
    assert.deepEqual(schemaFingerprint(database), currentFingerprint)
    assert.equal(database.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  }
})

const SHARE_DASHBOARD_TABLES = [
  'temporary_share',
  'temporary_share_extension',
  'temporary_share_audit',
  'temporary_share_return',
]

/** Apply frozen migration steps through `toVersion` (FK-off, same as runMigrations). */
function applyMigrationsThrough(database, fromVersion, toVersion) {
  const pending = pendingMigrations(fromVersion).filter(
    (migration) => migration.to <= toVersion,
  )
  const foreignKeysWereOn = Boolean(
    database.pragma('foreign_keys', { simple: true }),
  )
  database.pragma('foreign_keys = OFF')
  try {
    database.transaction(() => {
      for (const migration of pending) {
        migration.up(database)
        database.pragma(`user_version = ${migration.to}`)
      }
    })()
  } finally {
    if (foreignKeysWereOn) database.pragma('foreign_keys = ON')
  }
}

function tableNames(database) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
}

test('schema v5 adds the dashboard tables; v9 removes them', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  database.pragma('foreign_keys = ON')

  applyMigrationsThrough(database, 1, 5)

  const afterV5 = tableNames(database)
  for (const table of SHARE_DASHBOARD_TABLES) {
    assert.ok(afterV5.includes(table), `v5 must create dashboard table ${table}`)
  }

  const projectColumnsV5 = new Set(
    database.pragma('table_info(project)').map((column) => column.name),
  )
  assert.ok(projectColumnsV5.has('imported_from_license_id'))
  assert.ok(projectColumnsV5.has('imported_at'))

  database
    .prepare(
      `INSERT INTO temporary_share (license_id, created_at, updated_at, encrypted_unlock_password)
       VALUES ('lic-v5', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', '{"v":1}')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO temporary_share_extension (license_id, extension_id, created_at, updated_at)
       VALUES ('lic-v5', 'ext-30', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`,
    )
    .run()
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO temporary_share_extension (license_id, extension_id, created_at, updated_at)
           VALUES ('lic-v5', 'ext-30', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`,
        )
        .run(),
    /UNIQUE/,
  )
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO temporary_share_extension (license_id, extension_id, created_at, updated_at)
           VALUES ('lic-missing', 'ext-30', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`,
        )
        .run(),
    /FOREIGN KEY/,
  )

  database.prepare('INSERT INTO project (client) VALUES (?)').run('Northern Health')
  const projectV5 = database.prepare('SELECT * FROM project').get()
  assert.equal(projectV5.imported_from_license_id, null)
  assert.equal(projectV5.imported_at, null)

  applyMigrationsThrough(database, 5, SCHEMA_VERSION)

  const afterCurrent = tableNames(database)
  for (const table of SHARE_DASHBOARD_TABLES) {
    assert.equal(
      afterCurrent.includes(table),
      false,
      `v9 must drop dashboard table ${table}`,
    )
  }
  const projectColumns = new Set(
    database.pragma('table_info(project)').map((column) => column.name),
  )
  assert.equal(projectColumns.has('imported_from_license_id'), false)
  assert.equal(projectColumns.has('imported_at'), false)
  assert.ok(projectColumns.has('deletion_snapshot'))
})

test('a current database has no Temporary Shares tables or provenance columns', (t) => {
  const database = openCurrentDatabase()
  t.after(() => database.close())

  const tables = tableNames(database)
  for (const table of SHARE_DASHBOARD_TABLES) {
    assert.equal(tables.includes(table), false, `current schema still has ${table}`)
  }

  const projectColumns = new Set(
    database.pragma('table_info(project)').map((column) => column.name),
  )
  assert.equal(projectColumns.has('imported_from_license_id'), false)
  assert.equal(projectColumns.has('imported_at'), false)
  assert.ok(
    projectColumns.has('deletion_snapshot'),
    'Settings recovery snapshot must remain',
  )
})

test('migration includes the first six asset photos in the report by default', (t) => {
  const database = openRelease1Database()
  t.after(() => database.close())
  seedRelease1Data(database)

  const insertImage = database.prepare(
    `INSERT INTO asset_image (asset_id, file_path, sort_order) VALUES (1, ?, ?)`,
  )
  // seedRelease1Data already inserted sort_order 0; add seven more (eight total).
  for (let sortOrder = 1; sortOrder < 8; sortOrder += 1) {
    insertImage.run(`/images/roof-${sortOrder}.jpg`, sortOrder)
  }

  initializeForTest(database, { migrate: true })

  const flags = database
    .prepare(
      `SELECT include_in_report FROM asset_image
       WHERE asset_id = 1
       ORDER BY sort_order, id`,
    )
    .all()
    .map((row) => row.include_in_report)
  assert.deepEqual(flags, [1, 1, 1, 1, 1, 1, 0, 0])
})
