const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electronPath = require('electron')
const root = path.join(__dirname, '..')
const workbookPath = path.join(
  root,
  'samples',
  'Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx',
)
const extractScript = path.join(root, 'scripts', 'extract-bca-reference-data.py')

function findPython() {
  for (const cmd of ['python3', 'python', 'py']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    if (!probe.error && (probe.status ?? 1) === 0) return cmd
  }
  return null
}

function runReferenceDataCheck({ required }) {
  const python = findPython()
  if (!python) {
    const message =
      'BCA reference-data check skipped: no Python interpreter found (tried python3, python, py).'
    if (required) {
      console.error(message)
      console.error('Install Python or run with a PATH that includes it.')
      process.exit(1)
    }
    console.warn(`${message} Use npm run verify:data in CI when available.`)
    return
  }
  if (!fs.existsSync(workbookPath)) {
    const message = `BCA reference-data check skipped: missing workbook ${workbookPath}`
    if (required) {
      console.error(message)
      process.exit(1)
    }
    console.warn(`${message}. Use npm run verify:data in CI when the sample workbook is present.`)
    return
  }

  const extractCheck = spawnSync(python, [extractScript, '--check'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (extractCheck.error) {
    throw extractCheck.error
  }
  if ((extractCheck.status ?? 1) !== 0) {
    process.exit(extractCheck.status ?? 1)
  }
}

const verifyDataOnly = process.argv.includes('--verify-data')
if (verifyDataOnly) {
  runReferenceDataCheck({ required: true })
  process.exit(0)
}

runReferenceDataCheck({ required: false })

const testDir = path.join(__dirname, '..', 'test')
// Only top-level test/*.test.js — not helpers under test/helpers/.
const discovered = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join(testDir, name))
const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--verify-data')
// Flags like --test-name-pattern must not replace discovery (Node would then
// load test/helpers/*.js via **/test/**/* patterns). Only path-like args
// replace the default file list.
const fileArgs = extraArgs.filter((arg) => !arg.startsWith('-'))
const flagArgs = extraArgs.filter((arg) => arg.startsWith('-'))
const files = fileArgs.length > 0 ? fileArgs : discovered
const testArgs = ['--test', '--test-reporter=spec', ...flagArgs, ...files]
const result = spawnSync(electronPath, testArgs, {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
