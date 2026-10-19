/**
 * Launch the packaged application and assert it actually works.
 *
 * Scenarios matter as much as the assertions: v1.0.2 shipped a Windows build
 * that exited instantly on every machine with an existing database, because CI
 * only ever launched it against an empty userData directory and never opened a
 * window. Each scenario below covers one of those blind spots.
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const platform = process.argv[2] ?? process.platform
if (!['linux', 'win32'].includes(platform)) {
  throw new Error(`Unsupported packaged smoke-test platform: ${platform}`)
}

const { APP_NAME: appName } = require('./app-identity')

const repoRoot = path.join(__dirname, '..')
const packageDirectory = path.join(repoRoot, 'out', `${appName}-${platform}-x64`)
const executablePath = path.join(
  packageDirectory,
  platform === 'win32' ? `${appName}.exe` : appName,
)
const asarPath = path.join(packageDirectory, 'resources', 'app.asar')
const release1SchemaPath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'schema',
  'v1.sql',
)

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged executable not found: ${executablePath}`)
}

/** Normalize asar list paths to POSIX so Windows backslashes compare cleanly. */
function toPosixPath(entry) {
  return String(entry).replace(/\\/g, '/')
}

/**
 * List asar entries as POSIX paths. Prefer the library API (stable, no shell)
 * and fall back to `npx asar list`.
 */
function listAsarEntries(filePath) {
  try {
    const asar = require('@electron/asar')
    if (typeof asar.listPackage === 'function') {
      return asar.listPackage(filePath).map(toPosixPath)
    }
  } catch {
    // @electron/asar may not resolve from this script's location in odd installs.
  }

  const list = spawnSync('npx', ['asar', 'list', filePath], {
    encoding: 'utf8',
    shell: platform === 'win32',
  })
  if (list.error) throw list.error
  if (list.status !== 0) {
    throw new Error(
      `asar list failed with status ${list.status}: ${list.stderr || list.stdout}`,
    )
  }
  return list.stdout.split(/\r?\n/).filter(Boolean).map(toPosixPath)
}

/**
 * Confirm the asar does not ship dev-only paths that used to leak into releases.
 */
