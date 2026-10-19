const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

const project = { id: 1, client: 'Acme Property Co' }
const building = { id: 2, project_id: 1, property_name: 'Riverbend Tower', address: '1200 West Georgia', city: 'Vancouver' }
const asset = {
  id: 5,
  building_id: 2,
  asset_name: 'Foundation',
  condition_rating: 'Good',
  uniformat_pricing_id: null,
}

function open(overrides = {}, hash = '1:2') {
  return loadPage('index.html', {
    hash,
    electronAPI: {
      listProjects: () => [project],
      listUniformatLevel1Groups: () => [{ name: 'A — Substructure' }, { name: 'B — Shell' }],
      listBuildings: () => [building],
      listBuildingImages: () => [],
      listAssets: () => [asset],
      listAssetImages: () => [],
      getAiStatus: () => ({ captionJobs: [] }),
      ensureDatabaseCurrent: () => ({ changed: false }),
      previewAssetPlan: () => null,
      ...overrides,
    },
  })
}

function pricedAsset() {
  return {
    ...asset,
    uniformat_pricing_id: 'P1',
    level_2_code: 'A10',
    level_2_group_element: 'Foundations',
    level_3_code: 'A1010',
    level_4_code: 'A101001',
    unit_measure: 'Each',
    quantity: 1,
    include_as_not_assessed: 0,
  }
}

function uniformatOverrides(overrides = {}) {
  return {
    listAssets: (_buildingId, level1) =>
      String(level1).startsWith('A') ? [pricedAsset()] : [],
    listUniformatLevel2Groups: () => [
      { level_2_code: 'A10', label: 'A10 Foundations' },
      { level_2_code: 'A20', label: 'A20 Basement construction' },
      { level_2_code: 'A30', label: 'A30 Slabs' },
    ],
    listUniformatLevel3Groups: (_level1, level2) => [
      { level_3_code: `${level2}10`, label: `${level2}10 group` },
    ],
    listUniformatLevel4Groups: (_level1, _level2, level3) => [
      { level_4_code: `${level3}01`, label: `${level3}01 item` },
    ],
    listUniformatPricingItems: (_level1, level2) => [
      {
        pricing_id: level2 === 'A10' ? 'P1' : level2 === 'A20' ? 'P2' : 'P3',
        label: `${level2} material`,
        unit_of_measure: 'Each',
        mean_service_life: 30,
      },
    ],
    ...overrides,
  }
}

async function openPricedAsset(overrides = {}) {
  const ctx = open(uniformatOverrides(overrides))
  await ctx.flush()
  ctx.document.querySelector('.home-asset-item[data-asset-id="5"] .home-asset-row').click()
  await ctx.flush()
  await ctx.flush()
  return ctx
}

test('the home page renders the project list, property list, and building detail', async () => {
  const { document, calls, flush } = open()
  await flush()

  const projectBtn = document.querySelector('[data-project-id="1"]')
  assert.ok(projectBtn, 'project row rendered')
  assert.equal(projectBtn.tagName, 'BUTTON')
  assert.equal(projectBtn.getAttribute('aria-pressed'), 'true') // preselected via hash
  assert.equal(projectBtn.hasAttribute('role'), false, 'toggle semantics stay native')
  assert.match(document.getElementById('project-list-wrap').textContent, /Acme Property Co/)
  assert.match(document.getElementById('property-list-wrap').textContent, /Riverbend Tower/)
  assert.ok(calls.some((c) => c.method === 'listBuildings' && c.args[0] === 1))
})

test('project and property selection use native toggle buttons and retain useful focus', async () => {
  const { document, flush } = open({}, '1')
  await flush()

  const projectBtn = document.querySelector('[data-project-id="1"]')
  projectBtn.focus()
  projectBtn.click()
  await flush()
  await flush()

  const rerenderedProjectBtn = document.querySelector('[data-project-id="1"]')
  assert.equal(rerenderedProjectBtn.tagName, 'BUTTON')
  assert.equal(rerenderedProjectBtn.getAttribute('aria-pressed'), 'false')
  assert.equal(document.activeElement, rerenderedProjectBtn)

  // Select the project again so its property list is available.
  rerenderedProjectBtn.click()
  await flush()
  await flush()

  const propertyBtn = document.querySelector('[data-building-id="2"]')
  assert.equal(propertyBtn.tagName, 'BUTTON')
  assert.equal(propertyBtn.getAttribute('aria-pressed'), 'false')
  assert.equal(propertyBtn.querySelector('.home-property-action-btn'), null)
  assert.equal(
    propertyBtn.parentElement.querySelectorAll(':scope > .home-property-actions button').length,
    4,
    'secondary actions are siblings, not invalid nested controls',
  )

  propertyBtn.focus()
  propertyBtn.click()
  await flush()
  await flush()
  await flush()

  assert.equal(document.querySelector('[data-building-id="2"]').getAttribute('aria-pressed'), 'true')
  assert.equal(document.activeElement, document.querySelector('.home-detail-tab[aria-selected="true"]'))
})

