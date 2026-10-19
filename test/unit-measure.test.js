const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ASSET_UNIT_MEASURE_VALUES,
  mapPricingUnitToUnitMeasure,
} = require('../src/shared')

test('maps every catalogue and assessor-specific per-item unit without collapsing semantics', () => {
  const expected = new Map([
    ['Set', 'Set'],
    ['Per Floor', 'Per Floor'],
    ['Per Point', 'Per Point'],
    ['Per Hose', 'Per Hose'],
    ['Per Toilet', 'Per Toilet'],
    ['Per Tread', 'Per Tread'],
    ['Per Rung', 'Per Rung'],
    ['Per Starter', 'Per Starter'],
  ])

  for (const [source, target] of expected) {
    assert.equal(mapPricingUnitToUnitMeasure(source), target)
    assert.ok(ASSET_UNIT_MEASURE_VALUES.includes(target))
  }
  assert.equal(mapPricingUnitToUnitMeasure('Each'), 'EA')
  assert.equal(mapPricingUnitToUnitMeasure('Square Feet'), 'Sq. Ft.')
  assert.equal(mapPricingUnitToUnitMeasure('Linear Feet'), 'Ln. Ft.')
})
