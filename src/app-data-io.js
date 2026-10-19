const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')
const Database = require('better-sqlite3')
const tar = require('tar')
const appSettings = require('./app-settings')
const { assertDatabaseIntegrity } = require('./database-integrity')
const { fsyncFile } = require('./file-durability')

const SAVE_FORMAT = 'condition-assessment-app-data'
const SAVE_VERSION = 1
const MEDIA_DIRS = ['asset-images', 'building-images', 'firm-assets']
const OPTIONAL_FILES = ['app-settings.json', 'uniformat-pricing.csv']
const DB_SIDECARS = ['-wal', '-shm', '-journal']
const ROLLBACK_DIR_NAME = '.import-rollback'
const IMPORT_JOURNAL_FILE = '.import-journal.json'
const IMPORT_JOURNAL_VERSION = 1

const ROOT_ARCHIVE_FILES = new Set([
  'app.db',
  'manifest.json',
  ...OPTIONAL_FILES,
])

// A report backup can legitimately contain thousands of high-resolution
// photos. These bounds are deliberately generous while still preventing a
// tiny archive from expanding without limit or filling the drive with entries.
const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: 20 * 1024 ** 3,
  maxEntries: 50_000,
  maxTotalBytes: 50 * 1024 ** 3,
  maxDatabaseBytes: 8 * 1024 ** 3,
  maxMediaFileBytes: 512 * 1024 ** 2,
  maxSettingsFileBytes: 64 * 1024 ** 2,
  maxManifestBytes: 1024 ** 2,
  maxPathBytes: 1024,
  diskReserveBytes: 512 * 1024 ** 2,
})

function getUserDataPath() {
  return app.getPath('userData')
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true })
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function fsyncDirectory(dirPath) {
  let handle
  try {
    handle = fs.openSync(dirPath, 'r')
    fs.fsyncSync(handle)
  } catch (error) {
    // Windows and some filesystems do not allow opening/fsyncing directories.
    if (!['EACCES', 'EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    if (handle != null) fs.closeSync(handle)
  }
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const pendingPath = `${filePath}.writing`
  let handle
  try {
    handle = fs.openSync(pendingPath, 'w', 0o600)
    fs.writeFileSync(handle, JSON.stringify(value, null, 2))
    fs.fsyncSync(handle)
  } finally {
    if (handle != null) fs.closeSync(handle)
  }
  try {
    fs.renameSync(pendingPath, filePath)
    fsyncDirectory(path.dirname(filePath))
  } finally {
    removePath(pendingPath)
  }
}

function copyIfExists(sourcePath, destPath) {
  if (!pathExists(sourcePath)) return false
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.cpSync(sourcePath, destPath, { recursive: true })
  return true
}

function moveIfExists(sourcePath, destPath) {
  if (!pathExists(sourcePath)) return false
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  // Snapshot and recovery correctness depends on this being one atomic,
  // same-volume namespace operation. A copy fallback could leave a partial
  // rollback path that startup would mistake for the complete original.
  fs.renameSync(sourcePath, destPath)
  return true
}

function listRelativeFiles(rootDir) {
  const files = []
  function walk(dir, relative = '') {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? path.join(relative, entry.name) : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  walk(rootDir)
  return files
}

function assertContainedPath(rootPath, candidatePath, description) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Invalid save file: ${description} escapes its media directory`)
  }
}

function assertPortableMediaBasename(fileName, description) {
  if (
    !fileName ||
    path.posix.basename(fileName) !== fileName ||
    /[\u0000-\u001f<>:"|?*]/.test(fileName) ||
    /[. ]$/.test(fileName) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)
  ) {
    throw new Error(`Invalid save file: ${description} has an invalid filename`)
  }
}

/**
 * Rebase one app-owned media path from any machine/profile onto this userData.
 *
 * The table supplies `expectedDir`; the stored parent path is never trusted.
 * Current saves use a flat UUID filename under that directory, so accepting a
 * single basename preserves cross-machine backups without accepting arbitrary
 * host paths or `..` normalization.
 */
function rewriteStoredMediaPath(
  storedPath,
  userDataPath,
  expectedDir,
  stagedMediaRoot = userDataPath,
  description = 'media path',
) {
  if (storedPath == null || storedPath === '') return storedPath
  if (!MEDIA_DIRS.includes(expectedDir)) {
    throw new TypeError(`Unknown media directory: ${expectedDir}`)
  }

  const normalized = String(storedPath).replace(/\\/g, '/')
  if (normalized.includes('\0')) {
    throw new Error(`Invalid save file: ${description} contains a NUL byte`)
  }
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    segments.length < 2 ||
    segments.at(-2) !== expectedDir
  ) {
    throw new Error(
      `Invalid save file: ${description} is not a direct child of ${expectedDir}`,
    )
  }

  const fileName = segments.at(-1)
  assertPortableMediaBasename(fileName, description)

  const stagedDirectory = path.join(stagedMediaRoot, expectedDir)
  const stagedPath = path.join(stagedDirectory, fileName)
  assertContainedPath(stagedDirectory, stagedPath, description)

  let stagedStat
  try {
    stagedStat = fs.lstatSync(stagedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Invalid save file: ${description} references missing ${expectedDir}/${fileName}`)
    }
    throw error
  }
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
    throw new Error(
      `Invalid save file: ${description} must reference a regular media file`,
    )
  }

  const targetDirectory = path.join(userDataPath, expectedDir)
  const targetPath = path.join(targetDirectory, fileName)
  assertContainedPath(targetDirectory, targetPath, description)
  return targetPath
}

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  )
}

