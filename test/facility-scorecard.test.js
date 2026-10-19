const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  facilityScorecard,
  scorecardConditionScore,
  CONDITION_BANDS,
  NEAR_TERM_LAST_OFFSET,
} = require('../src/lib/property-report-rules')
const { conditionScore } = require('../src/lib/report-validation')

const RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'capital_planning_rules.json'), 'utf8'),
)

/** An asset in the shape getPropertyReportData hands the renderers. */
function asset(overrides = {}) {
  return {
    id: 1,
    asset_name: 'Component',
    level_2_code: 'C30',
    level_2_group_element: 'C30 Interior Finishes',
    condition_rating: 'Fair',
    assessed: true,
    capital: {
      effectiveTerm: 'Medium Term',
      scheduledActionYear: 2028,
      opinionOfProbableCost: 12000,
      events: [{ offset: 3, year: 2028, amount: 12000 }],
    },
    ...overrides,
  }
}

/** A report payload with a capital plan whose year totals match its assets. */
function report(assets, { years = null, crv = 1000000, fci = null } = {}) {
  return {
    assets,
    capitalPlan: {
      rules: RULES,
      crv: { value: crv },
      fci: fci ?? [{ percent: 4.2, grade: 'Good' }],
      years:
        years
        ?? assets.flatMap((item) =>
          (item.capital?.events ?? []).map((event) => ({
            offset: event.offset,
            year: event.year,
            total: event.amount,
          })),
        ),
    },
  }
}

test('the near-term need counts only the first six plan offsets', () => {
  const card = facilityScorecard(
    report([], {
      years: [
        { offset: 0, total: 100 },
        { offset: NEAR_TERM_LAST_OFFSET, total: 200 },
        { offset: NEAR_TERM_LAST_OFFSET + 1, total: 999999 },
        { offset: 24, total: 999999 },
      ],
    }),
  )
  assert.equal(card.nearTermNeed, 300)
})

test('priority rows are the in-window components, dearest first', () => {
  const card = facilityScorecard(
    report([
      asset({ id: 1, asset_name: 'Cheap', capital: { events: [{ offset: 1, amount: 500 }] } }),
      asset({ id: 2, asset_name: 'Dear', capital: { events: [{ offset: 4, amount: 90000 }] } }),
      asset({ id: 3, asset_name: 'Middling', capital: { events: [{ offset: 0, amount: 7000 }] } }),
      // Outside the window entirely: real money, but not a near-term priority.
      asset({ id: 4, asset_name: 'Later', capital: { events: [{ offset: 11, amount: 500000 }] } }),
    ]),
  )
  assert.deepEqual(
    card.priorities.map((row) => row.name),
    ['Dear', 'Middling', 'Cheap'],
  )
  assert.equal(card.nearTermCount, 3)
})

test('a component recurring inside the window carries only its in-window cost', () => {
  const card = facilityScorecard(
    report([
      asset({
        asset_name: 'Recurring',
        capital: {
          events: [
            { offset: 1, amount: 4000 },
            { offset: 5, amount: 4000 },
            // Beyond the window — must not inflate the row above the tile.
            { offset: 12, amount: 4000 },
          ],
        },
      }),
    ]),
  )
  assert.equal(card.priorities[0].cost, 8000)
  assert.equal(card.nearTermNeed, 8000)
})

test('the priority grid is capped so the scorecard stays one page', () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    asset({
      id: index + 1,
      asset_name: `Component ${index}`,
      capital: { events: [{ offset: 1, amount: (index + 1) * 1000 }] },
    }),
  )
  const card = facilityScorecard(report(many))
  assert.equal(card.priorities.length, 5)
  // The count is every in-window component, not just the ones that fit.
  assert.equal(card.nearTermCount, 12)
})

// The scorecard promises to be one page. Spelling the classification out here
// wrapped the first column to three lines a row and pushed the condition
// snapshot onto a page of its own, measured on the dev database.
test('priority rows carry the bare Uniformat code, not the spelled-out group', () => {
  const card = facilityScorecard(
    report([
      asset({
        level_2_code: 'B20',
        level_2_group_element: 'B20 Exterior Enclosure Systems',
        capital: { events: [{ offset: 1, amount: 1000 }] },
      }),
    ]),
  )
  assert.equal(card.priorities[0].element, 'B20')
})

