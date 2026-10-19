const assert = require('node:assert/strict')
const test = require('node:test')

const {
  conditionScore,
  conditionBandLabel,
  formatMoney,
  formatPercent,
  histogram,
  formatHistogram,
  planIndex,
  resolveStartYear,
  termTotalsForAssets,
  termLabelForYear,
  summarizeAssets,
  formatRollupLines,
  formatCapitalPositionLines,
  rankAssetsBySeverity,
  rankAssetsByCost,
} = require('../src/lib/asset-rollup')
const { calculateCapitalPlan } = require('../src/lib/capital-planning')

const BUILDING = {
  id: 1,
  property_name: 'Test Tower',
  date_of_assessment: '2026-03-14',
  location_factor: 1,
}

/** Two overdue assets, one healthy, one suppressed (No Action / N/A). */
const ASSETS = [
  {
    id: 1,
    asset_name: 'AHU-1',
    level_1_code: 'D',
    level_2_code: 'D30',
    vintage: 1998,
    service_life: 25,
    quantity: 2,
    unit_price: '48000',
    condition_rating: 'Poor',
    priority: 'High',
    action: 'Replace',
    term: 'Immediate',
  },
  {
    id: 2,
    asset_name: 'Boiler',
    level_1_code: 'D',
    level_2_code: 'D30',
    vintage: 2012,
    service_life: 30,
    quantity: 1,
    unit_price: '95000',
    condition_rating: 'Good',
    priority: 'Low',
    action: 'Maintain',
    term: 'Long Term',
  },
  {
    id: 3,
    asset_name: 'Elevator cab',
    level_1_code: 'D',
    level_2_code: 'D10',
    vintage: 1988,
    service_life: 30,
    quantity: 3,
    unit_price: '22000',
    condition_rating: 'Very poor',
    priority: 'High',
    action: 'Refurbish',
    term: 'Immediate',
  },
  {
    id: 4,
    asset_name: 'Sprinkler piping',
    level_1_code: 'D',
    level_2_code: 'D40',
    vintage: 1988,
    service_life: 50,
    quantity: 1,
    unit_price: '240000',
    condition_rating: 'Not applicable',
    priority: 'No Priority',
    action: 'No Action',
    term: 'N/A',
  },
]

function planFixture() {
  return calculateCapitalPlan({ assets: ASSETS, building: BUILDING })
}

test('conditionScore maps the dropdown to 1–6 and leaves others unscored', () => {
  assert.equal(conditionScore('Very good'), 1)
  assert.equal(conditionScore('good'), 2)
  assert.equal(conditionScore('Fair'), 3)
  assert.equal(conditionScore('Poor'), 4)
  assert.equal(conditionScore('Very poor'), 5)
  assert.equal(conditionScore('Critical'), 6)
  // 'Not applicable' must never be averaged into a mean.
  assert.equal(conditionScore('Not applicable'), null)
  assert.equal(conditionScore(''), null)
  assert.equal(conditionScore(null), null)
  assert.equal(conditionScore('Somewhat crunchy'), null)
})

test('conditionBandLabel names the band or the straddled pair', () => {
  assert.equal(conditionBandLabel(2), 'Good')
  assert.equal(conditionBandLabel(3.4), 'between Fair and Poor')
  assert.equal(conditionBandLabel(null), null)
  assert.equal(conditionBandLabel(6), 'Critical')
})

test('formatMoney rounds to the nearest thousand above $1,000', () => {
  assert.equal(formatMoney(1460320), '$1,460,000')
  assert.equal(formatMoney(101400), '$101,000')
  assert.equal(formatMoney(940), '$940')
  assert.equal(formatMoney(0), '$0')
  assert.equal(formatMoney(-12400), '-$12,000')
  assert.equal(formatMoney(null), null)
  assert.equal(formatMoney(''), null)
  assert.equal(formatMoney('not a number'), null)
})

test('formatPercent keeps one decimal', () => {
  assert.equal(formatPercent(12.54), '12.5%')
  assert.equal(formatPercent(null), null)
})

