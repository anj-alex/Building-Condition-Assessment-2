const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

const building = {
  id: 2,
  project_id: 1,
  property_name: 'Riverbend Tower',
  address: '1200 West Georgia',
  city: 'Vancouver',
  province: 'British Columbia',
  province_short: 'BC',
  location_factor: 1.063,
  location_factor_province: 'British Columbia',
  location_factor_city: 'Vancouver',
}
const factors = [
  { province: 'British Columbia', city: 'Vancouver', label: 'Vancouver, BC', factor: 1.063 },
  { province: 'Ontario', city: 'Toronto', label: 'Toronto, ON', factor: 1.12 },
]
const images = [
  { id: 10, file_path: '/ud/b/10.jpg', media_url: 'file:///ud/b/10.jpg', caption: 'Front', original_name: '10.jpg' },
  { id: 11, file_path: '/ud/b/11.jpg', media_url: 'file:///ud/b/11.jpg', original_name: '11.jpg' },
]

function open(overrides = {}) {
  return loadPage('building-info.html', {
    hash: '1:2',
    electronAPI: {
      getBuilding: () => building,
      getProject: () => ({ id: 1, client: 'Acme Property Co' }),
      listLocationFactors: () => factors,
      listBuildingImages: () => images,
      ...overrides,
    },
  })
}

test('editing an existing building loads its fields, factors, photos, and client', async () => {
  const { document, flush } = open()
  await flush()

  assert.equal(document.getElementById('property-name').value, 'Riverbend Tower')
  assert.equal(document.getElementById('city').value, 'Vancouver')
  assert.match(document.getElementById('project-client').textContent, /Acme Property Co/)

  // Location factor dropdown: custom option + one per factor row, preselected.
  const key = document.getElementById('location-factor-key')
  assert.equal(key.querySelectorAll('option').length, factors.length + 1)
  assert.equal(key.value, 'British Columbia::Vancouver')

  // Photos rendered with delete buttons.
  const figures = document.querySelectorAll('#building-photo-preview .building-photo-item')
  assert.equal(figures.length, 2)
  assert.ok(document.querySelector('#building-delete-slot .btn-danger'))
})

test('choosing a location factor key fills the numeric factor', async () => {
  const { document, flush } = open()
  await flush()
  const key = document.getElementById('location-factor-key')
  const input = document.getElementById('location-factor')

  key.value = 'Ontario::Toronto'
  key.dispatchEvent(new (key.ownerDocument.defaultView.Event)('change'))
  assert.equal(input.value, '1.12')
})

test('deleting a photo calls the API and re-renders from the fresh list', async () => {
  let remaining = images
  const { document, calls, flush } = open({
    deleteBuildingImage: () => { remaining = [images[1]]; return { canceled: false } },
    listBuildingImages: () => remaining,
  })
  await flush()

  document.querySelector('#building-photo-preview .building-photo-delete-btn').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'deleteBuildingImage' && c.args[0] === 10))
  assert.equal(document.querySelectorAll('#building-photo-preview .building-photo-item').length, 1)
})

test('a new building disables the add-photos button and shows the placeholder', async () => {
  const { document, flush } = loadPage('building-info.html', { hash: '1' })
  await flush()

  assert.equal(document.getElementById('add-building-photos').disabled, true)
  assert.match(document.getElementById('building-photo-preview').textContent, /Start editing/)
  assert.equal(document.querySelector('#building-delete-slot .btn-danger'), null)
})
