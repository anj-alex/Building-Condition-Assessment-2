const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const { app } = require('electron')
const { readUniformatPricingRows, parseLocationFactorRows } = require('./lib/csv-utils')
const { calculateCapitalPlan } = require('./lib/capital-planning')
const { isAssetAssessed, includeAssetInReport } = require('./lib/asset-completeness')
const { validateReport } = require('./lib/report-validation')
const appSettings = require('./app-settings')
const { parseAnnotationsJson, sanitizeAnnotations } = require('./lib/annotations')
const { readDataFileText } = require('./data-files')
const { toFileUrl } = require('./shared')
const { assertDatabaseIntegrity } = require('./database-integrity')
const { fsyncFile } = require('./file-durability')

let db
let dbFileIdentity = null
// An arbitrary DB call may be the first code to notice an out-of-band file
// replacement. Latch that fact until the lifecycle/persistence seam consumes
// it; otherwise openDatabase() updating dbFileIdentity makes the later check
// falsely report that nothing changed.
let databaseChangedSinceLastCheck = false
let locationFactorsCache = null

/**
 * Schema version stored in each database as `PRAGMA user_version`.
 *
 * Bump this whenever `data/schema.sql` changes and add a matching entry to
 * MIGRATIONS. Migrations are never applied automatically — startup asks the
 * user first and always keeps a copy of the pre-migration file.
 */
const SCHEMA_VERSION = 12

/** New asset photos at this index or later default to excluded from the report. */
const DEFAULT_ASSET_IMAGES_IN_REPORT = 6

/**
 * App releases up to 1.0.2 predate `user_version`, so their databases report 0.
 * They all shipped the same schema, which we call version 1 and detect by shape.
 */
const RELEASE_1_SCHEMA_VERSION = 1

/**
 * Raised when a userData database cannot be opened or migrated by this build.
 * Typed so startup can offer recovery instead of dying silently — callers
 * must not have to pattern-match on the message.
 */
class IncompatibleDatabaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IncompatibleDatabaseError'
  }
}

/**
 * Raised when a migration failed *and* rolling the live file back to its
 * pre-migration snapshot failed too.
 *
 * Separate from a plain migration failure because the advice is the opposite:
 * after an ordinary failure the live file is untouched and the user can carry
 * on, but here it may be half-migrated or truncated and the only good copy is
 * the `.bak`. Typed so the startup dialog cannot get that backwards.
 */
class DatabaseRestoreFailedError extends Error {
  constructor({ backupPath, migrationError, restoreError }) {
    super(
      `Migration failed (${migrationError.message}), and restoring the original ` +
        `database failed as well (${restoreError.message}). The pre-migration ` +
        `copy is intact at ${backupPath}.`,
      { cause: migrationError },
    )
    this.name = 'DatabaseRestoreFailedError'
    this.backupPath = backupPath
  }
}

/**
 * Raised when a database is an older but migratable shape. Carries everything
 * the startup prompt needs to explain the upgrade before the user approves it.
 */
class DatabaseMigrationRequiredError extends Error {
  constructor({ fromVersion, toVersion, changes }) {
    super(
      `Database schema version ${fromVersion} needs updating to version ${toVersion}.`,
    )
    this.name = 'DatabaseMigrationRequiredError'
    this.fromVersion = fromVersion
    this.toVersion = toVersion
    /** @type {string[]} human-readable summary of each pending step */
    this.changes = changes
  }
}

function getDbPath() {
  return path.join(app.getPath('userData'), 'app.db')
}

function closeDatabase() {
  if (!db) return
  db.close()
  db = null
  dbFileIdentity = null
}

/** Displayable `file://` URL for a stored filesystem path. */
function mediaUrlFor(filePath) {
  if (filePath == null || String(filePath) === '') return null
  return toFileUrl(filePath) || null
}

/** Row in, row out with `media_url` attached (`pathField` names the media column). */
function withMediaUrl(row, pathField = 'file_path') {
  if (!row) return row
  return { ...row, media_url: mediaUrlFor(row[pathField]) }
}

/**
 * Write a consistent on-disk copy of the live database (safe while connections are open).
 */
async function backupDatabaseTo(destPath) {
  const database = openDatabase()
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  await database.backup(destPath)
}