test('histogram orders by vocabulary and keeps unrecognized values', () => {
  const rows = [
    { action: 'Maintain' },
    { action: 'Replace' },
    { action: 'Replace' },
    { action: 'Zamboni' },
    { action: '' },
    {},
  ]
  const entries = histogram(rows, 'action', ['Replace', 'Maintain'])
  assert.deepEqual(entries, [
    { label: 'Replace', count: 2 },
    { label: 'Maintain', count: 1 },
    { label: 'Zamboni', count: 1 },
  ])
  assert.equal(formatHistogram(entries), 'Replace 2, Maintain 1, Zamboni 1')
  assert.equal(formatHistogram([]), null)
})

test('resolveStartYear prefers the capital plan, then the assessment date', () => {
  assert.equal(resolveStartYear({ capitalPlan: { startYear: 2024 } }), 2024)
  assert.equal(resolveStartYear({ building: BUILDING }), 2026)
  assert.equal(resolveStartYear({}), null)
})

test('summarizeAssets aggregates condition, vintage, and overdue counts', () => {
  const capitalPlan = planFixture()
  const summary = summarizeAssets(ASSETS, { capitalPlan })

  assert.equal(summary.count, 4)
  // Mean over the three scored assets only: (4 + 2 + 5) / 3.
  assert.equal(summary.condition.ratedCount, 3)
  assert.equal(summary.condition.unratedCount, 1)
  assert.equal(summary.condition.mean.toFixed(2), (11 / 3).toFixed(2))
  assert.equal(summary.condition.band, 'between Fair and Poor')

  assert.deepEqual(summary.priorities, [
    { label: 'High', count: 2 },
    { label: 'Low', count: 1 },
    { label: 'No Priority', count: 1 },
  ])
  assert.equal(summary.vintage.oldest, 1988)
  assert.equal(summary.vintage.newest, 2012)
  // AHU-1 (-3 yr) and the elevator cab (-8 yr) are past service life.
  assert.equal(summary.overdueCount, 2)
  assert.ok(summary.capital.opcTotal > 0)
  assert.equal(summary.capital.costedCount, 4)
})

test('summarizeAssets tolerates an empty register and a missing capital plan', () => {
  const empty = summarizeAssets([], {})
  assert.equal(empty.count, 0)
  assert.equal(empty.condition.mean, null)
  assert.deepEqual(empty.capital.byTerm, [])
  assert.deepEqual(formatRollupLines(empty), [])

  const noPlan = summarizeAssets(ASSETS, {})
  assert.equal(noPlan.count, 4)
  assert.equal(noPlan.overdueCount, 0, 'remaining life is unknown without a plan')
  assert.deepEqual(noPlan.capital.byTerm, [])
})

test('term totals for the whole register reconcile with the capital plan', () => {
  const capitalPlan = planFixture()
  const totals = termTotalsForAssets(ASSETS, { capitalPlan })
  assert.equal(totals.length, capitalPlan.terms.length)
  for (const [index, term] of totals.entries()) {
    assert.equal(term.id, capitalPlan.terms[index].id)
    assert.equal(
      Math.round(term.total),
      Math.round(capitalPlan.terms[index].total),
      `term ${term.id} must match the report's own total`,
    )
  }
})

test('term totals for a subset sum to no more than the building total', () => {
  const capitalPlan = planFixture()
  const subset = ASSETS.filter((asset) => asset.level_2_code === 'D30')
  const subsetTotal = termTotalsForAssets(subset, { capitalPlan }).reduce(
    (sum, term) => sum + term.total,
    0,
  )
  const buildingTotal = capitalPlan.terms.reduce((sum, term) => sum + term.total, 0)
  assert.ok(subsetTotal > 0)
  assert.ok(subsetTotal < buildingTotal)
})

