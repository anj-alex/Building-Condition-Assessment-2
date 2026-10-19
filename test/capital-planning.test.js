const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const {
  adjustUnitCost,
  roundOpinionOfCost,
  calculateCapitalPlan,
  loadCapitalPlanningRules,
  gradeForRatio,
  conditionGradeForRating,
} = require('../src/lib/capital-planning')
const { readLocationFactorRows, readUniformatPricingRows } = require('../src/lib/csv-utils')

const rulesPath = path.join(__dirname, '..', 'data', 'capital_planning_rules.json')
const locationCsv = path.join(__dirname, '..', 'data', 'location_factors.csv')
const pricingCsv = path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')

test('loads extracted capital planning rules and reference catalogues', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  assert.equal(rules.crv_uplift.multiplier, 1.86)
  assert.equal(rules.horizon.offsets.length, 26)
  assert.equal(readLocationFactorRows(locationCsv).length, 74)
  const pricing = readUniformatPricingRows(pricingCsv)
  assert.equal(pricing.length, 1774)
  assert.equal(rules.expected_counts.workbook_uniformat_pricing_rows, 1773)
  assert.equal(rules.expected_counts.supplement_uniformat_pricing_rows, 1)
  // The supplement covers codes the catalogue has nowhere, not codes it files
  // under a different parent: C33 / C3300 is the only such group.
  assert.deepEqual(
    pricing
      .filter((row) => row.pricing_id.startsWith('SUPP-'))
      .map((row) => row.level_3_code),
    ['C3300'],
  )
  for (const code of ['G2034', 'C2012', 'G2043']) {
    assert.ok(
      pricing.some((row) => row.level_4_code === code && row.unit_price),
      `${code} must stay reachable through its priced workbook rows`,
    )
  }
})

test('rounds adjusted unit cost by workbook bands but OPC to whole dollars', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  // Adjusted unit cost keeps the workbook's order-of-magnitude rounding bands.
  assert.equal(adjustUnitCost(25, 1.104, rules), 28)
  assert.equal(adjustUnitCost(125, 1.04, rules), 130)
  assert.equal(adjustUnitCost(2500, 1.1, rules), 2800)
  // OPC is the exact product in whole dollars — no $100/$1000 rounding.
  // Client-reported case: 1 × $130 must be $130, not $100.
  assert.equal(roundOpinionOfCost(130), 130)
  assert.equal(roundOpinionOfCost(239980), 239980)
  assert.equal(roundOpinionOfCost(1000001), 1000001)
  assert.equal(roundOpinionOfCost(1000500), 1000500)
  assert.equal(roundOpinionOfCost(325.4), 325)
})

test('action year, term, capital-needs and annual forecast share one scheduling logic', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      location_factor: 1,
      current_replacement_value: 1000000,
    },
    assets: [
      { id: 1, level_1_code: 'A', level_1_group: 'A Substructure', level_2_code: 'A10', quantity: 1, unit_price: '$1000', service_life: 50, vintage: 2026, action_year: 2026, action: 'Replace' },
      { id: 2, level_1_code: 'B', level_1_group: 'B Shell', level_2_code: 'B30', quantity: 1, unit_price: '$1000', service_life: 50, vintage: 2020, action_year: 2030, action: 'Replace' },
      { id: 3, level_1_code: 'D', level_1_group: 'D Service', level_2_code: 'D30', quantity: 1, unit_price: '$1000', service_life: 50, vintage: 2010, action_year: 2040, action: 'Replace' },
    ],
  })

  // Each asset's displayed term is exactly the planning bucket whose year range
  // contains its scheduled action year — no independent term derivation.
  const termByLabel = new Map(plan.terms.map((term) => [term.label, term]))
  const termFor = (effectiveTerm) =>
    termByLabel.get(effectiveTerm === 'Immediate' ? 'Immediate Term' : effectiveTerm)
  for (const asset of plan.assets) {
    const term = termFor(asset.effectiveTerm)
    assert.ok(
      term && term.yearFrom <= asset.scheduledActionYear && asset.scheduledActionYear <= term.yearTo,
      `asset ${asset.assetId} term ${asset.effectiveTerm} must contain action year ${asset.scheduledActionYear}`,
    )
  }

  // The Capital Needs Summary (group × term), the term totals, and the annual
  // forecast (year grid) all reconcile to the same scheduled total.
  const sum = (values) => values.reduce((total, value) => total + value, 0)
  const termTotal = sum(plan.terms.map((term) => term.total))
  const groupByTermTotal = sum(plan.groups.map((group) => sum(Object.values(group.byTerm))))
  const yearGridTotal = sum(plan.years.map((year) => year.total))
  assert.equal(termTotal, 3000)
  assert.equal(groupByTermTotal, 3000)
  assert.equal(yearGridTotal, 3000)
  assert.equal(plan.totals.scheduled, 3000)
})

