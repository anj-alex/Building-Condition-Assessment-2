const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

const firmWithLogo = {
  name: 'ANJ Software',
  short_name: 'ANJ',
  address_line_1: '123 Consulting Way',
  address_line_2: 'Suite 4',
  logo_path: '/ud/firm-assets/logo.png',
  media_url: 'file:///ud/firm-assets/logo.png',
  logo_original_name: 'logo.png',
}

test('the firm form fills from getFirm on load, including the logo preview', async () => {
  const { document, calls, flush } = loadPage('firm-setup.html', {
    electronAPI: { getFirm: () => firmWithLogo },
  })
  await flush()

  assert.ok(calls.some((c) => c.method === 'getFirm'))
  assert.equal(document.getElementById('firm-name').value, 'ANJ Software')
  assert.equal(document.getElementById('firm-short-name').value, 'ANJ')
  const img = document.querySelector('#firm-logo-preview img')
  assert.ok(img, 'logo preview image rendered')
  assert.equal(img.getAttribute('src'), 'file:///ud/firm-assets/logo.png')
  assert.ok(document.querySelector('#firm-logo-preview .firm-logo-remove-btn'))
})

test('with no logo the preview shows the empty message and no remove button', async () => {
  const { document, flush } = loadPage('firm-setup.html', {
    electronAPI: { getFirm: () => ({ name: 'Firm', logo_path: null }) },
  })
  await flush()

  assert.match(document.querySelector('#firm-logo-preview').textContent, /No logo selected/)
  assert.equal(document.querySelector('#firm-logo-preview .firm-logo-remove-btn'), null)
})

test('removing the logo calls removeFirmLogo and refills the form', async () => {
  const { document, calls, flush } = loadPage('firm-setup.html', {
    electronAPI: {
      getFirm: () => firmWithLogo,
      removeFirmLogo: () => ({ name: 'ANJ Software', logo_path: null }),
    },
  })
  await flush()

  document.querySelector('#firm-logo-preview .firm-logo-remove-btn').click()
  await flush()

  assert.ok(calls.some((c) => c.method === 'removeFirmLogo'))
  assert.match(document.querySelector('#firm-logo-preview').textContent, /No logo selected/)
})

test('an undo of a firm edit re-fetches and refills the form', async () => {
  const { window, document, calls, flush } = loadPage('firm-setup.html', {
    electronAPI: { getFirm: () => firmWithLogo },
  })
  await flush()
  const before = calls.filter((c) => c.method === 'getFirm').length

  window.dispatchEvent(
    new window.CustomEvent('app-undo', { detail: { undone: true, type: 'firm-update' } }),
  )
  await flush()

  assert.ok(calls.filter((c) => c.method === 'getFirm').length > before)
  assert.equal(document.getElementById('firm-name').value, 'ANJ Software')
})