function getDbFileIdentity(dbPath) {
  try {
    const stat = fs.statSync(dbPath)
    if (stat.ino) return `ino:${stat.ino}`
    return `path:${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * Dummy sample rows are a dev convenience only.
 * Packaged releases must start empty (schema + Uniformat pricing only).
 */
function shouldSeedDummyDataByDefault() {
  return !app.isPackaged
}

/**
 * Open/init policy: `data/schema.sql` is the only shape this build runs on.
 * Older databases are migrated forward, but only after the user approves it
 * (see `migrateDatabaseWithBackup`) — nothing is ever upgraded silently.
 *
 * @param {object} [options]
 * @param {boolean} [options.migrate] apply pending migrations instead of
 *   throwing DatabaseMigrationRequiredError. Set only once the user has agreed.
 */
function initializeDatabase(database, options = {}) {
  database.pragma('foreign_keys = ON')

  try {
    assertDatabaseIntegrity(database)
  } catch (error) {
    throw new IncompatibleDatabaseError(`Incompatible database: ${error.message}.`)
  }

  const status = inspectDatabase(database)
  if (status.state === 'unsupported') {
    throw new IncompatibleDatabaseError(
      `Incompatible database: ${status.reason}. This app cannot migrate that shape — ` +
        'open it with the release that created it, or start from a new database.',
    )
  }
  if (status.state === 'too-new') {
    throw new IncompatibleDatabaseError(
      `Incompatible database: it was written by a newer version of the app ` +
        `(schema version ${status.version}; this build supports ${SCHEMA_VERSION}). ` +
        'Install the newer release to open it.',
    )
  }
  if (status.state === 'needs-migration') {
    if (!options.migrate) {
      throw new DatabaseMigrationRequiredError({
        fromVersion: status.version,
        toVersion: SCHEMA_VERSION,
        changes: pendingMigrations(status.version).map(
          (migration) => migration.summary,
        ),
      })
    }
    runMigrations(database, status.version)
  }

  // schema.sql is the fresh-database blueprint, not a repair mechanism. Running
  // it against current or migrated files would silently create a newly-added
  // table/index and let a missing migration pass the fresh-vs-migrated tests.
  if (status.state === 'fresh') {
    database.exec(readSchemaSql())
  }
  assertCompatibleSchema(database)
  try {
    assertDatabaseIntegrity(database)
  } catch (error) {
    throw new IncompatibleDatabaseError(`Incompatible database: ${error.message}.`)
  }
  // Stamp last: only a database that passed every check claims to be current.
  database.pragma(`user_version = ${SCHEMA_VERSION}`)

  seedUniformatPricing(
    database,
    options.pricingCsvPath ?? appSettings.getUniformatPricingCsvPath(),
  )
  const seedDummyData = options.seedDummyData ?? shouldSeedDummyDataByDefault()
  if (seedDummyData) {
    seedDummyDataIfEmpty(database)
  }
}

/** Tables every release of this app has had. */
const CORE_TABLES = [
  'project',
  'firm',
  'building',
  'executive_summary',
  'asset',
  'asset_image',
  'building_image',
  'uniformat_pricing',
]

/** Tables from the pre-1.0 shape. No migration path exists for these. */
const PRE_RELEASE_TABLES = ['element', 'element_image', 'section', 'section_type']

/**
 * Columns that identify a database written by app releases 1.0.0–1.0.2, which
 * carry no `user_version`. Deliberately a signature, not the full schema: it
 * only has to distinguish "our version 1" from "something we don't recognise".
 */
const RELEASE_1_SIGNATURE = {
  building: ['id', 'project_id', 'property_name', 'num_floors', 'hidden'],
  executive_summary: ['building_id', 'accessibility', 'capital_needs', 'hidden'],
  asset: [
    'id',
    'building_id',
    'uniformat_pricing_id',
    'asset_name',
    'unit_measure',
    'action_year',
    'opinion_of_probable_cost',
    'hidden',
  ],
  asset_image: ['id', 'asset_id', 'file_path', 'sort_order', 'hidden'],
  building_image: ['id', 'building_id', 'file_path', 'sort_order', 'hidden'],
}

/**
 * Ordered, append-only. Each entry upgrades a database to `to`, and every
 * `data/schema.sql` change needs one. Steps are frozen once released: they must
 * keep working against the old shape, so they never reference schema.sql.
 */
const MIGRATIONS = [
  {
    to: 2,
    summary:
      'Adds location factors and replacement values to buildings, capital-planning ' +
      'inputs (quantity, unit cost, life adjustment, allowance interval) to assets, ' +
      'three executive-summary sections, and photo annotation boxes.',
    up(database) {
      addColumns(database, 'building', [
        ['location_factor_province', 'TEXT'],
        ['location_factor_city', 'TEXT'],
        ['location_factor', 'REAL NOT NULL DEFAULT 1'],
        ['current_replacement_value', 'REAL'],
      ])
      addColumns(database, 'executive_summary', [
        ['designated_substance_survey', 'TEXT'],
        ['immediate_concerns', 'TEXT'],
        ['facility_overview', 'TEXT'],
      ])
      addColumns(database, 'asset_image', [['bounding_boxes', 'TEXT']])
      addColumns(database, 'building_image', [['bounding_boxes', 'TEXT']])
      rebuildAssetTableForV2(database)
    },
  },
  {
    to: 3,
    summary:
      'Adds per-asset-photo include_in_report so users choose which photos appear ' +
      'in the exported property report (first six visible photos included by default).',
    up(database) {
      addColumns(database, 'asset_image', [
        ['include_in_report', 'INTEGER NOT NULL DEFAULT 1'],
      ])
      applyDefaultAssetImageReportInclusion(database)
    },
  },
  {
    to: 4,
    summary:
      'Removes the per-asset qualitative FCI field; FCI is now calculated once per ' +
      'building from scheduled capital costs and current replacement value.',
    up(database) {
      database.exec('ALTER TABLE asset DROP COLUMN fci')
    },
  },
  {
    to: 5,
    summary:
      'Adds Temporary Shares dashboard tables and project import-provenance ' +
      'columns (historical scaffolding; later removed). Existing project data ' +
      'is untouched.',
    // IF NOT EXISTS because an unstamped dev database can already carry some
    // of this shape and still arrive here via the version-1 path. The real
    // guard is assertCompatibleSchema after the migration: a pre-existing
    // table whose shape is wrong fails the open and rolls back to the backup.
    // This DDL is the *version 5* shape and stays that way: steps 6 and 7
    // reshape those tables, then step 9 drops them. data/schema.sql is the
    // post-v9 product shape and must not be edited back to include them.
    // The migration gate test compares the end of that chain against a fresh
    // database pragma by pragma. Editing this step to match the current
    // schema would erase the history the later steps are written against.
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS temporary_share (
            license_id                  TEXT PRIMARY KEY,
            label                       TEXT,
            recipient                   TEXT,
            notes                       TEXT,
            created_at                  TEXT NOT NULL,
            activate_by                 TEXT,
            activated_at                TEXT,
            original_expires_at         TEXT,
            expected_expires_at         TEXT,
            confirmed_expires_at        TEXT,
            duration_days               INTEGER,
            check_every_seconds         INTEGER,
            max_offline_seconds         INTEGER,
            tsa_list_json               TEXT,
            pinned_roots_json           TEXT,
            activation_mode             TEXT NOT NULL DEFAULT 'operator-mediated',
            state                       TEXT NOT NULL DEFAULT 'issued',
            archived                    INTEGER NOT NULL DEFAULT 0,
            selection_summary_json      TEXT,
            ai_enabled                  INTEGER NOT NULL DEFAULT 0,
            ai_key_label                TEXT,
            app_version                 TEXT,
            schema_version              INTEGER,
            container_version           INTEGER,
            artifact_path               TEXT,
            artifact_sha256             TEXT,
            device_public_key           TEXT,
            device_fingerprint          TEXT,
            encrypted_unlock_password   TEXT,
            encrypted_activation_material TEXT,
            last_receipt_json           TEXT,
            last_receipt_at             TEXT,
            last_return_at              TEXT,
            last_return_state           TEXT,
            updated_at                  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS temporary_share_extension (
            license_id          TEXT NOT NULL REFERENCES temporary_share(license_id),
            extension_id        TEXT NOT NULL,
            day_offset          INTEGER,
            target_expires_at   TEXT,
            salt                TEXT,
            password_hash       TEXT,
            encrypted_password  TEXT,
            issued_at           TEXT,
            redeemed_at         TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            UNIQUE (license_id, extension_id)
        );

        CREATE TABLE IF NOT EXISTS temporary_share_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            license_id  TEXT REFERENCES temporary_share(license_id),
            event_type  TEXT NOT NULL,
            event_at    TEXT NOT NULL,
            detail_json TEXT
        );

        CREATE TABLE IF NOT EXISTS temporary_share_return (
            id                        INTEGER PRIMARY KEY AUTOINCREMENT,
            license_id                TEXT NOT NULL REFERENCES temporary_share(license_id),
            staged_at                 TEXT NOT NULL,
            package_path              TEXT,
            validation_state          TEXT NOT NULL DEFAULT 'staged',
            source_schema_version     INTEGER,
            imported_project_ids_json TEXT,
            error_text                TEXT,
            imported_at               TEXT
        );
      `)
      addColumns(database, 'project', [
        ['imported_from_license_id', 'TEXT'],
        ['imported_at', 'TEXT'],
      ])
    },
  },
  {
    to: 6,
    summary:
      'Reshapes Temporary Shares expiry columns (historical; those tables are ' +
      'removed in a later step).',
    up(database) {
      // No production shares exist, so there is nothing to convert: any dev row
      // that predates this keeps whatever expiry it was activated with, and an
      // unactivated dev row is left with no date rather than one invented from
      // the deadline it no longer has.
      //
      // Each step is conditional for the same reason migration 5's DDL says IF
      // NOT EXISTS: an unstamped database already in the current shape reaches
      // here through the version-1 path, and an unconditional ALTER would fail
      // on a table that has already been converted.
      const columns = new Set(
        database.pragma('table_info(temporary_share)').map((column) => column.name),
      )
      if (columns.has('activate_by')) {
        database.exec('ALTER TABLE temporary_share DROP COLUMN activate_by')
      }
      if (columns.has('duration_days')) {
        database.exec('ALTER TABLE temporary_share DROP COLUMN duration_days')
      }
      if (columns.has('original_expires_at') && !columns.has('expires_at')) {
        database.exec(
          'ALTER TABLE temporary_share RENAME COLUMN original_expires_at TO expires_at',
        )
      }
    },
  },
  {
    to: 7,
    summary:
      'Drops Temporary Shares recipient-machine columns (historical; those ' +
      'tables are removed in a later step).',
    up(database) {
      // Conditional per column, like migration 6 and for the same reason: an
      // unstamped database already in the current shape reaches here through
      // the version-1 path.
      const columns = new Set(
        database.pragma('table_info(temporary_share)').map((column) => column.name),
      )
      for (const column of [
        'activated_at',
        'confirmed_expires_at',
        'activation_mode',
        'device_public_key',
        'device_fingerprint',
        'encrypted_activation_material',
        'last_receipt_json',
        'last_receipt_at',
      ]) {
        if (columns.has(column)) {
          database.exec(`ALTER TABLE temporary_share DROP COLUMN ${column}`)
        }
      }
      // A share left in the retired 'active' state was activated under the old
      // model. There is nothing to activate now, so it goes back to the only
      // state the dashboard still has for a delivered share.
      database.exec("UPDATE temporary_share SET state = 'issued' WHERE state = 'active'")
      // Redemption was only ever recorded from a status receipt, so this column
      // could never be filled again.
      const extensionColumns = new Set(
        database.pragma('table_info(temporary_share_extension)').map((column) => column.name),
      )
      if (extensionColumns.has('redeemed_at')) {
        database.exec('ALTER TABLE temporary_share_extension DROP COLUMN redeemed_at')
      }
    },
  },
  {
    to: 8,
    summary:
      'Keeps a recovery snapshot when a project is deleted, so Settings can restore ' +
      'the project and the records that were visible when it was deleted.',
    up(database) {
      addColumns(database, 'project', [['deletion_snapshot', 'TEXT']])
    },
  },
  {
    to: 9,
    summary:
      'Temporary Shares is retired: dashboard tables and return-import provenance columns are removed.',
    up(database) {
      database.exec(`
        DROP TABLE IF EXISTS temporary_share_return;
        DROP TABLE IF EXISTS temporary_share_audit;
        DROP TABLE IF EXISTS temporary_share_extension;
        DROP TABLE IF EXISTS temporary_share;
      `)
      const columns = columnNames(database, 'project')
      if (columns.has('imported_from_license_id')) {
        database.exec('ALTER TABLE project DROP COLUMN imported_from_license_id')
      }
      if (columns.has('imported_at')) {
        database.exec('ALTER TABLE project DROP COLUMN imported_at')
      }
    },
  },
  {
    to: 10,
    summary:
      'Adds asset.include_as_not_assessed so a blank asset can be opted in to the ' +
      'report as "Not Assessed"; blank assets are otherwise excluded.',
    up(database) {
      addColumns(database, 'asset', [
        ['include_as_not_assessed', 'INTEGER NOT NULL DEFAULT 0'],
      ])
    },
  },
  {
    to: 11,
    summary:
      'Adds building.site_id and asset.import_key so an imported Excel workbook ' +
      'can be re-imported and matched to existing buildings and assets.',
    up(database) {
      addColumns(database, 'building', [['site_id', 'TEXT']])
      addColumns(database, 'asset', [['import_key', 'TEXT']])
    },
  },
  {
    to: 12,
    summary:
      'Makes an imported asset unique per building and import key, so re-importing ' +
      'a revised workbook can never insert a second copy of a row it already holds.',
    up(database) {
      // Older imports keyed rows that had no Sheet ID by their row number, so a
      // re-import after any row was inserted or removed duplicated them. Those
      // duplicates already exist in databases out in the field and would fail
      // the unique index below, so give each extra copy its own key first —
      // suffixing rather than deleting, because a duplicate may be the row the
      // user actually attached photos and findings to. The pre-export review
      // reports what is left for the user to merge or delete by hand.
      const duplicates = database
        .prepare(
          `SELECT building_id, import_key
             FROM asset
            WHERE import_key IS NOT NULL AND import_key <> ''
            GROUP BY building_id, import_key
           HAVING count(*) > 1`,
        )
        .all()
      const listCopies = database.prepare(
        `SELECT id FROM asset
          WHERE building_id = ? AND import_key = ?
          ORDER BY id`,
      )
      const rekey = database.prepare('UPDATE asset SET import_key = ? WHERE id = ?')
      for (const group of duplicates) {
        const copies = listCopies.all(group.building_id, group.import_key)
        // The first copy keeps the original key; the rest are numbered.
        for (const [index, copy] of copies.entries()) {
          if (index === 0) continue
          rekey.run(`${group.import_key}#${index + 1}`, copy.id)
        }
      }
      database.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_building_import_key
           ON asset(building_id, import_key)
         WHERE import_key IS NOT NULL`,
      )
    },
  },
]

/**
 * Keep the first DEFAULT_ASSET_IMAGES_IN_REPORT visible photos per asset in the
 * report; mark the rest excluded. Matches the default used on new imports.
 */
function applyDefaultAssetImageReportInclusion(database) {
  const assetIds = database
    .prepare(
      `SELECT DISTINCT asset_id FROM asset_image WHERE hidden = 0 ORDER BY asset_id`,
    )
    .all()
    .map((row) => row.asset_id)
  const listVisible = database.prepare(
    `SELECT id FROM asset_image
     WHERE asset_id = ? AND hidden = 0
     ORDER BY sort_order, id`,
  )
  const exclude = database.prepare(
    `UPDATE asset_image SET include_in_report = 0 WHERE id = ?`,
  )
  for (const assetId of assetIds) {
    const images = listVisible.all(assetId)
    for (const [index, image] of images.entries()) {
      if (index >= DEFAULT_ASSET_IMAGES_IN_REPORT) exclude.run(image.id)
    }
  }
}

function pendingMigrations(fromVersion) {
  return MIGRATIONS.filter((migration) => migration.to > fromVersion).sort(
    (a, b) => a.to - b.to,
  )
}

function addColumns(database, table, columns) {
  const present = columnNames(database, table)
  for (const [name, definition] of columns) {
    if (present.has(name)) continue
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

/**
 * `asset` gains four columns *and* retypes two (action_year TEXT -> INTEGER,
 * opinion_of_probable_cost TEXT -> REAL). SQLite cannot change a column type in
 * place, so rebuild the table per the documented drop-and-rename procedure.
 *
 * Values are copied straight across: the new columns' type affinity converts
 * numeric strings ('2029' -> 2029) and leaves anything that was never a number
 * (e.g. 'TBD') untouched as text, which is exactly what a fresh database does
 * on insert. Nothing is discarded.
 *
 * The copied column list is the intersection of the old and new tables rather
 * than a hardcoded one: dev builds between 1.0.2 and 2 already grew some of the
 * v2 columns, and hardcoding would blank out whatever they had stored there.
 */
function rebuildAssetTableForV2(database) {
  database.exec(`
    CREATE TABLE asset_migration_v2 (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        building_id                 INTEGER NOT NULL REFERENCES building(id),
        uniformat_pricing_id        TEXT REFERENCES uniformat_pricing(pricing_id),
        asset_name                  TEXT,
        vintage                     INTEGER,
        service_life                INTEGER,
        description                 TEXT,
        recommendation              TEXT,
        condition_rating            TEXT,
        fci                         TEXT,
        priority                    TEXT,
        action                      TEXT,
        term                        TEXT,
        conservation_lens           TEXT,
        unit_measure                TEXT,
        quantity                    REAL,
        unit_cost_override          REAL,
        life_adjustment_years       INTEGER NOT NULL DEFAULT 0,
        allowance_interval_years    INTEGER,
        action_year                 INTEGER,
        opinion_of_probable_cost    REAL,
        hidden                      INTEGER NOT NULL DEFAULT 0
    );
  `)

  const target = columnNames(database, 'asset_migration_v2')
  const carried = [...columnNames(database, 'asset')].filter((column) =>
    target.has(column),
  )
  const columnList = carried.join(', ')

  // AUTOINCREMENT promises an id is never reused. That promise lives in
  // sqlite_sequence, which DROP TABLE deletes, so carry the high-water mark
  // across by hand — otherwise deleting the newest asset before an upgrade
  // lets the next insert reclaim its id.
  const previousSequence = database
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'asset'")
    .get()

  database.exec(`
    INSERT INTO asset_migration_v2 (${columnList})
    SELECT ${columnList} FROM asset;

    DROP TABLE asset;
    ALTER TABLE asset_migration_v2 RENAME TO asset;
  `)

  if (previousSequence) {
    // Copying rows recreates the entry, but only if there were rows to copy.
    const current = database
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'asset'")
      .get()
    if (!current) {
      database
        .prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('asset', ?)")
        .run(previousSequence.seq)
    } else if (current.seq < previousSequence.seq) {
      database
        .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'asset'")
        .run(previousSequence.seq)
    }
  }
}

/**
 * Apply every migration after `fromVersion`, atomically.
 *
 * Foreign keys are disabled around the transaction because table rebuilds drop
 * tables that others reference, and SQLite refuses to toggle the pragma inside
 * a transaction. `foreign_key_check` runs before commit so a migration that
 * would orphan rows rolls back instead of landing.
 */
function runMigrations(database, fromVersion) {
  const pending = pendingMigrations(fromVersion)
  if (pending.length === 0) return []

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
      const violations = database.pragma('foreign_key_check')
      if (violations.length > 0) {
        throw new Error(
          `Migration to schema version ${SCHEMA_VERSION} left ${violations.length} ` +
            'foreign key violation(s); no changes were saved.',
        )
      }
    })()
  } finally {
    if (foreignKeysWereOn) database.pragma('foreign_keys = ON')
  }
  return pending
}

function listTableNames(database) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_')),
  )
}

function matchesRelease1Signature(database) {
  return Object.entries(RELEASE_1_SIGNATURE).every(([table, columns]) => {
    const present = columnNames(database, table)
    return columns.every((column) => present.has(column))
  })
}

/**
 * Classify a database before anything is written to it.
 *
 * @returns {{ state: 'fresh'|'current'|'needs-migration'|'too-new'|'unsupported',
 *             version: number|null, reason?: string }}
 */
function inspectDatabase(database) {
  const tables = listTableNames(database)
  if (tables.size === 0) return { state: 'fresh', version: SCHEMA_VERSION }

  const stored = Number(database.pragma('user_version', { simple: true })) || 0
  if (stored > SCHEMA_VERSION) return { state: 'too-new', version: stored }
  if (stored > 0) {
    return stored === SCHEMA_VERSION
      ? { state: 'current', version: stored }
      : { state: 'needs-migration', version: stored }
  }

  // Unversioned: written by app <= 1.0.2, or by a dev build predating versioning.
  const preRelease = PRE_RELEASE_TABLES.filter((name) => tables.has(name))
  if (preRelease.length > 0) {
    return {
      state: 'unsupported',
      version: null,
      reason: `pre-release table(s) present (${preRelease.join(', ')})`,
    }
  }

  const missingCore = CORE_TABLES.filter((name) => !tables.has(name))
  if (missingCore.length > 0) {
    return {
      state: 'unsupported',
      version: null,
      reason: `missing table(s) ${missingCore.join(', ')}`,
    }
  }

  // Already the current shape, just never stamped. Adopt it silently — there is
  // nothing to migrate and nothing to ask the user about.
  const incompatibility = describeSchemaIncompatibility(database)
  if (!incompatibility) return { state: 'current', version: SCHEMA_VERSION }

  if (matchesRelease1Signature(database)) {
    return { state: 'needs-migration', version: RELEASE_1_SCHEMA_VERSION }
  }
  return { state: 'unsupported', version: null, reason: incompatibility }
}

function seedDummyDataIfEmpty(database) {
  // Count all project rows (including soft-deleted). Seeding only when
  // visible projects are empty would re-run dummy_data.sql after the user
  // soft-deletes everything and overwrite firm via INSERT OR REPLACE.
  const projectCount = database
    .prepare('SELECT COUNT(*) AS count FROM project')
    .get()
    ?.count ?? 0
  if (projectCount > 0) return

  const dummyDataPath = path.join(__dirname, '..', 'data', 'dummy_data.sql')
  // File is excluded from packaged builds; skip quietly if absent.
  if (!fs.existsSync(dummyDataPath)) return
  database.exec(fs.readFileSync(dummyDataPath, 'utf8'))
}

/**
 * @param {object} [options]
 * @param {boolean} [options.migrate] apply pending migrations (user-approved only)
 */
function openDatabase(options = {}) {
  const dbPath = getDbPath()
  const nextIdentity = getDbFileIdentity(dbPath)
  if (db && dbFileIdentity !== nextIdentity) {
    databaseChangedSinceLastCheck = true
    db.close()
    db = null
    dbFileIdentity = null
  }
  if (db) return db

  db = new Database(dbPath)
  try {
    initializeDatabase(db, options)
  } catch (error) {
    // Never leave a half-initialized handle behind — startup recovery needs to
    // reopen this same file, and on Windows an open handle blocks copies.
    db.close()
    db = null
    dbFileIdentity = null
    throw error
  }
  dbFileIdentity = getDbFileIdentity(dbPath)
  return db
}

/** SQLite sidecar files that must travel with (or away from) the main DB file. */
const DB_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm']

/** Colons are illegal in Windows filenames, so flatten the ISO timestamp. */
function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Render a path as a SQL string literal (SQLite escapes `'` by doubling it). */
function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Write `sourcePath` to `destinationPath` as a consistent, self-contained copy.
 *
 * `VACUUM INTO` runs under SQLite's own locking and writes a complete database
 * in one go, so the result is transaction-consistent even if another process
 * holds the file open — which a plain file copy is not. It also needs no
 * sidecar files to be valid, so the copy can never be separated from a journal
 * it depends on. Opening read-write first lets SQLite roll back any journal a
 * previous crash left behind before the snapshot is taken.
 */
function snapshotDatabaseFile(sourcePath, destinationPath) {
  const source = new Database(sourcePath)
  try {
    source.exec(`VACUUM INTO ${quoteSqlString(destinationPath)}`)
  } finally {
    source.close()
  }
}

/**
 * Put `backupPath` back in place at `dbPath`, leaving no half-written file.
 *
 * Copying straight over the live database is not atomic: a crash, a kill, or an
 * antivirus lock partway through leaves a truncated `app.db`, which is a worse
 * state than the failed migration we are recovering from. So the copy lands
 * beside it under a temporary name, is flushed to disk, and only then replaces
 * the live file — `rename` is atomic, and on Windows libuv maps it to
 * `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, so it overwrites there too.
 *
 * Sidecars go before the rename, not after: they describe the file being
 * replaced, and SQLite would apply a stale journal to the restored copy and
 * corrupt it. Clearing them first means every interruption point leaves either
 * the old file or the restored one, never a good file with a bad journal.
 */
function restoreDatabaseFile(backupPath, dbPath) {
  const pendingPath = `${dbPath}.restoring`
  try {
    fs.copyFileSync(backupPath, pendingPath)
    fsyncFile(pendingPath)
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true })
    }
    fs.renameSync(pendingPath, dbPath)
  } finally {
    // A leftover temp file would be copied into every later export.
    fs.rmSync(pendingPath, { force: true })
  }
}