function rewriteDatabaseMediaPaths(database, userDataPath, stagedMediaRoot = userDataPath) {
  const mappings = [
    {
      table: 'asset_image',
      column: 'file_path',
      expectedDir: 'asset-images',
    },
    {
      table: 'building_image',
      column: 'file_path',
      expectedDir: 'building-images',
    },
    {
      table: 'firm',
      column: 'logo_path',
      expectedDir: 'firm-assets',
    },
  ]

  database.transaction(() => {
    for (const { table, column, expectedDir } of mappings) {
      if (!tableExists(database, table)) continue
      const rows = database.prepare(`SELECT id, ${column} AS p FROM ${table}`).all()
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
      for (const row of rows) {
        const next = rewriteStoredMediaPath(
          row.p,
          userDataPath,
          expectedDir,
          stagedMediaRoot,
          `${table}.${column} row ${row.id}`,
        )
        if (next !== row.p) update.run(next, row.id)
      }
    }
  })()
}

function managedDataEntries(userDataPath, liveDbPath, rollbackRoot) {
  return [
    {
      key: 'app.db',
      livePath: liveDbPath,
      rollbackPath: path.join(rollbackRoot, 'app.db'),
    },
    ...DB_SIDECARS.map((suffix) => ({
      key: `app.db${suffix}`,
      livePath: `${liveDbPath}${suffix}`,
      rollbackPath: path.join(rollbackRoot, `app.db${suffix}`),
    })),
    ...MEDIA_DIRS.map((dirName) => ({
      key: dirName,
      livePath: path.join(userDataPath, dirName),
      rollbackPath: path.join(rollbackRoot, dirName),
    })),
    ...OPTIONAL_FILES.map((fileName) => ({
      key: fileName,
      livePath: path.join(userDataPath, fileName),
      rollbackPath: path.join(rollbackRoot, fileName),
    })),
  ]
}

function importJournalPath(userDataPath) {
  return path.join(userDataPath, IMPORT_JOURNAL_FILE)
}

