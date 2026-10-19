const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ASSET_EDITABLE_FIELDS,
  assetPayloadEqualsSnapshot,
} = require('../src/db')
const undoHistory = require('../src/undo-history')
const {
  ASSET_UPDATE_COALESCE_MS,
  MAX_ENTRIES,
} = undoHistory

function assetValues(overrides = {}) {
  return Object.fromEntries(
    ASSET_EDITABLE_FIELDS.map((field) => [field, overrides[field] ?? null]),
  )
}

test('asset change detection compares text fields without numeric coercion', () => {
  const before = assetValues({
    asset_name: '01',
    unit_measure: '1000.00',
  })

  assert.equal(
    assetPayloadEqualsSnapshot(assetValues({
      asset_name: '1',
      unit_measure: '1000.00',
    }), before),
    false,
  )
  assert.equal(
    assetPayloadEqualsSnapshot(assetValues({
      asset_name: '01',
      unit_measure: '1000',
    }), before),
    false,
  )
})

test('asset change detection still normalizes numeric database fields', () => {
  const before = assetValues({
    vintage: 2001,
    service_life: 25,
    opinion_of_probable_cost: 1000,
  })
  const payload = assetValues({
    vintage: '2001',
    service_life: '25.0',
    opinion_of_probable_cost: '1000.00',
  })

  assert.equal(assetPayloadEqualsSnapshot(payload, before), true)
})

test('asset update history preserves project and building ownership', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushAssetUpdate(
    17,
    assetValues({ asset_name: 'Roof' }),
    { buildingId: 8, projectId: 3, level1Group: 'B Shell' },
  )

  assert.deepEqual(
    {
      assetId: undoHistory.peek().assetId,
      buildingId: undoHistory.peek().buildingId,
      projectId: undoHistory.peek().projectId,
      level1Group: undoHistory.peek().level1Group,
    },
    {
      assetId: 17,
      buildingId: 8,
      projectId: 3,
      level1Group: 'B Shell',
    },
  )
})

test('building/project/firm/summary updates coalesce within the window', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushBuildingUpdate(9, { property_name: 'A' }, { projectId: 1 })
  undoHistory.pushBuildingUpdate(9, { property_name: 'B' }, { projectId: 1 })
  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.peek().before.property_name, 'A')
  assert.equal(undoHistory.peek().type, 'building-update')

  undoHistory.pushProjectUpdate(2, { client: 'Old' })
  undoHistory.pushProjectUpdate(2, { client: 'New' })
  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.peek().type, 'project-update')
  assert.equal(undoHistory.peek().before.client, 'Old')

  undoHistory.pushFirmUpdate({ name: 'Before', logo_path: null })
  undoHistory.pushFirmUpdate({ name: 'After', logo_path: '/x.png' })
  assert.equal(undoHistory.size(), 3)
  assert.equal(undoHistory.peek().type, 'firm-update')
  assert.equal(undoHistory.peek().before.name, 'Before')

  undoHistory.pushExecutiveSummaryUpdate(9, { accessibility: 'a' }, { projectId: 1 })
  undoHistory.pushExecutiveSummaryUpdate(9, { accessibility: 'b' }, { projectId: 1 })
  assert.equal(undoHistory.size(), 4)
  assert.equal(undoHistory.peek().before.accessibility, 'a')
})

test('different entities do not coalesce field updates', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushBuildingUpdate(1, { property_name: 'One' }, { projectId: 1 })
  undoHistory.pushBuildingUpdate(2, { property_name: 'Two' }, { projectId: 1 })
  assert.equal(undoHistory.size(), 2)
})

test('undo moves entry to redo stack and redo moves it back', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.push({ type: 'asset-delete', assetId: 1, label: 'A' })
  undoHistory.push({ type: 'asset-delete', assetId: 2, label: 'B' })
  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.redoSize(), 0)

  const undone = undoHistory.pop()
  undoHistory.pushRedo(undone)
  assert.equal(undone.label, 'B')
  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.redoSize(), 1)
  assert.equal(undoHistory.peekRedo().label, 'B')

  const redone = undoHistory.popRedo()
  undoHistory.requeue(redone)
  assert.equal(redone.label, 'B')
  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.redoSize(), 0)
  assert.equal(undoHistory.peek().label, 'B')
})

test('new user action clears the redo stack', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.push({ type: 'asset-delete', assetId: 1, label: 'A' })
  const entry = undoHistory.pop()
  undoHistory.pushRedo(entry)
  assert.equal(undoHistory.redoSize(), 1)

  undoHistory.push({ type: 'asset-delete', assetId: 2, label: 'C' })
  assert.equal(undoHistory.redoSize(), 0)
  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.peek().label, 'C')
})

test('requeue does not clear the redo stack', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.push({ type: 'asset-delete', assetId: 1, label: 'A' })
  undoHistory.push({ type: 'asset-delete', assetId: 2, label: 'B' })
  // Pop B (most recent), park it on redo.
  const first = undoHistory.pop()
  undoHistory.pushRedo(first)
  // Pop A, then requeue it (failed undo recovery must keep redo intact).
  const second = undoHistory.pop()
  undoHistory.requeue(second)

  assert.equal(first.label, 'B')
  assert.equal(second.label, 'A')
  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.redoSize(), 1)
  assert.equal(undoHistory.peek().label, 'A')
  assert.equal(undoHistory.peekRedo().label, 'B')
})

test('clearRedo drops redo without touching undo', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.push({ type: 'asset-delete', assetId: 1, label: 'A' })
  const entry = undoHistory.pop()
  undoHistory.pushRedo(entry)
  assert.equal(undoHistory.redoSize(), 1)

  undoHistory.clearRedo()
  assert.equal(undoHistory.redoSize(), 0)
  assert.equal(undoHistory.size(), 0)
})