/** VACUUM INTO refuses to overwrite, so never hand it a name already in use. */
function unusedBackupPath(preferredPath) {
  let candidate = preferredPath
  let attempt = 2
  while (fs.existsSync(candidate)) {
    candidate = `${preferredPath}.${attempt}`
    attempt += 1
  }
  return candidate
}

/**
 * Upgrade the userData database to the current schema, keeping the original.
 *
 * A snapshot of the pre-migration file is written to a `.bak` beside the live
 * database before anything is altered, so the old data is always recoverable by
 * opening that copy with the release that wrote it. If the migration fails for
 * any reason, the untouched snapshot is restored over the live file.
 *
 * Call only after the user has approved the upgrade.
 *
 * @returns {{ backupPath: string, fromVersion: number, toVersion: number }}
 */
function migrateDatabaseWithBackup() {
  closeDatabase()

  const dbPath = getDbPath()
  const fromVersion = readDatabaseVersion(dbPath)
  const backupPath = unusedBackupPath(
    `${dbPath}.v${fromVersion}-backup-${backupTimestamp()}.bak`,
  )
  snapshotDatabaseFile(dbPath, backupPath)

  try {
    openDatabase({ migrate: true })
  } catch (error) {
    // Leave the user with the file they started with, never a half-migrated one.
    closeDatabase()
    try {
      restoreDatabaseFile(backupPath, dbPath)
    } catch (restoreError) {
      // Never let a restore failure hide itself behind the migration error:
      // this is the one case where the user has to go find the backup by hand.
      throw new DatabaseRestoreFailedError({
        backupPath,
        migrationError: error,
        restoreError,
      })
    }
    throw error
  }

  return { backupPath, fromVersion, toVersion: SCHEMA_VERSION }
}

/** Read a database's schema version without disturbing it. */
function readDatabaseVersion(dbPath) {
  const probe = new Database(dbPath, { readonly: true })
  try {
    return inspectDatabase(probe).version ?? 0
  } finally {
    probe.close()
  }
}

/**
 * Move an unmigratable userData database aside and start again from a fresh one.
 *
 * Used only for shapes with no migration path. The old file is renamed, never
 * deleted, so it can still be opened with the release that wrote it. Sidecar
 * journal/WAL files move with it, otherwise SQLite would apply a stale journal
 * to the new database.
 *
 * @returns {{ backupPath: string | null }} where the old DB went, if there was one
 */