function readImportJournal(journalPath) {
  let journal
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Cannot recover interrupted app-data import: unreadable ${IMPORT_JOURNAL_FILE} ` +
        `(${error?.message ?? error})`,
    )
  }
  if (journal?.version !== IMPORT_JOURNAL_VERSION) {
    throw new Error(
      `Cannot recover interrupted app-data import: unsupported journal version ${journal?.version}`,
    )
  }
  if (!['snapshotting', 'installing', 'committed'].includes(journal.phase)) {
    throw new Error(
      `Cannot recover interrupted app-data import: unknown phase ${journal?.phase}`,
    )
  }
  if (!Array.isArray(journal.liveEntries)) {
    throw new Error('Cannot recover interrupted app-data import: journal inventory is missing')
  }
  return journal
}

function removeRecoveryState(userDataPath, rollbackRoot, journalPath) {
  removePath(rollbackRoot)
  fsyncDirectory(userDataPath)
  removePath(journalPath)
  removePath(`${journalPath}.writing`)
  fsyncDirectory(userDataPath)
}

/**
 * Finish or roll back a workspace swap left behind by a crash. This must run
 * before SQLite opens app.db: opening while the live path is temporarily absent
 * would create a fresh empty database and hide the rollback copy.
 */
function recoverInterruptedImport({ getDbPath }) {
  if (typeof getDbPath !== 'function') {
    throw new TypeError('recoverInterruptedImport requires getDbPath')
  }
  const userDataPath = getUserDataPath()
  const liveDbPath = getDbPath()
  const rollbackRoot = path.join(userDataPath, ROLLBACK_DIR_NAME)
  const journalPath = importJournalPath(userDataPath)

  if (!pathExists(journalPath)) {
    if (pathExists(rollbackRoot)) {
      throw new Error(
        `Cannot safely open app data: ${rollbackRoot} exists without ${IMPORT_JOURNAL_FILE}. ` +
          'Keep that recovery directory and contact support.',
      )
    }
    return { recovered: false }
  }

  const journal = readImportJournal(journalPath)
  const entries = managedDataEntries(userDataPath, liveDbPath, rollbackRoot)
  const knownKeys = new Set(entries.map((entry) => entry.key))
  const originalKeys = new Set(journal.liveEntries)
  for (const key of originalKeys) {
    if (!knownKeys.has(key)) {
      throw new Error(`Cannot recover interrupted app-data import: unknown inventory entry ${key}`)
    }
  }
  if (!originalKeys.has('app.db')) {
    throw new Error('Cannot recover interrupted app-data import: app.db is absent from inventory')
  }
  if (journal.phase === 'committed') {
    removeRecoveryState(userDataPath, rollbackRoot, journalPath)
    return { recovered: true, action: 'finalized' }
  }

  for (const entry of entries) {
    if (!originalKeys.has(entry.key)) {
      // This path did not exist before import; remove any partially installed one.
      removePath(entry.livePath)
      continue
    }

    if (pathExists(entry.rollbackPath)) {
      removePath(entry.livePath)
      moveIfExists(entry.rollbackPath, entry.livePath)
    }
    // If no rollback copy exists, snapshotting had not moved this entry yet;
    // its original must still be live.
    if (!pathExists(entry.livePath)) {
      throw new Error(
        `Cannot recover interrupted app-data import: original ${entry.key} is missing`,
      )
    }
  }

  removeRecoveryState(userDataPath, rollbackRoot, journalPath)
  return { recovered: true, action: 'rolled-back' }
}

/** Move live volatile data into a same-volume rollback directory. */
function snapshotLiveDataToRollback(
  userDataPath,
  liveDbPath,
  rollbackRoot,
  liveEntries,
  movePath = moveIfExists,
) {
  fs.mkdirSync(rollbackRoot, { recursive: false })
  const entries = managedDataEntries(userDataPath, liveDbPath, rollbackRoot)
  for (const entry of entries) {
    if (!liveEntries.has(entry.key)) continue
    const moved = movePath(entry.livePath, entry.rollbackPath)
    if (!moved || !pathExists(entry.rollbackPath)) {
      throw new Error(`Could not snapshot ${entry.key} for app-data import`)
    }
    fsyncDirectory(path.dirname(entry.livePath))
    fsyncDirectory(path.dirname(entry.rollbackPath))
  }
}

function fsyncTree(targetPath) {
  if (!pathExists(targetPath)) return
  const stat = fs.lstatSync(targetPath)
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to commit symbolic link at ${targetPath}`)
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(targetPath)) {
      fsyncTree(path.join(targetPath, name))
    }
    fsyncDirectory(targetPath)
    return
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to commit non-file app data at ${targetPath}`)
  }
  fsyncFile(targetPath)
}

function installStagedData(stagingDir, userDataPath, liveDbPath) {
  fs.copyFileSync(path.join(stagingDir, 'app.db'), liveDbPath)

  for (const dirName of MEDIA_DIRS) {
    copyIfExists(path.join(stagingDir, dirName), path.join(userDataPath, dirName))
  }
  for (const fileName of OPTIONAL_FILES) {
    copyIfExists(path.join(stagingDir, fileName), path.join(userDataPath, fileName))
  }

  appSettings.normalizeImportedUniformatPricingPath()
}

function resolveArchiveLimits(overrides = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Archive limit ${name} must be a positive safe integer`)
    }
  }
  return limits
}

