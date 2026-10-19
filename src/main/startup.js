// Database startup recovery: opening the database and, when the file on disk was
// written by a different release, driving the migrate-or-reset conversation with
// the user. Dependency-injected (db, dialog, shell) so the branches — including
// the load-bearing "do not delete the backup" wording — can be tested with
// stubs, never a live database or a real dialog.

/**
 * Ask before upgrading a database written by an older release.
 *
 * Migrations are never silent: the user is told what will change and the
 * previous file is always kept beside the upgraded one.
 *
 * @returns {boolean} whether startup should continue
 */
function promptForMigration({ error, db, dialog, isSmokeTest, autoResetIncompatibleDb, log = console }) {
  const dbPath = db.getDbPath()

  // Non-interactive runs (smoke tests, CI) must never block on a dialog.
  if (isSmokeTest || autoResetIncompatibleDb) {
    if (!autoResetIncompatibleDb) {
      log.error(`Database at ${dbPath} needs migration: ${error.message}`)
      log.error('Re-run with CONDITION_ASSESSMENT_RESET_DB=1 to migrate it.')
      return false
    }
    const result = db.migrateDatabaseWithBackup()
    log.log(
      `Migrated database from schema version ${result.fromVersion} to ` +
        `${result.toVersion}; previous file kept at ${result.backupPath}`,
    )
    return true
  }

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Update your data file?',
    message: 'Your data file was created by an earlier version of this app.',
    detail:
      `It needs a one-time update before it can be opened ` +
      `(schema version ${error.fromVersion} → ${error.toVersion}).\n\n` +
      `${error.changes.join('\n\n')}\n\n` +
      'Your existing file will be copied to a backup beside it first, so nothing ' +
      `is lost.\n\nData file: ${dbPath}`,
    buttons: ['Update Data File', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice !== 0) return false

  try {
    const result = db.migrateDatabaseWithBackup()
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Data file updated',
      message: `Your data file was updated to schema version ${result.toVersion}.`,
      detail: `A copy of the previous file was kept at:\n${result.backupPath}`,
      buttons: ['OK'],
      noLink: true,
    })
    return true
  } catch (migrationError) {
    // Only say the original survived when it actually did. A failed migration
    // rolls the live file back, but if that rollback *also* failed the live file
    // may be unusable and the backup is the only good copy left — telling the
    // user "nothing changed" there would talk them out of the one thing that
    // recovers their data.
    const restoreFailed = migrationError instanceof db.DatabaseRestoreFailedError
    dialog.showErrorBox(
      'Could not update your data file',
      `${migrationError?.message ?? migrationError}\n\n` +
        (restoreFailed
          ? 'Your data file may be unusable. Do not delete the backup file ' +
            'named above — it is now the only complete copy of your data. ' +
            'Contact support before making any further changes.'
          : 'Your original data file was left unchanged.'),
    )
    return false
  }
}

/**
 * Last resort for database shapes with no migration path: keep the old file and
 * start from an empty one. Always the user's choice.
 *
 * @returns {boolean} whether startup should continue
 */
function promptForReset({ error, db, dialog, shell, isSmokeTest, autoResetIncompatibleDb, log = console }) {
  const dbPath = db.getDbPath()

  if (isSmokeTest || autoResetIncompatibleDb) {
    if (!autoResetIncompatibleDb) {
      log.error(`Cannot open database at ${dbPath}: ${error.message}`)
      return false
    }
    const { backupPath } = db.backupAndResetDatabase()
    log.log(`Started a new database; previous file kept at ${backupPath}`)
    return true
  }

  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Cannot open your data file',
    message: 'Your data file cannot be opened by this version of the app.',
    detail:
      `${error.message}\n\nData file: ${dbPath}\n\n` +
      '“Start a New Data File” keeps the existing file (renamed with a .bak ' +
      'suffix) and starts with an empty database.',
    buttons: ['Start a New Data File', 'Show Data Folder', 'Quit'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  })

  if (choice === 1) {
    shell.showItemInFolder(dbPath)
    return false
  }
  if (choice !== 0) return false

  try {
    const { backupPath } = db.backupAndResetDatabase()
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'New data file created',
      message: 'Started with a new, empty data file.',
      detail: backupPath
        ? `Your previous file was kept at:\n${backupPath}`
        : 'No previous file was found.',
      buttons: ['OK'],
      noLink: true,
    })
    return true
  } catch (resetError) {
    dialog.showErrorBox(
      'Could not create a new data file',
      String(resetError?.message ?? resetError),
    )
    return false
  }
}

/**
 * Open the database, recovering interactively when the file on disk was written
 * by a different release.
 *
 * @returns {boolean} whether startup should continue
 */
function openDatabaseWithRecovery({ db, dialog, shell, isSmokeTest, autoResetIncompatibleDb, log = console }) {
  try {
    db.openDatabase()
    return true
  } catch (error) {
    if (error instanceof db.DatabaseMigrationRequiredError) {
      return promptForMigration({ error, db, dialog, isSmokeTest, autoResetIncompatibleDb, log })
    }
    if (error instanceof db.IncompatibleDatabaseError) {
      return promptForReset({ error, db, dialog, shell, isSmokeTest, autoResetIncompatibleDb, log })
    }
    throw error
  }
}

module.exports = {
  promptForMigration,
  promptForReset,
  openDatabaseWithRecovery,
}