function backupAndResetDatabase() {
  closeDatabase()

  const dbPath = getDbPath()
  let backupPath = null

  if (fs.existsSync(dbPath)) {
    backupPath = `${dbPath}.${backupTimestamp()}.bak`
    fs.renameSync(dbPath, backupPath)

    for (const suffix of DB_SIDECAR_SUFFIXES) {
      if (fs.existsSync(`${dbPath}${suffix}`)) {
        fs.renameSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`)
      }
    }
  }

  openDatabase()
  return { backupPath }
}

/**
 * Reopen the DB if the file on disk was replaced (e.g. load-local-db.sh).
 * Returns whether an existing connection was closed and a new one opened.
 */
function ensureDatabaseCurrent() {
  const previousIdentity = dbFileIdentity
  openDatabase()
  const changed =
    databaseChangedSinceLastCheck ||
    (previousIdentity != null && previousIdentity !== dbFileIdentity)
  databaseChangedSinceLastCheck = false
  return {
    changed,
  }
}

function tableExists(database, name) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
  )
}

function columnNames(database, table) {
  return new Set(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  )
}

/** Structure of one table, as SQLite reports it after the fact. */
function describeTableShape(database, table) {
  return {
    columns: database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map(
        (column) =>
          `${column.name} ${column.type} notnull=${column.notnull} ` +
          `default=${column.dflt_value ?? ''} pk=${column.pk}`,
      ),
    foreignKeys: database
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map(
        (key) =>
          `${key.from} -> ${key.table}.${key.to} ` +
          `on_update=${key.on_update} on_delete=${key.on_delete}`,
      )
      .sort(),
    indexes: database
      .prepare(`PRAGMA index_list(${table})`)
      .all()
      .map((index) => {
        const columns = database
          .prepare(`PRAGMA index_info(${index.name})`)
          .all()
          .map((entry) => entry.name)
          .join(',')
        return `${index.name} unique=${index.unique} origin=${index.origin} (${columns})`
      })
      .sort(),
  }
}

/**
 * Every table's structure, keyed by table name.
 *
 * Derived from pragmas rather than the stored CREATE TABLE text: `ALTER TABLE
 * ADD COLUMN` appends to that text, so a migrated table and a freshly created
 * one read differently while being structurally identical.
 */
function describeSchemaShape(database) {
  const shape = {}
  for (const table of [...listTableNames(database)].sort()) {
    shape[table] = describeTableShape(database, table)
  }
  return shape
}

function readSchemaSql() {
  return readDataFileText('data/schema.sql')
}

let referenceSchemaShape = null

/** The shape `data/schema.sql` produces. Built once, in memory. */
function getReferenceSchemaShape() {
  if (!referenceSchemaShape) {
    const reference = new Database(':memory:')
    try {
      reference.exec(readSchemaSql())
      referenceSchemaShape = describeSchemaShape(reference)
    } finally {
      reference.close()
    }
  }
  return referenceSchemaShape
}

/**
 * Describe why `database` is not the current shape, or null when it is.
 * Used both to classify databases before migrating and to verify the result.
 *
 * Compared against a database built from `data/schema.sql` itself rather than a
 * hand-maintained column list. A curated list is the thing that has to be kept
 * in sync by hand, and forgetting to is how a release ships a database the code
 * cannot actually use.
 *
 * @returns {string|null}
 */
function describeSchemaIncompatibility(database) {
  const legacyTables = PRE_RELEASE_TABLES.filter((name) =>
    tableExists(database, name),
  )
  if (legacyTables.length > 0) {
    return `legacy table(s) present (${legacyTables.join(', ')})`
  }

  const expected = getReferenceSchemaShape()
  const actual = describeSchemaShape(database)

  for (const [table, expectedShape] of Object.entries(expected)) {
    const actualShape = actual[table]
    if (!actualShape) return `missing table "${table}"`

    for (const part of ['columns', 'foreignKeys', 'indexes']) {
      const missing = expectedShape[part].filter(
        (entry) => !actualShape[part].includes(entry),
      )
      if (missing.length > 0) {
        return `table "${table}" ${part} differ: expected ${missing.join('; ')}`
      }
      const extra = actualShape[part].filter(
        (entry) => !expectedShape[part].includes(entry),
      )
      if (extra.length > 0) {
        return `table "${table}" ${part} differ: unexpected ${extra.join('; ')}`
      }
    }
  }

  const extraTables = Object.keys(actual).filter((table) => !expected[table])
  if (extraTables.length > 0) {
    return `unrecognised table(s) (${extraTables.join(', ')})`
  }

  return null
}

/**
 * Guard the invariant that we only ever hand out a current-shape database —
 * after a fresh create and after a migration.
 */
function assertCompatibleSchema(database) {
  const incompatibility = describeSchemaIncompatibility(database)
  if (incompatibility) {
    throw new IncompatibleDatabaseError(`Incompatible database: ${incompatibility}.`)
  }
}

function seedUniformatPricing(database, csvPath = appSettings.getUniformatPricingCsvPath()) {
  seedUniformatPricingRecords(database, readUniformatPricingRows(csvPath))
}

/** Upsert Uniformat catalogue rows from an in-memory record list. */
function seedUniformatPricingRecords(database, records) {
  if (!Array.isArray(records)) {
    throw new TypeError('seedUniformatPricingRecords needs an array of records.')
  }
  if (records.length === 0) {
    throw new Error('Uniformat pricing catalogue contains no records.')
  }
  const pricingIds = new Set()
  for (const record of records) {
    const pricingId = String(record?.pricing_id ?? '').trim()
    if (!pricingId) throw new Error('Uniformat pricing record is missing pricing_id.')
    if (pricingIds.has(pricingId)) {
      throw new Error(`Uniformat pricing catalogue contains duplicate id "${pricingId}".`)
    }
    pricingIds.add(pricingId)
  }
  const insertPricing = database.prepare(
    `INSERT INTO uniformat_pricing (
       pricing_id,
       level_1_code,
       level_1_description,
       level_2_code,
       level_2_description,
       level_3_code,
       level_3_description,
       level_4_code,
       level_4_description,
       material,
       mean_service_life,
       practical_life,
       unit_price,
       unit_of_measure
     ) VALUES (
       @pricing_id,
       @level_1_code,
       @level_1_description,
       @level_2_code,
       @level_2_description,
       @level_3_code,
       @level_3_description,
       @level_4_code,
       @level_4_description,
       @material,
       @mean_service_life,
       @practical_life,
       @unit_price,
       @unit_of_measure
     ) ON CONFLICT(pricing_id) DO UPDATE SET
       level_1_code = excluded.level_1_code,
       level_1_description = excluded.level_1_description,
       level_2_code = excluded.level_2_code,
       level_2_description = excluded.level_2_description,
       level_3_code = excluded.level_3_code,
       level_3_description = excluded.level_3_description,
       level_4_code = excluded.level_4_code,
       level_4_description = excluded.level_4_description,
       material = excluded.material,
       mean_service_life = excluded.mean_service_life,
       practical_life = excluded.practical_life,
       unit_price = excluded.unit_price,
       unit_of_measure = excluded.unit_of_measure`,
  )

  const seed = database.transaction(() => {
    for (const record of records) {
      insertPricing.run(record)
    }

    database.exec(
      `DROP TABLE IF EXISTS temp.current_uniformat_pricing_ids;
       CREATE TEMP TABLE current_uniformat_pricing_ids (pricing_id TEXT PRIMARY KEY)`,
    )
    const insertCurrentPricingId = database.prepare(
      'INSERT OR IGNORE INTO current_uniformat_pricing_ids (pricing_id) VALUES (?)',
    )

    for (const record of records) {
      insertCurrentPricingId.run(record.pricing_id)
    }

    database.exec(
      `DELETE FROM uniformat_pricing
       WHERE NOT EXISTS (
         SELECT 1
         FROM current_uniformat_pricing_ids current
         WHERE current.pricing_id = uniformat_pricing.pricing_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM asset e
         WHERE e.uniformat_pricing_id = uniformat_pricing.pricing_id
       );

       DROP TABLE current_uniformat_pricing_ids`,
    )
  })
  seed()
}

function listUniformatLevel1Groups() {
  return openDatabase()
    .prepare(
      `SELECT MIN(level_1_code) AS id,
              level_1_code,
              level_1_description,
              level_1_code || ' ' || level_1_description AS name
       FROM uniformat_pricing
       GROUP BY level_1_code, level_1_description
       ORDER BY level_1_code`,
    )
    .all()
}

function level1CodeFromName(level1GroupName) {
  return String(level1GroupName ?? '').trim().split(/\s+/, 1)[0] || null
}

function listUniformatLevel2Groups(level1GroupName) {
  return openDatabase()
    .prepare(
      `SELECT level_2_code,
              level_2_description,
              level_2_code || ' ' || level_2_description AS label
       FROM uniformat_pricing
       WHERE level_1_code = ?
       GROUP BY level_2_code, level_2_description
       ORDER BY level_2_code`,
    )
    .all(level1CodeFromName(level1GroupName))
}

function listUniformatLevel3Groups(level1GroupName, level2Code) {
  return openDatabase()
    .prepare(
      `SELECT level_3_code,
              level_3_description,
              level_3_code || ' ' || level_3_description AS label
       FROM uniformat_pricing
       WHERE level_1_code = @level_1_code
       AND level_2_code = @level_2_code
       GROUP BY level_3_code, level_3_description
       ORDER BY level_3_code`,
    )
    .all({
      level_1_code: level1CodeFromName(level1GroupName),
      level_2_code: level2Code,
    })
}

function listUniformatLevel4Groups(level1GroupName, level2Code, level3Code) {
  return openDatabase()
    .prepare(
      `SELECT level_4_code,
              level_4_description,
              level_4_code || ' ' || level_4_description AS label
       FROM uniformat_pricing
       WHERE level_1_code = @level_1_code
       AND level_2_code = @level_2_code
       AND level_3_code = @level_3_code
       GROUP BY level_4_code, level_4_description
       ORDER BY level_4_code`,
    )
    .all({
      level_1_code: level1CodeFromName(level1GroupName),
      level_2_code: level2Code,
      level_3_code: level3Code,
    })
}

function listUniformatPricingItems(level1GroupName, level2Code, level3Code, level4Code) {
  return openDatabase()
    .prepare(
      `SELECT pricing_id,
              coalesce(material, level_4_description) AS label,
              unit_of_measure,
              mean_service_life,
              practical_life
       FROM uniformat_pricing
       WHERE level_1_code = @level_1_code
       AND level_2_code = @level_2_code
       AND level_3_code = @level_3_code
       AND level_4_code = @level_4_code
       ORDER BY material, pricing_id`,
    )
    .all({
      level_1_code: level1CodeFromName(level1GroupName),
      level_2_code: level2Code,
      level_3_code: level3Code,
      level_4_code: level4Code,
    })
}

function listProjects() {
  return openDatabase()
    .prepare(
      `SELECT id, client
      FROM project
      WHERE hidden = 0
      ORDER BY id DESC`,
    )
    .all()
}

/** Projects retained by the soft-delete path and available from Settings. */
function listDeletedProjects() {
  return openDatabase()
    .prepare(
      `SELECT id, client
       FROM project
       WHERE hidden = 1
       ORDER BY id DESC`,
    )
    .all()
}

function getProject(projectId) {
  return (
    openDatabase()
      .prepare(
        `SELECT id, client
         FROM project
         WHERE id = ? AND hidden = 0`,
      )
      .get(projectId) ?? null
  )
}

function createProject({ client }) {
  const stmt = openDatabase().prepare(
    `INSERT INTO project (client)
     VALUES (@client)`,
  )
  const info = stmt.run({
    client: client ?? null,
  })
  return { id: Number(info.lastInsertRowid) }
}

function updateProject(projectId, { client }) {
  openDatabase()
    .prepare(
      `UPDATE project
       SET client = @client
       WHERE id = @id`,
    )
    .run({
      id: projectId,
      client: client ?? null,
    })
  return { id: projectId }
}

function getFirm() {
  return withMediaUrl(
    openDatabase()
      .prepare(
        `SELECT id,
                name,
                short_name,
                address_line_1,
                address_line_2,
                logo_path,
                logo_original_name
         FROM firm
         ORDER BY id
         LIMIT 1`,
      )
      .get() ?? {
      id: 1,
      name: 'Northstar Building Consultants',
      short_name: 'NBC',
      address_line_1: '5063 North Service Rd., Suite 100',
      address_line_2: 'Burlington, Ontario, Canada, L7L 5H6',
      logo_path: null,
      logo_original_name: null,
    },
    'logo_path',
  )
}

function updateFirm({
  name,
  short_name,
  address_line_1,
  address_line_2,
  logo_path,
  logo_original_name,
} = {}) {
  const current = getFirm()
  // Use `!== undefined` so undo can restore explicit nulls (e.g. cleared logo).
  openDatabase()
    .prepare(
      `INSERT OR REPLACE INTO firm (
         id,
         name,
         short_name,
         address_line_1,
         address_line_2,
         logo_path,
         logo_original_name
       ) VALUES (
         @id,
         @name,
         @short_name,
         @address_line_1,
         @address_line_2,
         @logo_path,
         @logo_original_name
       )`,
    )
    .run({
      id: current.id ?? 1,
      name: name !== undefined ? name : current.name,
      short_name: short_name !== undefined ? short_name : current.short_name ?? null,
      address_line_1:
        address_line_1 !== undefined ? address_line_1 : current.address_line_1 ?? null,
      address_line_2:
        address_line_2 !== undefined ? address_line_2 : current.address_line_2 ?? null,
      logo_path: logo_path !== undefined ? logo_path : current.logo_path ?? null,
      logo_original_name:
        logo_original_name !== undefined
          ? logo_original_name
          : current.logo_original_name ?? null,
    })
  return getFirm()
}

function listBuildings(projectId) {
  return openDatabase()
    .prepare(
      `SELECT id, property_name, address, city, province, property_vintage
       FROM building
       WHERE project_id = ? AND hidden = 0
       ORDER BY id`,
    )
    .all(projectId)
}

function getBuilding(buildingId) {
  return (
    openDatabase()
      .prepare(
        `SELECT id,
                project_id,
                property_name,
                address,
                city,
                province,
                province_short,
                postal_code,
                gross_floor_area_m2,
                property_vintage,
                date_of_assessment,
                num_floors,
                location_factor_province,
                location_factor_city,
                location_factor,
                current_replacement_value,
                site_id
         FROM building
         WHERE id = ? AND hidden = 0`,
      )
      .get(buildingId) ?? null
  )
}

function createBuilding({
  project_id,
  property_name,
  address,
  city,
  province,
  province_short,
  postal_code,
  gross_floor_area_m2,
  property_vintage,
  date_of_assessment,
  num_floors,
  location_factor_province,
  location_factor_city,
  location_factor,
  current_replacement_value,
}) {
  const stmt = openDatabase().prepare(
    `INSERT INTO building (
      project_id,
      property_name,
      address,
      city,
      province,
      province_short,
      postal_code,
      gross_floor_area_m2,
      property_vintage,
      date_of_assessment,
      num_floors,
      location_factor_province,
      location_factor_city,
      location_factor,
      current_replacement_value
    ) VALUES (
      @project_id,
      @property_name,
      @address,
      @city,
      @province,
      @province_short,
      @postal_code,
      @gross_floor_area_m2,
      @property_vintage,
      @date_of_assessment,
      @num_floors,
      @location_factor_province,
      @location_factor_city,
      @location_factor,
      @current_replacement_value
    )`,
  )
  const info = stmt.run({
    project_id,
    property_name: property_name ?? null,
    address: address ?? null,
    city: city ?? null,
    province: province ?? null,
    province_short: province_short ?? null,
    postal_code: postal_code ?? null,
    gross_floor_area_m2: gross_floor_area_m2 ?? null,
    property_vintage: property_vintage ?? null,
    date_of_assessment: date_of_assessment ?? null,
    num_floors: num_floors ?? null,
    location_factor_province: location_factor_province ?? null,
    location_factor_city: location_factor_city ?? null,
    location_factor: location_factor ?? 1,
    current_replacement_value: current_replacement_value ?? null,
  })
  return { id: Number(info.lastInsertRowid) }
}

function updateBuilding(
  buildingId,
  {
    property_name,
    address,
    city,
    province,
    province_short,
    postal_code,
    gross_floor_area_m2,
    property_vintage,
    date_of_assessment,
    num_floors,
    location_factor_province,
    location_factor_city,
    location_factor,
    current_replacement_value,
  },
) {
  openDatabase()
    .prepare(
      `UPDATE building
       SET property_name = @property_name,
           address = @address,
           city = @city,
           province = @province,
           province_short = @province_short,
           postal_code = @postal_code,
           gross_floor_area_m2 = @gross_floor_area_m2,
           property_vintage = @property_vintage,
           date_of_assessment = @date_of_assessment,
           num_floors = @num_floors,
           location_factor_province = @location_factor_province,
           location_factor_city = @location_factor_city,
           location_factor = @location_factor,
           current_replacement_value = @current_replacement_value
       WHERE id = @id`,
    )
    .run({
      id: buildingId,
      property_name: property_name ?? null,
      address: address ?? null,
      city: city ?? null,
      province: province ?? null,
      province_short: province_short ?? null,
      postal_code: postal_code ?? null,
      gross_floor_area_m2: gross_floor_area_m2 ?? null,
      property_vintage: property_vintage ?? null,
      date_of_assessment: date_of_assessment ?? null,
      num_floors: num_floors ?? null,
      location_factor_province: location_factor_province ?? null,
      location_factor_city: location_factor_city ?? null,
      location_factor: location_factor ?? 1,
      current_replacement_value: current_replacement_value ?? null,
    })
  return { id: buildingId }
}

function getExecutiveSummary(buildingId) {
  return (
    openDatabase()
      .prepare(
        `SELECT building_id,
                accessibility,
                designated_substance_survey,
                architectural_structural,
                plumbing,
                mechanical,
                electrical,
                fire_life_safety,
                site,
                code_compliance,
                immediate_concerns,
                facility_overview,
                capital_needs
         FROM executive_summary
         WHERE building_id = ? AND hidden = 0
         LIMIT 1`,
      )
      .get(buildingId) ?? {
      building_id: buildingId,
      accessibility: null,
      designated_substance_survey: null,
      architectural_structural: null,
      plumbing: null,
      mechanical: null,
      electrical: null,
      fire_life_safety: null,
      site: null,
      code_compliance: null,
      immediate_concerns: null,
      facility_overview: null,
      capital_needs: null,
    }
  )
}

function updateExecutiveSummary(
  buildingId,
  {
    accessibility,
    designated_substance_survey,
    architectural_structural,
    plumbing,
    mechanical,
    electrical,
    fire_life_safety,
    site,
    code_compliance,
    immediate_concerns,
    facility_overview,
    capital_needs,
  },
) {
  const database = openDatabase()
  const save = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO executive_summary (
           building_id,
           accessibility,
           designated_substance_survey,
           architectural_structural,
           plumbing,
           mechanical,
           electrical,
           fire_life_safety,
           site,
           code_compliance,
           immediate_concerns,
           facility_overview,
           capital_needs,
           hidden
         ) VALUES (
           @building_id,
           @accessibility,
           @designated_substance_survey,
           @architectural_structural,
           @plumbing,
           @mechanical,
           @electrical,
           @fire_life_safety,
           @site,
           @code_compliance,
           @immediate_concerns,
           @facility_overview,
           @capital_needs,
           0
         )
         ON CONFLICT(building_id) DO UPDATE SET
           accessibility = excluded.accessibility,
           designated_substance_survey = excluded.designated_substance_survey,
           architectural_structural = excluded.architectural_structural,
           plumbing = excluded.plumbing,
           mechanical = excluded.mechanical,
           electrical = excluded.electrical,
           fire_life_safety = excluded.fire_life_safety,
           site = excluded.site,
           code_compliance = excluded.code_compliance,
           immediate_concerns = excluded.immediate_concerns,
           facility_overview = excluded.facility_overview,
           capital_needs = excluded.capital_needs,
           hidden = 0`,
      )
      .run({
        building_id: buildingId,
        accessibility: accessibility ?? null,
        designated_substance_survey: designated_substance_survey ?? null,
        architectural_structural: architectural_structural ?? null,
        plumbing: plumbing ?? null,
        mechanical: mechanical ?? null,
        electrical: electrical ?? null,
        fire_life_safety: fire_life_safety ?? null,
        site: site ?? null,
        code_compliance: code_compliance ?? null,
        immediate_concerns: immediate_concerns ?? null,
        facility_overview: facility_overview ?? null,
        capital_needs: capital_needs ?? null,
      })
  })
  save()
  return { building_id: buildingId }
}

