const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Must load before src/app-settings (which requires electron).
const { setUserDataPath } = require('./helpers/electron-stub')

const appSettings = require('../src/app-settings')

const BUNDLED_CSV = path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')

function makeTempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-settings-test-'))
  setUserDataPath(dir)
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function settingsPath(userData) {
  return path.join(userData, 'app-settings.json')
}

function readSettingsFile(userData) {
  return JSON.parse(fs.readFileSync(settingsPath(userData), 'utf8'))
}

function writeSettingsFile(userData, settings) {
  fs.writeFileSync(settingsPath(userData), JSON.stringify(settings, null, 2))
}

/** Copy the bundled pricing CSV (or a tiny valid CSV) into dir under `name`. */
function makeCsv(dir, name, content) {
  const dest = path.join(dir, name)
  if (content != null) {
    fs.writeFileSync(dest, content, 'utf8')
  } else {
    fs.copyFileSync(BUNDLED_CSV, dest)
  }
  return dest
}

const TINY_CSV = [
  '',
  'Uni-Format Pricing ID,Level 1,Level 1 Description,Level 2,Level 2 Description,Level 3,Level 3 Description,Level 4,Level 4 Description,Material,Mean Service Life (yrs),Practical Life (yrs),Unit Price,Unit of Measure',
  '100001,A,Substructure,A10,Foundations,A1010,Standard Foundations,A1010,Standard Foundations,Concrete,100,100,$10.00,Linear Feet',
].join('\n')

test('choosing a second CSV updates the display identity', (t) => {
  const userData = makeTempUserData(t)
  const a = makeCsv(userData, 'a.csv', TINY_CSV)
  const b = makeCsv(userData, 'b.csv', TINY_CSV + '\n')

  appSettings.setUniformatPricingCsvPath(a)
  appSettings.setUniformatPricingCsvPath(b)

  const info = appSettings.getUniformatPricingCsvInfo()
  const storedPath = appSettings.getStoredUniformatPricingCsvPath()

  assert.equal(info.fileName, 'b.csv')
  assert.equal(info.sourcePath, b)
  assert.equal(info.path, storedPath)
  assert.equal(info.isDefault, false)
})

test('fresh state copies bundled CSV and reports default', (t) => {
  const userData = makeTempUserData(t)
  const storedPath = path.join(userData, 'uniformat-pricing.csv')

  assert.equal(fs.existsSync(storedPath), false)

  const info = appSettings.getUniformatPricingCsvInfo()

  assert.equal(info.isDefault, true)
  assert.equal(info.sourcePath, null)
  assert.equal(info.path, storedPath)
  assert.equal(info.fileName, 'uniformat-pricing.csv')
  assert.equal(fs.existsSync(storedPath), true)
  assert.deepEqual(
    fs.readFileSync(storedPath),
    fs.readFileSync(BUNDLED_CSV),
  )
})

test('setUniformatPricingCsvPath persists all three keys and copies bytes', (t) => {
  const userData = makeTempUserData(t)
  const source = makeCsv(userData, 'a.csv', TINY_CSV)

  const returned = appSettings.setUniformatPricingCsvPath(source)
  const storedPath = appSettings.getStoredUniformatPricingCsvPath()
  const settings = readSettingsFile(userData)

  assert.equal(returned, storedPath)
  assert.equal(settings.uniformatPricingCsvPath, storedPath)
  assert.equal(settings.uniformatPricingCsvSourceName, 'a.csv')
  assert.equal(settings.uniformatPricingCsvSourcePath, source)
  assert.deepEqual(fs.readFileSync(storedPath), fs.readFileSync(source))
})

test('failed catalogue commit restores the previous working file and settings', (t) => {
  const userData = makeTempUserData(t)
  const original = makeCsv(userData, 'original.csv', `${TINY_CSV}\noriginal`)
  const replacement = makeCsv(userData, 'replacement.csv', `${TINY_CSV}\nreplacement`)
  appSettings.setUniformatPricingCsvPath(original)

  const storedPath = appSettings.getStoredUniformatPricingCsvPath()
  const fileBefore = fs.readFileSync(storedPath)
  const settingsBefore = fs.readFileSync(settingsPath(userData))

  assert.throws(
    () =>
      appSettings.installUniformatPricingCsv(replacement, () => {
        throw new Error('database commit failed')
      }),
    /database commit failed/,
  )
  assert.deepEqual(fs.readFileSync(storedPath), fileBefore)
  assert.deepEqual(fs.readFileSync(settingsPath(userData)), settingsBefore)
  assert.equal(
    fs.readdirSync(userData).some((name) => name.endsWith('.pending')),
    false,
  )
})

