const assert = require('node:assert/strict')
const test = require('node:test')

const {
  isAssetAssessed,
  includeAssetInReport,
  isImportedAsset,
} = require('../src/lib/asset-completeness')

// A freshly created asset carries only what createAsset prefills.
const blankAsset = () => ({
  id: 1,
  uniformat_pricing_id: 'A1010.10',
  vintage: null,
  service_life: 50,
  life_adjustment_years: 0,
  asset_name: null,
  condition_rating: null,
  description: null,
  recommendation: null,
  action: null,
  priority: null,
  conservation_lens: null,
  quantity: null,
  unit_cost_override: null,
  opinion_of_probable_cost: null,
  action_year: null,
  allowance_interval_years: null,
  import_key: null,
})

// What one row of an un-inspected master-library workbook looks like once it is
// imported: fully identified and priced by the template, assessed by nobody.
const masterLibraryRow = () => ({
  ...blankAsset(),
  asset_name: 'Foundation and Footings',
  import_key: 'AB-1042',
  vintage: 1980,
  service_life: 100,
  unit_cost_override: 25,
  unit_measure: 'Sq. Ft.',
  description: '-',
})

test('a freshly created asset with only prefills is not assessed', () => {
  assert.equal(isAssetAssessed(blankAsset()), false)
  // Prefilled vintage/service life/pricing must never count as assessment.
  assert.equal(isAssetAssessed({ ...blankAsset(), vintage: 2005, service_life: 40 }), false)
})

// The regression the client reported: a 201-page PDF that was almost entirely
// master-library placeholder pages. Every imported row carries a name, a
// Uniformat class and a catalogue reference cost straight from the template, so
// none of those can be the signal that someone assessed the component.
test('an imported master-library row is not assessed', () => {
  assert.equal(isAssetAssessed(masterLibraryRow()), false)
  assert.equal(includeAssetInReport(masterLibraryRow()), false)
})

test('template identity and pricing never count as assessment', () => {
  for (const field of ['asset_name', 'unit_measure']) {
    assert.equal(
      isAssetAssessed({ ...masterLibraryRow(), [field]: 'anything' }),
      false,
      `${field} must not mark an imported row assessed`,
    )
  }
  // The workbook's Unit Repl. Cost is a catalogue price on 3,448 of the sample's
  // 4,091 rows. It prices the component; it says nothing about this property.
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), unit_cost_override: 999 }), false)
  // A quantity of 0 is the template saying the component is not present.
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), quantity: 0 }), false)
})

test('placeholder text is not a finding', () => {
  for (const placeholder of ['-', '--', 'N/A', 'n/a', 'none', 'TBD', '  -  ']) {
    assert.equal(
      isAssetAssessed({ ...masterLibraryRow(), description: placeholder }),
      false,
      `"${placeholder}" must not count as a description`,
    )
  }
})

test('any real assessor finding marks an imported row assessed', () => {
  for (const field of [
    'condition_rating',
    'description',
    'recommendation',
    'action',
    'priority',
    'conservation_lens',
  ]) {
    assert.equal(
      isAssetAssessed({ ...masterLibraryRow(), [field]: 'Fair' }),
      true,
      `${field} should count as assessed`,
    )
  }
  for (const field of [
    'quantity',
    'opinion_of_probable_cost',
    'action_year',
    'allowance_interval_years',
  ]) {
    assert.equal(
      isAssetAssessed({ ...masterLibraryRow(), [field]: 5 }),
      true,
      `${field} should count as assessed`,
    )
  }
  // A life adjustment is only ever typed against one component.
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), life_adjustment_years: 3 }), true)
})

// An asset created in the app has no name until someone types one, so there the
// name IS assessor input — unlike an imported row, where it is the library's.
test('naming an asset counts only when the assessor did the naming', () => {
  assert.equal(isAssetAssessed({ ...blankAsset(), asset_name: 'Roof' }), true)
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), asset_name: 'Roof' }), false)
})

test('isImportedAsset distinguishes workbook rows from app-created assets', () => {
  assert.equal(isImportedAsset(blankAsset()), false)
  assert.equal(isImportedAsset(masterLibraryRow()), true)
  assert.equal(isImportedAsset({ ...blankAsset(), import_key: '   ' }), false)
})

test('a photo alone marks an asset assessed', () => {
  assert.equal(isAssetAssessed(masterLibraryRow(), [{ id: 9 }]), true)
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), images: [{ id: 9 }] }), true)
  assert.equal(isAssetAssessed({ ...masterLibraryRow(), photo_count: 2 }), true)
  assert.equal(isAssetAssessed(masterLibraryRow(), []), false)
})

test('whitespace-only text is not assessment', () => {
  assert.equal(isAssetAssessed({ ...blankAsset(), asset_name: '   ' }), false)
  assert.equal(isAssetAssessed({ ...blankAsset(), description: '   ' }), false)
})

test('includeAssetInReport honours the Not Assessed opt-in', () => {
  const blank = blankAsset()
  assert.equal(includeAssetInReport(blank), false)
  assert.equal(includeAssetInReport({ ...blank, include_as_not_assessed: 1 }), true)
  // The opt-in is also the escape hatch for a master-library row the assessor
  // wants listed for completeness.
  assert.equal(includeAssetInReport({ ...masterLibraryRow(), include_as_not_assessed: 1 }), true)
  // An assessed asset is always included, opt-in or not.
  assert.equal(includeAssetInReport({ ...blank, asset_name: 'Roof' }), true)
})
