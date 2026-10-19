/**
 * Run every real-Electron UI scenario sequentially.
 *
 * Sequential execution avoids single-instance-lock and debugging-port
 * collisions while keeping `npm run verify:ui` as the one documented gate.
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const scripts = [
  'verify-project-report.js',
  'verify-asset-calculations.js',
  'verify-project-recovery.js',
  'verify-excel-import.js',
  'verify-word-export.js',
]
const forwarded = process.argv.slice(2)

for (const script of scripts) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, script), ...forwarded],
    {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status || 1
    break
  }
}
