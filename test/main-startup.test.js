const assert = require('node:assert/strict')
const test = require('node:test')

const {
  promptForMigration,
  promptForReset,
  openDatabaseWithRecovery,
} = require('../src/main/startup')

// Stand-ins for the error classes db.js exports; startup.js only uses them for
// instanceof routing, so shape does not matter.
class DatabaseMigrationRequiredError extends Error {}
class IncompatibleDatabaseError extends Error {}
class DatabaseRestoreFailedError extends Error {}

const silentLog = { log() {}, error() {}, warn() {} }

/** A db stub carrying the error classes and recording which recovery ran. */
function makeDb(overrides = {}) {
  return {
    DatabaseMigrationRequiredError,
    IncompatibleDatabaseError,
    DatabaseRestoreFailedError,
    getDbPath: () => '/data/app.db',
    migrateDatabaseWithBackup: () => ({ fromVersion: 7, toVersion: 9, backupPath: '/data/app.db.bak' }),
    backupAndResetDatabase: () => ({ backupPath: '/data/app.db.bak' }),
    openDatabase: () => {},
    ...overrides,
  }
}

/** A dialog stub that returns a scripted showMessageBoxSync response. */
function makeDialog(response) {
  const calls = { messageBoxSync: [], info: [], error: [] }
  return {
    calls,
    showMessageBoxSync(opts) {
      calls.messageBoxSync.push(opts)
      // Info confirmations (single OK button) always resolve to 0.
      if (opts.buttons && opts.buttons.length === 1) return 0
      return response
    },
    showErrorBox(title, body) {
      calls.error.push({ title, body })
    },
  }
}

const migrationError = Object.assign(new DatabaseMigrationRequiredError('needs upgrade'), {
  fromVersion: 7,
  toVersion: 9,
  changes: ['Adds a column'],
})

test('approving a migration runs it and continues startup', () => {
  let migrated = 0
  const db = makeDb({ migrateDatabaseWithBackup: () => { migrated += 1; return { fromVersion: 7, toVersion: 9, backupPath: '/b' } } })
  const dialog = makeDialog(0) // "Update Data File"
  const cont = promptForMigration({ error: migrationError, db, dialog, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog })
  assert.equal(cont, true)
  assert.equal(migrated, 1)
})

test('declining a migration stops startup and never touches the database', () => {
  let migrated = 0
  const db = makeDb({ migrateDatabaseWithBackup: () => { migrated += 1 } })
  const dialog = makeDialog(1) // "Quit"
  const cont = promptForMigration({ error: migrationError, db, dialog, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog })
  assert.equal(cont, false)
  assert.equal(migrated, 0)
})

test('a failed migration that also failed to roll back tells the user NOT to delete the backup', () => {
  const db = makeDb({
    migrateDatabaseWithBackup: () => { throw new DatabaseRestoreFailedError('rollback failed') },
  })
  const dialog = makeDialog(0)
  const cont = promptForMigration({ error: migrationError, db, dialog, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog })
  assert.equal(cont, false)
  assert.equal(dialog.calls.error.length, 1)
  assert.match(dialog.calls.error[0].body, /Do not delete the backup/)
})

test('an ordinary migration failure reassures that the original is unchanged', () => {
  const db = makeDb({
    migrateDatabaseWithBackup: () => { throw new Error('disk full') },
  })
  const dialog = makeDialog(0)
  const cont = promptForMigration({ error: migrationError, db, dialog, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog })
  assert.equal(cont, false)
  assert.match(dialog.calls.error[0].body, /left unchanged/)
  assert.doesNotMatch(dialog.calls.error[0].body, /Do not delete the backup/)
})

test('smoke mode refuses migration without a dialog unless RESET_DB is set', () => {
  const db = makeDb()
  const dialog = makeDialog(0)
  // Non-interactive and not opted in: stop, do not prompt.
  assert.equal(
    promptForMigration({ error: migrationError, db, dialog, isSmokeTest: true, autoResetIncompatibleDb: false, log: silentLog }),
    false,
  )
  assert.equal(dialog.calls.messageBoxSync.length, 0)

  // Opted in: migrate non-interactively.
  let migrated = 0
  const db2 = makeDb({ migrateDatabaseWithBackup: () => { migrated += 1; return { fromVersion: 7, toVersion: 9, backupPath: '/b' } } })
  assert.equal(
    promptForMigration({ error: migrationError, db: db2, dialog, isSmokeTest: true, autoResetIncompatibleDb: true, log: silentLog }),
    true,
  )
  assert.equal(migrated, 1)
})

const incompatibleError = new IncompatibleDatabaseError('unknown schema')

test('reset: "Start a New Data File" backs up and continues', () => {
  let reset = 0
  const db = makeDb({ backupAndResetDatabase: () => { reset += 1; return { backupPath: '/b' } } })
  const dialog = makeDialog(0)
  const shell = { showItemInFolder() {} }
  assert.equal(
    promptForReset({ error: incompatibleError, db, dialog, shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    true,
  )
  assert.equal(reset, 1)
})

test('reset: "Show Data Folder" opens the folder and stops', () => {
  let shown = 0
  let reset = 0
  const db = makeDb({ backupAndResetDatabase: () => { reset += 1; return { backupPath: '/b' } } })
  const dialog = makeDialog(1) // "Show Data Folder"
  const shell = { showItemInFolder: () => { shown += 1 } }
  assert.equal(
    promptForReset({ error: incompatibleError, db, dialog, shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    false,
  )
  assert.equal(shown, 1)
  assert.equal(reset, 0)
})

test('openDatabaseWithRecovery routes each error class to its prompt', () => {
  const shell = { showItemInFolder() {} }

  // Clean open -> continue, no prompt.
  assert.equal(
    openDatabaseWithRecovery({ db: makeDb(), dialog: makeDialog(0), shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    true,
  )

  // Migration required -> migrate path (dialog approves).
  let migrated = 0
  const migDb = makeDb({
    openDatabase: () => { throw migrationError },
    migrateDatabaseWithBackup: () => { migrated += 1; return { fromVersion: 7, toVersion: 9, backupPath: '/b' } },
  })
  assert.equal(
    openDatabaseWithRecovery({ db: migDb, dialog: makeDialog(0), shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    true,
  )
  assert.equal(migrated, 1)

  // Incompatible -> reset path (dialog quits -> stop).
  const resetDb = makeDb({ openDatabase: () => { throw incompatibleError } })
  assert.equal(
    openDatabaseWithRecovery({ db: resetDb, dialog: makeDialog(2), shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    false,
  )

  // Any other error is a real fault -> rethrow.
  const boomDb = makeDb({ openDatabase: () => { throw new Error('boom') } })
  assert.throws(
    () => openDatabaseWithRecovery({ db: boomDb, dialog: makeDialog(0), shell, isSmokeTest: false, autoResetIncompatibleDb: false, log: silentLog }),
    /boom/,
  )
})
