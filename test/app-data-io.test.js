const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const Database = require('better-sqlite3')
const tar = require('tar')

// Must load before src/app-data-io and src/db (both require electron).
const { setUserDataPath, setIsPackaged } = require('./helpers/electron-stub')
// Packaged shape: openDatabase does not seed dummy data, so each workspace holds
// exactly what the test puts in it.
setIsPackaged(true)

const appDataIo = require('../src/app-data-io')
const db = require('../src/db')

const tmpRoots = []
function freshUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-io-ud-'))
  tmpRoots.push(dir)
  return dir
}
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-io-'))
  tmpRoots.push(dir)
  return path.join(dir, name)
}

test.after(() => {
  db.closeDatabase()
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
})

/** Open a fresh empty workspace at a new userData root and return its path. */
function openWorkspace() {
  const userData = freshUserData()
  db.closeDatabase()
  setUserDataPath(userData)
  db.openDatabase()
  return userData
}

/** Populate the open workspace with a project graph and three media files. */
function populate(userData) {
  const project = db.createProject({ client: 'Acme Property Co' })
  const building = db.createBuilding({ project_id: project.id, property_name: 'Riverbend Tower' })
  const asset = db.createAsset(building.id, 'A — Substructure')

  const writeMedia = (dir, name, contents) => {
    fs.mkdirSync(path.join(userData, dir), { recursive: true })
    const filePath = path.join(userData, dir, name)
    fs.writeFileSync(filePath, contents)
    return filePath
  }
  const buildingPhoto = writeMedia('building-images', 'b.jpg', 'BUILDING-PHOTO')
  db.createBuildingImage({ building_id: building.id, file_path: buildingPhoto, original_name: 'b.jpg', sort_order: 0 })
  const assetPhoto = writeMedia('asset-images', 'a.jpg', 'ASSET-PHOTO')
  db.createAssetImage({ asset_id: asset.id, file_path: assetPhoto, original_name: 'a.jpg', sort_order: 0 })
  const logo = writeMedia('firm-assets', 'logo.png', 'FIRM-LOGO')
  db.updateFirm({ ...db.getFirm(), logo_path: logo, logo_original_name: 'logo.png' })

  return { project, building, asset }
}

async function exportSave() {
  const dest = tmpFile('save.projectdata')
  await appDataIo.exportAppData(dest, { backupDatabaseTo: db.backupDatabaseTo })
  return dest
}

async function unpackSave(savePath) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-io-stage-'))
  tmpRoots.push(staging)
  await tar.extract({ file: savePath, cwd: staging, gzip: true })
  return staging
}

async function repackSave(staging, name = 'repacked.projectdata') {
  const savePath = tmpFile(name)
  await tar.create(
    { gzip: true, file: savePath, cwd: staging, portable: true },
    fs.readdirSync(staging),
  )
  return savePath
}

function editStagedDatabase(staging, edit) {
  const database = new Database(path.join(staging, 'app.db'))
  try {
    edit(database)
  } finally {
    database.close()
  }
}