test('building tabs support arrow-key activation and preserve focus after rebuild', async () => {
  const { window, document, flush } = open()
  await flush()

  const activeTab = document.querySelector('.home-detail-tab[aria-selected="true"]')
  assert.equal(activeTab.getAttribute('aria-controls'), 'building-detail-panel')
  activeTab.focus()
  activeTab.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  )
  await flush()
  await flush()
  await flush()

  const nextTab = document.querySelector('.home-detail-tab[aria-selected="true"]')
  assert.equal(nextTab.textContent, 'B — Shell')
  assert.equal(document.activeElement, nextTab)
})

test('the project-report picker traps Tab and restores focus when dismissed', async () => {
  const secondBuilding = {
    ...building,
    id: 3,
    property_name: 'Lakeside Annex',
  }
  const { window, document, flush } = open({
    listBuildings: () => [building, secondBuilding],
  }, '1')
  await flush()

  const opener = document.getElementById('generate-project-report')
  opener.focus()
  opener.click()

  const picker = document.getElementById('project-report-picker')
  const dialog = picker.querySelector('[role="dialog"]')
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.closest('[hidden]'))
  const first = focusable[0]
  const last = focusable[focusable.length - 1]

  last.focus()
  last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(document.activeElement, first, 'Tab wraps to the first picker control')

  first.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
  }))
  assert.equal(document.activeElement, last, 'Shift+Tab wraps to the last picker control')

  first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(document.getElementById('project-report-picker'), null)
  assert.equal(document.activeElement, opener)
})

// syncHome reads the whole home graph over IPC before it assigns any of it, and
// several things start one: selecting a project, finishing an Excel import, and
// the background database-change poll. Without a last-writer guard the slower
// one lands second and writes its stale selection over the newer one — which is
// how a 4,000-row import ended with no project selected and a blank property
// list. Reproduced here with two overlapping selections.
test('a slow syncHome never overwrites a newer one', async () => {
  const projects = [project, { id: 9, client: 'Northern Health' }]
  const other = { id: 7, project_id: 9, property_name: 'Grandview Manor' }
  const { document, flush } = loadPage('index.html', {
    electronAPI: {
      listProjects: () => projects,
      listUniformatLevel1Groups: () => [],
      // Project 1's buildings arrive late, the way a big import's refresh does.
      listBuildings: async (id) => {
        if (id === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40))
          return [building]
        }
        return [other]
      },
      listBuildingImages: () => [],
      listAssets: () => [],
      listAssetImages: () => [],
      getAiStatus: () => ({ captionJobs: [] }),
      ensureDatabaseCurrent: () => ({ changed: false }),
      previewAssetPlan: () => null,
    },
  })
  await flush()

  // Start the slow selection, then immediately ask for the other project.
  document.querySelector('[data-project-id="1"]').click()
  document.querySelector('[data-project-id="9"]').click()

  // Long enough for the slow first sync to have resolved and tried to write.
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(
    document.querySelector('[data-project-id="9"]').getAttribute('aria-pressed'),
    'true',
    'the selection the user asked for last is the one that stands',
  )
  assert.equal(
    document.querySelector('[data-project-id="1"]').getAttribute('aria-pressed'),
    'false',
  )
  assert.match(document.getElementById('property-list-wrap').textContent, /Grandview Manor/)
})

// The ordering that survived the token guard, and that a 4,000-row import hits
// often: a background refresh defaults its selection from `homeState`, which is
// still the pre-selection value while the selection's own sync is fetching. It
// starts last, so it wins, and reverts the user's choice.
test('a background refresh during an in-flight selection keeps the new selection', async () => {
  const projects = [project, { id: 9, client: 'Northern Health' }]
  const other = { id: 7, project_id: 9, property_name: 'Grandview Manor' }
  const { window, document, flush } = loadPage('index.html', {
    electronAPI: {
      listProjects: () => projects,
      listUniformatLevel1Groups: () => [],
      listBuildings: async (id) => {
        // The newly selected project's buildings take a while to arrive.
        if (id === 9) {
          await new Promise((resolve) => setTimeout(resolve, 60))
          return [other]
        }
        return [building]
      },
      listBuildingImages: () => [],
      listAssets: () => [],
      listAssetImages: () => [],
      getAiStatus: () => ({ captionJobs: [] }),
      // The import changed the database, so the next focus triggers a refresh.
      ensureDatabaseCurrent: () => ({ changed: true }),
      previewAssetPlan: () => null,
    },
  })
  await flush()

  document.querySelector('[data-project-id="9"]').click()
  // Refocusing mid-flight is what the real app does after an import: the window
  // regains focus and refreshHomeIfDatabaseChanged fires a defaulted syncHome.
  window.dispatchEvent(new window.Event('focus'))

  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.equal(
    document.querySelector('[data-project-id="9"]').getAttribute('aria-pressed'),
    'true',
    'the refresh kept the selection instead of reverting it',
  )
  assert.match(document.getElementById('property-list-wrap').textContent, /Grandview Manor/)
})