function assertAsarExcludesDevArtifacts() {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged asar not found: ${asarPath}`)
  }

  const entries = listAsarEntries(asarPath)
  const entrySet = new Set(entries)

  const forbidden = [
    '/data/dummy_data.sql',
    '/load-local-db.sh',
    '/samples',
    '/docs',
    '/test',
    '/scripts',
    '/.venv',
    '/venv',
    '/.github',
    '/.agents',
    '/AGENTS.md',
    '/CLAUDE.md',
    '/README.md',
    '/forge.config.js',
    '/package-lock.json',
  ]

  const leaks = forbidden.filter((prefix) =>
    entries.some(
      (entry) => entry === prefix || entry.startsWith(`${prefix}/`),
    ),
  )
  if (leaks.length > 0) {
    throw new Error(
      `Packaged asar includes forbidden dev artifacts:\n  ${leaks.join('\n  ')}`,
    )
  }

  const required = [
    '/data/schema.sql',
    '/data/uniformat_pricing.csv',
    '/src/main.js',
    '/src/db.js',
    '/src/preload.js',
    '/src/lib/csv-utils.js',
    '/pages/index.html',
    '/pages/property-report.html',
    '/styles/styles.css',
    '/node_modules/jszip/dist/jszip.min.js',
    '/node_modules/docx-preview/dist/docx-preview.min.js',
    '/package.json',
  ]
  const missing = required.filter((entry) => !entrySet.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `Packaged asar is missing required runtime files:\n  ${missing.join('\n  ')}`,
    )
  }
}

/**
 * Run SQLite without loading better-sqlite3 (which is rebuilt for Electron's
 * Node ABI, not the host `node` that runs this script). Requires python3/python
 * with the stdlib sqlite3 module.
 */
function runPython(script, ...args) {
  let lastError = null
  for (const python of ['python3', 'python']) {
    const result = spawnSync(python, ['-c', script, ...args], {
      encoding: 'utf8',
    })
    if (result.error) {
      lastError = result.error
      continue
    }
    if (result.status !== 0) {
      lastError = new Error(result.stderr || result.stdout || `${python} failed`)
      continue
    }
    return String(result.stdout).trim()
  }
  throw new Error(
    `Failed to run SQLite helper (need python3/python with sqlite3): ${lastError}`,
  )
}

function queryScalar(dbPath, sql) {
  const output = runPython(
    'import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])',
    dbPath,
    sql,
  )
  const value = Number(output)
  if (!Number.isFinite(value)) {
    throw new Error(
      `Smoke-test DB query returned a non-numeric result for ${sql}: ${JSON.stringify(output)}`,
    )
  }
  return value
}

/** Materialize a database in the shape shipped by releases 1.0.0–1.0.2. */
function writeRelease1Database(dbPath) {
  runPython(
    'import sqlite3, sys\n' +
      'con = sqlite3.connect(sys.argv[1])\n' +
      'con.executescript(open(sys.argv[2]).read())\n' +
      "con.execute(\"INSERT INTO project (id, client) VALUES (1, 'Existing client')\")\n" +
      'con.execute("INSERT INTO building (id, project_id, property_name) VALUES (1, 1, \'Existing building\')")\n' +
      'con.execute("INSERT INTO asset (id, building_id, asset_name, action_year) VALUES (1, 1, \'Existing asset\', \'2029\')")\n' +
      'con.commit()\n' +
      'con.close()',
    dbPath,
    release1SchemaPath,
  )
}

function makeUserDataDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${appName}-smoke-${label}-`))
}

/**
 * Linux needs a display to open a real window: `--ozone-platform=headless`
 * survives a main-process-only launch but segfaults the moment a BrowserWindow
 * is created, and plain `--headless` with no display can still select Wayland
 * and die in initialization. CI therefore runs this script under `xvfb-run`.
 *
 * Failing here rather than skipping the window scenario is deliberate — silently
 * dropping coverage is how the v1.0.2 crash reached users in the first place.
 */
if (platform === 'linux' && !process.env.DISPLAY) {
  throw new Error(
    'No DISPLAY available. Run the Linux packaged smoke test under a virtual ' +
      'display, e.g. `xvfb-run --auto-servernum npm run test:packaged -- linux`.',
  )
}

const appArguments =
  platform === 'linux' ? ['--disable-gpu', '--no-sandbox'] : ['--disable-gpu']

/**
 * @param {object} options
 * @param {string} options.userDataDirectory
 * @param {Record<string,string>} [options.env] extra environment for this run
 * @param {number} options.expectedStatus
 */
function runPackagedApp({ userDataDirectory, env = {}, expectedStatus, label }) {
  const result = spawnSync(executablePath, appArguments, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONDITION_ASSESSMENT_SMOKE_TEST: '1',
      CONDITION_ASSESSMENT_USER_DATA: userDataDirectory,
      ...env,
    },
    timeout: 180_000,
    windowsHide: true,
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error

  if (result.status !== expectedStatus) {
    throw new Error(
      `[${label}] packaged app exited with status ${result.status ?? 'unknown'}` +
        (result.signal ? ` (${result.signal})` : '') +
        `; expected ${expectedStatus}`,
    )
  }
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}\nLooked for: ${needle}`)
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const scenarios = []

/**
 * First launch on a clean machine: the app must build its own database, seed the
 * pricing catalogue, and ship no sample projects.
 */
scenarios.push(function freshInstall() {
  const userData = makeUserDataDirectory('fresh')
  try {
    runPackagedApp({
      userDataDirectory: userData,
      expectedStatus: 0,
      label: 'fresh install',
    })

    const dbPath = path.join(userData, 'app.db')
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Smoke-test database was not created: ${dbPath}`)
    }

    const projectCount = queryScalar(dbPath, 'SELECT COUNT(*) FROM project')
    if (projectCount !== 0) {
      throw new Error(
        `Packaged app seeded dummy projects (project count = ${projectCount}); expected 0`,
      )
    }
    const pricingCount = queryScalar(
      dbPath,
      'SELECT COUNT(*) FROM uniformat_pricing',
    )
    if (pricingCount <= 0) {
      throw new Error(
        'Packaged app did not seed Uniformat pricing catalogue on first open',
      )
    }

    const schemaVersion = queryScalar(dbPath, 'PRAGMA user_version')
    if (schemaVersion <= 0) {
      throw new Error(
        `A newly created database must record its schema version; got ${schemaVersion}`,
      )
    }
    return { schemaVersion }
  } finally {
    fs.rmSync(userData, { force: true, recursive: true })
  }
})