function tarEntryHeader(
  entryName,
  { type = '0', linkName = '', size = 0, mode = 0o644 } = {},
) {
  const header = Buffer.alloc(512)
  const writeText = (offset, length, value) =>
    header.write(String(value).slice(0, length), offset, length, 'utf8')
  const writeOctal = (offset, length, value) =>
    writeText(offset, length, `${Number(value).toString(8).padStart(length - 1, '0')}\0`)

  writeText(0, 100, entryName)
  writeOctal(100, 8, mode)
  writeOctal(108, 8, 0)
  writeOctal(116, 8, 0)
  writeOctal(124, 12, size)
  writeOctal(136, 12, Math.floor(Date.now() / 1000))
  header.fill(0x20, 148, 156)
  writeText(156, 1, type)
  writeText(157, 100, linkName)
  writeText(257, 6, 'ustar\0')
  writeText(263, 2, '00')
  let checksum = 0
  for (const byte of header) checksum += byte
  writeText(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function tarEntry(entryName, contents) {
  const bytes = Buffer.from(contents)
  const padding = (512 - (bytes.length % 512)) % 512
  return Buffer.concat([
    tarEntryHeader(entryName, { size: bytes.length }),
    bytes,
    Buffer.alloc(padding),
  ])
}

function appendEntryToSave(savePath, entry, outputName) {
  const tarBytes = zlib.gunzipSync(fs.readFileSync(savePath))
  let contentEnd = tarBytes.length
  while (
    contentEnd >= 512 &&
    tarBytes.subarray(contentEnd - 512, contentEnd).every((byte) => byte === 0)
  ) {
    contentEnd -= 512
  }
  const withLink = Buffer.concat([
    tarBytes.subarray(0, contentEnd),
    entry,
    Buffer.alloc(1024),
  ])
  const malicious = tmpFile(outputName)
  fs.writeFileSync(malicious, zlib.gzipSync(withLink))
  return malicious
}

function appendSymbolicLinkToSave(savePath, entryName, linkName) {
  return appendEntryToSave(
    savePath,
    tarEntryHeader(entryName, { type: '2', linkName, mode: 0o777 }),
    'symlink.projectdata',
  )
}

const importDeps = () => ({
  closeDatabase: db.closeDatabase,
  openDatabase: db.openDatabase,
  getDbPath: db.getDbPath,
})

test('export then import round-trips the whole workspace, rewriting media paths', async () => {
  const userDataA = openWorkspace()
  populate(userDataA)
  const dest = await exportSave()

  // Import into a pristine, unrelated userData root.
  const userDataB = openWorkspace() // empty
  assert.equal(db.listProjects().length, 0)
  db.closeDatabase()
  const result = await appDataIo.importAppData(dest, importDeps())
  assert.deepEqual(result, { ok: true })

  const projects = db.listProjects()
  assert.equal(projects.length, 1)
  assert.equal(projects[0].client, 'Acme Property Co')

  const buildings = db.listBuildings(projects[0].id)
  assert.equal(buildings.length, 1)

  const buildingImages = db.listBuildingImages(buildings[0].id)
  assert.equal(buildingImages.length, 1)
  // Path rewritten under the current userData, and the bytes came across.
  assert.ok(buildingImages[0].file_path.startsWith(userDataB), buildingImages[0].file_path)
  assert.equal(fs.readFileSync(buildingImages[0].file_path, 'utf8'), 'BUILDING-PHOTO')

  const assets = db.listBuildingAssets(buildings[0].id)
  const assetImages = db.listAssetImages(assets[0].id)
  assert.equal(assetImages.length, 1)
  assert.equal(fs.readFileSync(assetImages[0].file_path, 'utf8'), 'ASSET-PHOTO')

  const firm = db.getFirm()
  assert.ok(firm.logo_path.startsWith(userDataB), firm.logo_path)
  assert.equal(fs.readFileSync(firm.logo_path, 'utf8'), 'FIRM-LOGO')
})

test('a failed export preserves an existing backup at the chosen path', async () => {
  const userData = openWorkspace()
  populate(userData)
  const destination = tmpFile('existing.projectdata')
  fs.writeFileSync(destination, 'PREVIOUS GOOD BACKUP')

  await assert.rejects(
    () => appDataIo.exportAppData(destination, {
      backupDatabaseTo: db.backupDatabaseTo,
      createArchive: async () => {
        throw new Error('injected archive failure')
      },
    }),
    /injected archive failure/,
  )

  assert.equal(fs.readFileSync(destination, 'utf8'), 'PREVIOUS GOOD BACKUP')
  assert.deepEqual(
    fs.readdirSync(path.dirname(destination)).filter((name) => name.endsWith('.pending')),
    [],
  )
})

test('import replaces the existing workspace rather than merging into it', async () => {
  const userDataA = openWorkspace()
  populate(userDataA)
  const dest = await exportSave()

  // A different workspace with its own project.
  openWorkspace()
  db.createProject({ client: 'Stale Client That Must Not Survive' })
  assert.equal(db.listProjects().length, 1)
  db.closeDatabase()

  await appDataIo.importAppData(dest, importDeps())
  const clients = db.listProjects().map((p) => p.client)
  assert.deepEqual(clients, ['Acme Property Co']) // replaced, not merged
})

test('a save file newer than this app supports is refused', async () => {
  const userDataA = openWorkspace()
  populate(userDataA)
  const goodSave = await exportSave()

  // Re-package the same app.db with a bumped manifest version.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-io-stage-'))
  tmpRoots.push(staging)
  await tar.extract({ file: goodSave, cwd: staging, gzip: true })
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify({ format: appDataIo.SAVE_FORMAT, version: appDataIo.SAVE_VERSION + 5 }),
  )
  const futureSave = tmpFile('future.projectdata')
  await tar.create({ gzip: true, file: futureSave, cwd: staging, portable: true }, fs.readdirSync(staging))

  openWorkspace()
  db.createProject({ client: 'Existing' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(futureSave, importDeps()),
    /newer than this app supports/,
  )
  // Existing data was never touched — the archive is rejected before any wipe.
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((p) => p.client), ['Existing'])
})

test('a truncated archive fails cleanly and leaves existing data untouched', async () => {
  const userDataA = openWorkspace()
  populate(userDataA)
  const good = await exportSave()

  // Corrupt: keep only the first few hundred bytes of a valid gzip tar.
  const corrupt = tmpFile('corrupt.projectdata')
  fs.writeFileSync(corrupt, fs.readFileSync(good).subarray(0, 200))

  openWorkspace()
  db.createProject({ client: 'Survivor' })
  db.closeDatabase()
  await assert.rejects(() => appDataIo.importAppData(corrupt, importDeps()))

  db.openDatabase()
  assert.deepEqual(db.listProjects().map((p) => p.client), ['Survivor'])
})

test('an archive entry that escapes the target directory is not written outside it', async () => {
  const userDataA = openWorkspace()
  populate(userDataA)
  const good = await exportSave()

  // Build a malicious archive: a `pkg/` holding a valid app.db + manifest, plus
  // a sibling file referenced through `../` so the stored entry name escapes the
  // extraction directory (it would land one level above, in os.tmpdir()).
  const evilRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-io-evil-'))
  tmpRoots.push(evilRoot)
  const pkg = path.join(evilRoot, 'pkg')
  fs.mkdirSync(pkg)
  await tar.extract({ file: good, cwd: pkg, gzip: true })
  const escapeName = `escaped-${Date.now()}.txt`
  fs.writeFileSync(path.join(evilRoot, escapeName), 'PWNED')
  const evil = tmpFile('evil.projectdata')
  await tar.create(
    { gzip: true, file: evil, cwd: pkg, preservePaths: true, portable: true },
    ['app.db', 'manifest.json', `../${escapeName}`],
  )

  const escapeTarget = path.join(os.tmpdir(), escapeName)
  fs.rmSync(escapeTarget, { force: true })

  openWorkspace()
  db.closeDatabase()
  // Import may succeed or reject; either way the escaping entry must not land
  // outside the extraction directory.
  await appDataIo.importAppData(evil, importDeps()).catch(() => {})
  assert.equal(fs.existsSync(escapeTarget), false, 'archive entry escaped the target directory')
})

test('import rejects arbitrary and traversal media paths before replacing live data', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()

  for (const [name, maliciousPath, message] of [
    ['absolute', '/home/another-user/Documents/secret.jpg', /direct child of asset-images/],
    [
      'traversal',
      'C:\\Users\\old\\asset-images\\..\\..\\secret.jpg',
      /direct child of asset-images/,
    ],
  ]) {
    const staging = await unpackSave(good)
    editStagedDatabase(staging, (database) => {
      database.prepare('UPDATE asset_image SET file_path = ?').run(maliciousPath)
    })
    const malicious = await repackSave(staging, `${name}.projectdata`)

    openWorkspace()
    db.createProject({ client: `Survivor ${name}` })
    db.closeDatabase()
    await assert.rejects(() => appDataIo.importAppData(malicious, importDeps()), message)
    db.openDatabase()
    assert.deepEqual(db.listProjects().map((project) => project.client), [
      `Survivor ${name}`,
    ])
  }
})