function listBuildingAssets(buildingId, level1GroupName) {
  const level1Code = level1GroupName ? level1CodeFromName(level1GroupName) : null
  const whereClause = level1Code
    ? 'WHERE e.building_id = @building_id AND e.hidden = 0 AND up.level_1_code = @level_1_code'
    : 'WHERE e.building_id = @building_id AND e.hidden = 0'
  const orderBy = level1Code
    ? 'ORDER BY e.id'
    : 'ORDER BY up.level_1_code, up.level_2_code, up.level_3_code, up.level_4_code, e.id'
  return openDatabase()
    .prepare(
      `SELECT e.id,
              e.building_id,
              e.uniformat_pricing_id,
              e.asset_name,
              up.level_1_code,
              up.level_1_description,
              up.level_1_code || ' ' || up.level_1_description AS level_1_group,
              up.level_2_code,
              up.level_2_description,
              up.level_2_code || ' ' || up.level_2_description AS level_2_group_element,
              up.level_3_code,
              up.level_3_description,
              up.level_4_code,
              up.level_4_description,
              up.material,
              up.unit_price,
              up.unit_of_measure,
              up.mean_service_life,
              up.practical_life,
              e.vintage,
              e.service_life,
              e.description,
              e.recommendation,
              e.condition_rating,
              e.priority,
              e.action,
              e.term,
              e.conservation_lens,
              e.unit_measure,
              e.quantity,
              e.unit_cost_override,
              e.life_adjustment_years,
              e.allowance_interval_years,
              e.action_year,
              e.opinion_of_probable_cost,
              e.include_as_not_assessed,
              e.import_key
       FROM asset e
       JOIN uniformat_pricing up ON up.pricing_id = e.uniformat_pricing_id
       ${whereClause}
       ${orderBy}`,
    )
    .all(
      level1Code
        ? { building_id: buildingId, level_1_code: level1Code }
        : { building_id: buildingId },
    )
}

function listLocationFactors() {
  if (!locationFactorsCache) {
    locationFactorsCache = parseLocationFactorRows(readDataFileText('data/location_factors.csv'))
  }
  return locationFactorsCache
}

const ASSET_CAPITAL_PREVIEW_SELECT = `SELECT e.id,
              e.building_id,
              e.uniformat_pricing_id,
              e.asset_name,
              up.level_1_code,
              up.level_1_description,
              up.level_1_code || ' ' || up.level_1_description AS level_1_group,
              up.level_2_code,
              up.level_2_description,
              up.material,
              up.unit_price,
              up.unit_of_measure,
              up.mean_service_life,
              up.practical_life,
              e.vintage,
              e.service_life,
              e.condition_rating,
              e.priority,
              e.action,
              e.term,
              e.unit_measure,
              e.quantity,
              e.unit_cost_override,
              e.life_adjustment_years,
              e.allowance_interval_years,
              e.action_year,
              e.opinion_of_probable_cost
       FROM asset e
       JOIN uniformat_pricing up ON up.pricing_id = e.uniformat_pricing_id
       WHERE e.id = ?`

function getAssetCapitalPreviewRow(assetId) {
  return openDatabase().prepare(ASSET_CAPITAL_PREVIEW_SELECT).get(Number(assetId)) ?? null
}

function previewAssetPlan(assetId, formValues = {}) {
  const asset = getAssetCapitalPreviewRow(assetId)
  if (!asset) return null
  const building = getBuilding(asset.building_id)
  if (!building) return null

  const merged = { ...asset }
  for (const [key, value] of Object.entries(formValues ?? {})) {
    if (value === undefined) continue
    merged[key] = value === '' ? null : value
  }

  const pricingId = String(merged.uniformat_pricing_id ?? '').trim()
  if (pricingId && pricingId !== String(asset.uniformat_pricing_id ?? '')) {
    const pricing = openDatabase()
      .prepare(
        `SELECT unit_price, unit_of_measure, mean_service_life, practical_life,
                level_1_code, level_1_description,
                level_1_code || ' ' || level_1_description AS level_1_group,
                level_2_code, level_2_description, material
         FROM uniformat_pricing
         WHERE pricing_id = ?`,
      )
      .get(pricingId)
    if (pricing) Object.assign(merged, pricing)
  }

  const assets = listBuildingAssets(building.id).map((row) =>
    Number(row.id) === Number(asset.id) ? merged : row,
  )
  const capitalPlan = calculateCapitalPlan({
    assets,
    building,
    rulesPath: null,
  })
  const plan = capitalPlan.assets.find((row) => Number(row.assetId) === Number(asset.id))
  return plan
    ? {
        ...plan,
        buildingFci: capitalPlan.fci,
        buildingCrv: capitalPlan.crv,
      }
    : null
}