/**
 * The window, preload and renderer are where "the app opens but does nothing"
 * bugs live. A main-process-only launch cannot see any of them.
 */
scenarios.push(function windowLoads() {
  const userData = makeUserDataDirectory('window')
  try {
    const { stdout } = runPackagedApp({
      userDataDirectory: userData,
      env: { CONDITION_ASSESSMENT_SMOKE_WINDOW: '1' },
      expectedStatus: 0,
      label: 'window loads',
    })
    assertIncludes(
      stdout,
      'Packaged window loaded cleanly.',
      'The window smoke run exited 0 without reporting a clean load.',
    )
  } finally {
    fs.rmSync(userData, { force: true, recursive: true })
  }
})

/**
 * The v1.0.2 regression, pinned: upgrading over an existing database must fail
 * loudly and say what is wrong, never exit silently.
 */
scenarios.push(function upgradeAsksBeforeMigrating() {
  const userData = makeUserDataDirectory('upgrade')
  try {
    const dbPath = path.join(userData, 'app.db')
    writeRelease1Database(dbPath)

    const { stderr } = runPackagedApp({
      userDataDirectory: userData,
      expectedStatus: 1,
      label: 'upgrade without approval',
    })
    assertIncludes(
      stderr,
      'needs migration',
      'An older database must explain that it needs migrating.',
    )

    // Nothing may change until the user agrees.
    const version = queryScalar(dbPath, 'PRAGMA user_version')
    if (version !== 0) {
      throw new Error(
        `An unapproved run modified the database (user_version = ${version})`,
      )
    }
  } finally {
    fs.rmSync(userData, { force: true, recursive: true })
  }
})

/**
 * The approved upgrade: data survives, the file lands on the current schema,
 * and the pre-migration copy is kept beside it.
 */
scenarios.push(function approvedMigrationPreservesData(freshResult) {
  const userData = makeUserDataDirectory('migrate')
  try {
    const dbPath = path.join(userData, 'app.db')
    writeRelease1Database(dbPath)

    runPackagedApp({
      userDataDirectory: userData,
      env: { CONDITION_ASSESSMENT_RESET_DB: '1' },
      expectedStatus: 0,
      label: 'approved migration',
    })

    const version = queryScalar(dbPath, 'PRAGMA user_version')
    if (version !== freshResult.schemaVersion) {
      throw new Error(
        `Migrated database is at schema version ${version}; a fresh one is at ${freshResult.schemaVersion}`,
      )
    }

    const projectCount = queryScalar(dbPath, 'SELECT COUNT(*) FROM project')
    if (projectCount !== 1) {
      throw new Error(
        `Migration lost project rows (project count = ${projectCount}); expected 1`,
      )
    }
    const actionYear = queryScalar(
      dbPath,
      'SELECT action_year FROM asset WHERE id = 1',
    )
    if (actionYear !== 2029) {
      throw new Error(
        `Migration did not retype action_year (got ${actionYear}); expected 2029`,
      )
    }

    const backups = fs
      .readdirSync(userData)
      .filter((name) => name.startsWith('app.db.') && name.endsWith('.bak'))
    if (backups.length !== 1) {
      throw new Error(
        `Expected exactly one pre-migration backup beside the database, found ${backups.length}: ${backups.join(', ')}`,
      )
    }
    // The backup must still be the original, openable v1 file.
    const backupVersion = queryScalar(
      path.join(userData, backups[0]),
      'PRAGMA user_version',
    )
    if (backupVersion !== 0) {
      throw new Error(
        `The backup was migrated too (user_version = ${backupVersion}); it must stay as it was`,
      )
    }
  } finally {
    fs.rmSync(userData, { force: true, recursive: true })
  }
})