test('import rejects a database media row whose archived file is missing', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const staging = await unpackSave(await exportSave())
  fs.rmSync(path.join(staging, 'asset-images', 'a.jpg'))
  const malicious = await repackSave(staging, 'missing-media.projectdata')

  openWorkspace()
  db.createProject({ client: 'Still here' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(malicious, importDeps()),
    /references missing asset-images\/a\.jpg/,
  )
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), ['Still here'])
})

test('import rejects symbolic links and unexpected regular files in the archive', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()
  const withSymlink = appendSymbolicLinkToSave(
    good,
    'asset-images/linked-secret.jpg',
    '../app.db',
  )

  openWorkspace()
  db.createProject({ client: 'Link survivor' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(withSymlink, importDeps()),
    /forbidden type SymbolicLink/,
  )

  const staging = await unpackSave(good)
  fs.writeFileSync(path.join(staging, 'unexpected.txt'), 'not part of the save format')
  const unexpected = await repackSave(staging, 'unexpected-entry.projectdata')
  await assert.rejects(
    () => appDataIo.importAppData(unexpected, importDeps()),
    /unexpected archive entry unexpected\.txt/,
  )
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), ['Link survivor'])
})

test('import rejects media names that alias on case-insensitive filesystems', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()
  // Construct the second archive entry directly. NTFS cannot represent both
  // names in a staging directory, which is exactly why the importer rejects
  // an archive containing them before extraction.
  const ambiguous = appendEntryToSave(
    good,
    tarEntry('asset-images/A.JPG', 'CASE-ALIAS'),
    'case-alias.projectdata',
  )

  openWorkspace()
  db.createProject({ client: 'Case survivor' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(ambiguous, importDeps()),
    /duplicate archive entry asset-images\/a\.jpg/i,
  )
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Case survivor',
  ])
})