test('missing custom path resets cleanly including orphan source keys', (t) => {
  const userData = makeTempUserData(t)
  const missing = path.join(userData, 'gone-custom.csv')
  writeSettingsFile(userData, {
    uniformatPricingCsvPath: missing,
    uniformatPricingCsvSourceName: 'stale.csv',
    uniformatPricingCsvSourcePath: path.join(userData, 'stale.csv'),
  })

  const resultPath = appSettings.getUniformatPricingCsvPath()
  const storedPath = appSettings.getStoredUniformatPricingCsvPath()

  assert.equal(resultPath, storedPath)
  assert.equal(fs.existsSync(storedPath), true)

  // Settings file must no longer contain any of the three keys.
  if (fs.existsSync(settingsPath(userData))) {
    const settings = readSettingsFile(userData)
    assert.equal(
      Object.prototype.hasOwnProperty.call(settings, 'uniformatPricingCsvPath'),
      false,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(settings, 'uniformatPricingCsvSourceName'),
      false,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(settings, 'uniformatPricingCsvSourcePath'),
      false,
    )
  }
})

test('orphaned source keys alone still report default without stale name', (t) => {
  const userData = makeTempUserData(t)
  writeSettingsFile(userData, {
    uniformatPricingCsvSourceName: 'old-pick.csv',
    uniformatPricingCsvSourcePath: path.join(userData, 'old-pick.csv'),
  })

  const info = appSettings.getUniformatPricingCsvInfo()
  assert.equal(info.isDefault, true)
  assert.equal(info.sourcePath, null)
  assert.equal(info.fileName, 'uniformat-pricing.csv')
  assert.notEqual(info.fileName, 'old-pick.csv')
})

test('invalid source throws and leaves settings untouched', (t) => {
  const userData = makeTempUserData(t)
  writeSettingsFile(userData, { keepMe: true })
  const before = fs.readFileSync(settingsPath(userData), 'utf8')

  for (const bad of ['', null, path.join(userData, 'does-not-exist.csv')]) {
    assert.throws(
      () => appSettings.setUniformatPricingCsvPath(bad),
      /Uniformat pricing CSV file not found/,
    )
  }

  assert.equal(fs.readFileSync(settingsPath(userData), 'utf8'), before)
})

test('self-copy guard does not truncate working copy', (t) => {
  const userData = makeTempUserData(t)
  const source = makeCsv(userData, 'chosen.csv', TINY_CSV)
  const storedPath = appSettings.setUniformatPricingCsvPath(source)
  const bytesBefore = fs.readFileSync(storedPath)

  // Point set at the working copy itself (path.resolve equality branch).
  const returned = appSettings.setUniformatPricingCsvPath(storedPath)
  const bytesAfter = fs.readFileSync(storedPath)
  const settings = readSettingsFile(userData)

  assert.equal(returned, storedPath)
  assert.deepEqual(bytesAfter, bytesBefore)
  assert.equal(settings.uniformatPricingCsvPath, storedPath)
  assert.equal(settings.uniformatPricingCsvSourceName, path.basename(storedPath))
  assert.equal(settings.uniformatPricingCsvSourcePath, storedPath)
})

test('normalizeImportedUniformatPricingPath rewrites foreign uniformat-pricing.csv paths', (t) => {
  const userData = makeTempUserData(t)
  const storedCsv = appSettings.getStoredUniformatPricingCsvPath()
  // Ensure working copy exists so a rewritten path would resolve.
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(storedCsv, TINY_CSV)

  writeSettingsFile(userData, {
    uniformatPricingCsvPath:
      'C:\\Users\\bob\\AppData\\Roaming\\condition-assesment-report-generator\\uniformat-pricing.csv',
    other: 1,
  })

  appSettings.normalizeImportedUniformatPricingPath()
  const settings = readSettingsFile(userData)
  assert.equal(settings.uniformatPricingCsvPath, storedCsv)
  assert.equal(settings.other, 1)
})

test('normalizeImportedUniformatPricingPath rewrites every foreign custom path', (t) => {
  const userData = makeTempUserData(t)
  const foreign = 'D:\\Consulting\\catalogues\\custom-name.csv'
  writeSettingsFile(userData, {
    uniformatPricingCsvPath: foreign,
  })

  appSettings.normalizeImportedUniformatPricingPath()
  const settings = readSettingsFile(userData)
  assert.equal(
    settings.uniformatPricingCsvPath,
    appSettings.getStoredUniformatPricingCsvPath(),
  )
})

test('normalizeImportedUniformatPricingPath is a no-op when setting absent or empty', (t) => {
  const userData = makeTempUserData(t)

  // No settings file.
  appSettings.normalizeImportedUniformatPricingPath()
  assert.equal(fs.existsSync(settingsPath(userData)), false)

  writeSettingsFile(userData, { uniformatPricingCsvPath: '   ', keep: true })
  appSettings.normalizeImportedUniformatPricingPath()
  const settings = readSettingsFile(userData)
  assert.equal(settings.uniformatPricingCsvPath, '   ')
  assert.equal(settings.keep, true)
})

test('corrupt settings file behaves as empty settings', (t) => {
  const userData = makeTempUserData(t)
  fs.writeFileSync(settingsPath(userData), '{not valid json!!!', 'utf8')

  const info = appSettings.getUniformatPricingCsvInfo()
  assert.equal(info.isDefault, true)
  assert.equal(info.sourcePath, null)
  assert.equal(info.path, appSettings.getStoredUniformatPricingCsvPath())
  assert.equal(fs.existsSync(info.path), true)
})