test('the asset section lists the building assets and opens a form on click', async () => {
  const { document, flush } = open()
  await flush()

  assert.match(document.querySelector('.home-asset-list')?.textContent ?? '', /Foundation/)
  const row = document.querySelector('.home-asset-item[data-asset-id="5"] .home-asset-row')
  assert.ok(row, 'asset row rendered')
  row.click()
  await flush()

  const item = document.querySelector('.home-asset-item[data-asset-id="5"]')
  assert.ok(item.classList.contains('is-open'), 'asset expands on click')
  assert.ok(item.querySelector('form, .home-asset-form'), 'an asset form renders when open')
})

test('a failed asset flush keeps the current tab and form mounted', async () => {
  const { window, document, calls, flush } = await openPricedAsset({
    updateAsset: () => Promise.reject(new Error('asset database is locked')),
  })
  window.console.error = () => {}

  const checkbox = document.querySelector(
    '.home-asset-form input[name="include_as_not_assessed"]',
  )
  checkbox.checked = true
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }))
  const shellTab = [...document.querySelectorAll('.home-detail-tab')].find((tab) =>
    tab.textContent.startsWith('B'),
  )
  shellTab.click()
  await flush()
  await flush()

  assert.ok(calls.some((call) => call.method === 'updateAsset'))
  assert.equal(shellTab.getAttribute('aria-selected'), 'false')
  assert.equal(
    document.querySelector('.home-detail-tab[aria-selected="true"]').textContent,
    'A — Substructure',
  )
  assert.ok(document.querySelector('.home-asset-form'), 'the rejected form was not rebuilt away')
  assert.equal(document.querySelector('.home-asset-autosave-status').textContent, 'Save failed')
})

test('home navigation does not leave an asset whose flush failed', async () => {
  const { window, document, calls, flush } = await openPricedAsset({
    updateAsset: () => Promise.reject(new Error('asset save failed')),
  })
  window.console.error = () => {}

  const assetName = document.querySelector('.home-asset-form input[name="asset_name"]')
  assetName.value = 'Unsaved foundation'
  assetName.dispatchEvent(new window.Event('input', { bubbles: true }))
  document.querySelector('.home-property-menu-option--add').click()
  await flush()
  await flush()

  assert.ok(calls.some((call) => call.method === 'updateAsset'))
  assert.equal(calls.some((call) => call.method === 'openBuildingInfo'), false)
  assert.ok(document.querySelector('.home-asset-form'))
})

test('an asset tab switch flushes an edit made during its first write', async () => {
  let resolveFirst
  const firstWrite = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const payloads = []
  const { window, document, flush } = await openPricedAsset({
    updateAsset: (_id, payload) => {
      payloads.push({ ...payload })
      return payloads.length === 1 ? firstWrite : null
    },
  })

  const checkbox = document.querySelector(
    '.home-asset-form input[name="include_as_not_assessed"]',
  )
  checkbox.checked = true
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }))
  const shellTab = [...document.querySelectorAll('.home-detail-tab')].find((tab) =>
    tab.textContent.startsWith('B'),
  )
  shellTab.click()
  await flush()
  assert.equal(payloads.length, 1)

  const assetName = document.querySelector('.home-asset-form input[name="asset_name"]')
  assetName.value = 'Final foundation name'
  assetName.dispatchEvent(new window.Event('input', { bubbles: true }))
  resolveFirst()
  await flush()
  await flush()
  await flush()

  assert.equal(payloads.length, 2)
  assert.equal(payloads[1].asset_name, 'Final foundation name')
  assert.equal(
    document.querySelector('.home-detail-tab[aria-selected="true"]').textContent,
    'B — Shell',
  )
})