test('import rejects media names that alias after Unicode normalization', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()
  const withComposedName = appendEntryToSave(
    good,
    tarEntry('asset-images/caf\u00e9.jpg', 'COMPOSED'),
    'unicode-composed.projectdata',
  )
  const ambiguous = appendEntryToSave(
    withComposedName,
    tarEntry('asset-images/cafe\u0301.jpg', 'DECOMPOSED'),
    'unicode-alias.projectdata',
  )

  openWorkspace()
  db.createProject({ client: 'Unicode survivor' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(ambiguous, importDeps()),
    /duplicate archive entry asset-images\/cafe\u0301\.jpg/i,
  )
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Unicode survivor',
  ])
})

test('archive resource limits reject expansion before live data is touched', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()

  openWorkspace()
  db.createProject({ client: 'Limit survivor' })
  db.closeDatabase()
  await assert.rejects(
    () =>
      appDataIo.importAppData(good, {
        ...importDeps(),
        archiveLimits: { maxEntries: 1 },
      }),
    /more than 1 entries/,
  )
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Limit survivor',
  ])
})

test('imported databases must pass quick-check and foreign-key integrity before swap', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const good = await exportSave()
  const staging = await unpackSave(good)
  editStagedDatabase(staging, (database) => {
    database.pragma('foreign_keys = OFF')
    database
      .prepare('INSERT INTO asset (building_id, asset_name) VALUES (?, ?)')
      .run(999_999, 'Orphan from archive')
  })
  const invalid = await repackSave(staging, 'foreign-key-invalid.projectdata')

  openWorkspace()
  db.createProject({ client: 'Integrity survivor' })
  db.closeDatabase()
  await assert.rejects(
    () => appDataIo.importAppData(invalid, importDeps()),
    /foreign-key check found 1 violation/i,
  )

  const corruptStaging = await unpackSave(good)
  fs.writeFileSync(path.join(corruptStaging, 'app.db'), 'not a SQLite database')
  const corrupt = await repackSave(corruptStaging, 'quick-check-invalid.projectdata')
  await assert.rejects(
    () => appDataIo.importAppData(corrupt, importDeps()),
    /quick check could not read|file is not a database/i,
  )

  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Integrity survivor',
  ])
})

test('a snapshot failure after app.db moves rolls the whole live workspace back', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const incoming = await exportSave()

  const liveUserData = openWorkspace()
  populate(liveUserData)
  db.openDatabase().prepare('UPDATE project SET client = ?').run('Original workspace')
  db.closeDatabase()

  const movePath = (sourcePath, destPath) => {
    if (!fs.existsSync(sourcePath)) return false
    if (sourcePath === path.join(liveUserData, 'asset-images')) {
      throw new Error('injected snapshot failure')
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.renameSync(sourcePath, destPath)
    return true
  }

  await assert.rejects(
    () => appDataIo.importAppData(incoming, { ...importDeps(), movePath }),
    /injected snapshot failure/,
  )
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Original workspace',
  ])
  assert.equal(
    fs.existsSync(path.join(liveUserData, appDataIo.IMPORT_JOURNAL_FILE)),
    false,
  )
  assert.equal(
    fs.existsSync(path.join(liveUserData, appDataIo.ROLLBACK_DIR_NAME)),
    false,
  )
})