test('formatRollupLines emits labelled aggregate lines', () => {
  const capitalPlan = planFixture()
  const lines = formatRollupLines(summarizeAssets(ASSETS, { capitalPlan })).join('\n')
  assert.match(lines, /Assets in scope: 4/)
  assert.match(lines, /Mean condition rating: 3\.7 of 6 \(between Fair and Poor\)/)
  assert.match(lines, /1 unrated or not applicable/)
  assert.match(lines, /Condition mix: Good 1, Poor 1, Very poor 1, Not applicable 1/)
  assert.match(lines, /Work priorities: High 2, Low 1, No Priority 1/)
  assert.match(lines, /Installation vintages: 1988–2012; mean age \d+ years/)
  assert.match(lines, /2 asset\(s\) are at or past the end of their expected service life/)
  assert.match(lines, /Total opinion of probable cost for these assets: \$/)
  assert.match(lines, /Scheduled capital by term: Immediate Term \(2026\) \$/)
})

test('formatCapitalPositionLines reports CRV, FCI windows, and term totals', () => {
  const lines = formatCapitalPositionLines(planFixture()).join('\n')
  assert.match(lines, /Current replacement value: \$[\d,]+ \(derived, includes 86% soft costs\)/)
  assert.match(lines, /Facility Condition Index by window: 0–2 yr \d+\.\d% \(\w/)
  assert.match(lines, /Building capital plan by term: Immediate Term \(2026\) \$/)
  assert.match(lines, /Total scheduled 25-year renewal: \$/)
  assert.deepEqual(formatCapitalPositionLines(null), [])
})

test('formatCapitalPositionLines flags a manual CRV override', () => {
  const plan = calculateCapitalPlan({
    assets: ASSETS,
    building: { ...BUILDING, current_replacement_value: 25000000 },
  })
  const lines = formatCapitalPositionLines(plan).join('\n')
  assert.match(lines, /Current replacement value: \$25,000,000 \(manual override/)
})

test('rankAssetsBySeverity leads with high priority and worst condition', () => {
  const capitalPlan = planFixture()
  const ranked = rankAssetsBySeverity(ASSETS, planIndex(capitalPlan))
  assert.deepEqual(
    ranked.map((asset) => asset.asset_name),
    ['Elevator cab', 'AHU-1', 'Boiler', 'Sprinkler piping'],
  )
  // Must not mutate the caller's array.
  assert.equal(ASSETS[0].asset_name, 'AHU-1')
})

test('rankAssetsByCost leads with the largest opinion of probable cost', () => {
  const capitalPlan = planFixture()
  const plans = planIndex(capitalPlan)
  const ranked = rankAssetsByCost(ASSETS, plans)
  const costs = ranked.map((asset) => plans.get(asset.id).opinionOfProbableCost)
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a))
})

test('termLabelForYear buckets a year into the plan term that contains it', () => {
  const terms = [
    { id: 'immediate', label: 'Immediate Term', yearFrom: 2026, yearTo: 2026 },
    { id: 'short', label: 'Short Term', yearFrom: 2027, yearTo: 2028 },
    { id: 'medium', label: 'Medium Term', yearFrom: 2029, yearTo: 2031 },
  ]
  assert.equal(termLabelForYear(terms, 2026), 'Immediate Term')
  // Boundaries are inclusive at both ends.
  assert.equal(termLabelForYear(terms, 2027), 'Short Term')
  assert.equal(termLabelForYear(terms, 2028), 'Short Term')
  assert.equal(termLabelForYear(terms, 2029), 'Medium Term')

  // Outside every window, or nothing to bucket against: the caller falls back to
  // whatever the assessor recorded rather than inventing a term.
  assert.equal(termLabelForYear(terms, 2040), null)
  assert.equal(termLabelForYear(terms, null), null)
  assert.equal(termLabelForYear(terms, undefined), null)
  assert.equal(termLabelForYear([], 2027), null)
  assert.equal(termLabelForYear(null, 2027), null)
})

test('termLabelForYear agrees with the terms the capital plan reports', () => {
  const capitalPlan = planFixture()
  for (const term of capitalPlan.terms) {
    assert.equal(termLabelForYear(capitalPlan.terms, term.yearFrom), term.label)
    assert.equal(termLabelForYear(capitalPlan.terms, term.yearTo), term.label)
  }
})