test('calculates recurring reserve events and group/term rollups', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-03-12',
      location_factor: 1,
    },
    assets: [
      {
        id: 1,
        asset_name: 'Sealant',
        level_1_code: 'B',
        level_1_group: 'B Shell',
        level_2_code: 'B20',
        level_2_description: 'Exterior Enclosure',
        quantity: 100,
        unit_price: '$10',
        service_life: 10,
        vintage: 2016,
        action: 'Replace',
        term: 'Short Term',
        action_year: 2026,
        allowance_interval_years: 10,
      },
      {
        id: 2,
        asset_name: 'Maintain only',
        level_1_code: 'A',
        level_1_group: 'A Substructure',
        level_2_code: 'A10',
        level_2_description: 'Foundations',
        quantity: 50,
        unit_price: '$20',
        service_life: 100,
        vintage: 1988,
        action: 'No Action',
        term: 'N/A',
      },
    ],
  })

  assert.equal(plan.startYear, 2026)
  assert.equal(plan.assets[0].opinionOfProbableCost, 1000)
  assert.deepEqual(
    plan.events.filter((event) => event.assetId === 1).map((event) => event.year),
    [2026, 2036, 2046],
  )
  assert.equal(plan.events.some((event) => event.assetId === 2), false)
  assert.equal(plan.totals.replacementBase, 2000)
  assert.equal(plan.crv.derived, 3720)
  assert.equal(plan.crv.value, 3720)
  assert.ok(plan.groups.some((group) => group.name === 'B Shell' && group.total === 3000))
})

test('honors OPC override, overdue move, and CRV override', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      location_factor: 1,
      current_replacement_value: 100000,
    },
    assets: [
      {
        id: 9,
        asset_name: 'Roof',
        level_1_group: 'B Shell',
        level_2_code: 'B30',
        level_2_description: 'Roofing',
        quantity: 10,
        unit_price: '$100',
        opinion_of_probable_cost: 5500,
        action_year: 2020,
        service_life: 20,
        vintage: 2000,
        action: 'Replace',
        term: 'Immediate',
      },
    ],
  })
  assert.equal(plan.assets[0].opcSource, 'override')
  assert.equal(plan.assets[0].opinionOfProbableCost, 5500)
  assert.equal(plan.events[0].year, 2026)
  assert.equal(plan.crv.source, 'override')
  assert.equal(plan.crv.value, 100000)
  const immediate = plan.fci.find((row) => row.id === 'years_0_2')
  assert.equal(immediate.numerator, 5500)
  assert.equal(immediate.grade, 'Fair')
})

test('applies location factor end-to-end in capital plan OPC', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      location_factor: 1.063,
    },
    assets: [
      {
        id: 11,
        asset_name: 'Flooring',
        level_1_group: 'C Interiors',
        level_2_code: 'C30',
        level_2_description: 'Interior Finishes',
        quantity: 100,
        unit_price: '$100',
        service_life: 20,
        vintage: 2010,
        action: 'Replace',
        term: 'Medium Term',
        action_year: 2030,
      },
    ],
  })
  // 100 × 1.063 = 106.3 → rounds to tens band → 110; OPC 100×110 = 11000
  assert.equal(plan.assets[0].adjustedUnitCost, 110)
  assert.equal(plan.assets[0].opinionOfProbableCost, 11000)
  assert.equal(plan.assets[0].locationFactor, 1.063)
  assert.equal(plan.events[0].amount, 11000)
})

