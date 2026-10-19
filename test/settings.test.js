const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

const appInfo = {
  version: '1.4.0',
  name: 'CARA',
  packaged: false,
  electron: '43.0.0',
  chrome: '138.0',
  node: '22.0',
  platform: 'linux',
  arch: 'x64',
  userDataPath: '/ud',
  dbPath: '/ud/app.db',
}

function open(overrides = {}, opts = {}) {
  return loadPage('settings.html', {
    electronAPI: {
      getAppInfo: () => appInfo,
      getAiStatus: () => ({ configured: true, unlocked: false }),
      ...overrides,
    },
    ...opts,
  })
}

test('bootstrap fills the About panel and version from getAppInfo', async () => {
  const { document, calls, flush } = open()
  await flush()

  assert.ok(calls.some((c) => c.method === 'getAppInfo'))
  assert.equal(document.getElementById('app-about-version').textContent, 'Version 1.4.0')
  const debug = document.getElementById('app-debug-info').textContent
  assert.match(debug, /1\.4\.0/)
  assert.match(debug, /\/ud\/app\.db/)
})

test('an unlocked AI status shows the usage panel and renders usage figures', async () => {
  const { document, calls, flush } = open({
    getAiStatus: () => ({ configured: true, unlocked: true }),
    getAiUsage: () => ({
      ok: true,
      label: 'capped-key',
      limit: 10,
      limitReset: 'monthly',
      display: { usage: '$1.20', usageMonthly: '$3.00', limitRemaining: '$8.80', limit: '$10' },
    }),
  })
  await flush()

  assert.ok(calls.some((c) => c.method === 'getAiUsage'))
  assert.equal(document.getElementById('ai-usage-panel').hidden, false)
  assert.equal(document.getElementById('ai-usage-total').textContent, '$1.20')
  assert.equal(document.getElementById('ai-usage-remaining').textContent, '$8.80')
  assert.match(document.getElementById('ai-usage-meta').textContent, /capped-key/)
  assert.equal(document.getElementById('ai-status-detail').textContent, '')
})

test('a not-configured AI status explains how to add a key and hides usage', async () => {
  const { document, flush } = open({ getAiStatus: () => ({ configured: false }) })
  await flush()

  assert.match(document.getElementById('ai-status-detail').textContent, /OPENROUTER_API_KEY/)
  assert.equal(document.getElementById('ai-usage-panel').hidden, true)
})

test('deleted projects list renders and Recover restores then re-syncs', async () => {
  let restored = false
  const { document, calls, flush } = open({
    listDeletedProjects: () => (restored ? [] : [{ id: 7, client: 'Old Client' }]),
    restoreDeletedProject: () => {
      restored = true
      return { ok: true, label: 'Old Client' }
    },
  })
  await flush()

  const list = document.getElementById('deleted-projects-list')
  assert.match(list.textContent, /Old Client/)
  const recoverBtn = list.querySelector('.settings-deleted-projects-item .btn-secondary')
  assert.ok(recoverBtn, 'a Recover button rendered')

  recoverBtn.click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'restoreDeletedProject' && c.args[0] === 7))
  assert.match(list.textContent, /No deleted projects to recover/)
  assert.match(document.getElementById('deleted-projects-status').textContent, /Recovered/)
})

test('a custom uniformat pricing file is reflected in the status card', async () => {
  const { document, flush } = open({
    reloadUniformatPricingFromDisk: () => ({
      isDefault: false,
      fileName: 'custom-pricing.csv',
      path: '/ud/uniformat.csv',
      sourcePath: '/home/user/custom-pricing.csv',
    }),
  })
  await flush()

  assert.equal(document.getElementById('uniformat-status-label').textContent, 'custom-pricing.csv')
  assert.ok(document.getElementById('uniformat-status').classList.contains('is-custom'))
})

test('choosing a pricing file routes through chooseUniformatPricingCsv', async () => {
  const { document, calls, flush } = open({
    chooseUniformatPricingCsv: () => ({ isDefault: true }),
  })
  await flush()

  document.getElementById('uniformat-pricing-csv').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'chooseUniformatPricingCsv'))
  assert.equal(document.getElementById('uniformat-status-label').textContent, 'Default pricing list')
})

test('Export data reports where the backup was saved', async () => {
  const { document, calls, flush } = open({
    exportAppData: () => ({ filePath: '/backups/app.carbak' }),
  })
  await flush()

  document.getElementById('export-app-data').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'exportAppData'))
  assert.match(document.getElementById('app-data-status').textContent, /\/backups\/app\.carbak/)
})

test('Generate blank fields previews and opens the confirmation modal', async () => {
  const { document, calls, flush } = open({
    previewBlankFields: () => ({ ok: true, captions: 2, summaries: 1, missingFiles: 0 }),
  })
  await flush()

  document.getElementById('ai-generate-blank-captions').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'previewBlankFields'))
  assert.equal(document.getElementById('ai-bulk-modal').hidden, false)
  assert.match(document.getElementById('ai-bulk-counts').textContent, /2 photo captions and 1 summary section/)
})

test('the theme segments start on the stored preference and switch on click', async () => {
  const { document, window, flush } = open({}, { localStorage: { 'app-theme': 'light' } })
  await flush()

  const light = document.querySelector('[data-theme-value="light"]')
  const dark = document.querySelector('[data-theme-value="dark"]')
  assert.equal(light.getAttribute('aria-checked'), 'true')

  dark.click()
  assert.equal(dark.getAttribute('aria-checked'), 'true')
  assert.equal(light.getAttribute('aria-checked'), 'false')
  assert.equal(window.localStorage.getItem('app-theme'), 'dark')
})