test('tab switching waits for the latest Uniformat cascade before saving', async () => {
  let resolveLevel3
  const delayedLevel3 = new Promise((resolve) => {
    resolveLevel3 = resolve
  })
  const payloads = []
  const { window, document, flush } = await openPricedAsset({
    listUniformatLevel3Groups: (_level1, level2) =>
      level2 === 'A20'
        ? delayedLevel3
        : [{ level_3_code: 'A1010', label: 'A1010 group' }],
    updateAsset: (_id, payload) => {
      payloads.push({ ...payload })
    },
  })

  const level2 = document.querySelector(
    '.home-asset-form select[name="uniformat_level_2_code"]',
  )
  level2.value = 'A20'
  level2.dispatchEvent(new window.Event('change', { bubbles: true }))
  const shellTab = [...document.querySelectorAll('.home-detail-tab')].find((tab) =>
    tab.textContent.startsWith('B'),
  )
  shellTab.click()
  await flush()
  assert.equal(payloads.length, 0, 'teardown is waiting for the hierarchy request')

  resolveLevel3([{ level_3_code: 'A2010', label: 'A2010 group' }])
  await flush()
  await flush()
  assert.equal(payloads.length, 0, 'the obsolete P1 material was not written')
  assert.equal(
    document.querySelector('.home-detail-tab[aria-selected="true"]').textContent,
    'A — Substructure',
  )
  assert.match(document.querySelector('.home-asset-autosave-status').textContent, /Choose a material/)

  const form = document.querySelector('.home-asset-form')
  form.elements.uniformat_level_4_code.value = 'A201001'
  form.elements.uniformat_level_4_code.dispatchEvent(
    new window.Event('change', { bubbles: true }),
  )
  await flush()
  assert.equal(form.elements.uniformat_pricing_id.value, 'P2')
  shellTab.click()
  await flush()
  await flush()

  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].uniformat_pricing_id, 'P2')
  assert.equal(
    document.querySelector('.home-detail-tab[aria-selected="true"]').textContent,
    'B — Shell',
  )
})

test('a stale Uniformat response cannot overwrite the newest parent selection', async () => {
  let resolveA20
  let resolveA30
  const a20 = new Promise((resolve) => {
    resolveA20 = resolve
  })
  const a30 = new Promise((resolve) => {
    resolveA30 = resolve
  })
  const { window, document, flush } = await openPricedAsset({
    listUniformatLevel3Groups: (_level1, level2) => {
      if (level2 === 'A20') return a20
      if (level2 === 'A30') return a30
      return [{ level_3_code: 'A1010', label: 'A1010 group' }]
    },
  })

  const form = document.querySelector('.home-asset-form')
  const level2 = form.elements.uniformat_level_2_code
  level2.value = 'A20'
  level2.dispatchEvent(new window.Event('change', { bubbles: true }))
  level2.value = 'A30'
  level2.dispatchEvent(new window.Event('change', { bubbles: true }))

  resolveA30([{ level_3_code: 'A3010', label: 'A3010 group' }])
  await flush()
  resolveA20([{ level_3_code: 'A2010', label: 'A2010 stale group' }])
  await flush()
  await flush()

  assert.equal(form.elements.uniformat_level_2_code.value, 'A30')
  assert.equal(form.elements.uniformat_level_3_code.value, 'A3010')
  assert.ok(
    [...form.elements.uniformat_level_4_code.options].some(
      (option) => option.value === 'A301001',
    ),
  )
  form.elements.uniformat_level_4_code.value = 'A301001'
  form.elements.uniformat_level_4_code.dispatchEvent(
    new window.Event('change', { bubbles: true }),
  )
  await flush()
  assert.equal(form.elements.uniformat_pricing_id.value, 'P3')
})

test('a Uniformat hydration error is visible in the asset form', async () => {
  const { document, flush } = await openPricedAsset({
    listUniformatLevel2Groups: () => Promise.reject(new Error('pricing file unavailable')),
  })
  await flush()

  assert.match(
    document.querySelector('.home-asset-autosave-status').textContent,
    /Could not load pricing choices: pricing file unavailable/,
  )
  assert.equal(document.querySelector('.home-asset-uniformat-retry').hidden, false)
})