/**
 * Two copies of the app on one data file each hold their own connection and
 * their own cached rows, so they overwrite each other silently — and a second
 * copy could start migrating a file the first one already has open. Launching
 * twice is one double-click on a Windows shortcut.
 *
 * The assertion that matters most is the last one: refusing the *first*
 * instance would brick the app for everyone.
 */
scenarios.push(async function secondInstanceIsRefused() {
  const userData = makeUserDataDirectory('single-instance')
  const first = spawn(executablePath, appArguments, {
    env: {
      ...process.env,
      CONDITION_ASSESSMENT_SMOKE_TEST: '1',
      CONDITION_ASSESSMENT_USER_DATA: userData,
      CONDITION_ASSESSMENT_SMOKE_WINDOW: '1',
      // Hold the loaded window open long enough to launch a second copy at it.
      CONDITION_ASSESSMENT_SMOKE_SETTLE_MS: '15000',
    },
    windowsHide: true,
  })

  let firstOutput = ''
  let firstExited = false
  for (const stream of [first.stdout, first.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      firstOutput += chunk
    })
  }
  const firstExit = new Promise((resolve) => {
    first.once('exit', (code, signal) => {
      firstExited = true
      resolve({ code, signal })
    })
  })

  try {
    // The lock is requested before the database is opened, so an existing
    // app.db proves the first instance is already holding it.
    const dbPath = path.join(userData, 'app.db')
    const deadline = Date.now() + 120_000
    while (!fs.existsSync(dbPath)) {
      if (firstExited) {
        throw new Error('First instance exited before opening its database')
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the first instance to start')
      }
      await delay(250)
    }

    const second = runPackagedApp({
      userDataDirectory: userData,
      expectedStatus: 1,
      label: 'second instance',
    })
    assertIncludes(
      second.stderr,
      'Another copy of this app is already using',
      'A second instance started against a data file the first one had open.',
    )

    const { code, signal } = await firstExit
    if (code !== 0) {
      throw new Error(
        `First instance exited ${code ?? 'unknown'}${signal ? ` (${signal})` : ''} ` +
          'after a second copy was launched; it should have been unaffected',
      )
    }
    assertIncludes(
      firstOutput,
      'Packaged window loaded cleanly.',
      'The first instance did not survive a second launch.',
    )
  } finally {
    if (!firstExited) first.kill()
    // Print whatever the first instance said last, so a failure above is read
    // alongside it rather than on its own.
    if (firstOutput) process.stdout.write(firstOutput)
    fs.rmSync(userData, { force: true, recursive: true })
  }
})

assertAsarExcludesDevArtifacts()

async function runScenarios() {
  let freshResult = null
  for (const scenario of scenarios) {
    console.log(`\n--- ${platform} smoke scenario: ${scenario.name} ---`)
    const result = await scenario(freshResult)
    if (scenario.name === 'freshInstall') freshResult = result
  }
  console.log(
    `\nAll ${scenarios.length} packaged ${platform} smoke scenarios passed.`,
  )
}

runScenarios().catch((error) => {
  console.error(error)
  process.exit(1)
})