test('treats sub-1 recurrence intervals as one-shot events', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: { date_of_assessment: '2026-01-01', location_factor: 1 },
    assets: [
      {
        id: 12,
        asset_name: 'Fractional life',
        level_1_group: 'B Shell',
        quantity: 10,
        unit_price: '$100',
        service_life: 0.5,
        allowance_interval_years: 0.75,
        vintage: 2026,
        action: 'Replace',
        term: 'Immediate',
        action_year: 2026,
      },
    ],
  })
  const years = plan.events.filter((event) => event.assetId === 12).map((event) => event.year)
  assert.deepEqual(years, [2026])
})

test('grades FCI with standard IFMA bands', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  assert.equal(gradeForRatio(0, rules), 'Very Good')
  assert.equal(gradeForRatio(0.025, rules), 'Very Good')
  assert.equal(gradeForRatio(0.05, rules), 'Good')
  assert.equal(gradeForRatio(0.1, rules), 'Fair')
  assert.equal(gradeForRatio(0.3, rules), 'Poor')
  assert.equal(gradeForRatio(0.02, rules), 'Very Good')
  assert.equal(gradeForRatio(0.04, rules), 'Good')
  assert.equal(gradeForRatio(0.08, rules), 'Fair')
  assert.equal(gradeForRatio(0.2, rules), 'Poor')
  assert.equal(gradeForRatio(0.5, rules), 'Critical')
})

test('applies one IFMA grade scale (Critical > 30%) to every FCI window', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  // The IFMA scale is the single grade table for current and projected FCI.
  assert.equal(gradeForRatio(0.3, rules, 'ifma'), 'Poor')
  assert.equal(gradeForRatio(0.3001, rules, 'ifma'), 'Critical')

  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      location_factor: 1,
      current_replacement_value: 100000,
    },
    assets: [
      {
        id: 20,
        quantity: 1,
        unit_price: '$53800',
        service_life: 100,
        vintage: 2026,
        action_year: 2026,
        action: 'Replace',
      },
    ],
  })
  // A single $53,800 need against a $100,000 CRV is a 53.8% FCI. Per the client
  // requirement it must read Critical in the current window and every projected
  // window — not "Poor" on a separate 0–5 scale.
  for (const id of ['years_0_2', 'years_0_5', 'years_0_10', 'years_0_25']) {
    const row = plan.fci.find((r) => r.id === id)
    assert.equal(row.percent.toFixed(1), '53.8')
    assert.equal(row.grade, 'Critical')
    assert.equal(row.gradeScale, 'ifma')
  }
})

