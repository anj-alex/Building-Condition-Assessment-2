const assert = require('node:assert/strict')
const test = require('node:test')

const { validateReport, localIsoDate } = require('../src/lib/report-validation')
const { loadCapitalPlanningRules } = require('../src/lib/capital-planning')

const rules = loadCapitalPlanningRules()

// A fully specified building and CRV so only the field under test is flagged.
const goodBuilding = {
  property_name: 'ASHC Lodge',
  address: '1 Main St',
  gross_floor_area_m2: 4200,
  num_floors: 3,
  property_vintage: 1998,
  date_of_assessment: '2026-05-01',
}
const overrideCrv = { source: 'override', value: 1000000 }

function codes(result) {
  return result.findings.map((finding) => finding.code)
}

test('calendar-date comparisons use the local day rather than the UTC day', () => {
  const localEvening = {
    getFullYear: () => 2026,
    getMonth: () => 8,
    getDate: () => 1,
    toISOString: () => {
      throw new Error('UTC conversion must not be used for a local calendar date')
    },
  }
  assert.equal(localIsoDate(localEvening), '2026-09-01')
})

test('flags each missing required project/facility field', () => {
  const result = validateReport({
    project: {},
    building: { property_name: 'X', address: 'Y' },
    assets: [],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const messages = result.findings.map((finding) => finding.message).join(' | ')
  assert.match(messages, /Client name is missing/)
  assert.match(messages, /Gross floor area is missing/)
  assert.match(messages, /Number of floors is missing/)
  assert.match(messages, /Year built is missing/)
  assert.match(messages, /Assessment date is missing/)
})

test('a fully specified building with an override CRV and no assets is clean', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.deepEqual(result.findings, [])
  assert.equal(result.errorCount, 0)
  assert.equal(result.warningCount, 0)
})

test('nonblank but impossible facility measurements and dates block export', () => {
  const nextYear = new Date().getUTCFullYear() + 1
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: {
      ...goodBuilding,
      gross_floor_area_m2: 0,
      num_floors: -2,
      location_factor: 0,
      property_vintage: 1799,
      date_of_assessment: `${nextYear}-01-01`,
    },
    assets: [],
    capitalPlan: { crv: overrideCrv, rules },
  })

  const invalid = result.findings.filter(
    (finding) => finding.code === 'invalid_project_field',
  )
  assert.deepEqual(
    invalid.map((finding) => finding.field).sort(),
    [
      'date_of_assessment',
      'gross_floor_area_m2',
      'location_factor',
      'num_floors',
      'property_vintage',
    ],
  )
  assert.equal(result.errorCount, 5)
})

test('year built cannot be later than the assessment year', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: { ...goodBuilding, property_vintage: 2027 },
    assets: [],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === 'invalid_project_field' &&
        finding.field === 'property_vintage',
    ),
  )
})

test('zero/missing CRV is an error (divide-by-zero guard)', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [],
    capitalPlan: { crv: { source: 'derived', value: 0 }, rules },
  })
  assert.ok(codes(result).includes('crv_zero'))
  assert.equal(result.errorCount, 1)
})

test('a derived CRV is an error: the FCI has no real denominator', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [],
    capitalPlan: { crv: { source: 'derived', value: 500000 }, rules },
  })
  assert.ok(codes(result).includes('crv_derived_from_opc'))
  assert.equal(result.errorCount, 1)
})

// The client asked for mandatory property information to be validated *before*
// the report is generated. The report page blocks export while any error stands,
// so these have to be errors, not advice.
test('every mandatory property field is an error, not a warning', () => {
  const result = validateReport({
    project: {},
    building: {},
    assets: [],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const required = [
    'Client name',
    'Facility / building name',
    'Address',
    'Gross floor area',
    'Number of floors',
    'Year built',
    'Assessment date',
  ]
  for (const label of required) {
    const finding = result.findings.find((item) => item.message.startsWith(label))
    assert.ok(finding, `${label} must be reported`)
    assert.equal(finding.severity, 'error', `${label} must block export`)
  }
  assert.equal(result.warningCount, 0)
})

// Two pages describing one component, each counted separately in the capital
// totals. Imports can no longer create these, but databases that predate the
// unique index still hold the ones an earlier re-import made.
test('duplicate asset records are reported as an error', () => {
  // A real duplicate is a copy: same identity AND the same findings.
  const copy = (id) => ({
    id,
    asset_name: 'Rooftop Unit RTU-1',
    level_2_code: 'D30',
    level_2_group_element: 'D30 HVAC',
    quantity: 1,
    condition_rating: 'Fair',
    description: 'Original unit, surface corrosion at the casing.',
    recommendation: 'Replace at end of life.',
    capital: {},
  })
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [copy(1), copy(2)],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const finding = result.findings.find((item) => item.code === 'duplicate_asset')
  assert.ok(finding, 'the duplicate is reported')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /2 identical assets/)
  assert.match(finding.message, /Rooftop Unit RTU-1/)
})

// A building legitimately has two roof areas or two boilers under one Uniformat
// class. Flagging those as duplicates would block a perfectly good export.
test('two real components sharing a name are not duplicates', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [
      {
        id: 1,
        asset_name: 'Built Up Roof Assemblies',
        level_2_code: 'B30',
        quantity: 4200,
        condition_rating: 'Fair',
        capital: {},
      },
      {
        id: 2,
        asset_name: 'Built Up Roof Assemblies',
        level_2_code: 'B30',
        quantity: 1150,
        condition_rating: 'Good',
        capital: {},
      },
    ],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.ok(!codes(result).includes('duplicate_asset'))
})

