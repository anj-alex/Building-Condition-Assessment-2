// The report's wording is the client's, supplied as a rewritten text template
// (docs/report-wording.md). Most of it is prose that no other test can defend:
// a paragraph can be reworded into something legally wrong without breaking a
// single rendering assertion. These tests pin the parts where the wording is
// load-bearing — the claims the report makes, and the numbers it quotes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const content = require('../src/lib/report-content')

const rules = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'capital_planning_rules.json'), 'utf8'),
)

const ctx = {
  firm: 'ANJ Engineering Ltd',
  client: 'Hastings County',
  property: 'Centre Hastings Lodge',
  address: '12 Main Street, Madoc ON',
  visitDate: 'May 1, 2026',
  assessmentType: content.LABELS.assessmentType,
  assessmentTypePlural: content.LABELS.assessmentTypePlural,
  startYear: 2026,
  endYear: 2051,
  projectName: 'the Hastings County Building Condition Assessment program',
  immediateConcerns: '',
}

/** Every block every prose function emits, flattened to plain strings. */
function allProse() {
  const blockFns = Object.entries(content).filter(([name]) => name.endsWith('Blocks'))
  const out = []
  for (const [name, fn] of blockFns) {
    for (const block of fn(ctx) ?? []) {
      if (block.type === 'bullets') out.push(...block.items.map((item) => [name, item]))
      else out.push([name, block.text])
    }
  }
  return out
}

test('every prose function emits well-formed, non-empty blocks', () => {
  const valid = new Set(['heading', 'paragraph', 'bullets', 'callout', 'formula'])
  for (const [name, fn] of Object.entries(content).filter(([n]) => n.endsWith('Blocks'))) {
    const blocks = fn(ctx)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} emits blocks`)
    for (const block of blocks) {
      assert.ok(valid.has(block.type), `${name} emits a known block type, got ${block.type}`)
      if (block.type === 'bullets') {
        assert.ok(block.items.length > 0, `${name} bullet list is not empty`)
        for (const item of block.items) assert.ok(item.trim(), `${name} bullet is not blank`)
      } else {
        assert.ok(String(block.text).trim(), `${name} block text is not blank`)
      }
    }
  }
})

test('the report calls itself a Building Condition Assessment throughout', () => {
  assert.equal(content.LABELS.assessmentType, 'Building Condition Assessment')
  for (const [name, line] of allProse()) {
    assert.doesNotMatch(line, /Property Condition Assessment/, `${name} still says "Property Condition Assessment"`)
  }
})

// The client's implementation notes are explicit: do not state compliance with
// all applicable codes unless the scope includes a full code-compliance review.
// It does not — this is a visual, non-destructive walk-through.
test('no section claims the facility complies with every applicable code', () => {
  for (const [name, line] of allProse()) {
    assert.doesNotMatch(
      line,
      /in compliance with (all )?applicable codes/i,
      `${name} claims code compliance the assessment cannot establish`,
    )
  }
})

// The printed bands and the scale that actually grades the FCI are two copies
// of the same numbers. This is the one place they can be compared.
test('the printed FCI bands match the grade scale that computes them', () => {
  const bands = content
    .fciBlocks()
    .find((block) => block.type === 'bullets')
    .items.map((item) => {
      const [label, range] = item.split(':').map((part) => part.trim())
      const bounds = range.match(/(\d+\.?\d*)%/g).map((n) => Number.parseFloat(n))
      return { label, upper: /greater than [\d.]+% up to/.test(range) || !/greater than/.test(range) ? bounds.at(-1) : null }
    })

  const scale = rules.fci.grade_scales.ifma
  assert.equal(bands.length, scale.length, 'one printed band per grade')
  for (const [index, step] of scale.entries()) {
    assert.equal(bands[index].label, step.label, `band ${index} names the same grade`)
    if (step.max_inclusive == null) {
      assert.equal(bands[index].upper, null, 'the open-ended top band prints no upper bound')
    } else {
      assert.equal(
        bands[index].upper,
        Number((step.max_inclusive * 100).toFixed(1)),
        `band "${step.label}" prints the threshold that grades it`,
      )
    }
  }
})

test('the executive summary opening survives a facility with no address', () => {
  const [, opening] = content.executiveSummaryIntroBlocks({ ...ctx, address: content.NOT_PROVIDED })
  assert.match(opening.text, /located at Not Provided\./)
  assert.doesNotMatch(opening.text, /located at \./, 'never leaves a dangling "located at ."')
})

test('immediate concerns are appended only when the assessor recorded some', () => {
  const without = content.executiveSummaryIntroBlocks(ctx)
  const with_ = content.executiveSummaryIntroBlocks({ ...ctx, immediateConcerns: 'Roof membrane is failing.' })
  assert.equal(with_.length, without.length + 2)
  assert.equal(with_.at(-1).text, 'Roof membrane is failing.')
})

test('the notices and limitations name the firm and client from the data', () => {
  const notices = content.disclaimerBlocks(ctx).map((b) => b.text).join(' ')
  const limitations = content.limitationsBlocks(ctx).map((b) => b.text ?? '').join(' ')
  for (const section of [notices, limitations]) {
    assert.match(section, /ANJ Engineering Ltd/)
    assert.match(section, /Hastings County/)
    // The firm is never hardcoded — a different firm's report must not carry
    // the wrong company's name in its legal notices.
    assert.doesNotMatch(section, /ANJ ENGINEERING LTD/)
  }
})

test('field labels are unique, so no two rows of a table read the same', () => {
  for (const [name, map] of [['FACILITY_FIELDS', content.FACILITY_FIELDS], ['ASSET_FIELDS', content.ASSET_FIELDS]]) {
    const values = Object.values(map)
    assert.equal(new Set(values).size, values.length, `${name} has no duplicate labels`)
  }
})
