const fs = require('node:fs')
const path = require('node:path')

// Runtime data files: `data/schema.sql`, `data/location_factors.csv`, and
// `data/capital_planning_rules.json`. Product code reads them from disk.

const DATA_FILE_PREFIX = 'data/'

/**
 * Read one runtime data file as UTF-8 text.
 *
 * `name` must be a repository-relative path under `data/` (`data/schema.sql`).
 * The prefix check and `..` / `\` rejection keep this from being coaxed into
 * reading arbitrary files.
 */
function readDataFileText(name) {
  if (
    typeof name !== 'string' ||
    !name.startsWith(DATA_FILE_PREFIX) ||
    name.includes('..') ||
    name.includes('\\')
  ) {
    throw new TypeError(`Not a runtime data file name: ${JSON.stringify(name)}`)
  }
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8')
}

module.exports = {
  readDataFileText,
}
