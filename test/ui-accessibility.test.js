const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const styles = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'styles.css'),
  'utf8',
)

function relativeLuminance(hex) {
  const channels = hex
    .match(/[0-9a-f]{2}/gi)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

test('dark and light themes use an opaque accent focus indicator', () => {
  const focusTokens = [...styles.matchAll(/--shadow-focus:\s*([^;]+);/g)].map(
    (match) => match[1].trim(),
  )

  assert.deepEqual(focusTokens, [
    '0 0 0 3px var(--accent)',
    '0 0 0 3px var(--accent)',
  ])

  const accents = [...styles.matchAll(/--accent:\s*(#[0-9a-f]{6});/gi)].map(
    (match) => match[1],
  )
  const pageBackgrounds = [...styles.matchAll(/--bg:\s*(#[0-9a-f]{6});/gi)].map(
    (match) => match[1],
  )
  const panelBackgrounds = [
    ...styles.matchAll(/--bg-elevated-2:\s*(#[0-9a-f]{6});/gi),
  ].map((match) => match[1])

  assert.equal(accents.length, 2)
  assert.equal(pageBackgrounds.length, 2)
  assert.equal(panelBackgrounds.length, 2)
  for (let index = 0; index < accents.length; index += 1) {
    assert.ok(contrastRatio(accents[index], pageBackgrounds[index]) >= 3)
    assert.ok(contrastRatio(accents[index], panelBackgrounds[index]) >= 3)
  }
})

test('real-app scenarios wait on the project toggle semantic state', () => {
  for (const file of [
    'verify-excel-import.js',
    'verify-project-report.js',
    'verify-word-export.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8')
    assert.match(source, /aria-pressed/)
    assert.match(
      source,
      /\.until\([\s\S]*?aria-pressed/,
      `${file} reads aria-pressed but does not wait for the async selection to settle`,
    )
    assert.doesNotMatch(source, /aria-checked/)
  }
})