test('failed initial Uniformat hydration can be retried and then flushed', async () => {
  let level2Attempts = 0
  const { window, document, calls, flush } = await openPricedAsset({
    listUniformatLevel2Groups: () => {
      level2Attempts += 1
      if (level2Attempts === 1) throw new Error('pricing file temporarily unavailable')
      return [{ level_2_code: 'A10', label: 'A10 Foundations' }]
    },
    updateAsset: () => null,
  })
  await flush()

  const form = document.querySelector('.home-asset-form')
  const name = form.elements.asset_name
  name.value = 'Retried foundation'
  name.dispatchEvent(new window.Event('input', { bubbles: true }))

  const retry = document.querySelector('.home-asset-uniformat-retry')
  assert.equal(retry.hidden, false)
  retry.click()
  await flush()
  await flush()
  await flush()

  assert.equal(level2Attempts, 2)
  assert.equal(retry.hidden, true)
  assert.equal(form.elements.uniformat_pricing_id.value, 'P1')

  const shellTab = [...document.querySelectorAll('.home-detail-tab')].find((tab) =>
    tab.textContent.startsWith('B'),
  )
  shellTab.click()
  await flush()
  await flush()

  const saved = calls.find((call) => call.method === 'updateAsset')
  assert.ok(saved, 'the draft became flushable after retry')
  assert.equal(saved.args[1].asset_name, 'Retried foundation')
  assert.equal(
    document.querySelector('.home-detail-tab[aria-selected="true"]').textContent,
    'B — Shell',
  )
})

test('app undo flushes a pending asset edit before asking main history to undo', async () => {
  const { window, document, calls, flush } = await openPricedAsset({
    updateAsset: () => null,
    undoLastAction: () => ({ undone: false, empty: true }),
  })

  const checkbox = document.querySelector(
    '.home-asset-form input[name="include_as_not_assessed"]',
  )
  checkbox.checked = true
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }))
  checkbox.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
  )
  await flush()
  await flush()

  const updateIndex = calls.findIndex((call) => call.method === 'updateAsset')
  const undoIndex = calls.findIndex((call) => call.method === 'undoLastAction')
  assert.ok(updateIndex >= 0)
  assert.ok(undoIndex > updateIndex, 'the pending edit became the newest history action first')
})

test('app undo aborts when a pending asset edit cannot be saved', async () => {
  const { window, document, calls, flush } = await openPricedAsset({
    updateAsset: () => Promise.reject(new Error('save rejected')),
    undoLastAction: () => ({ undone: true, type: 'project-update' }),
  })
  window.console.error = () => {}

  const checkbox = document.querySelector(
    '.home-asset-form input[name="include_as_not_assessed"]',
  )
  checkbox.checked = true
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }))
  checkbox.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
  )
  await flush()
  await flush()

  assert.ok(calls.some((call) => call.method === 'updateAsset'))
  assert.equal(calls.some((call) => call.method === 'undoLastAction'), false)
  assert.match(document.getElementById('app-toast-host').textContent, /undo was not applied/)
})

test('Ctrl+Z in an asset text field remains native text undo', async () => {
  const { window, document, calls, flush } = await openPricedAsset({
    undoLastAction: () => ({ undone: true, type: 'asset-update' }),
  })

  const assetName = document.querySelector('.home-asset-form input[name="asset_name"]')
  assetName.focus()
  assetName.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
  )
  await flush()

  assert.equal(calls.some((call) => call.method === 'undoLastAction'), false)
})

test('deleting a project through the row button re-syncs from an emptied list', async () => {
  let deleted = false
  const { document, calls, flush } = open({
    deleteProject: () => {
      deleted = true
      return { canceled: false }
    },
    listProjects: () => (deleted ? [] : [project]),
  })
  await flush()

  document.querySelector('.home-delete-project-btn').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'deleteProject' && c.args[0] === 1))
  // After the re-sync the emptied list shows the placeholder.
  assert.match(document.getElementById('project-list-wrap').textContent, /No projects yet/)
})

const assetImage = {
  id: 20,
  asset_id: 5,
  file_path: '/ud/asset-images/a.jpg',
  media_url: 'file:///ud/asset-images/a.jpg',
  caption: 'Cracked footing',
  original_name: 'a.jpg',
  include_in_report: 1,
  bounding_boxes: '[]',
}

async function openWithImageGallery(overrides = {}) {
  const ctx = open({ listAssetImages: () => [assetImage], ...overrides })
  await ctx.flush()
  // Open the asset so its image section renders.
  ctx.document.querySelector('.home-asset-item[data-asset-id="5"] .home-asset-row').click()
  await ctx.flush()
  return ctx
}

test('clicking an asset image thumbnail opens the gallery with its caption', async () => {
  const { document, flush } = await openWithImageGallery()

  const thumb = document.querySelector('.home-asset-image-thumb')
  assert.ok(thumb, 'asset image thumbnail rendered')
  assert.equal(thumb.tagName, 'BUTTON')
  assert.match(thumb.getAttribute('aria-label'), /Open .* in image gallery/)
  thumb.focus()
  thumb.click()
  await flush()

  const gallery = document.getElementById('home-image-gallery')
  assert.ok(gallery, 'gallery overlay opened')
  const captionInput = gallery.querySelector('.home-image-gallery-caption-input')
  assert.ok(captionInput, 'caption editor rendered')
  assert.equal(captionInput.value, 'Cracked footing')
  assert.equal(document.activeElement, gallery.querySelector('.home-image-gallery-close'))

  // Closing removes the overlay.
  document.querySelector('.home-image-gallery-close').click()
  await flush()
  assert.equal(document.getElementById('home-image-gallery'), null)
  assert.equal(document.activeElement, thumb)
})