test('a component with no Level 2 code falls back to its group rather than blanking', () => {
  const card = facilityScorecard(
    report([
      asset({
        level_2_code: null,
        level_2_group_element: 'Unclassified',
        capital: { events: [{ offset: 1, amount: 1000 }] },
      }),
    ]),
  )
  assert.equal(card.priorities[0].element, 'Unclassified')
})

test('assets carried in as Not Assessed are excluded throughout', () => {
  const card = facilityScorecard(
    report([
      asset({ id: 1, condition_rating: 'Good' }),
      asset({
        id: 2,
        assessed: false,
        condition_rating: 'Critical',
        capital: { events: [{ offset: 0, amount: 50000 }] },
      }),
    ]),
  )
  assert.equal(card.assessedCount, 1)
  assert.equal(card.ratedCount, 1)
  assert.deepEqual(
    card.priorities.map((row) => row.name),
    ['Component'],
  )
  assert.equal(
    card.conditionBands.find((band) => band.id === 'poor').count,
    0,
    'a Not Assessed asset must not be banded by a condition it was never given',
  )
})

test('the six-point scale collapses to three bands with shares of the rated set', () => {
  const card = facilityScorecard(
    report([
      asset({ id: 1, condition_rating: 'Very good' }),
      asset({ id: 2, condition_rating: 'Good' }),
      asset({ id: 3, condition_rating: 'Fair' }),
      asset({ id: 4, condition_rating: 'Critical' }),
      // Unrated: counted as assessed, but not as a share of the condition mix.
      asset({ id: 5, condition_rating: null }),
    ]),
  )
  assert.deepEqual(
    card.conditionBands.map((band) => [band.label, band.count, band.percent]),
    [
      ['Very Good / Good', 2, 50],
      ['Fair', 1, 25],
      ['Poor / Critical', 1, 25],
    ],
  )
  assert.equal(card.ratedCount, 4)
  assert.equal(card.assessedCount, 5)
})

test('a facility with nothing rated reports no shares rather than zero percent', () => {
  const card = facilityScorecard(report([asset({ condition_rating: '  ' })]))
  assert.deepEqual(
    card.conditionBands.map((band) => band.percent),
    [null, null, null],
  )
})

test('an empty facility produces a scorecard rather than throwing', () => {
  const card = facilityScorecard({})
  assert.equal(card.nearTermNeed, 0)
  assert.equal(card.nearTermCount, 0)
  assert.deepEqual(card.priorities, [])
  assert.equal(card.crv, null)
  assert.equal(card.grade, null)
})

// The scorecard scores conditions with its own copy of the mapping so that
// property-report-rules.js keeps no cross-module dependency; this is the test
// its doc comment promises, and it fails the moment the two spellings diverge.
test('scorecard condition scoring matches the pre-export review across the whole scale', () => {
  const spellings = []
  for (const rating of RULES.condition_ratings) {
    for (const key of ['stored_value', 'legacy_label', 'display', 'revised_label']) {
      if (rating[key]) spellings.push(rating[key], String(rating[key]).toUpperCase())
    }
    spellings.push(String(rating.score))
  }
  spellings.push('', '  ', 'not a rating', '0', '7')
  assert.ok(spellings.length > 30, 'the scale should offer many spellings to disagree over')
  for (const spelling of spellings) {
    assert.equal(
      scorecardConditionScore(spelling, RULES),
      conditionScore(spelling, RULES),
      `disagreement on "${spelling}"`,
    )
  }
})

test('every score on the scale falls in exactly one band', () => {
  for (const rating of RULES.condition_ratings) {
    const matches = CONDITION_BANDS.filter(
      (band) => rating.score >= band.from && rating.score <= band.to,
    )
    assert.equal(matches.length, 1, `score ${rating.score} matched ${matches.length} bands`)
  }
})