test('the same name under a different Uniformat group is not a duplicate', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [
      { id: 1, asset_name: 'Signage', level_2_code: 'C10', capital: {} },
      { id: 2, asset_name: 'Signage', level_2_code: 'G20', capital: {} },
    ],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.ok(!codes(result).includes('duplicate_asset'))
})

test('an expired lifecycle date is reported as overdue work', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [
      {
        id: 1,
        asset_name: 'Domestic Water Distribution',
        capital: {
          actionYear: 1990,
          scheduledActionYear: 2026,
          actionYearIsOverdue: true,
          overdueByYears: 36,
        },
      },
    ],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const finding = result.findings.find((item) => item.code === 'action_year_overdue')
  assert.ok(finding, 'the overdue date is reported')
  assert.equal(finding.severity, 'warning')
  assert.match(finding.message, /1990/)
  assert.match(finding.message, /36 year/)
  assert.match(finding.message, /2026/)
})

test('a vintage borrowed from the building is reported', () => {
  const result = validateReport({
    project: { client: 'Northern Health' },
    building: goodBuilding,
    assets: [
      {
        id: 1,
        asset_name: 'Elevator',
        capital: { vintage: 1998, vintageSource: 'building' },
      },
    ],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const finding = result.findings.find((item) => item.code === 'vintage_from_building')
  assert.ok(finding, 'the borrowed vintage is reported')
  assert.match(finding.message, /1998/)
})

test('good condition with an urgent action/priority/term is flagged', () => {
  const asset = {
    id: 1,
    asset_name: 'New Boiler',
    condition_rating: 'Very good',
    priority: 'High',
    action: 'Repair',
    capital: { effectiveTerm: 'Long Term', opinionOfProbableCost: 5000, suppressed: false, warnings: [] },
  }
  const result = validateReport({
    project: { client: 'X' },
    building: goodBuilding,
    assets: [asset],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const conflict = result.findings.find((finding) => finding.code === 'condition_action_conflict')
  assert.ok(conflict, 'expected a condition/action conflict')
  assert.match(conflict.message, /good condition but is marked High priority/)
  assert.equal(conflict.assetId, 1)
})

test('very poor condition marked No Action is flagged', () => {
  const asset = {
    id: 2,
    asset_name: 'Failed Roof',
    condition_rating: 'Critical',
    priority: 'No Priority',
    action: 'No Action',
    capital: { effectiveTerm: null, opinionOfProbableCost: null, suppressed: true, warnings: [] },
  }
  const result = validateReport({
    project: { client: 'X' },
    building: goodBuilding,
    assets: [asset],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.ok(
    result.findings.some(
      (finding) => finding.code === 'condition_action_conflict' && /No Action/.test(finding.message),
    ),
  )
})

test('a costed action with no computable cost is flagged', () => {
  const asset = {
    id: 3,
    asset_name: 'Elevator',
    condition_rating: 'Fair',
    action: 'Replace',
    capital: { effectiveTerm: 'Short Term', opinionOfProbableCost: null, suppressed: false, warnings: ['missing_quantity'] },
  }
  const result = validateReport({
    project: { client: 'X' },
    building: goodBuilding,
    assets: [asset],
    capitalPlan: { crv: overrideCrv, rules },
  })
  const finding = result.findings.find((entry) => entry.code === 'missing_cost_for_action')
  assert.ok(finding)
  assert.match(finding.message, /no quantity/)
})

test('opted-in Not Assessed assets are not condition-checked', () => {
  const asset = {
    id: 4,
    asset_name: null,
    assessed: false,
    condition_rating: null,
    capital: null,
  }
  const result = validateReport({
    project: { client: 'X' },
    building: goodBuilding,
    assets: [asset],
    capitalPlan: { crv: overrideCrv, rules },
  })
  assert.equal(
    result.findings.some((finding) => finding.assetId === 4),
    false,
  )
})