test('derives condition grade, age, timing, and term from the scheduled action year', () => {
  const rules = loadCapitalPlanningRules(rulesPath)
  assert.equal(conditionGradeForRating('Fair', rules), 'C - Acceptable')
  assert.equal(conditionGradeForRating('5', rules), 'E - Poor')
  assert.equal(conditionGradeForRating('Not applicable', rules), null)

  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      property_vintage: 2000,
      location_factor: 1,
    },
    assets: [
      {
        id: 21,
        condition_rating: 'Fair',
        quantity: 1,
        unit_price: '$100',
        mean_service_life: 30,
        practical_life: 25,
        life_adjustment_years: 2,
        action: 'Replace',
      },
      {
        id: 22,
        condition_rating: 'Poor',
        quantity: 1,
        unit_price: '$100',
        service_life: 20,
        vintage: 2024,
        action_year: 2030,
        allowance_interval_years: 7,
        term: 'Long Term',
        action: 'Replace',
      },
    ],
  })

  const derived = plan.assets[0]
  assert.equal(derived.vintage, 2000)
  assert.equal(derived.vintageSource, 'building')
  assert.equal(derived.age, 26)
  assert.equal(derived.serviceLife, 30)
  assert.equal(derived.serviceLifeSource, 'catalogue_mean')
  assert.equal(derived.remainingLife, 6)
  assert.equal(derived.estimatedReplacementYear, 2032)
  assert.equal(derived.actionYear, 2032)
  assert.equal(derived.actionYearSource, 'derived')
  assert.equal(derived.effectiveTerm, 'Long Term')
  assert.equal(derived.termSource, 'derived')
  assert.equal(derived.conditionGrade, 'C - Acceptable')

  // Asset 22 carries a stored term of 'Long Term', but term is always derived
  // from the scheduled action year — the stored value is ignored.
  const scheduled = plan.assets[1]
  assert.equal(scheduled.actionYear, 2030)
  assert.equal(scheduled.actionYearSource, 'override')
  assert.equal(scheduled.recurrenceInterval, 7)
  assert.equal(scheduled.recurrenceIntervalSource, 'allowance_override')
  assert.equal(scheduled.derivedTerm, 'Medium Term')
  assert.equal(scheduled.effectiveTerm, 'Medium Term')
  assert.equal(scheduled.termSource, 'derived')
})

test('a suppressed asset claims no derived term bucket its costs never fund', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: '2026-01-01',
      property_vintage: 2020,
      location_factor: 1,
    },
    assets: [
      {
        id: 24,
        quantity: 1,
        unit_price: '$100',
        service_life: 10,
        action: 'No Action',
      },
      {
        id: 25,
        quantity: 1,
        unit_price: '$100',
        service_life: 10,
        action: 'No Action',
        term: 'N/A',
      },
    ],
  })

  // Both derive Medium Term (2030) but neither schedules an event, so the
  // Medium Term total is $0 and no row may report itself as Medium Term.
  const [derivedOnly, alsoSuppressed] = plan.assets
  assert.equal(derivedOnly.suppressed, true)
  assert.equal(derivedOnly.derivedTerm, 'Medium Term')
  assert.equal(derivedOnly.effectiveTerm, null)
  assert.equal(derivedOnly.termSource, null)
  // A stored term ('N/A' here) is ignored — suppression comes from the action
  // type, and a suppressed asset claims no term.
  assert.equal(alsoSuppressed.suppressed, true)
  assert.equal(alsoSuppressed.effectiveTerm, null)
  assert.equal(alsoSuppressed.termSource, null)
  assert.equal(plan.terms.find((term) => term.id === 'medium').total, 0)
})

test('keeps missing age inputs unscheduled when neither asset nor building vintage exists', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: { date_of_assessment: '2026-01-01', location_factor: 1 },
    assets: [
      {
        id: 23,
        quantity: 1,
        unit_price: '$100',
        service_life: 20,
        action: 'Replace',
      },
    ],
  })
  assert.equal(plan.assets[0].age, null)
  assert.equal(plan.assets[0].actionYear, null)
  assert.ok(plan.assets[0].warnings.includes('missing_life_inputs'))
})

test('flags non-numeric catalogue prices and missing quantity', () => {
  const plan = calculateCapitalPlan({
    rulesPath,
    building: { date_of_assessment: '2026-01-01', location_factor: 1 },
    assets: [
      {
        id: 3,
        asset_name: 'Range price',
        level_1_group: 'B Shell',
        unit_price: '$10 to $18',
        action: 'Replace',
        term: 'Short Term',
        quantity: 12,
        service_life: 10,
        vintage: 2020,
      },
      {
        id: 4,
        asset_name: 'No qty',
        level_1_group: 'B Shell',
        unit_price: '$25',
        action: 'Replace',
        term: 'Short Term',
        service_life: 10,
        vintage: 2020,
      },
    ],
  })
  assert.ok(plan.exceptions.some((item) => item.code === 'non_numeric_unit_price'))
  assert.ok(plan.exceptions.some((item) => item.code === 'missing_quantity'))
})
