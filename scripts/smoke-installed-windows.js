/**
 * Install the Squirrel package the way a user does, then launch what it
 * installed.
 *
 * Everything else in CI tests `out/<app>-win32-x64/` — the directory the
 * packager produced. Users never run that. They run Setup.exe, which unpacks a
 * NuGet payload into %LOCALAPPDATA%, invokes the app with Squirrel's install
 * hooks, and creates shortcuts. None of that was covered when the v1.0.2
 * release shipped.
 *
 * Windows only. Uninstalls itself again on the way out.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'win32') {
  throw new Error('smoke-installed-windows.js only runs on Windows')
}

// The executable Squirrel installs is named after productName; the install
// directory it goes into is named after the package id, which is the npm name.
// Two different strings — see scripts/app-identity.js.
const { APP_NAME: appName } = require('./app-identity')

const repoRoot = path.join(__dirname, '..')
const makeDirectory = path.join(repoRoot, 'out', 'make')
const localAppData =
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')

function findFile(directory, predicate) {
  if (!fs.existsSync(directory)) return null
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(full, predicate)
      if (nested) return nested
    } else if (predicate(entry.name, full)) {
      return full
    }
  }
  return null
}

function waitFor(description, check, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    // Busy-wait on the filesystem; Squirrel gives us nothing to await.
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'])
  }
}

const setupExe = findFile(makeDirectory, (name) => /Setup\.exe$/i.test(name))
if (!setupExe) {
  throw new Error(`No Squirrel Setup.exe found under ${makeDirectory}`)
}

const nupkg = findFile(makeDirectory, (name) => /-full\.nupkg$/i.test(name))
if (!nupkg) {
  throw new Error(`No .nupkg found under ${makeDirectory}`)
}
// Squirrel installs to %LOCALAPPDATA%\<package id>; the id is the nupkg prefix.
// The version may carry a prerelease tag (1.1.0-beta1), so strip a full semver
// rather than digits-and-dots.
const nupkgName = path.basename(nupkg)
const versionMatch = nupkgName.match(
  /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-full\.nupkg$/i,
)
if (!versionMatch) {
  throw new Error(`Cannot read the package id from ${nupkgName}`)
}
const packageId = nupkgName.slice(0, nupkgName.length - versionMatch[0].length)
const installRoot = path.join(localAppData, packageId)

console.log(`Setup:     ${setupExe}`)
console.log(`Package:   ${packageId}`)
console.log(`Install to: ${installRoot}`)

function findInstalledExecutable() {
  if (!fs.existsSync(installRoot)) return null
  const appDirectory = fs
    .readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('app-'))
    .map((entry) => path.join(installRoot, entry.name))
    .sort()
    .pop()
  if (!appDirectory) return null
  const exe = path.join(appDirectory, `${appName}.exe`)
  return fs.existsSync(exe) ? exe : null
}

function startMenuShortcuts() {
  const roots = [
    path.join(
      process.env.APPDATA ?? '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    ),
    path.join(
      process.env.ProgramData ?? '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    ),
  ].filter((root) => root && fs.existsSync(root))

  const found = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.lnk$/i.test(entry.name) && entry.name.toLowerCase().includes('condition')) {
        found.push(full)
      }
    }
  }
  for (const root of roots) walk(root)
  return found
}

/** Resolve a .lnk's target through the shell, the only thing that reads them. */
function shortcutTarget(shortcutPath) {
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${JSON.stringify(
    shortcutPath,
  )}); Write-Output $s.TargetPath`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(
      `Could not read shortcut ${shortcutPath}: ${result.stderr || result.status}`,
    )
  }
  return result.stdout.trim()
}

function uninstall() {
  const updateExe = path.join(installRoot, 'Update.exe')
  if (!fs.existsSync(updateExe)) return null
  console.log('Uninstalling…')
  const result = spawnSync(updateExe, ['--uninstall'], {
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (result.error) return result.error.message
  if (result.status !== 0) {
    return `Update.exe --uninstall exited ${result.status ?? 'unknown'}`
  }
  return null
}

// Shortcuts that already existed, so the assertion below is about this install
// rather than about anything left behind by an earlier run.
const shortcutsBefore = new Set(startMenuShortcuts())

let smokeTestPassed = false
try {
  console.log('Installing silently…')
  const install = spawnSync(setupExe, ['--silent'], {
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
  })
  if (install.stdout) process.stdout.write(install.stdout)
  if (install.stderr) process.stderr.write(install.stderr)
  if (install.error) throw install.error
  if (install.status !== 0) {
    throw new Error(
      `Setup.exe --silent exited ${install.status ?? 'unknown'}` +
        (install.signal ? ` (${install.signal})` : ''),
    )
  }

  const installedExe = waitFor(
    'the installed executable to appear',
    findInstalledExecutable,
  )
  console.log(`Installed: ${installedExe}`)

  // Without the electron-squirrel-startup hook the app opens a window during
  // install instead of creating shortcuts, and Squirrel eventually kills it.
  const shortcuts = startMenuShortcuts().filter(
    (shortcut) => !shortcutsBefore.has(shortcut),
  )
  if (shortcuts.length === 0) {
    throw new Error(
      'Install created no Start Menu shortcut — the Squirrel install hook did not run.',
    )
  }
  console.log(`Shortcuts: ${shortcuts.join(', ')}`)

  // A shortcut pointing at the wrong place is as broken as no shortcut.
  const targets = shortcuts.map(shortcutTarget)
  if (!targets.some((target) => target && target.startsWith(installRoot))) {
    throw new Error(
      `No new shortcut points into ${installRoot} (targets: ${targets.join(', ')})`,
    )
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `${appName}-installed-`))
  try {
    for (const [label, extraEnv] of [
      ['starts up', {}],
      ['opens its window', { CONDITION_ASSESSMENT_SMOKE_WINDOW: '1' }],
    ]) {
      fs.rmSync(userData, { force: true, recursive: true })
      fs.mkdirSync(userData, { recursive: true })

      console.log(`\n--- installed app ${label} ---`)
      const run = spawnSync(installedExe, ['--disable-gpu'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CONDITION_ASSESSMENT_SMOKE_TEST: '1',
          CONDITION_ASSESSMENT_USER_DATA: userData,
          ...extraEnv,
        },
        timeout: 180_000,
        windowsHide: true,
      })
      if (run.stdout) process.stdout.write(run.stdout)
      if (run.stderr) process.stderr.write(run.stderr)
      if (run.error) throw run.error
      if (run.status !== 0) {
        throw new Error(
          `Installed app failed to ${label}: exit ${run.status ?? 'unknown'}` +
            (run.signal ? ` (${run.signal})` : ''),
        )
      }
    }

    if (!fs.existsSync(path.join(userData, 'app.db'))) {
      throw new Error('Installed app did not create its database')
    }
  } finally {
    fs.rmSync(userData, { force: true, recursive: true })
  }

  console.log('\nInstalled Windows app installs, gets shortcuts, and launches cleanly.')
  smokeTestPassed = true
} finally {
  const uninstallFailure = uninstall()
  if (uninstallFailure) {
    // Never let cleanup bury the real failure, but never pass while the
    // uninstaller is broken either.
    console.error(`Uninstall failed: ${uninstallFailure}`)
    if (smokeTestPassed) {
      throw new Error(`Uninstall failed: ${uninstallFailure}`)
    }
  }
}
