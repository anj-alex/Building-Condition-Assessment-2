const fs = require('node:fs')
const path = require('node:path')

/**
 * What the packaged application calls itself on disk.
 *
 * Electron Packager names the output directory *and* the executable after
 * `productName`, falling back to `name` — so the moment `productName` was added
 * to package.json, `out/condition-assesment-report-generator-linux-x64/` became
 * `out/Condition Assessment Report Generator-linux-x64/`. Both smoke tests had
 * the old string hardcoded and started failing on every CI run, at the step
 * after packaging, with a missing-directory error that named a directory nobody
 * had asked for.
 *
 * Derived rather than written down, in one place rather than two, because the
 * failure is entirely silent until a release build reaches the smoke step.
 */
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
)

/** The packaged product: the out directory's prefix and the executable's stem. */
const APP_NAME = manifest.productName || manifest.name

/**
 * The npm package name, which is also the Squirrel package id and so the
 * `%LOCALAPPDATA%` install directory — a different string, deliberately.
 */
const PACKAGE_NAME = manifest.name

module.exports = { APP_NAME, PACKAGE_NAME }
