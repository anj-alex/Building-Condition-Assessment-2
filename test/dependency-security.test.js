const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..')

test('privileged archive and workbook parsers stay on audited versions', () => {
  const packageJson = require('../package.json')
  const tarPackage = require('tar/package.json')
  const xlsx = require('xlsx')

  assert.equal(packageJson.dependencies.tar, '7.5.22')
  assert.equal(tarPackage.version, '7.5.22')
  assert.equal(packageJson.dependencies.xlsx, 'file:vendor/xlsx-0.20.3.tgz')
  assert.equal(xlsx.version, '0.20.3')
  assert.equal(packageJson.overrides.tar, '7.5.22')
  assert.equal(packageJson.overrides.tmp, '0.2.7')
})

test('build tooling cannot reinstall vulnerable tar or tmp copies', () => {
  const lock = require('../package-lock.json')
  const versions = (dependencyName) =>
    new Set(
      Object.entries(lock.packages)
        .filter(([location]) =>
          location === `node_modules/${dependencyName}` ||
          location.endsWith(`/node_modules/${dependencyName}`),
        )
        .map(([, metadata]) => metadata.version),
    )

  assert.deepEqual([...versions('tar')], ['7.5.22'])
  assert.deepEqual([...versions('tmp')], ['0.2.7'])
})

test('vendored SheetJS source matches the locked upstream tarball', () => {
  const tarball = fs.readFileSync(
    path.join(repoRoot, 'vendor', 'xlsx-0.20.3.tgz'),
  )
  const integrity = crypto.createHash('sha512').update(tarball).digest('base64')

  assert.equal(
    integrity,
    'oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==',
  )
})