test('the gallery traps Tab, supports arrow navigation, and closes with Escape', async () => {
  const secondImage = {
    ...assetImage,
    id: 21,
    file_path: '/ud/asset-images/b.jpg',
    media_url: 'file:///ud/asset-images/b.jpg',
    caption: 'Roof membrane',
    original_name: 'b.jpg',
  }
  const { window, document, flush } = await openWithImageGallery({
    listAssetImages: () => [{ ...assetImage }, secondImage],
  })

  const thumb = document.querySelector('.home-asset-image-thumb')
  thumb.focus()
  thumb.click()
  await flush()

  let gallery = document.getElementById('home-image-gallery')
  const focusable = [...gallery.querySelectorAll(
    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.closest('[hidden]'))
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  last.focus()
  last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(document.activeElement, first, 'Tab wraps inside the modal')

  first.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  )
  await flush()
  await flush()

  gallery = document.getElementById('home-image-gallery')
  assert.match(gallery.querySelector('.home-image-gallery-meta').textContent, /2 of 2/)
  assert.equal(document.activeElement, gallery.querySelector('.home-image-gallery-nav--next'))

  document.activeElement.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
  await flush()
  await flush()

  assert.equal(document.getElementById('home-image-gallery'), null)
  assert.equal(document.activeElement, thumb)
})

