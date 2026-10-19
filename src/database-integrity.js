/**
 * Raised when SQLite can read a file but its pages or existing relationships
 * are inconsistent. Kept separate from schema compatibility: callers decide
 * whether an integrity failure means startup recovery or an invalid import.
 */
class DatabaseIntegrityError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'DatabaseIntegrityError'
  }
}

/**
 * Verify both SQLite's storage and every already-stored foreign-key relation.
 * `PRAGMA foreign_keys = ON` only protects future writes; it does not diagnose
 * orphan rows already present in a copied or hand-edited database.
 */
function assertDatabaseIntegrity(database) {
  let quickCheck
  try {
    quickCheck = database.pragma('quick_check')
  } catch (error) {
    throw new DatabaseIntegrityError(
      `SQLite quick check could not read the database: ${error?.message ?? error}`,
      { cause: error },
    )
  }

  const quickCheckMessages = quickCheck
    .flatMap((row) => Object.values(row ?? {}))
    .map((value) => String(value))
    .filter((value) => value.toLowerCase() !== 'ok')
  if (quickCheckMessages.length > 0) {
    throw new DatabaseIntegrityError(
      `SQLite quick check failed: ${quickCheckMessages.slice(0, 3).join('; ')}`,
    )
  }

  let foreignKeyViolations
  try {
    foreignKeyViolations = database.pragma('foreign_key_check')
  } catch (error) {
    throw new DatabaseIntegrityError(
      `SQLite foreign-key check could not read the database: ${error?.message ?? error}`,
      { cause: error },
    )
  }
  if (foreignKeyViolations.length > 0) {
    const first = foreignKeyViolations[0]
    const location = first?.table
      ? ` (first: ${first.table} row ${first.rowid ?? 'unknown'})`
      : ''
    throw new DatabaseIntegrityError(
      `SQLite foreign-key check found ${foreignKeyViolations.length} violation(s)${location}`,
    )
  }
}

module.exports = {
  DatabaseIntegrityError,
  assertDatabaseIntegrity,
}