/**
 * Capital plan for one building, independent of any project/report context.
 * Uses the same engine as the report so AI prompt figures match the tables.
 * @param {number} buildingId
 * @returns {object|null}
 */
function getBuildingCapitalPlan(buildingId) {
  const building = getBuilding(buildingId)
  if (!building) return null
  return calculateCapitalPlan({
    assets: listBuildingAssets(buildingId),
    building,
    rulesPath: null,
  })
}

function getPropertyReportData(projectId, buildingId) {
  const project = getProject(projectId)
  const building = getBuilding(buildingId)
  if (!project || !building || Number(building.project_id) !== Number(projectId)) {
    return null
  }
  const allAssets = listBuildingAssets(buildingId)
  const imagesByAssetId = new Map(
    allAssets.map((asset) => [asset.id, listAssetImages(asset.id)]),
  )
  // Blank/unassessed assets stay out of the final report and its totals unless
  // the user opted them in as "Not Assessed". Only assessed assets drive the
  // capital plan (CRV, FCI, term totals); an opted-in blank asset appears as a
  // narrative "Not Assessed" page and contributes no cost, so no default
  // action/priority/service-life/unit-cost is shown as if it were assessed.
  const assessedAssets = []
  const includedAssets = []
  for (const asset of allAssets) {
    const images = imagesByAssetId.get(asset.id) ?? []
    const assessed = isAssetAssessed(asset, images)
    if (assessed) {
      assessedAssets.push(asset)
      includedAssets.push({ asset, images, assessed: true })
    } else if (includeAssetInReport(asset, images)) {
      includedAssets.push({ asset, images, assessed: false })
    }
  }
  const capitalPlan = calculateCapitalPlan({
    assets: assessedAssets,
    building,
    rulesPath: null,
  })
  const assetPlanById = new Map(capitalPlan.assets.map((plan) => [plan.assetId, plan]))
  const reportAssets = includedAssets.map(({ asset, images, assessed }) => ({
    ...asset,
    images,
    assessed,
    capital: assetPlanById.get(asset.id) ?? null,
  }))
  return {
    project,
    firm: getFirm(),
    building,
    buildingImages: listBuildingImages(buildingId),
    executiveSummary: getExecutiveSummary(buildingId),
    capitalPlan,
    assets: reportAssets,
    validation: validateReport({ project, building, assets: reportAssets, capitalPlan }),
  }
}

function createAsset(buildingId, level1GroupName) {
  const database = openDatabase()
  const pricing = database
    .prepare(
      `SELECT pricing_id,
              coalesce(mean_service_life, practical_life) AS service_life
       FROM uniformat_pricing
       WHERE level_1_code = ?
       ORDER BY level_2_code, level_3_code, level_4_code, material, pricing_id
       LIMIT 1`,
    )
    .get(level1CodeFromName(level1GroupName))
  if (!pricing) {
    throw new Error(`No Uniformat pricing rows found for ${level1GroupName}`)
  }

  // Vintage is deliberately NOT prefilled from the building's year built. A
  // stored vintage is indistinguishable from one the assessor entered, so
  // copying the building's year here put a fabricated construction year on
  // every asset page in the report. The asset form still *offers* the building
  // year as a placeholder, and the capital engine still falls back to it for
  // scheduling — but only a real entry is ever stored or presented as this
  // component's vintage. Requested by the client; see docs/property-report.md.
  const info = database
    .prepare(
      `INSERT INTO asset (building_id, uniformat_pricing_id, service_life)
       SELECT id, ?, ?
       FROM building
       WHERE id = ?`,
    )
    .run(pricing.pricing_id, pricing.service_life, buildingId)
  if (info.changes !== 1) {
    throw new Error(`Building ${buildingId} was not found; asset was not created.`)
  }
  return { id: Number(info.lastInsertRowid) }
}

const ASSET_EDITABLE_FIELDS = [
  'uniformat_pricing_id',
  'asset_name',
  'vintage',
  'service_life',
  'description',
  'recommendation',
  'condition_rating',
  'priority',
  'action',
  'term',
  'conservation_lens',
  'unit_measure',
  'quantity',
  'unit_cost_override',
  'life_adjustment_years',
  'allowance_interval_years',
  'action_year',
  'opinion_of_probable_cost',
  'include_as_not_assessed',
]

const ASSET_NUMERIC_FIELDS = new Set([
  'vintage',
  'service_life',
  'quantity',
  'unit_cost_override',
  'life_adjustment_years',
  'allowance_interval_years',
  'action_year',
  'opinion_of_probable_cost',
  'include_as_not_assessed',
])

/** Full asset row including soft-deleted rows (for undo snapshots). */
function getAssetRow(assetId) {
  return (
    openDatabase()
      .prepare('SELECT * FROM asset WHERE id = ?')
      .get(Number(assetId)) ?? null
  )
}

/** Uniformat Level-1 tab label for a pricing row (e.g. "A Substructure"). */
function getLevel1GroupForPricingId(pricingId) {
  const id = String(pricingId ?? '').trim()
  if (!id) return null
  const row = openDatabase()
    .prepare(
      `SELECT level_1_code || ' ' || level_1_description AS level_1_group
       FROM uniformat_pricing
       WHERE pricing_id = ?`,
    )
    .get(id)
  return row?.level_1_group ?? null
}

/** Level-1 tab label for an asset (includes soft-deleted assets). */
function getAssetLevel1GroupName(assetId) {
  const row = openDatabase()
    .prepare(
      `SELECT up.level_1_code || ' ' || up.level_1_description AS level_1_group
       FROM asset e
       JOIN uniformat_pricing up ON up.pricing_id = e.uniformat_pricing_id
       WHERE e.id = ?`,
    )
    .get(Number(assetId))
  return row?.level_1_group ?? null
}

function assetFieldsSnapshot(row) {
  if (!row) return null
  const snapshot = {}
  for (const field of ASSET_EDITABLE_FIELDS) {
    snapshot[field] = row[field] ?? null
  }
  return snapshot
}

const BUILDING_EDITABLE_FIELDS = [
  'property_name',
  'address',
  'city',
  'province',
  'province_short',
  'postal_code',
  'gross_floor_area_m2',
  'property_vintage',
  'date_of_assessment',
  'num_floors',
  'location_factor_province',
  'location_factor_city',
  'location_factor',
  'current_replacement_value',
]

const BUILDING_NUMERIC_FIELDS = new Set([
  'gross_floor_area_m2',
  'property_vintage',
  'num_floors',
  'location_factor',
  'current_replacement_value',
])

const PROJECT_EDITABLE_FIELDS = ['client']

const FIRM_EDITABLE_FIELDS = [
  'name',
  'short_name',
  'address_line_1',
  'address_line_2',
  'logo_path',
  'logo_original_name',
]

const EXECUTIVE_SUMMARY_EDITABLE_FIELDS = [
  'accessibility',
  'designated_substance_survey',
  'architectural_structural',
  'plumbing',
  'mechanical',
  'electrical',
  'fire_life_safety',
  'site',
  'code_compliance',
  'immediate_concerns',
  'facility_overview',
  'capital_needs',
]

/**
 * @param {object|null|undefined} row
 * @param {string[]} fields
 */
function fieldsSnapshot(row, fields) {
  if (!row) return null
  const snapshot = {}
  for (const field of fields) {
    snapshot[field] = row[field] ?? null
  }
  return snapshot
}

/**
 * @param {object|null|undefined} payload
 * @param {object|null|undefined} snapshot
 * @param {string[]} fields
 * @param {Set<string>} [numericFields]
 */
function payloadEqualsSnapshot(payload, snapshot, fields, numericFields) {
  if (!snapshot) return false
  for (const field of fields) {
    const next = payload?.[field] ?? null
    const prev = snapshot[field] ?? null
    if (next === prev) continue
    if (
      numericFields &&
      numericFields.has(field) &&
      next != null &&
      prev != null &&
      Number.isFinite(Number(next)) &&
      Number.isFinite(Number(prev)) &&
      Number(next) === Number(prev)
    ) {
      continue
    }
    return false
  }
  return true
}

function buildingFieldsSnapshot(row) {
  return fieldsSnapshot(row, BUILDING_EDITABLE_FIELDS)
}

function buildingPayloadEqualsSnapshot(payload, snapshot) {
  return payloadEqualsSnapshot(
    payload,
    snapshot,
    BUILDING_EDITABLE_FIELDS,
    BUILDING_NUMERIC_FIELDS,
  )
}

function projectFieldsSnapshot(row) {
  return fieldsSnapshot(row, PROJECT_EDITABLE_FIELDS)
}

function projectPayloadEqualsSnapshot(payload, snapshot) {
  return payloadEqualsSnapshot(payload, snapshot, PROJECT_EDITABLE_FIELDS)
}

function firmFieldsSnapshot(row) {
  return fieldsSnapshot(row, FIRM_EDITABLE_FIELDS)
}

function firmPayloadEqualsSnapshot(payload, snapshot) {
  return payloadEqualsSnapshot(payload, snapshot, FIRM_EDITABLE_FIELDS)
}

function executiveSummaryFieldsSnapshot(row) {
  return fieldsSnapshot(row, EXECUTIVE_SUMMARY_EDITABLE_FIELDS)
}

function executiveSummaryPayloadEqualsSnapshot(payload, snapshot) {
  return payloadEqualsSnapshot(
    payload,
    snapshot,
    EXECUTIVE_SUMMARY_EDITABLE_FIELDS,
  )
}

/**
 * Blank executive-summary sections across visible buildings.
 * Buildings without a summary row are treated as all-blank.
 * @returns {Array<{ buildingId: number, field: string }>}
 */
function listBlankExecutiveSummaryFields() {
  const database = openDatabase()
  const buildings = database
    .prepare('SELECT id FROM building WHERE hidden = 0 ORDER BY id')
    .all()
  const blanks = []
  for (const row of buildings) {
    const buildingId = Number(row.id)
    const summary = getExecutiveSummary(buildingId)
    for (const field of EXECUTIVE_SUMMARY_EDITABLE_FIELDS) {
      const value = summary?.[field]
      if (value == null || String(value).trim() === '') {
        blanks.push({ buildingId, field })
      }
    }
  }
  return blanks
}

/**
 * Set one executive-summary field without clearing the others.
 * @param {number} buildingId
 * @param {string} field
 * @param {string|null} text
 */
function updateExecutiveSummaryField(buildingId, field, text) {
  if (!EXECUTIVE_SUMMARY_EDITABLE_FIELDS.includes(field)) {
    throw new Error(`Unknown executive summary field: ${field}`)
  }
  const current = getExecutiveSummary(Number(buildingId))
  const payload = executiveSummaryFieldsSnapshot(current) || {}
  for (const key of EXECUTIVE_SUMMARY_EDITABLE_FIELDS) {
    if (!(key in payload)) payload[key] = null
  }
  payload[field] = text == null || text === '' ? null : String(text)
  return updateExecutiveSummary(Number(buildingId), payload)
}