test('a locked snapshot rename aborts without copying a partial rollback', async (t) => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  const incoming = await exportSave()

  const liveUserData = openWorkspace()
  populate(liveUserData)
  db.openDatabase().prepare('UPDATE project SET client = ?').run('Locked original')
  db.closeDatabase()

  const liveDbPath = db.getDbPath()
  const rollbackDbPath = path.join(
    liveUserData,
    appDataIo.ROLLBACK_DIR_NAME,
    'app.db',
  )
  const originalRenameSync = fs.renameSync
  const originalCpSync = fs.cpSync
  let rollbackCopyAttempts = 0

  t.mock.method(fs, 'renameSync', (sourcePath, destPath, ...args) => {
    if (sourcePath === liveDbPath && destPath === rollbackDbPath) {
      const error = new Error('locked live app.db')
      error.code = 'EACCES'
      throw error
    }
    return Reflect.apply(originalRenameSync, fs, [sourcePath, destPath, ...args])
  })
  t.mock.method(fs, 'cpSync', (sourcePath, destPath, ...args) => {
    if (sourcePath === liveDbPath && destPath === rollbackDbPath) {
      rollbackCopyAttempts += 1
    }
    return Reflect.apply(originalCpSync, fs, [sourcePath, destPath, ...args])
  })

  await assert.rejects(
    () => appDataIo.importAppData(incoming, importDeps()),
    /locked live app\.db/,
  )
  assert.equal(rollbackCopyAttempts, 0)
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Locked original',
  ])
  assert.equal(
    fs.existsSync(path.join(liveUserData, appDataIo.IMPORT_JOURNAL_FILE)),
    false,
  )
  assert.equal(
    fs.existsSync(path.join(liveUserData, appDataIo.ROLLBACK_DIR_NAME)),
    false,
  )
})

test('startup recovery restores a workspace interrupted halfway through snapshotting', () => {
  const userData = openWorkspace()
  populate(userData)
  db.openDatabase().prepare('UPDATE project SET client = ?').run('Crash survivor')
  db.closeDatabase()

  const rollbackRoot = path.join(userData, appDataIo.ROLLBACK_DIR_NAME)
  const journalPath = path.join(userData, appDataIo.IMPORT_JOURNAL_FILE)
  const liveEntries = [
    'app.db',
    'asset-images',
    'building-images',
    'firm-assets',
    'uniformat-pricing.csv',
  ]
  fs.mkdirSync(rollbackRoot)
  fs.renameSync(db.getDbPath(), path.join(rollbackRoot, 'app.db'))
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      version: appDataIo.IMPORT_JOURNAL_VERSION,
      phase: 'snapshotting',
      liveEntries,
    }),
  )

  assert.deepEqual(appDataIo.recoverInterruptedImport({ getDbPath: db.getDbPath }), {
    recovered: true,
    action: 'rolled-back',
  })
  assert.equal(fs.existsSync(journalPath), false)
  assert.equal(fs.existsSync(rollbackRoot), false)

  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Crash survivor',
  ])
  assert.equal(fs.readFileSync(path.join(userData, 'asset-images', 'a.jpg'), 'utf8'), 'ASSET-PHOTO')
})

test('startup recovery finalizes a durably committed import instead of rolling it back', () => {
  const userData = openWorkspace()
  db.createProject({ client: 'Committed workspace' })
  db.closeDatabase()

  const rollbackRoot = path.join(userData, appDataIo.ROLLBACK_DIR_NAME)
  const journalPath = path.join(userData, appDataIo.IMPORT_JOURNAL_FILE)
  fs.mkdirSync(rollbackRoot)
  fs.copyFileSync(db.getDbPath(), path.join(rollbackRoot, 'app.db'))
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      version: appDataIo.IMPORT_JOURNAL_VERSION,
      phase: 'committed',
      liveEntries: ['app.db', 'uniformat-pricing.csv'],
    }),
  )

  assert.deepEqual(appDataIo.recoverInterruptedImport({ getDbPath: db.getDbPath }), {
    recovered: true,
    action: 'finalized',
  })
  assert.equal(fs.existsSync(rollbackRoot), false)
  db.openDatabase()
  assert.deepEqual(db.listProjects().map((project) => project.client), [
    'Committed workspace',
  ])
})

test('import rebases every custom pricing path onto the local working copy', async () => {
  const sourceUserData = openWorkspace()
  populate(sourceUserData)
  fs.writeFileSync(
    path.join(sourceUserData, 'app-settings.json'),
    JSON.stringify({
      uniformatPricingCsvPath: 'D:\\Consulting\\catalogues\\renamed-client-prices.csv',
      uniformatPricingCsvSourceName: 'renamed-client-prices.csv',
    }),
  )
  const incoming = await exportSave()

  const targetUserData = openWorkspace()
  db.closeDatabase()
  await appDataIo.importAppData(incoming, importDeps())
  const settings = JSON.parse(
    fs.readFileSync(path.join(targetUserData, 'app-settings.json'), 'utf8'),
  )
  assert.equal(
    settings.uniformatPricingCsvPath,
    path.join(targetUserData, 'uniformat-pricing.csv'),
  )
  assert.equal(settings.uniformatPricingCsvSourceName, 'renamed-client-prices.csv')
})
