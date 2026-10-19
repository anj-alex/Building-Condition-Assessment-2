const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { calculateCapitalPlan } = require('../src/lib/capital-planning')
const { aggregateProjectPlan } = require('../src/lib/project-rollup')

const rulesPath = path.join(__dirname, '..', 'data', 'capital_planning_rules.json')

function buildingPlan(unitPrice, crv, assessmentYear = 2026) {
  return calculateCapitalPlan({
    rulesPath,
    building: {
      date_of_assessment: `${assessmentYear}-01-01`,
      location_factor: 1,
      current_replacement_value: crv,
    },
    assets: [
      {
        id: 1,
        level_1_code: 'A',
        level_1_group: 'A Substructure',
        level_2_code: 'A10',
        level_2_description: 'Foundations',
        quantity: 1,
        unit_price: unitPrice,
        service_life: 100,
        vintage: assessmentYear,
        action_year: assessmentYear,
        action: 'Replace',
      },
    ],
  })
}

test('aggregates term, group, year, CRV and FCI totals across buildings', () => {
  const planA = buildingPlan('$100000', 1000000)
  const planB = buildingPlan('$300000', 1000000)
  const project = aggregateProjectPlan([planA, planB])

  assert.equal(project.buildingCount, 2)

  // Terms: both assets are Immediate (2026), so Immediate holds the full 400k.
  const immediate = project.terms.find((term) => term.id === 'immediate')
  assert.equal(immediate.total, 400000)

  // Groups (Building System A) sum across buildings.
  const groupA = project.groups.find((group) => group.code === 'A' || group.name === 'A Substructure')
  assert.equal(groupA.total, 400000)
  assert.equal(groupA.byTerm.immediate, 400000)

  // Annual forecast sums by calendar year.
  assert.equal(project.years.find((row) => row.year === 2026).total, 400000)

  // CRV is the sum of building replacement values.
  assert.equal(project.crv.value, 2000000)

  // FCI: 400k of immediate+short need over 2M CRV = 20% → Poor on IFMA.
  const fci02 = project.fci.find((window) => window.id === 'years_0_2')
  assert.equal(fci02.percent, 20)
  assert.equal(fci02.grade, 'Poor')
  assert.equal(fci02.gradeScale, 'ifma')
})

test('a single-plan aggregate mirrors that plan', () => {
  const planA = buildingPlan('$100000', 1000000)
  const project = aggregateProjectPlan([planA])
  assert.equal(project.buildingCount, 1)
  assert.equal(project.crv.value, 1000000)
  assert.equal(project.terms.find((term) => term.id === 'immediate').total, 100000)
})

test('mixed assessment years are re-bucketed by absolute portfolio year', () => {
  const plan2026 = buildingPlan('$100000', 1000000, 2026)
  const plan2028 = buildingPlan('$300000', 1000000, 2028)
  const project = aggregateProjectPlan([plan2026, plan2028])

  assert.equal(project.startYear, 2026)
  assert.equal(project.terms.find((term) => term.id === 'immediate').total, 100000)
  assert.equal(project.terms.find((term) => term.id === 'short').total, 300000)
  assert.equal(project.years.find((row) => row.year === 2026).total, 100000)
  assert.equal(project.years.find((row) => row.year === 2028).total, 300000)

  const group = project.groups.find((row) => row.code === 'A')
  assert.equal(group.byTerm.immediate, 100000)
  assert.equal(group.byTerm.short, 300000)
  assert.equal(group.total, 400000)

  const termTotal = project.terms.reduce((sum, term) => sum + term.total, 0)
  const yearTotal = project.years.reduce((sum, row) => sum + row.total, 0)
  assert.equal(termTotal, yearTotal)
  assert.equal(project.totals.scheduled, yearTotal)
  assert.equal(project.fci.find((window) => window.id === 'years_0_2').numerator, 400000)
})