function archivePathSegments(entryPath, limits) {
  const raw = String(entryPath ?? '')
  if (Buffer.byteLength(raw, 'utf8') > limits.maxPathBytes) {
    throw new Error('Invalid save file: archive entry path is too long')
  }
  if (
    !raw ||
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw)
  ) {
    throw new Error(`Invalid save file: unsafe archive entry path ${raw || '(empty)'}`)
  }

  const withoutTrailingSlash = raw.replace(/\/+$/, '')
  const segments = withoutTrailingSlash.split('/')
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid save file: unsafe archive entry path ${raw}`)
  }
  return segments
}

function assertAllowedArchiveEntry(entryPath, type, limits) {
  const segments = archivePathSegments(entryPath, limits)
  if (type === 'Directory') {
    if (segments.length === 1 && MEDIA_DIRS.includes(segments[0])) {
      return { relativePath: segments[0], kind: 'directory' }
    }
    throw new Error(`Invalid save file: unexpected archive directory ${entryPath}`)
  }
  if (type !== 'File') {
    throw new Error(`Invalid save file: archive entry ${entryPath} has forbidden type ${type}`)
  }

  if (segments.length === 1 && ROOT_ARCHIVE_FILES.has(segments[0])) {
    return { relativePath: segments[0], kind: 'file' }
  }
  if (
    segments.length === 2 &&
    MEDIA_DIRS.includes(segments[0]) &&
    segments[1] !== '.' &&
    segments[1] !== '..'
  ) {
    assertPortableMediaBasename(segments[1], `archive entry ${entryPath}`)
    return { relativePath: segments.join('/'), kind: 'media' }
  }
  throw new Error(`Invalid save file: unexpected archive entry ${entryPath}`)
}

function maxBytesForArchiveFile(relativePath, kind, limits) {
  if (kind === 'media') return limits.maxMediaFileBytes
  if (relativePath === 'app.db') return limits.maxDatabaseBytes
  if (relativePath === 'manifest.json') return limits.maxManifestBytes
  return limits.maxSettingsFileBytes
}

function availableDiskBytes(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

function assertDiskCapacity(targetPath, bytesNeeded, limits) {
  const available = availableDiskBytes(targetPath)
  if (available == null) return
  if (bytesNeeded + limits.diskReserveBytes > available) {
    throw new Error(
      `Invalid save file: import needs ${bytesNeeded} bytes plus reserved free space, ` +
        `but only ${available} bytes are available`,
    )
  }
}

function validateExtractedTree(stagingDir, limits) {
  let entries = 0
  let totalBytes = 0

  function walk(dirPath, relativeDir = '') {
    for (const name of fs.readdirSync(dirPath)) {
      const absolutePath = path.join(dirPath, name)
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name
      const stat = fs.lstatSync(absolutePath)
      entries += 1
      if (entries > limits.maxEntries) {
        throw new Error(`Invalid save file: archive has more than ${limits.maxEntries} entries`)
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Invalid save file: symbolic links are forbidden (${relativePath})`)
      }
      if (stat.isDirectory()) {
        assertAllowedArchiveEntry(relativePath, 'Directory', limits)
        walk(absolutePath, relativePath)
        continue
      }
      if (!stat.isFile()) {
        throw new Error(`Invalid save file: non-file archive entry ${relativePath}`)
      }
      const allowed = assertAllowedArchiveEntry(relativePath, 'File', limits)
      const fileLimit = maxBytesForArchiveFile(
        allowed.relativePath,
        allowed.kind,
        limits,
      )
      if (stat.size > fileLimit) {
        throw new Error(
          `Invalid save file: ${relativePath} exceeds its ${fileLimit}-byte limit`,
        )
      }
      totalBytes += stat.size
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `Invalid save file: extracted data exceeds ${limits.maxTotalBytes} bytes`,
        )
      }
    }
  }

  walk(stagingDir)
  return { entries, totalBytes }
}