function typeGalleryCaption(window, input, text) {
  input.value = text
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('closing the gallery flushes a caption still inside the debounce window', async () => {
  const { window, document, calls, flush } = await openWithImageGallery({
    updateImageCaption: (kind, imageId, caption) => ({ kind, imageId, caption }),
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()

  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  typeGalleryCaption(window, captionInput, 'Hairline crack at north footing')
  document.querySelector('.home-image-gallery-close').click()
  await flush()

  assert.ok(
    calls.some(
      (c) =>
        c.method === 'updateImageCaption' &&
        c.args[0] === 'asset' &&
        c.args[1] === 20 &&
        c.args[2] === 'Hairline crack at north footing',
    ),
    'close must write the caption without waiting for the 450 ms debounce',
  )
})

test('a failed caption flush keeps the gallery open and can be retried', async () => {
  let shouldFail = true
  const { window, document, calls, flush } = await openWithImageGallery({
    updateImageCaption: () =>
      shouldFail ? Promise.reject(new Error('image database is locked')) : null,
  })
  window.console.error = () => {}

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  typeGalleryCaption(window, captionInput, 'Retry this caption')
  document.querySelector('.home-image-gallery-close').click()
  await flush()

  assert.ok(document.getElementById('home-image-gallery'), 'failed close keeps the editor mounted')
  assert.match(document.querySelector('.home-image-gallery-status').textContent, /database is locked/)

  shouldFail = false
  document.querySelector('.home-image-gallery-close').click()
  await flush()
  await flush()

  assert.equal(document.getElementById('home-image-gallery'), null)
  assert.equal(calls.filter((call) => call.method === 'updateImageCaption').length, 2)
})

test('failed annotation saves block gallery and window close until a retry succeeds', async () => {
  let requestClose
  let closeResult
  let shouldFail = true
  const annotatedImage = {
    ...assetImage,
    bounding_boxes: [
      { kind: 'box', x: 0.1, y: 0.1, w: 0.25, h: 0.2, color: '#ff2d2d' },
    ],
  }
  const { window, document, calls, flush } = await openWithImageGallery({
    listAssetImages: () => [annotatedImage],
    onCloseRequested: (listener) => {
      requestClose = listener
    },
    completeCloseRequest: (_requestId, result) => {
      closeResult = result
    },
    updateImageBoundingBoxes: () =>
      shouldFail ? Promise.reject(new Error('annotation database is locked')) : null,
  })
  window.console.error = () => {}

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const removeBoxes = [...document.querySelectorAll('.home-image-gallery-annot-remove')].find(
    (button) => button.textContent === 'Remove boxes',
  )
  removeBoxes.click()
  await flush()
  await flush()

  assert.match(
    document.querySelector('.home-image-gallery-status').textContent,
    /Could not save annotations: annotation database is locked/,
  )

  requestClose(91)
  await flush()
  await flush()
  assert.equal(closeResult.ok, false)
  assert.match(closeResult.error, /annotation database is locked/)

  document.querySelector('.home-image-gallery-close').click()
  await flush()
  assert.ok(document.getElementById('home-image-gallery'), 'failed retry keeps the gallery mounted')

  shouldFail = false
  document.querySelector('.home-image-gallery-close').click()
  await flush()
  await flush()

  assert.equal(document.getElementById('home-image-gallery'), null)
  assert.ok(calls.filter((call) => call.method === 'updateImageBoundingBoxes').length >= 3)

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const reopenedRemoveBoxes = [
    ...document.querySelectorAll('.home-image-gallery-annot-remove'),
  ].find((button) => button.textContent === 'Remove boxes')
  assert.equal(reopenedRemoveBoxes.disabled, true, 'the successful retry updated canonical state')
})

test('rapid annotation edits serialize and gallery close waits for the latest revision', async () => {
  let resolveFirst
  const firstWrite = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const payloads = []
  const annotatedImage = {
    ...assetImage,
    bounding_boxes: [
      { kind: 'box', x: 0.1, y: 0.1, w: 0.25, h: 0.2, color: '#ff2d2d' },
      { kind: 'arrow', x1: 0.2, y1: 0.2, x2: 0.7, y2: 0.7, color: '#228be6' },
    ],
  }
  const { document, flush } = await openWithImageGallery({
    listAssetImages: () => [annotatedImage],
    updateImageBoundingBoxes: (_kind, _imageId, annotations) => {
      payloads.push(annotations.map((item) => ({ ...item })))
      return payloads.length === 1 ? firstWrite : null
    },
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const removeButtons = [...document.querySelectorAll('.home-image-gallery-annot-remove')]
  removeButtons.find((button) => button.textContent === 'Remove boxes').click()
  removeButtons.find((button) => button.textContent === 'Remove arrows').click()
  document.querySelector('.home-image-gallery-close').click()
  await flush()

  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].length, 1)
  assert.equal(payloads[0][0].kind, 'arrow')
  assert.ok(document.getElementById('home-image-gallery'), 'close waits for the first write')

  resolveFirst()
  await flush()
  await flush()
  await flush()

  assert.equal(payloads.length, 2)
  assert.deepEqual(payloads[1], [])
  assert.equal(document.getElementById('home-image-gallery'), null)
})

test('gallery close flushes a caption edit made during its first write', async () => {
  let resolveFirst
  const firstWrite = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const captions = []
  const { window, document, flush } = await openWithImageGallery({
    updateImageCaption: (_kind, _imageId, caption) => {
      captions.push(caption)
      return captions.length === 1 ? firstWrite : null
    },
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  typeGalleryCaption(window, captionInput, 'First caption')
  document.querySelector('.home-image-gallery-close').click()
  await flush()
  assert.deepEqual(captions, ['First caption'])

  typeGalleryCaption(window, captionInput, 'Final caption')
  resolveFirst()
  await flush()
  await flush()

  assert.deepEqual(captions, ['First caption', 'Final caption'])
  assert.equal(document.getElementById('home-image-gallery'), null)
})

test('caption saves preserve the photo object used by later annotation updates', async () => {
  const annotatedImage = {
    ...assetImage,
    caption: 'Original caption',
    bounding_boxes: [
      { kind: 'box', x: 0.1, y: 0.1, w: 0.25, h: 0.2, color: '#ff2d2d' },
    ],
  }
  const { window, document, flush } = await openWithImageGallery({
    listAssetImages: () => [annotatedImage],
    updateImageCaption: () => null,
    updateImageBoundingBoxes: () => null,
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  captionInput.value = 'Updated caption'
  captionInput.dispatchEvent(new window.Event('change', { bubbles: true }))
  await flush()

  const removeBoxes = [...document.querySelectorAll('.home-image-gallery-annot-remove')].find(
    (button) => button.textContent === 'Remove boxes',
  )
  assert.ok(removeBoxes)
  assert.equal(removeBoxes.disabled, false)
  removeBoxes.click()
  await flush()

  document.querySelector('.home-image-gallery-close').click()
  await flush()
  document.querySelector('.home-asset-image-thumb').click()
  await flush()

  const reopenedRemoveBoxes = [
    ...document.querySelectorAll('.home-image-gallery-annot-remove'),
  ].find((button) => button.textContent === 'Remove boxes')
  assert.equal(reopenedRemoveBoxes.disabled, true, 'the canonical image retains the empty box list')
  assert.equal(document.querySelectorAll('.home-image-gallery-box').length, 0)
})

test('pagehide flushes a pending gallery caption', async () => {
  const { window, document, calls, flush } = await openWithImageGallery({
    updateImageCaption: (kind, imageId, caption) => ({ kind, imageId, caption }),
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()

  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  typeGalleryCaption(window, captionInput, 'Spalling at the southeast corner')
  window.dispatchEvent(new window.Event('pagehide'))
  await flush()

  assert.ok(
    calls.some(
      (c) =>
        c.method === 'updateImageCaption' &&
        c.args[0] === 'asset' &&
        c.args[1] === 20 &&
        c.args[2] === 'Spalling at the southeast corner',
    ),
    'pagehide must consume pendingGalleryCaptionSave so quit cannot drop the edit',
  )
})

test('a registry flush waits for an ordinary debounced caption write', async () => {
  let requestClose
  let closeResult
  let resolveCaptionWrite
  const captionWrite = new Promise((resolve) => {
    resolveCaptionWrite = resolve
  })
  const { window, document, calls, flush } = await openWithImageGallery({
    updateImageCaption: () => captionWrite,
    onCloseRequested: (listener) => {
      requestClose = listener
    },
    completeCloseRequest: (_requestId, result) => {
      closeResult = result
    },
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  typeGalleryCaption(
    window,
    document.querySelector('.home-image-gallery-caption-input'),
    'Debounced write still in progress',
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(calls.some((call) => call.method === 'updateImageCaption'))

  requestClose(92)
  await flush()
  await flush()
  assert.equal(closeResult, undefined, 'close acknowledgement waits for the caption IPC')

  resolveCaptionWrite()
  await flush()
  await flush()
  assert.equal(closeResult.ok, true)
})

test('Generate New Caption drains an older manual caption write before enqueueing AI', async () => {
  let resolveCaptionWrite
  const order = []
  const captionWrite = new Promise((resolve) => {
    resolveCaptionWrite = () => {
      order.push('manual resolved')
      resolve()
    }
  })
  const { window, document, calls, flush } = await openWithImageGallery({
    updateImageCaption: () => {
      order.push('manual started')
      return captionWrite
    },
    regenerateImageCaption: () => {
      order.push('AI enqueued')
      return { ok: true }
    },
  })

  document.querySelector('.home-asset-image-thumb').click()
  await flush()
  const captionInput = document.querySelector('.home-image-gallery-caption-input')
  typeGalleryCaption(window, captionInput, 'Manual caption on the wire')
  captionInput.dispatchEvent(new window.Event('change', { bubbles: true }))
  await flush()
  assert.deepEqual(order, ['manual started'])

  document.querySelector('.home-image-gallery-caption-generate').click()
  await flush()
  assert.equal(
    calls.some((call) => call.method === 'regenerateImageCaption'),
    false,
    'AI cannot snapshot while the manual write is unresolved',
  )

  resolveCaptionWrite()
  await flush()
  await flush()
  assert.deepEqual(order, ['manual started', 'manual resolved', 'AI enqueued'])
})

test('the include-in-report toggle calls updateAssetImageIncludeInReport', async () => {
  const { document, calls, flush } = await openWithImageGallery({
    updateAssetImageIncludeInReport: (id, next) => ({ include_in_report: next ? 1 : 0 }),
  })

  const reportBtn = document.querySelector('.home-image-report-btn')
  assert.ok(reportBtn)
  assert.equal(reportBtn.getAttribute('aria-pressed'), 'true') // starts included
  reportBtn.click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'updateAssetImageIncludeInReport' && c.args[0] === 20))
  assert.equal(reportBtn.getAttribute('aria-pressed'), 'false')
})

test('a failed include-in-report update keeps its state and reports the error', async () => {
  const { document, flush } = await openWithImageGallery({
    listAssetImages: () => [{ ...assetImage, include_in_report: 1 }],
    updateAssetImageIncludeInReport: () => Promise.reject(new Error('image database is locked')),
  })

  const reportBtn = document.querySelector('.home-image-report-btn')
  assert.equal(reportBtn.getAttribute('aria-pressed'), 'true')
  reportBtn.click()
  await flush()
  await flush()

  assert.equal(reportBtn.getAttribute('aria-pressed'), 'true')
  assert.equal(reportBtn.disabled, false)
  assert.match(document.getElementById('app-toast-host').textContent, /image database is locked/)
})

test('Start new project and Settings buttons route through the API', async () => {
  const { document, calls, flush } = open()
  await flush()

  document.getElementById('start-new-project').click()
  document.getElementById('open-settings').click()
  await flush()
  assert.ok(calls.some((c) => c.method === 'openProjectSetup'))
  assert.ok(calls.some((c) => c.method === 'openSettings'))
})
