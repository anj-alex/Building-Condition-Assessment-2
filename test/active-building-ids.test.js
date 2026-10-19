const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

/**
 * Drive `src/shared.js`'s hash parsers through the shared renderer harness: any
 * page loads shared.js into the realm, exposing the parsers as window globals,
 * and the report page's own `#project:b1,b2,…` hashes can then be replayed by
 * mutating `window.location.hash`.
 */
function hashHarness() {
  const { window } = loadPage('index.html', { hash: '1001:42' })
  return {
    ids: (hash) => {
      window.location.hash = hash
      const { projectId, buildingId } = window.getActiveIds()
      return { projectId, buildingId }
    },
    buildingIds: (hash) => {
      window.location.hash = hash
      return [...window.getActiveBuildingIds()]
    },
  }
}

test('a single-building hash yields one id', () => {
  const { buildingIds } = hashHarness()
  assert.deepEqual(buildingIds('#1001:42'), [42])
})

test('a comma-joined hash keeps every id in hash order', () => {
  const { buildingIds } = hashHarness()
  assert.deepEqual(buildingIds('#1001:42,7,19'), [42, 7, 19])
})

test('repeated ids collapse to one entry each', () => {
  const { buildingIds } = hashHarness()
  assert.deepEqual(buildingIds('#1001:42,42,7'), [42, 7])
})

test('missing, empty, and non-positive ids yield no buildings', () => {
  const { buildingIds } = hashHarness()
  assert.deepEqual(buildingIds('#1001'), [])
  assert.deepEqual(buildingIds('#1001:'), [])
  assert.deepEqual(buildingIds('#1001:0,-3,abc'), [])
})

test('getActiveIds still reads a lone building id and rejects a list', () => {
  const { ids } = hashHarness()
  assert.deepEqual(ids('#1001:42'), { projectId: 1001, buildingId: 42 })
  // Why getActiveBuildingIds exists: Number('42,7') is NaN, so pages that only
  // ever open one building keep their single-id contract untouched.
  assert.deepEqual(ids('#1001:42,7'), { projectId: 1001, buildingId: null })
})