async function extractValidatedArchive(sourcePath, stagingDir, userDataPath, overrides) {
  const limits = resolveArchiveLimits(overrides)
  const sourceStat = fs.statSync(sourcePath)
  if (!sourceStat.isFile()) {
    throw new Error('Save file is not a regular file')
  }
  if (sourceStat.size > limits.maxCompressedBytes) {
    throw new Error(
      `Save file exceeds the ${limits.maxCompressedBytes}-byte compressed-size limit`,
    )
  }

  const seen = new Set()
  let entries = 0
  let declaredBytes = 0
  let archiveError = null
  const stagingAvailable = availableDiskBytes(stagingDir)
  const stagingBudget =
    stagingAvailable == null
      ? limits.maxTotalBytes
      : Math.max(0, stagingAvailable - limits.diskReserveBytes)

  await tar.extract({
    file: sourcePath,
    cwd: stagingDir,
    gzip: true,
    strict: true,
    preservePaths: false,
    maxDepth: 2,
    filter(entryPath, entry) {
      // node-tar calls filters from its stream parser; a thrown filter error can
      // escape the returned promise on some versions. Record and reject after
      // parsing instead, while returning false so the entry is never written.
      if (archiveError) return false
      try {
        entries += 1
        if (entries > limits.maxEntries) {
          throw new Error(
            `Invalid save file: archive has more than ${limits.maxEntries} entries`,
          )
        }

        const allowed = assertAllowedArchiveEntry(entryPath, entry.type, limits)
        // Backups must unpack identically on Windows/macOS as on Linux. Treat
        // case and Unicode-normalization aliases as the same entry before a
        // case-insensitive filesystem can silently overwrite one with another.
        const portableKey = allowed.relativePath.normalize('NFC').toLowerCase()
        if (seen.has(portableKey)) {
          throw new Error(
            `Invalid save file: duplicate archive entry ${allowed.relativePath}`,
          )
        }
        seen.add(portableKey)

        if (allowed.kind !== 'directory') {
          const size = Number(entry.size)
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Invalid save file: ${entryPath} has an invalid size`)
          }
          const fileLimit = maxBytesForArchiveFile(
            allowed.relativePath,
            allowed.kind,
            limits,
          )
          if (size > fileLimit) {
            throw new Error(
              `Invalid save file: ${entryPath} exceeds its ${fileLimit}-byte limit`,
            )
          }
          declaredBytes += size
          if (declaredBytes > limits.maxTotalBytes || declaredBytes > stagingBudget) {
            throw new Error(
              'Invalid save file: archive expands beyond the allowed disk budget',
            )
          }
        }
        return true
      } catch (error) {
        archiveError = error
        return false
      }
    },
  })

  if (archiveError) throw archiveError

  const extracted = validateExtractedTree(stagingDir, limits)
  assertDiskCapacity(userDataPath, extracted.totalBytes, limits)
  return { ...extracted, limits }
}

function prepareStagedDatabase(stagingDir, userDataPath) {
  const stagedDbPath = path.join(stagingDir, 'app.db')
  let database
  try {
    database = new Database(stagedDbPath, { fileMustExist: true })
    database.pragma('foreign_keys = ON')
    assertDatabaseIntegrity(database)
    rewriteDatabaseMediaPaths(database, userDataPath, stagingDir)
    assertDatabaseIntegrity(database)
  } catch (error) {
    throw new Error(`Invalid save file: database validation failed: ${error?.message ?? error}`)
  } finally {
    if (database) database.close()
  }
}

async function exportAppData(
  destPath,
  { backupDatabaseTo, createArchive = tar.create },
) {
  const userDataPath = getUserDataPath()
  const stagingDir = createTempDir('car-export-')
  try {
    await backupDatabaseTo(path.join(stagingDir, 'app.db'))

    for (const dirName of MEDIA_DIRS) {
      copyIfExists(path.join(userDataPath, dirName), path.join(stagingDir, dirName))
    }
    for (const fileName of OPTIONAL_FILES) {
      copyIfExists(path.join(userDataPath, fileName), path.join(stagingDir, fileName))
    }

    fs.writeFileSync(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(
        {
          format: SAVE_FORMAT,
          version: SAVE_VERSION,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )

    const files = listRelativeFiles(stagingDir)
    if (!files.includes('app.db')) {
      throw new Error('Failed to stage database for export')
    }

    const destinationDir = path.dirname(destPath)
    fs.mkdirSync(destinationDir, { recursive: true })
    const pendingPath = `${destPath}.${process.pid}.${randomUUID()}.pending`
    try {
      await createArchive(
        {
          gzip: true,
          file: pendingPath,
          cwd: stagingDir,
          portable: true,
        },
        files,
      )
      fsyncTree(pendingPath)
      fs.renameSync(pendingPath, destPath)
      fsyncDirectory(destinationDir)
    } finally {
      removePath(pendingPath)
    }

    return { filePath: destPath }
  } finally {
    removePath(stagingDir)
  }
}

function validateSaveManifest(stagingDir) {
  const dbPath = path.join(stagingDir, 'app.db')
  if (!fs.existsSync(dbPath)) {
    throw new Error('Invalid save file: missing app.db')
  }

  const manifestPath = path.join(stagingDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    // Allow older/hand-made archives that only contain the expected files.
    return { format: SAVE_FORMAT, version: 0 }
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('Invalid save file: unreadable manifest.json')
  }

  if (manifest.format && manifest.format !== SAVE_FORMAT) {
    throw new Error('Invalid save file: unrecognized format')
  }

  const version = Number(manifest.version)
  if (Number.isFinite(version) && version > SAVE_VERSION) {
    throw new Error(
      `Save file version ${version} is newer than this app supports (${SAVE_VERSION})`,
    )
  }

  return manifest
}

/**
 * Import replaces volatile app data, but never deletes the live set until the
 * incoming archive is validated. Live data is moved to a same-volume rollback
 * directory and restored if any install step fails.
 */
async function importAppData(
  sourcePath,
  {
    closeDatabase,
    openDatabase,
    getDbPath,
    archiveLimits,
    movePath = moveIfExists,
  },
) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Save file not found')
  }
  if (typeof getDbPath !== 'function') {
    throw new Error('importAppData requires getDbPath')
  }

  const userDataPath = getUserDataPath()
  const liveDbPath = getDbPath()
  const stagingDir = createTempDir('car-import-')
  const rollbackRoot = path.join(userDataPath, ROLLBACK_DIR_NAME)
  const journalPath = importJournalPath(userDataPath)
  let journalStarted = false
  let committed = false

  try {
    await extractValidatedArchive(sourcePath, stagingDir, userDataPath, archiveLimits)
    validateSaveManifest(stagingDir)
    prepareStagedDatabase(stagingDir, userDataPath)

    closeDatabase()
    // Normally startup has already done this. Recheck after closing SQLite so a
    // prior interrupted import can never be overwritten by this one.
    recoverInterruptedImport({ getDbPath })

    const managedEntries = managedDataEntries(userDataPath, liveDbPath, rollbackRoot)
    const liveEntries = new Set(
      managedEntries
        .filter((entry) => pathExists(entry.livePath))
        .map((entry) => entry.key),
    )
    const journal = {
      version: IMPORT_JOURNAL_VERSION,
      phase: 'snapshotting',
      startedAt: new Date().toISOString(),
      liveEntries: [...liveEntries],
    }
    writeJsonAtomically(journalPath, journal)
    journalStarted = true

    try {
      snapshotLiveDataToRollback(
        userDataPath,
        liveDbPath,
        rollbackRoot,
        liveEntries,
        movePath,
      )
      journal.phase = 'installing'
      writeJsonAtomically(journalPath, journal)

      installStagedData(stagingDir, userDataPath, liveDbPath)
      openDatabase()

      // The committed marker is the point of no return. Flush every installed
      // file and directory before it, so startup may safely finalize rather
      // than roll back when it sees phase=committed after a power loss.
      for (const entry of managedEntries) {
        fsyncTree(entry.livePath)
      }
      fsyncDirectory(userDataPath)
      journal.phase = 'committed'
      writeJsonAtomically(journalPath, journal)
      committed = true
      removeRecoveryState(userDataPath, rollbackRoot, journalPath)
    } catch (installErr) {
      if (committed) {
        // Cleanup after the durable commit is idempotent. If it succeeds here,
        // the imported workspace is complete and must not be reported as lost.
        try {
          recoverInterruptedImport({ getDbPath })
          return { ok: true }
        } catch (cleanupErr) {
          throw new Error(
            `Import committed, but recovery metadata cleanup failed ` +
              `(${cleanupErr?.message ?? cleanupErr}).`,
            { cause: installErr },
          )
        }
      }

      try {
        closeDatabase()
      } catch {
        // ignore — restore must proceed even if close fails
      }
      try {
        recoverInterruptedImport({ getDbPath })
        try {
          openDatabase()
        } catch {
          // surface the original install error; reopen may recover on next launch
        }
      } catch (restoreErr) {
        const installMessage = String(installErr?.message ?? installErr)
        const restoreMessage = String(restoreErr?.message ?? restoreErr)
        throw new Error(
          `Import failed (${installMessage}). Rollback also failed (${restoreMessage}). ` +
            `A recovery copy may remain at ${rollbackRoot}.`,
        )
      }
      throw installErr
    }

    return { ok: true }
  } finally {
    removePath(stagingDir)
    // Never delete journal/rollback here. If an abrupt error escaped the
    // recovery path, startup needs those durable files to restore the workspace.
    if (!journalStarted) removePath(`${journalPath}.writing`)
  }
}

function defaultExportFileName() {
  const stamp = new Date().toISOString().slice(0, 10)
  return `condition-assessment-data-${stamp}.projectdata`
}

module.exports = {
  SAVE_FORMAT,
  SAVE_VERSION,
  DEFAULT_ARCHIVE_LIMITS,
  IMPORT_JOURNAL_FILE,
  IMPORT_JOURNAL_VERSION,
  ROLLBACK_DIR_NAME,
  defaultExportFileName,
  exportAppData,
  importAppData,
  recoverInterruptedImport,
  rewriteStoredMediaPath,
  rewriteDatabaseMediaPaths,
}
