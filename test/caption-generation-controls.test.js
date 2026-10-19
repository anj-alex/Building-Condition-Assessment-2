const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { loadPage } = require('./helpers/renderer-page')

// The gallery (and its caption controls) lives in the photo module, not renderer.js.
const gallerySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer-photos.js'),
  'utf8',
)
const stylesSource = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'styles.css'),
  'utf8',
)

/**
 * `setImageCaptionGenerationControls` (from shared.js) toggles the real gallery
 * caption field + generate button by data attribute. Load shared.js through the
 * renderer harness and give it the two elements it looks for.
 */
function captionControlHarness(imageId) {
  const { window, document } = loadPage('index.html', { hash: '1001:42' })
  const captionInput = document.createElement('input')
  captionInput.setAttribute('data-gallery-image-caption', String(imageId))
  const generateButton = document.createElement('button')
  generateButton.setAttribute('data-gallery-image-regen', String(imageId))
  document.body.append(captionInput, generateButton)
  return { captionInput, generateButton, setGenerating: window.setImageCaptionGenerationControls }
}

test('caption generation disables both the caption field and generate button', () => {
  const { captionInput, generateButton, setGenerating } = captionControlHarness(42)

  setGenerating(42, true)

  assert.equal(captionInput.disabled, true)
  assert.equal(captionInput.getAttribute('aria-busy'), 'true')
  assert.equal(generateButton.disabled, true)
  assert.equal(generateButton.getAttribute('aria-busy'), 'true')
})

test('finished caption generation re-enables both controls', () => {
  const { captionInput, generateButton, setGenerating } = captionControlHarness(42)

  setGenerating(42, true)
  setGenerating(42, false)

  assert.equal(captionInput.disabled, false)
  assert.equal(captionInput.getAttribute('aria-busy'), 'false')
  assert.equal(generateButton.disabled, false)
  assert.equal(generateButton.getAttribute('aria-busy'), 'false')
})

test('caption generation action uses the explicit button label', () => {
  assert.match(gallerySource, /regenBtn\.textContent = 'Generate New Caption'/)
  assert.doesNotMatch(gallerySource, /regenBtn\.textContent = 'Regenerate'/)
})

test('disabled caption generation action has an unmistakable visual state', () => {
  assert.match(gallerySource, /home-image-gallery-caption-generate/)
  assert.match(
    stylesSource,
    /\.home-image-gallery-caption-generate:disabled[\s\S]*?cursor: not-allowed;[\s\S]*?opacity: 0\.55;/,
  )
})