function assetPayloadEqualsSnapshot(payload, snapshot) {
  if (!snapshot) return false
  for (const field of ASSET_EDITABLE_FIELDS) {
    const next = payload?.[field] ?? null
    const prev = snapshot[field] ?? null
    if (next === prev) continue
    if (
      ASSET_NUMERIC_FIELDS.has(field) &&
      next != null &&
      prev != null &&
      Number.isFinite(Number(next)) &&
      Number.isFinite(Number(prev)) &&
      Number(next) === Number(prev)
    ) {
      continue
    }
    return false
  }
  return true
}

function updateAsset(
  assetId,
  {
    uniformat_pricing_id,
    asset_name,
    vintage,
    service_life,
    description,
    recommendation,
    condition_rating,
    priority,
    action,
    term,
    conservation_lens,
    unit_measure,
    quantity,
    unit_cost_override,
    life_adjustment_years,
    allowance_interval_years,
    action_year,
    opinion_of_probable_cost,
    include_as_not_assessed,
  },
) {
  openDatabase()
    .prepare(
      `UPDATE asset
       SET uniformat_pricing_id = @uniformat_pricing_id,
           asset_name = @asset_name,
           vintage = @vintage,
           service_life = @service_life,
           description = @description,
           recommendation = @recommendation,
           condition_rating = @condition_rating,
           priority = @priority,
           action = @action,
           term = @term,
           conservation_lens = @conservation_lens,
           unit_measure = @unit_measure,
           quantity = @quantity,
           unit_cost_override = @unit_cost_override,
           life_adjustment_years = @life_adjustment_years,
           allowance_interval_years = @allowance_interval_years,
           action_year = @action_year,
           opinion_of_probable_cost = @opinion_of_probable_cost,
           include_as_not_assessed = @include_as_not_assessed
       WHERE id = @id`,
    )
    .run({
      id: assetId,
      uniformat_pricing_id: uniformat_pricing_id ?? null,
      asset_name: asset_name ?? null,
      vintage: vintage ?? null,
      service_life: service_life ?? null,
      description: description ?? null,
      recommendation: recommendation ?? null,
      condition_rating: condition_rating ?? null,
      priority: priority ?? null,
      action: action ?? null,
      term: term ?? null,
      conservation_lens: conservation_lens ?? null,
      unit_measure: unit_measure ?? null,
      quantity: quantity ?? null,
      unit_cost_override: unit_cost_override ?? null,
      life_adjustment_years: life_adjustment_years ?? 0,
      allowance_interval_years: allowance_interval_years ?? null,
      action_year: action_year ?? null,
      opinion_of_probable_cost: opinion_of_probable_cost ?? null,
      include_as_not_assessed: Number(include_as_not_assessed) === 1 ? 1 : 0,
    })
  return { id: assetId }
}

function getVisibleAssetImageIds(assetId) {
  return openDatabase()
    .prepare('SELECT id FROM asset_image WHERE asset_id = ? AND hidden = 0')
    .all(Number(assetId))
    .map((row) => Number(row.id))
}

function getAssetImageRow(imageId) {
  return withMediaUrl(
    openDatabase()
      .prepare('SELECT * FROM asset_image WHERE id = ?')
      .get(Number(imageId)) ?? null,
  )
}

function getBuildingImageRow(imageId) {
  return withMediaUrl(
    openDatabase()
      .prepare('SELECT * FROM building_image WHERE id = ?')
      .get(Number(imageId)) ?? null,
  )
}

/**
 * Capture ids that are currently visible so a soft-delete can be undone
 * without re-showing rows that were already hidden. `includeHidden` is only
 * for restoring projects deleted by versions before recovery snapshots were
 * persisted; it deliberately captures every stored descendant as a fallback.
 */
function captureBuildingDeleteSnapshot(buildingId, { includeHidden = false } = {}) {
  const id = Number(buildingId)
  const database = openDatabase()
  const building = database.prepare('SELECT * FROM building WHERE id = ?').get(id)
  if (!building || (!includeHidden && Number(building.hidden) === 1)) return null

  const visibleOnly = includeHidden ? '' : ' AND hidden = 0'

  const assetIds = database
    .prepare(`SELECT id FROM asset WHERE building_id = ?${visibleOnly}`)
    .all(id)
    .map((row) => Number(row.id))
  const assetImageIds =
    assetIds.length === 0
      ? []
      : database
          .prepare(
            `SELECT id FROM asset_image
             WHERE asset_id IN (${assetIds.map(() => '?').join(',')})${visibleOnly}`,
          )
          .all(...assetIds)
          .map((row) => Number(row.id))
  const buildingImageIds = database
    .prepare(`SELECT id FROM building_image WHERE building_id = ?${visibleOnly}`)
    .all(id)
    .map((row) => Number(row.id))
  const executiveSummaryVisible = Boolean(
    database
      .prepare(
        `SELECT 1 AS ok FROM executive_summary WHERE building_id = ?${visibleOnly}`,
      )
      .get(id),
  )

  return {
    buildingId: id,
    projectId: Number(building.project_id),
    propertyName: building.property_name ?? null,
    assetIds,
    assetImageIds,
    buildingImageIds,
    executiveSummaryVisible,
  }
}

function captureProjectDeleteSnapshot(projectId, { includeHidden = false } = {}) {
  const id = Number(projectId)
  const database = openDatabase()
  const project = database.prepare('SELECT * FROM project WHERE id = ?').get(id)
  if (!project || (!includeHidden && Number(project.hidden) === 1)) return null

  const visibleOnly = includeHidden ? '' : ' AND hidden = 0'

  const buildingIds = database
    .prepare(`SELECT id FROM building WHERE project_id = ?${visibleOnly}`)
    .all(id)
    .map((row) => Number(row.id))
  const buildings = buildingIds
    .map((buildingId) => captureBuildingDeleteSnapshot(buildingId, { includeHidden }))
    .filter(Boolean)

  return {
    projectId: id,
    client: project.client ?? null,
    buildings,
  }
}

function readProjectDeletionSnapshot(value, projectId) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const snapshot = JSON.parse(value)
    if (
      !snapshot ||
      Number(snapshot.projectId) !== Number(projectId) ||
      !Array.isArray(snapshot.buildings)
    ) {
      return null
    }
    return snapshot
  } catch {
    return null
  }
}

function restoreAssetVisibility(assetId, imageIds = []) {
  const id = Number(assetId)
  const database = openDatabase()
  database.transaction(() => {
    database.prepare('UPDATE asset SET hidden = 0 WHERE id = ?').run(id)
    const restoreImage = database.prepare(
      'UPDATE asset_image SET hidden = 0 WHERE id = ?',
    )
    for (const imageId of imageIds) {
      restoreImage.run(Number(imageId))
    }
  })()
}

function restoreImageVisibility(table, imageId) {
  if (table !== 'asset_image' && table !== 'building_image') {
    throw new Error(`Unsupported image table: ${table}`)
  }
  openDatabase()
    .prepare(`UPDATE ${table} SET hidden = 0 WHERE id = ?`)
    .run(Number(imageId))
}

function restoreBuildingDeleteSnapshot(snapshot) {
  if (!snapshot?.buildingId) return
  const database = openDatabase()
  database.transaction(() => {
    database
      .prepare('UPDATE building SET hidden = 0 WHERE id = ?')
      .run(snapshot.buildingId)
    if (snapshot.executiveSummaryVisible) {
      database
        .prepare(
          'UPDATE executive_summary SET hidden = 0 WHERE building_id = ?',
        )
        .run(snapshot.buildingId)
    }
    const restoreBuildingImage = database.prepare(
      'UPDATE building_image SET hidden = 0 WHERE id = ?',
    )
    for (const imageId of snapshot.buildingImageIds ?? []) {
      restoreBuildingImage.run(Number(imageId))
    }
    const restoreAsset = database.prepare('UPDATE asset SET hidden = 0 WHERE id = ?')
    for (const assetId of snapshot.assetIds ?? []) {
      restoreAsset.run(Number(assetId))
    }
    const restoreAssetImage = database.prepare(
      'UPDATE asset_image SET hidden = 0 WHERE id = ?',
    )
    for (const imageId of snapshot.assetImageIds ?? []) {
      restoreAssetImage.run(Number(imageId))
    }
  })()
}

/** Restore one project snapshot inside its caller's transaction. */
function restoreProjectDeleteSnapshotInTransaction(database, snapshot) {
  const projectId = Number(snapshot?.projectId)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return false

  database
    .prepare('UPDATE project SET hidden = 0, deletion_snapshot = NULL WHERE id = ?')
    .run(projectId)

  const restoreBuilding = database.prepare(
    'UPDATE building SET hidden = 0 WHERE id = ? AND project_id = ?',
  )
  const restoreSummary = database.prepare(
    'UPDATE executive_summary SET hidden = 0 WHERE building_id = ?',
  )
  const restoreBuildingImage = database.prepare(
    'UPDATE building_image SET hidden = 0 WHERE id = ? AND building_id = ?',
  )
  const restoreAsset = database.prepare(
    'UPDATE asset SET hidden = 0 WHERE id = ? AND building_id = ?',
  )
  const restoreAssetImage = database.prepare(
    `UPDATE asset_image
     SET hidden = 0
     WHERE id = ?
       AND asset_id IN (SELECT id FROM asset WHERE building_id = ?)`,
  )

  for (const buildingSnapshot of snapshot.buildings ?? []) {
    const buildingId = Number(buildingSnapshot?.buildingId)
    if (!Number.isSafeInteger(buildingId) || buildingId <= 0) continue

    // Nested transactions are avoided: all restoration uses this connection.
    restoreBuilding.run(buildingId, projectId)
    if (buildingSnapshot.executiveSummaryVisible) {
      restoreSummary.run(buildingId)
    }
    for (const imageId of buildingSnapshot.buildingImageIds ?? []) {
      restoreBuildingImage.run(Number(imageId), buildingId)
    }
    for (const assetId of buildingSnapshot.assetIds ?? []) {
      restoreAsset.run(Number(assetId), buildingId)
    }
    for (const imageId of buildingSnapshot.assetImageIds ?? []) {
      restoreAssetImage.run(Number(imageId), buildingId)
    }
  }
  return true
}

function restoreProjectDeleteSnapshot(snapshot) {
  if (!snapshot?.projectId) return false
  const database = openDatabase()
  let restored = false
  database.transaction(() => {
    restored = restoreProjectDeleteSnapshotInTransaction(database, snapshot)
  })()
  return restored
}

/**
 * Restore a soft-deleted project from the durable snapshot Settings lists.
 * Projects deleted before schema v8 did not have one, so their fallback
 * captures every stored descendant once and makes that old deletion recoverable.
 */
function restoreDeletedProject(projectId) {
  const id = Number(projectId)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const database = openDatabase()
  const project = database
    .prepare(
      `SELECT id, client, deletion_snapshot
       FROM project
       WHERE id = ? AND hidden = 1`,
    )
    .get(id)
  if (!project) return null

  const snapshot =
    readProjectDeletionSnapshot(project.deletion_snapshot, id) ??
    captureProjectDeleteSnapshot(id, { includeHidden: true })
  if (!snapshot) return null

  database.transaction(() => {
    restoreProjectDeleteSnapshotInTransaction(database, snapshot)
  })()

  return {
    id,
    client: project.client ?? null,
    snapshot,
  }
}

function restoreExecutiveSummaryVisibility(buildingId) {
  openDatabase()
    .prepare(
      'UPDATE executive_summary SET hidden = 0 WHERE building_id = ?',
    )
    .run(Number(buildingId))
}

function getExecutiveSummaryRow(buildingId) {
  return (
    openDatabase()
      .prepare('SELECT * FROM executive_summary WHERE building_id = ?')
      .get(Number(buildingId)) ?? null
  )
}

