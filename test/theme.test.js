const assert = require('node:assert/strict')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

// theme.js runs on every page. Loading one exposes its top-level functions on
// the shared realm and applies the stored preference on load.

test('a stored light preference sets data-theme=light on load', () => {
  const { document } = loadPage('firm-setup.html', { localStorage: { 'app-theme': 'light' } })
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light')
})

test('a stored dark preference removes data-theme (dark is the default palette)', () => {
  const { document } = loadPage('firm-setup.html', { localStorage: { 'app-theme': 'dark' } })
  assert.equal(document.documentElement.getAttribute('data-theme'), null)
})

test('system preference resolves against matchMedia', () => {
  const light = loadPage('firm-setup.html', { localStorage: { 'app-theme': 'system' }, matchMediaLight: true })
  assert.equal(light.document.documentElement.getAttribute('data-theme'), 'light')

  const dark = loadPage('firm-setup.html', { localStorage: { 'app-theme': 'system' }, matchMediaLight: false })
  assert.equal(dark.document.documentElement.getAttribute('data-theme'), null)
})

test('getThemePreference falls back to system for missing or bogus values', () => {
  const { window } = loadPage('firm-setup.html', { localStorage: { 'app-theme': 'chartreuse' } })
  assert.equal(window.getThemePreference(), 'system')
})

test('setThemePreference persists the choice and re-applies the theme', () => {
  const { window, document } = loadPage('firm-setup.html', {})
  assert.equal(window.setThemePreference('light'), 'light')
  assert.equal(window.localStorage.getItem('app-theme'), 'light')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light')

  assert.equal(window.setThemePreference('dark'), 'dark')
  assert.equal(document.documentElement.getAttribute('data-theme'), null)

  // An unknown value normalizes to 'system'.
  assert.equal(window.setThemePreference('nonsense'), 'system')
  assert.equal(window.localStorage.getItem('app-theme'), 'system')
})
