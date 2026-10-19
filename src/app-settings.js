const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

function getBundledUniformatPricingCsvPath() {
  return path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')
}

function getStoredUniformatPricingCsvPath() {
  return path.join(app.getPath('userData'), 'uniformat-pricing.csv')
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'app-settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeFileAtomically(targetPath, bytes) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const pendingPath = `${targetPath}.${process.pid}.${Date.now()}.pending`
  try {
    fs.writeFileSync(pendingPath, bytes)
    fs.renameSync(pendingPath, targetPath)
  } finally {
    fs.rmSync(pendingPath, { force: true })
  }
}

function writeSettings(settings) {
  writeFileAtomically(getSettingsPath(), JSON.stringify(settings, null, 2))
}

function getUniformatPricingCsvPathSetting() {
  const customPath = readSettings().uniformatPricingCsvPath
  return typeof customPath === 'string' && customPath.trim() ? customPath.trim() : null
}

function clearUniformatPricingCsvPathSetting() {
  const settings = readSettings()
  const hasPath = Object.prototype.hasOwnProperty.call(settings, 'uniformatPricingCsvPath')
  const hasSourceName = Object.prototype.hasOwnProperty.call(
    settings,
    'uniformatPricingCsvSourceName',
  )
  const hasSourcePath = Object.prototype.hasOwnProperty.call(
    settings,
    'uniformatPricingCsvSourcePath',
  )
  if (!hasPath && !hasSourceName && !hasSourcePath) return
  const next = { ...settings }
  delete next.uniformatPricingCsvPath
  delete next.uniformatPricingCsvSourceName
  delete next.uniformatPricingCsvSourcePath
  writeSettings(next)
}

/**
 * Ensure the working pricing CSV exists under userData.
 * On first launch (or if the file was deleted), copy the bundled default there.
 */
function ensureUniformatPricingCsv() {
  const storedPath = getStoredUniformatPricingCsvPath()
  if (fs.existsSync(storedPath)) return storedPath

  const bundledPath = getBundledUniformatPricingCsvPath()
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`Bundled Uniformat pricing CSV not found at ${bundledPath}`)
  }

  fs.mkdirSync(path.dirname(storedPath), { recursive: true })
  fs.copyFileSync(bundledPath, storedPath)
  return storedPath
}

function getUniformatPricingCsvPath() {
  const customPath = getUniformatPricingCsvPathSetting()
  if (customPath && fs.existsSync(customPath)) return customPath

  // Configured custom path is missing (e.g. deleted in Explorer). Reset so we
  // do not keep reporting "custom" after restoring the bundled default.
  if (customPath) {
    clearUniformatPricingCsvPathSetting()
  }
  return ensureUniformatPricingCsv()
}

/**
 * Copy a validated CSV into userData and persist that stable path.
 * For an operation that also replaces the database catalogue, use
 * installUniformatPricingCsv() so a failed database commit restores these files.
 * The original source path/name are kept for Settings display only — the
 * working copy under userData is what the app reads and seeds from.
 */
function setUniformatPricingCsvPath(sourcePath) {
  const normalizedSource = String(sourcePath ?? '').trim()
  if (!normalizedSource || !fs.existsSync(normalizedSource)) {
    throw new Error('Uniformat pricing CSV file not found')
  }

  const storedPath = getStoredUniformatPricingCsvPath()
  if (path.resolve(normalizedSource) !== path.resolve(storedPath)) {
    writeFileAtomically(storedPath, fs.readFileSync(normalizedSource))
  }

  writeSettings({
    ...readSettings(),
    uniformatPricingCsvPath: storedPath,
    // Remember what the user picked so Settings can show it (working path is fixed).
    uniformatPricingCsvSourceName: path.basename(normalizedSource),
    uniformatPricingCsvSourcePath: normalizedSource,
  })
  return storedPath
}

function fileSnapshot(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
}

function restoreFileSnapshot(filePath, snapshot) {
  if (snapshot == null) {
    fs.rmSync(filePath, { force: true })
  } else {
    writeFileAtomically(filePath, snapshot)
  }
}

/**
 * Install the working CSV/settings and database catalogue as one recoverable
 * operation. `commitCatalogue` must use a database transaction; if it throws,
 * the previous working file and settings bytes are restored before the error
 * escapes.
 */
function installUniformatPricingCsv(sourcePath, commitCatalogue) {
  if (typeof commitCatalogue !== 'function') {
    throw new TypeError('installUniformatPricingCsv requires a commit callback')
  }
  const storedPath = getStoredUniformatPricingCsvPath()
  const settingsPath = getSettingsPath()
  const previousStored = fileSnapshot(storedPath)
  const previousSettings = fileSnapshot(settingsPath)
  try {
    setUniformatPricingCsvPath(sourcePath)
    commitCatalogue()
    return storedPath
  } catch (installError) {
    try {
      restoreFileSnapshot(storedPath, previousStored)
      restoreFileSnapshot(settingsPath, previousSettings)
    } catch (restoreError) {
      throw new Error(
        `Uniformat catalogue install failed (${String(installError?.message ?? installError)}). ` +
          `Restoring the previous files also failed (${String(restoreError?.message ?? restoreError)}).`,
      )
    }
    throw installError
  }
}

function getUniformatPricingCsvInfo() {
  const csvPath = getUniformatPricingCsvPath()
  const customPath = getUniformatPricingCsvPathSetting()
  const customExists = Boolean(customPath && fs.existsSync(customPath))
  const settings = readSettings()
  const sourceName =
    customExists &&
    typeof settings.uniformatPricingCsvSourceName === 'string' &&
    settings.uniformatPricingCsvSourceName.trim()
      ? settings.uniformatPricingCsvSourceName.trim()
      : null
  const sourcePath =
    customExists &&
    typeof settings.uniformatPricingCsvSourcePath === 'string' &&
    settings.uniformatPricingCsvSourcePath.trim()
      ? settings.uniformatPricingCsvSourcePath.trim()
      : null
  return {
    // Operational path: always the working copy under userData.
    path: csvPath,
    // Display name prefers the file the user last chose.
    fileName: sourceName || path.basename(csvPath),
    // Original pick (may no longer exist); for Settings path line / tooltips.
    sourcePath,
    customPath: customExists ? customPath : null,
    isDefault: !customExists,
  }
}

/**
 * After import, rewrite a custom pricing CSV path so it points at the stable
 * userData copy (handles archives made on another machine/profile).
 */
function normalizeImportedUniformatPricingPath() {
  const settings = readSettings()
  const customPath = settings.uniformatPricingCsvPath
  if (typeof customPath !== 'string' || !customPath.trim()) return

  const storedCsv = getStoredUniformatPricingCsvPath()
  // The operational CSV is always the copy included under userData. Never keep
  // an imported machine's arbitrary absolute path merely because that user
  // happened to give the source file a different basename.
  if (customPath === storedCsv) return
  writeSettings({
    ...settings,
    uniformatPricingCsvPath: storedCsv,
  })
}

module.exports = {
  getBundledUniformatPricingCsvPath,
  getStoredUniformatPricingCsvPath,
  ensureUniformatPricingCsv,
  getUniformatPricingCsvPath,
  getUniformatPricingCsvPathSetting,
  getUniformatPricingCsvInfo,
  setUniformatPricingCsvPath,
  installUniformatPricingCsv,
  normalizeImportedUniformatPricingPath,
}