function listImages(table, ownerColumn, ownerId) {
  const includeColumn =
    table === 'asset_image' ? ',\n              include_in_report' : ''
  const rows = openDatabase()
    .prepare(
      `SELECT id,
              ${ownerColumn},
              file_path,
              original_name,
              caption,
              bounding_boxes,
              sort_order,
              created_at${includeColumn}
       FROM ${table}
       WHERE ${ownerColumn} = ? AND hidden = 0
       ORDER BY sort_order, id`,
    )
    .all(ownerId)
  return rows.map((row) => ({
    ...row,
    bounding_boxes: parseAnnotationsJson(row.bounding_boxes),
    media_url: mediaUrlFor(row.file_path),
  }))
}

function createImageRow(
  table,
  ownerColumn,
  { ownerId, file_path, original_name, caption, sort_order, include_in_report },
) {
  const isAssetImage = table === 'asset_image'
  const columns = [
    ownerColumn,
    'file_path',
    'original_name',
    'caption',
    'sort_order',
  ]
  const values = {
    ownerId,
    file_path,
    original_name: original_name ?? null,
    caption: caption ?? null,
    sort_order: sort_order ?? 0,
  }
  if (isAssetImage) {
    columns.push('include_in_report')
    values.include_in_report =
      include_in_report == null ? 1 : include_in_report ? 1 : 0
  }
  const placeholders = columns
    .map((column) => (column === ownerColumn ? '@ownerId' : `@${column}`))
    .join(',\n         ')
  const info = openDatabase()
    .prepare(
      `INSERT INTO ${table} (
         ${columns.join(',\n         ')}
       ) VALUES (
         ${placeholders}
       )`,
    )
    .run(values)
  return { id: Number(info.lastInsertRowid) }
}

function listBuildingImages(buildingId) {
  return listImages('building_image', 'building_id', buildingId)
}

function createBuildingImage({ building_id, ...rest }) {
  return createImageRow('building_image', 'building_id', { ownerId: building_id, ...rest })
}

function listAssetImages(assetId) {
  return listImages('asset_image', 'asset_id', assetId)
}

function createAssetImage({ asset_id, include_in_report, ...rest }) {
  let includeFlag = include_in_report
  if (includeFlag == null) {
    const existingCount = listAssetImages(asset_id).length
    includeFlag = existingCount < DEFAULT_ASSET_IMAGES_IN_REPORT ? 1 : 0
  }
  return createImageRow('asset_image', 'asset_id', {
    ownerId: asset_id,
    include_in_report: includeFlag,
    ...rest,
  })
}

/**
 * Toggle whether an asset photo appears in the exported property report.
 * @param {number} imageId
 * @param {boolean|number} includeInReport
 */
function updateAssetImageIncludeInReport(imageId, includeInReport) {
  const flag = includeInReport ? 1 : 0
  openDatabase()
    .prepare('UPDATE asset_image SET include_in_report = @flag WHERE id = @id')
    .run({ id: Number(imageId), flag })
  return { id: Number(imageId), include_in_report: flag }
}

function getImageRowByKind(kind, imageId) {
  const table = kind === 'building' ? 'building_image' : 'asset_image'
  return withMediaUrl(
    openDatabase()
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(Number(imageId)) ?? null,
  )
}

/**
 * Visible images with empty captions across the open database
 * (property + asset photos whose parent building/asset is not hidden).
 * @returns {{ building: object[], asset: object[] }}
 */
function listImagesNeedingCaptions() {
  const database = openDatabase()
  const building = database
    .prepare(
      `SELECT bi.id,
              bi.building_id,
              bi.file_path,
              bi.original_name,
              bi.caption
       FROM building_image bi
       INNER JOIN building b ON b.id = bi.building_id
       WHERE bi.hidden = 0
         AND b.hidden = 0
         AND (bi.caption IS NULL OR trim(bi.caption) = '')
       ORDER BY bi.building_id, bi.sort_order, bi.id`,
    )
    .all()
  const asset = database
    .prepare(
      `SELECT ai.id,
              ai.asset_id,
              ai.file_path,
              ai.original_name,
              ai.caption,
              a.building_id
       FROM asset_image ai
       INNER JOIN asset a ON a.id = ai.asset_id
       INNER JOIN building b ON b.id = a.building_id
       WHERE ai.hidden = 0
         AND a.hidden = 0
         AND b.hidden = 0
         AND (ai.caption IS NULL OR trim(ai.caption) = '')
       ORDER BY a.building_id, ai.asset_id, ai.sort_order, ai.id`,
    )
    .all()
  return { building, asset }
}

/**
 * @param {'asset'|'building'} kind
 * @param {number} imageId
 * @param {string|null} caption
 */
function updateImageCaption(kind, imageId, caption) {
  const table = kind === 'building' ? 'building_image' : 'asset_image'
  openDatabase()
    .prepare(`UPDATE ${table} SET caption = @caption WHERE id = @id`)
    .run({
      id: Number(imageId),
      caption: caption == null || caption === '' ? null : String(caption),
    })
  return { id: Number(imageId), caption: caption ?? null }
}

/**
 * Replace photo annotations (boxes + arrows) for one image.
 * @param {'asset'|'building'} kind
 * @param {number} imageId
 * @param {object[]|null} boxes
 */
function updateImageBoundingBoxes(kind, imageId, boxes) {
  const table = kind === 'building' ? 'building_image' : 'asset_image'
  const sanitized = Array.isArray(boxes)
    ? sanitizeAnnotations(boxes)
    : parseAnnotationsJson(boxes)
  openDatabase()
    .prepare(`UPDATE ${table} SET bounding_boxes = @boxes WHERE id = @id`)
    .run({
      id: Number(imageId),
      boxes: sanitized.length ? JSON.stringify(sanitized) : null,
    })
  return { id: Number(imageId), bounding_boxes: sanitized }
}

function deleteImageRow(table, imageId) {
  openDatabase().prepare(`UPDATE ${table} SET hidden = 1 WHERE id = ?`).run(imageId)
}

function deleteBuildingImage(imageId) {
  deleteImageRow('building_image', Number(imageId))
}

function deleteAssetImage(imageId) {
  deleteImageRow('asset_image', Number(imageId))
}

function softHideBuilding(database, buildingId) {
  database
    .prepare(
      'UPDATE asset_image SET hidden = 1 WHERE asset_id IN (SELECT id FROM asset WHERE building_id = ?)',
    )
    .run(buildingId)
  database.prepare('UPDATE building_image SET hidden = 1 WHERE building_id = ?').run(buildingId)
  database.prepare('UPDATE asset SET hidden = 1 WHERE building_id = ?').run(buildingId)
  database.prepare('UPDATE executive_summary SET hidden = 1 WHERE building_id = ?').run(buildingId)
  database.prepare('UPDATE building SET hidden = 1 WHERE id = ?').run(buildingId)
}

function deleteAsset(assetId) {
  const id = Number(assetId)
  const database = openDatabase()
  database.transaction(() => {
    database.prepare('UPDATE asset_image SET hidden = 1 WHERE asset_id = ?').run(id)
    database.prepare('UPDATE asset SET hidden = 1 WHERE id = ?').run(id)
  })()
}

function deleteBuilding(buildingId) {
  const id = Number(buildingId)
  const database = openDatabase()
  database.transaction(() => {
    softHideBuilding(database, id)
  })()
}

function deleteProject(projectId) {
  const id = Number(projectId)
  const database = openDatabase()
  const recoverySnapshot = captureProjectDeleteSnapshot(id)
  if (!recoverySnapshot) return null

  database.transaction(() => {
    for (const building of recoverySnapshot.buildings ?? []) {
      const buildingId = Number(building?.buildingId)
      if (!Number.isSafeInteger(buildingId) || buildingId <= 0) continue
      softHideBuilding(database, buildingId)
    }
    database
      .prepare('UPDATE project SET hidden = 1, deletion_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(recoverySnapshot), id)
  })()
  return recoverySnapshot
}

function deleteExecutiveSummary(buildingId) {
  openDatabase()
    .prepare('UPDATE executive_summary SET hidden = 1 WHERE building_id = ?')
    .run(Number(buildingId))
}

function removeFirmLogo() {
  const firm = getFirm()
  const logoPath = firm?.logo_path ?? null
  openDatabase()
    .prepare(
      `UPDATE firm SET logo_path = NULL, logo_original_name = NULL WHERE id = 1`,
    )
    .run()
  return logoPath
}

module.exports = {
  SCHEMA_VERSION,
  IncompatibleDatabaseError,
  DatabaseMigrationRequiredError,
  DatabaseRestoreFailedError,
  getDbPath,
  closeDatabase,
  backupDatabaseTo,
  backupAndResetDatabase,
  migrateDatabaseWithBackup,
  readDatabaseVersion,
  inspectDatabase,
  pendingMigrations,
  runMigrations,
  initializeDatabase,
  openDatabase,
  ensureDatabaseCurrent,
  readSchemaSql,
  describeSchemaIncompatibility,
  seedUniformatPricing,
  seedUniformatPricingRecords,
  listUniformatLevel1Groups,
  listUniformatLevel2Groups,
  listUniformatLevel3Groups,
  listUniformatLevel4Groups,
  listUniformatPricingItems,
  listProjects,
  listDeletedProjects,
  getProject,
  getFirm,
  updateFirm,
  createProject,
  updateProject,
  deleteProject,
  listBuildings,
  getBuilding,
  createBuilding,
  updateBuilding,
  deleteBuilding,
  getExecutiveSummary,
  updateExecutiveSummary,
  updateExecutiveSummaryField,
  listBlankExecutiveSummaryFields,
  deleteExecutiveSummary,
  listBuildingImages,
  createBuildingImage,
  deleteBuildingImage,
  listBuildingAssets,
  listLocationFactors,
  previewAssetPlan,
  getBuildingCapitalPlan,
  getPropertyReportData,
  createAsset,
  updateAsset,
  deleteAsset,
  listAssetImages,
  createAssetImage,
  deleteAssetImage,
  getImageRowByKind,
  listImagesNeedingCaptions,
  updateImageCaption,
  updateImageBoundingBoxes,
  updateAssetImageIncludeInReport,
  removeFirmLogo,
  getAssetRow,
  getLevel1GroupForPricingId,
  getAssetLevel1GroupName,
  assetFieldsSnapshot,
  assetPayloadEqualsSnapshot,
  buildingFieldsSnapshot,
  buildingPayloadEqualsSnapshot,
  projectFieldsSnapshot,
  projectPayloadEqualsSnapshot,
  firmFieldsSnapshot,
  firmPayloadEqualsSnapshot,
  executiveSummaryFieldsSnapshot,
  executiveSummaryPayloadEqualsSnapshot,
  BUILDING_EDITABLE_FIELDS,
  PROJECT_EDITABLE_FIELDS,
  FIRM_EDITABLE_FIELDS,
  EXECUTIVE_SUMMARY_EDITABLE_FIELDS,
  getVisibleAssetImageIds,
  getAssetImageRow,
  getBuildingImageRow,
  captureBuildingDeleteSnapshot,
  captureProjectDeleteSnapshot,
  restoreDeletedProject,
  restoreAssetVisibility,
  restoreImageVisibility,
  restoreBuildingDeleteSnapshot,
  restoreProjectDeleteSnapshot,
  restoreExecutiveSummaryVisibility,
  getExecutiveSummaryRow,
  ASSET_EDITABLE_FIELDS,
}
