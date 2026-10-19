const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { readDataFileText } = require('../src/data-files')

test('reads repository data files from disk', () => {
  assert.equal(
    readDataFileText('data/schema.sql'),
    fs.readFileSync(path.join(__dirname, '..', 'data', 'schema.sql'), 'utf8'),
  )
  assert.ok(readDataFileText('data/location_factors.csv').includes('province'))
  assert.ok(readDataFileText('data/capital_planning_rules.json').startsWith('{'))
})

test('only names under data/ are read — traversal is refused before any I/O', () => {
  for (const bad of [
    '../data/schema.sql',
    'data/../package.json',
    'data\\schema.sql',
    'schema.sql',
    '/etc/passwd',
    42,
    null,
  ]) {
    assert.throws(() => readDataFileText(bad), TypeError, JSON.stringify(bad))
  }
})
