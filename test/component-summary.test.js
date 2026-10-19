const assert = require('node:assert/strict')
const test = require('node:test')

const {
  componentSummaryRows,
  componentSummaryTotal,
  orderedAssetGroups,
} = require('../src/lib/property-report-rules')

/** An asset in the shape getPropertyReportData hands the renderers. */
function asset(overrides = {}) {
  return {
    id: 1,
    asset_name: 'Component',
    level_1_group: 'C Interiors',
    level_2_code: 'C30',
    condition_rating: 'Fair',
    priority: 'Medium',
    action: 'Repair',
    assessed: true,
    capital: { scheduledActionYear: 2028, opinionOfProbableCost: 12000 },
    ...overrides,
  }
}

test('summary rows follow the order the findings section prints', () => {
  const rows = componentSummaryRows([
    asset({ id: 3, asset_name: 'Roof', level_1_group: 'B Shell', level_2_code: 'B30' }),
    asset({ id: 4, asset_name: 'Ceilings', level_2_code: 'C30' }),
    asset({ id: 5, asset_name: 'Footings', level_1_group: 'A Substructure', level_2_code: 'A10' }),
    asset({ id: 6, asset_name: 'Stairs', level_2_code: 'C20' }),
  ])
  assert.deepEqual(
    rows.map((row) => row.name),
    ['Footings', 'Roof', 'Stairs', 'Ceilings'],
  )
  // Level 1 groups A-G, then Level 2 within the group: C20 sorts before C30.
  assert.deepEqual(
    rows.map((row) => row.system),
    ['A Substructure', 'B Shell', 'C Interiors', 'C Interiors'],
  )
})

test('an asset with no Level 1 group is grouped as Unclassified, last', () => {
  const groups = [...orderedAssetGroups([
    asset({ asset_name: 'Loose end', level_1_group: '  ' }),
    asset({ asset_name: 'Ceilings' }),
  ]).keys()]
  assert.deepEqual(groups, ['C Interiors', 'Unclassified'])
})

test('a not-assessed component is listed with no findings and no cost', () => {
  const [row] = componentSummaryRows([
    asset({
      assessed: false,
      condition_rating: 'Fair',
      priority: 'High',
      action: 'Replace',
      capital: null,
    }),
  ])
  assert.equal(row.condition, 'Not Assessed')
  // Nothing was assessed, so nothing prefilled on the record is reported as a
  // finding — the same rule the asset page follows.
  assert.equal(row.priority, null)
  assert.equal(row.action, null)
  assert.equal(row.year, null)
  assert.equal(row.cost, null)
  assert.equal(componentSummaryTotal([row]), 0)
})

test('an overdue action year is flagged, not explained', () => {
  const [row] = componentSummaryRows([
    asset({
      capital: {
        actionYear: 1990,
        scheduledActionYear: 2026,
        actionYearIsOverdue: true,
        opinionOfProbableCost: 5000,
      },
    }),
  ])
  // The asset page prints "2026 — overdue (lifecycle date 1990)"; a column in a
  // seven-wide grid has no room for the lifecycle date.
  assert.equal(row.year, '2026 (overdue)')
})

test('the total adds up only the allowances the table prints', () => {
  const rows = componentSummaryRows([
    asset({ id: 1, capital: { opinionOfProbableCost: 12000 } }),
    asset({ id: 2, capital: { opinionOfProbableCost: 3000 } }),
    asset({ id: 3, assessed: false, capital: null }),
    asset({ id: 4, capital: { opinionOfProbableCost: null } }),
  ])
  assert.equal(componentSummaryTotal(rows), 15000)
})