test('asset-update coalesce skips entries that already have after', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushAssetUpdate(
    9,
    assetValues({ asset_name: 'Before' }),
    { buildingId: 1, projectId: 1 },
  )
  const entry = undoHistory.pop()
  entry.after = assetValues({ asset_name: 'After' })
  // Simulate successful redo: entry with after is back on the undo stack.
  undoHistory.requeue(entry)
  assert.equal(undoHistory.size(), 1)

  undoHistory.pushAssetUpdate(
    9,
    assetValues({ asset_name: 'After' }),
    { buildingId: 1, projectId: 1 },
  )

  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.peek().before.asset_name, 'After')
  assert.equal(undoHistory.peek().after, undefined)
  // Original step remains intact under the new one.
  const older = undoHistory.pop()
  const original = undoHistory.peek()
  assert.equal(older.before.asset_name, 'After')
  assert.equal(original.before.asset_name, 'Before')
  assert.deepEqual(original.after, assetValues({ asset_name: 'After' }))
})

test('asset-update coalesce clears redo on continued typing', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushAssetUpdate(
    5,
    assetValues({ asset_name: 'V1' }),
    { buildingId: 1, projectId: 1 },
  )
  undoHistory.push({ type: 'asset-delete', assetId: 99, label: 'Other' })
  const other = undoHistory.pop()
  undoHistory.pushRedo(other)
  assert.equal(undoHistory.redoSize(), 1)

  // Coalesce into the open asset-update (no after) — must still invalidate redo.
  undoHistory.pushAssetUpdate(
    5,
    assetValues({ asset_name: 'V2' }),
    { buildingId: 1, projectId: 1 },
  )

  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.redoSize(), 0)
  assert.equal(undoHistory.peek().before.asset_name, 'V1')
})

test('asset-update coalesce window expiry creates a second entry', (t) => {
  undoHistory.clear()
  t.after(() => {
    t.mock.timers.reset()
    undoHistory.clear()
  })
  t.mock.timers.enable({ apis: ['Date'] })

  undoHistory.pushAssetUpdate(
    3,
    assetValues({ asset_name: 'First' }),
    { buildingId: 1, projectId: 1 },
  )
  assert.equal(undoHistory.size(), 1)

  t.mock.timers.tick(ASSET_UPDATE_COALESCE_MS)

  undoHistory.pushAssetUpdate(
    3,
    assetValues({ asset_name: 'Later' }),
    { buildingId: 1, projectId: 1 },
  )

  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.peek().before.asset_name, 'Later')
  const later = undoHistory.pop()
  assert.equal(later.before.asset_name, 'Later')
  assert.equal(undoHistory.peek().before.asset_name, 'First')
})

test('coalesced updates keep the earliest before snapshot', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushAssetUpdate(
    7,
    assetValues({ asset_name: 'Original' }),
    { buildingId: 1, projectId: 1 },
  )
  undoHistory.pushAssetUpdate(
    7,
    assetValues({ asset_name: 'Typed more' }),
    { buildingId: 1, projectId: 1 },
  )

  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.peek().before.asset_name, 'Original')
})

test('different asset does not coalesce within the window', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.pushAssetUpdate(
    1,
    assetValues({ asset_name: 'A' }),
    { buildingId: 1, projectId: 1 },
  )
  undoHistory.pushAssetUpdate(
    2,
    assetValues({ asset_name: 'B' }),
    { buildingId: 1, projectId: 1 },
  )

  assert.equal(undoHistory.size(), 2)
  assert.equal(undoHistory.peek().assetId, 2)
})

test('MAX_ENTRIES cap drops oldest undo and redo entries', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  for (let i = 1; i <= MAX_ENTRIES + 1; i += 1) {
    undoHistory.push({ type: 'marker', n: i })
  }
  assert.equal(undoHistory.size(), MAX_ENTRIES)
  // Pop newest → expect MAX_ENTRIES + 1; drain remainder → oldest remaining is n: 2.
  const newest = undoHistory.pop()
  assert.equal(newest.n, MAX_ENTRIES + 1)
  let oldest = null
  while (undoHistory.size() > 0) {
    oldest = undoHistory.pop()
  }
  assert.equal(oldest.n, 2)

  // Same cap for redo via pushRedo.
  for (let i = 1; i <= MAX_ENTRIES + 1; i += 1) {
    undoHistory.pushRedo({ type: 'redo-marker', n: i })
  }
  assert.equal(undoHistory.redoSize(), MAX_ENTRIES)
  const newestRedo = undoHistory.popRedo()
  assert.equal(newestRedo.n, MAX_ENTRIES + 1)
  let oldestRedo = null
  while (undoHistory.redoSize() > 0) {
    oldestRedo = undoHistory.popRedo()
  }
  assert.equal(oldestRedo.n, 2)
})

test('invalid push / pushAssetUpdate inputs are no-ops', (t) => {
  undoHistory.clear()
  t.after(() => undoHistory.clear())

  undoHistory.push({ type: 'seed', label: 'keep-me' })
  assert.equal(undoHistory.size(), 1)

  const snap = assetValues({ asset_name: 'X' })
  undoHistory.pushAssetUpdate(0, snap)
  undoHistory.pushAssetUpdate(NaN, snap)
  undoHistory.pushAssetUpdate(1, null)
  undoHistory.push('not an object')
  undoHistory.push(null)

  assert.equal(undoHistory.size(), 1)
  assert.equal(undoHistory.peek().label, 'keep-me')
  assert.equal(undoHistory.redoSize(), 0)
})
