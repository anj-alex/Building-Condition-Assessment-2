const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildAssetCaptionPrompt,
  buildBuildingCaptionPrompt,
  buildExecutiveSummaryPrompt,
  completeTextWithOpenRouter,
  filterAssetsForSummarySection,
  formatAssetForSummaryPrompt,
  selectSectionDetailAssets,
  isExecutiveSummaryField,
  sanitizeSummaryText,
  BUILDING_WIDE_SECTIONS,
  EXECUTIVE_SUMMARY_SECTIONS,
  SECTION_DETAIL_POLICY,
  parseRetryAfterMs,
  postToOpenRouter,
} = require('../src/ai/openrouter-client')
const {
  VISION_MODEL,
  SUMMARY_MODEL,
  SUMMARY_MAX_TOKENS,
} = require('../src/ai/openrouter-config')
const { planIndex } = require('../src/lib/asset-rollup')
const { calculateCapitalPlan } = require('../src/lib/capital-planning')

const BUILDING = {
  id: 1,
  property_name: 'Riverbend Office Tower',
  address: '1200 West Georgia Street',
  city: 'Vancouver',
  province_short: 'BC',
  gross_floor_area_m2: 18450.5,
  num_floors: 18,
  property_vintage: 1988,
  date_of_assessment: '2026-03-14',
  location_factor: 1,
}

const SAMPLE_ASSETS = [
  {
    id: 1,
    asset_name: 'Rooftop air handling unit AHU-1',
    level_1_code: 'D',
    level_2_code: 'D30',
    level_2_group_element: 'D30 HVAC',
    level_3_description: 'Packaged rooftop units',
    material: 'Galvanized steel',
    vintage: 1998,
    service_life: 25,
    quantity: 2,
    unit_measure: 'EA',
    unit_price: '48000',
    condition_rating: 'Poor',
    priority: 'High',
    action: 'Replace',
    term: 'Immediate',
    recommendation: 'Replace both rooftop units; compressors are beyond economic repair.',
    description: 'Casing corrosion observed at the curb.',
  },
  {
    id: 2,
    asset_name: 'Built-up roof membrane',
    level_1_code: 'B',
    level_2_code: 'B30',
    level_2_group_element: 'B30 Roofing',
    vintage: 2004,
    service_life: 25,
    quantity: 1800,
    unit_measure: 'm2',
    unit_price: '210',
    condition_rating: 'Fair',
    priority: 'Medium',
    action: 'Replace',
    term: 'Medium Term',
  },
  {
    id: 3,
    asset_name: 'Passenger elevator cab finishes',
    level_1_code: 'D',
    level_2_code: 'D10',
    level_2_group_element: 'D10 Conveying',
    vintage: 1988,
    service_life: 30,
    quantity: 3,
    unit_measure: 'EA',
    unit_price: '22000',
    condition_rating: 'Very poor',
    priority: 'High',
    action: 'Refurbish',
    term: 'Immediate',
  },
  {
    id: 4,
    asset_name: 'Sprinkler distribution piping',
    level_1_code: 'D',
    level_2_code: 'D40',
    level_2_group_element: 'D40 Fire Protection',
    vintage: 1988,
    service_life: 50,
    quantity: 1,
    unit_measure: 'LS',
    unit_price: '240000',
    condition_rating: 'Good',
    priority: 'No Priority',
    action: 'No Action',
    term: 'N/A',
  },
]

function samplePrompt(field, overrides = {}) {
  const assets = overrides.assets ?? SAMPLE_ASSETS
  const building = overrides.building ?? BUILDING
  const capitalPlan =
    overrides.capitalPlan === undefined
      ? calculateCapitalPlan({ assets, building })
      : overrides.capitalPlan
  return buildExecutiveSummaryPrompt({ field, building, assets, capitalPlan })
}

/**
 * Per-asset bullets only: everything under the detail block header, minus the
 * parenthesised "N further assets" / "no records" notes.
 */
function detailLines(prompt) {
  const header = prompt.match(
    /^(Highest-impact assets[^\n]*|Highest-cost assets[^\n]*|Relevant assets:)$/m,
  )
  if (!header) return []
  const after = prompt.slice(prompt.indexOf(header[0]) + header[0].length)
  return after
    .split('\n')
    .filter((line) => line.startsWith('- ') && !line.startsWith('- ('))
}

test('vision and summary models are configured separately', () => {
  assert.ok(VISION_MODEL)
  assert.ok(SUMMARY_MODEL)
  // Defaults must not collapse to one shared slug when env is unset in CI.
  assert.notEqual(
    String(VISION_MODEL),
    String(SUMMARY_MODEL),
    'vision and summary models should differ by default',
  )
})

test('summary model default is DeepSeek V4 Pro on OpenRouter', () => {
  // When OPENROUTER_SUMMARY_MODEL is set in the process env (local .env),
  // still assert the configured value is non-empty; the checked-in default
  // is deepseek/deepseek-v4-pro.
  assert.match(String(SUMMARY_MODEL), /deepseek/i)
})

test('all twelve executive summary fields are known', () => {
  const fields = [
    'accessibility',
    'designated_substance_survey',
    'architectural_structural',
    'plumbing',
    'mechanical',
    'electrical',
    'fire_life_safety',
    'site',
    'code_compliance',
    'immediate_concerns',
    'facility_overview',
    'capital_needs',
  ]
  for (const field of fields) {
    assert.equal(isExecutiveSummaryField(field), true, field)
    assert.ok(EXECUTIVE_SUMMARY_SECTIONS[field])
  }
  assert.equal(isExecutiveSummaryField('not_a_field'), false)
})

test('filterAssetsForSummarySection maps Uniformat codes', () => {
  const assets = [
    { asset_name: 'Roof', level_1_code: 'B', level_2_code: 'B30' },
    { asset_name: 'Chiller', level_1_code: 'D', level_2_code: 'D30' },
    { asset_name: 'Panelboard', level_1_code: 'D', level_2_code: 'D50' },
    { asset_name: 'Sprinkler', level_1_code: 'D', level_2_code: 'D40' },
    { asset_name: 'Asphalt', level_1_code: 'G', level_2_code: 'G20' },
    {
      asset_name: 'Urgent pump',
      level_1_code: 'D',
      level_2_code: 'D20',
      priority: 'High',
      condition_rating: 'Poor',
    },
  ]

  assert.equal(filterAssetsForSummarySection('mechanical', assets).length, 1)
  assert.equal(filterAssetsForSummarySection('electrical', assets)[0].asset_name, 'Panelboard')
  assert.equal(filterAssetsForSummarySection('fire_life_safety', assets)[0].asset_name, 'Sprinkler')
  assert.equal(filterAssetsForSummarySection('site', assets)[0].asset_name, 'Asphalt')
  assert.ok(
    filterAssetsForSummarySection('architectural_structural', assets).some(
      (a) => a.asset_name === 'Roof',
    ),
  )
  assert.ok(
    filterAssetsForSummarySection('immediate_concerns', assets).some(
      (a) => a.asset_name === 'Urgent pump',
    ),
  )
  assert.equal(filterAssetsForSummarySection('facility_overview', assets).length, assets.length)
})

test('keyword fallbacks cannot steal an asset a Uniformat code already owns', () => {
  // Real catalogue rows carry level-2 descriptions like this, which used to drag
  // G-group site assets into the Mechanical section.
  const stormDrainage = {
    id: 9,
    asset_name: 'Storm & Site Drainage',
    level_1_code: 'G',
    level_2_code: 'G30',
    level_2_description: 'Site Civil/Mechanical Utilities',
    condition_rating: 'Fair',
    priority: 'Medium',
  }
  const assets = [...SAMPLE_ASSETS, stormDrainage]

  assert.equal(
    filterAssetsForSummarySection('mechanical', assets).some(
      (asset) => asset.asset_name === 'Storm & Site Drainage',
    ),
    false,
    'a G-group asset must not appear under Mechanical',
  )
  assert.ok(
    filterAssetsForSummarySection('site', assets).some(
      (asset) => asset.asset_name === 'Storm & Site Drainage',
    ),
    'the site section still owns it',
  )
  // A rooftop mechanical unit stays in Mechanical, not Architectural.
  assert.equal(
    filterAssetsForSummarySection('architectural_structural', assets).some(
      (asset) => asset.id === 1,
    ),
    false,
  )
  // Assets no code assigns (D10 Conveying) remain reachable by keyword.
  const uncoded = [{ id: 20, asset_name: 'Exhaust fan', level_1_code: 'D', level_2_code: 'D10' }]
  assert.equal(filterAssetsForSummarySection('mechanical', uncoded).length, 1)
})

test('keyword scope ignores pricing-catalogue text', () => {
  // A real D10 row: the priced line item is a boiler, the asset is an elevator.
  // Only the level-1/2 group descriptions and assessor-authored fields count.
  const elevator = {
    id: 40,
    asset_name: 'Passenger elevator controller',
    level_1_code: 'D',
    level_2_code: 'D10',
    level_2_description: 'Conveying',
    level_3_description: 'Boilers',
    material: 'Boiler, Gas Fired, Cast Iron, Hot Water',
  }

  assert.equal(
    filterAssetsForSummarySection('mechanical', [elevator]).length,
    0,
    'catalogue text must not pull an elevator into Mechanical',
  )
  // The same asset is still reachable when the assessor writes about mechanicals.
  assert.equal(
    filterAssetsForSummarySection('mechanical', [
      { ...elevator, description: 'Shares the mechanical room ventilation.' },
    ]).length,
    1,
  )
})

test('detail lines omit pricing-catalogue text', () => {
  const asset = {
    ...SAMPLE_ASSETS[0],
    level_3_description: 'Controls And Instrumentation',
    material: 'Air Compressor, 3 HP, 1 Stage, 1 Ph',
  }
  const { prompt } = samplePrompt('mechanical', { assets: [asset, ...SAMPLE_ASSETS.slice(1)] })
  const lines = detailLines(prompt).join('\n')
  assert.match(lines, /Rooftop air handling unit AHU-1/)
  // These come from the uniformat_pricing join and misdescribe the asset.
  assert.doesNotMatch(lines, /Air Compressor/)
  assert.doesNotMatch(lines, /Controls And Instrumentation/)
})

test('accessibility keyword scan ignores catalogue text', () => {
  const curtainWall = {
    id: 30,
    asset_name: 'Curtain Wall & Glazing Systems',
    level_1_code: 'B',
    level_2_code: 'B20',
    // The priced line item is a door; the asset is not an accessible entrance.
    level_3_description: 'Exterior Doors',
    material: 'Doors, Exterior, Steel, Commercial, Flush, 16 ga',
    condition_rating: 'Fair',
    priority: 'High',
  }
  const { prompt } = samplePrompt('accessibility', { assets: [curtainWall] })
  assert.deepEqual(detailLines(prompt), [])
})

test('buildExecutiveSummaryPrompt includes property facts and section title', () => {
  const { system, prompt, sectionTitle } = samplePrompt('facility_overview')
  assert.match(system, /Building Condition Assessment/i)
  assert.doesNotMatch(system, /Property Condition Assessment/i)
  assert.equal(sectionTitle, 'Facility Overview')
  assert.match(prompt, /Riverbend Office Tower/)
  assert.match(prompt, /Vancouver/)
  assert.match(prompt, /18450\.5/)
  assert.match(prompt, /Facility Overview/)
})

test('all AI writing prompts use the report\'s Building Condition Assessment name', () => {
  for (const prompt of [
    buildAssetCaptionPrompt({}),
    buildBuildingCaptionPrompt({}),
    samplePrompt('facility_overview').system,
  ]) {
    assert.match(prompt, /Building Condition Assessment/i)
    assert.doesNotMatch(prompt, /Property Condition Assessment/i)
  }
})

test('every summary field declares a detail policy', () => {
  for (const field of Object.keys(EXECUTIVE_SUMMARY_SECTIONS)) {
    const policy = SECTION_DETAIL_POLICY[field]
    assert.ok(policy, `missing detail policy for ${field}`)
    assert.ok(
      ['none', 'keyword', 'severity', 'cost'].includes(policy.mode),
      `unknown mode for ${field}: ${policy.mode}`,
    )
    if (policy.mode !== 'none') {
      assert.ok(policy.limit > 0, `${field} needs a positive limit`)
      assert.ok(['scope', 'all'].includes(policy.source), `${field} needs a source`)
    }
  }
})

test('system prompt permits quoting figures but forbids deriving them', () => {
  const { system } = samplePrompt('capital_needs')
  assert.match(system, /quote them exactly as provided/i)
  assert.match(system, /never derive, total, extrapolate, or estimate/i)
  // FCI and mean condition rating must not be conflated.
  assert.match(system, /Facility Condition Index and mean condition rating are separate metrics/i)
})

test('capital figures reach every section', () => {
  for (const field of Object.keys(EXECUTIVE_SUMMARY_SECTIONS)) {
    const { prompt } = samplePrompt(field)
    assert.match(prompt, /Building-wide capital position:/, field)
    assert.match(prompt, /Current replacement value: \$/, field)
    assert.match(prompt, /Facility Condition Index by window:/, field)
    assert.match(prompt, /Building capital plan by term:/, field)
    assert.match(prompt, /Building-wide asset register \(aggregate\):/, field)
    assert.match(prompt, /Mean condition rating: /, field)
  }
})

test('building-wide sections send no per-asset detail', () => {
  for (const field of ['facility_overview', 'designated_substance_survey', 'code_compliance']) {
    const { prompt } = samplePrompt(field)
    assert.deepEqual(detailLines(prompt), [], `${field} should send no asset lines`)
    assert.match(prompt, /Asset-level detail is intentionally omitted/, field)
    // No asset names should leak into these prompts.
    assert.doesNotMatch(prompt, /AHU-1/, field)
    assert.doesNotMatch(prompt, /Sprinkler distribution piping/, field)
  }
})

test('building-wide sections do not repeat the register as a section rollup', () => {
  for (const field of BUILDING_WIDE_SECTIONS) {
    const { prompt, sectionTitle } = samplePrompt(field)
    assert.doesNotMatch(
      prompt,
      new RegExp(`${sectionTitle} — assets in this section`),
      `${field} duplicates the building rollup`,
    )
  }
})

test('system sections get a scoped rollup plus ranked detail lines', () => {
  const { prompt } = samplePrompt('mechanical')
  assert.match(prompt, /Mechanical Executive Summary — assets in this section \(aggregate\):/)
  const lines = detailLines(prompt)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Rooftop air handling unit AHU-1/)
  // Richer asset facts than the pre-rollup prompt carried.
  assert.match(lines[0], /quantity 2 EA/)
  assert.match(lines[0], /vintage 1998, age 28 yr/)
  assert.match(lines[0], /service life 25 yr/)
  assert.match(lines[0], /remaining life -3 yr/)
  assert.match(lines[0], /opinion of probable cost \$/)
  assert.match(lines[0], /recommendation: Replace both rooftop units/)
  assert.match(lines[0], /observations: Casing corrosion/)
})

test('detail lines are ordered by severity and capped by the policy limit', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: 100 + index,
    asset_name: `Pump ${index}`,
    level_1_code: 'D',
    level_2_code: 'D20',
    level_2_group_element: 'D20 Plumbing',
    quantity: 1,
    unit_measure: 'EA',
    unit_price: '5000',
    condition_rating: index === 29 ? 'Critical' : 'Good',
    priority: index === 29 ? 'High' : 'Low',
    action: 'Repair',
    term: 'Short Term',
  }))
  const { prompt } = samplePrompt('plumbing', { assets: many })
  const lines = detailLines(prompt)
  assert.equal(lines.length, SECTION_DETAIL_POLICY.plumbing.limit)
  // The worst asset is last in register order but must lead the list.
  assert.match(lines[0], /Pump 29/)
  assert.match(prompt, /further asset\(s\) are represented in the aggregates above/)
})

test('capital needs lists highest-cost assets and excludes suppressed ones', () => {
  const { prompt } = samplePrompt('capital_needs')
  const lines = detailLines(prompt)
  assert.ok(lines.length > 0)
  assert.match(prompt, /Highest-cost assets/)
  // No Action / term N/A carries a replacement value but no scheduled work.
  assert.doesNotMatch(prompt, /Sprinkler distribution piping/)
  assert.match(lines[0], /Built-up roof membrane/)
})

test('accessibility sends only accessibility-related assets', () => {
  const { prompt } = samplePrompt('accessibility')
  const lines = detailLines(prompt)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Passenger elevator cab finishes/)
  assert.doesNotMatch(prompt, /Built-up roof membrane/)
})

test('immediate concerns keeps urgent assets only', () => {
  const { prompt } = samplePrompt('immediate_concerns')
  const lines = detailLines(prompt)
  assert.ok(lines.length > 0)
  assert.match(lines[0], /Passenger elevator cab finishes/)
  for (const line of lines) {
    assert.doesNotMatch(line, /Sprinkler distribution piping/)
  }
})

test('immediate concerns scope is urgency, not the action column', () => {
  const scope = (assets) =>
    filterAssetsForSummarySection('immediate_concerns', assets).map((a) => a.asset_name)

  // Replace and Repair are the most common actions in a condition assessment and
  // say nothing about timing, so on their own they must not scope an asset in.
  assert.deepEqual(
    scope([
      { id: 1, asset_name: 'Routine replacement', condition_rating: 'Fair', priority: 'Medium', action: 'Replace', term: 'Long Term' },
      { id: 2, asset_name: 'Routine repair', condition_rating: 'Good', priority: 'Low', action: 'Repair', term: 'Medium Term' },
    ]),
    [],
  )

  // Each urgency signal on its own is enough.
  assert.deepEqual(
    scope([
      { id: 3, asset_name: 'High priority', condition_rating: 'Fair', priority: 'High', action: 'Repair', term: 'Medium Term' },
      { id: 4, asset_name: 'Immediate term', condition_rating: 'Fair', priority: 'Low', action: 'Repair', term: 'Immediate' },
      { id: 5, asset_name: 'Very poor', condition_rating: 'Very poor', priority: 'Low', action: 'Repair', term: 'Long Term' },
      { id: 6, asset_name: 'Critical', condition_rating: 'Critical', priority: 'Low', action: 'Repair', term: 'Long Term' },
    ]),
    ['High priority', 'Immediate term', 'Very poor', 'Critical'],
  )

  // Poor is mid-scale (4 of 6) and no longer urgent by itself.
  assert.deepEqual(
    scope([
      { id: 7, asset_name: 'Poor only', condition_rating: 'Poor', priority: 'Medium', action: 'Repair', term: 'Long Term' },
    ]),
    [],
  )

  // Assets the plan schedules nothing for are never immediate concerns.
  assert.deepEqual(
    scope([
      { id: 8, asset_name: 'Decommissioned riser', condition_rating: 'Critical', priority: 'No Priority', action: 'No Action', term: 'N/A' },
      { id: 9, asset_name: 'Not applicable term', condition_rating: 'Critical', priority: 'High', action: 'Replace', term: 'N/A' },
    ]),
    [],
  )

  // Unrated assets have no implicit urgency signal; FCI is building-level.
  assert.deepEqual(
    scope([
      { id: 10, asset_name: 'Unrated low priority', priority: 'Low', action: 'Repair', term: 'Long Term' },
      { id: 11, asset_name: 'Unrated high priority', priority: 'High', action: 'Repair', term: 'Long Term' },
    ]),
    ['Unrated high priority'],
  )
})

test('a suppressed plan entry overrides the asset action columns', () => {
  const asset = {
    id: 12,
    asset_name: 'Rule-suppressed asset',
    condition_rating: 'Critical',
    priority: 'High',
    action: 'Replace',
    term: 'Immediate',
  }
  assert.equal(filterAssetsForSummarySection('immediate_concerns', [asset]).length, 1)
  const plans = new Map([[12, { suppressed: true }]])
  assert.equal(filterAssetsForSummarySection('immediate_concerns', [asset], plans).length, 0)
})

test('selectSectionDetailAssets honours mode, source, and limit', () => {
  const capitalPlan = calculateCapitalPlan({ assets: SAMPLE_ASSETS, building: BUILDING })
  const planByAssetId = planIndex(capitalPlan)
  const scopedAssets = filterAssetsForSummarySection('mechanical', SAMPLE_ASSETS)

  assert.deepEqual(
    selectSectionDetailAssets({
      field: 'code_compliance',
      assets: SAMPLE_ASSETS,
      scopedAssets: SAMPLE_ASSETS,
      planByAssetId,
    }),
    [],
  )

  const mechanical = selectSectionDetailAssets({
    field: 'mechanical',
    assets: SAMPLE_ASSETS,
    scopedAssets,
    planByAssetId,
  })
  assert.deepEqual(
    mechanical.map((asset) => asset.asset_name),
    ['Rooftop air handling unit AHU-1'],
  )

  const unknown = selectSectionDetailAssets({
    field: 'not_a_field',
    assets: SAMPLE_ASSETS,
    scopedAssets: SAMPLE_ASSETS,
    planByAssetId,
  })
  assert.deepEqual(unknown, [], 'unknown fields must not leak the register')
})

test('prompt still builds without a capital plan', () => {
  const { prompt } = samplePrompt('mechanical', { capitalPlan: null })
  assert.doesNotMatch(prompt, /Building-wide capital position:/)
  assert.match(prompt, /Building-wide asset register \(aggregate\):/)
  const lines = detailLines(prompt)
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /remaining life/)
})

test('sections with no matching assets say so instead of listing others', () => {
  const roofOnly = [SAMPLE_ASSETS[1]]
  const { prompt } = samplePrompt('plumbing', { assets: roofOnly })
  assert.deepEqual(detailLines(prompt), [])
  assert.match(prompt, /No matching asset records were available for this section/)
  assert.doesNotMatch(prompt, /Built-up roof membrane/)
})

test('the token budget leaves room for a reasoning model to think and write', () => {
  // The summary model reasons before it writes and OpenRouter bills reasoning
  // against max_tokens. Measured traces ran 212-2161 tokens for these prompts, so
  // a budget near the old 700 starves the prose entirely and the call returns no
  // content at all.
  assert.ok(
    SUMMARY_MAX_TOKENS >= 8000,
    `SUMMARY_MAX_TOKENS ${SUMMARY_MAX_TOKENS} leaves too little room above a ~2200-token reasoning trace`,
  )
  // 16384 is the smallest max_completion_tokens among providers serving the model.
  // Above it, requests route away from providers we depend on for failover.
  assert.ok(
    SUMMARY_MAX_TOKENS <= 16384,
    `SUMMARY_MAX_TOKENS ${SUMMARY_MAX_TOKENS} exceeds the narrowest provider limit (16384)`,
  )
})

/** Minimal OpenRouter chat/completions response. */
function stubFetch(choice) {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({ choices: [choice] }),
  })
}

test('a summary truncated at the token budget fails instead of being saved', async () => {
  const original = global.fetch
  try {
    // Prose that stopped at the budget stops mid-sentence. Autosave commits
    // whatever comes back, so returning it would persist a broken summary.
    global.fetch = stubFetch({
      finish_reason: 'length',
      message: { content: 'Near-term requirements total $447,000, with $437,000 scheduled' },
    })
    await assert.rejects(
      completeTextWithOpenRouter({ apiKey: 'k', prompt: 'p', model: 'm' }),
      /token limit before finishing the summary/,
    )
  } finally {
    global.fetch = original
  }
})

test('a budget consumed entirely by reasoning names the budget, not emptiness', async () => {
  const original = global.fetch
  try {
    // What the reported bug actually looked like on the wire: reasoning filled
    // max_tokens, so content came back null with finish_reason "length".
    global.fetch = stubFetch({ finish_reason: 'length', message: { content: null } })
    await assert.rejects(
      completeTextWithOpenRouter({ apiKey: 'k', prompt: 'p', model: 'm', maxTokens: 700 }),
      /700-token limit.*Reasoning models count thinking tokens/s,
    )

    // A genuinely empty reply that was not truncated keeps the old message.
    global.fetch = stubFetch({ finish_reason: 'stop', message: { content: '   ' } })
    await assert.rejects(
      completeTextWithOpenRouter({ apiKey: 'k', prompt: 'p', model: 'm' }),
      /returned an empty response/,
    )
  } finally {
    global.fetch = original
  }
})

test('detail lines bucket term by action year, not the assessor column', () => {
  const terms = [
    { id: 'short', label: 'Short Term', yearFrom: 2027, yearTo: 2028 },
    { id: 'medium', label: 'Medium Term', yearFrom: 2029, yearTo: 2031 },
  ]
  const asset = { id: 7, asset_name: 'Curtain Wall & Glazing Systems', term: 'Short Term' }

  // Column says Short Term, action year lands in Medium Term. The capital position
  // block buckets totals by year, so printing the column would put an $890,000
  // asset inside a Short Term total that does not contain it.
  const line = formatAssetForSummaryPrompt(asset, {
    plan: { actionYear: 2030, opinionOfProbableCost: 890000 },
    terms,
  })
  assert.match(line, /term Medium Term/)
  assert.doesNotMatch(line, /term Short Term/)

  // Suppressed assets are scheduled for nothing, so no bucket is theirs to claim.
  const suppressed = formatAssetForSummaryPrompt(
    { id: 8, asset_name: 'Slab-on-Grade', term: 'N/A' },
    { plan: { actionYear: 2038, suppressed: true }, terms },
  )
  assert.match(suppressed, /term N\/A/)

  // No terms to bucket against (no capital plan): fall back to the column.
  const noPlan = formatAssetForSummaryPrompt(asset, { plan: null, terms: null })
  assert.match(noPlan, /term Short Term/)

  const unscheduled = formatAssetForSummaryPrompt(asset, {
    plan: { actionYear: null, scheduledActionYear: null },
    terms,
  })
  assert.doesNotMatch(unscheduled, /action year 0/)
})

test('overdue detail lines state the scheduled year and retain the lifecycle date as context', () => {
  const line = formatAssetForSummaryPrompt(
    { id: 8, asset_name: 'Domestic water distribution' },
    {
      plan: {
        actionYear: 1990,
        scheduledActionYear: 2026,
        actionYearIsOverdue: true,
        effectiveTerm: 'Immediate',
      },
      terms: [{ id: 'immediate', label: 'Immediate Term', yearFrom: 2026, yearTo: 2026 }],
    },
  )
  assert.match(line, /term Immediate/)
  assert.match(line, /action year 2026 \(overdue; lifecycle date 1990\)/)
  assert.doesNotMatch(line, /action year 1990/)
})

test('no prompt states a term that contradicts its own capital position block', () => {
  for (const field of Object.keys(EXECUTIVE_SUMMARY_SECTIONS)) {
    const { prompt } = samplePrompt(field)
    const capitalPlan = calculateCapitalPlan({ assets: SAMPLE_ASSETS, building: BUILDING })
    for (const line of prompt.split('\n')) {
      const match = /term ([A-Za-z/ ]+?); action year (\d{4})/.exec(line)
      if (!match) continue
      const [, label, year] = match
      const bucket = (capitalPlan.terms ?? []).find(
        (term) => Number(year) >= term.yearFrom && Number(year) <= term.yearTo,
      )
      if (!bucket || label.trim() === 'N/A') continue
      assert.equal(
        label.trim(),
        bucket.label === 'Immediate Term' ? 'Immediate' : bucket.label,
        `${field}: "term ${label.trim()}" but action year ${year} falls in "${bucket.label}"`,
      )
    }
  }
})

test('sanitizeSummaryText strips fences and excess blank lines', () => {
  assert.equal(
    sanitizeSummaryText('```\nHello paragraph.\n\n\nSecond.\n```'),
    'Hello paragraph.\n\nSecond.',
  )
  assert.equal(sanitizeSummaryText('"Quoted block."'), 'Quoted block.')
})

test('Retry-After accepts delta-seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-01T12:00:00Z')
  assert.equal(parseRetryAfterMs('2.5', now), 2500)
  assert.equal(parseRetryAfterMs('Tue, 01 Sep 2026 12:00:07 GMT', now), 7000)
  assert.equal(parseRetryAfterMs('Tue, 01 Sep 2026 11:59:00 GMT', now), 0)
  assert.equal(parseRetryAfterMs('invalid', now), null)
})

test('OpenRouter retry shares one absolute wall-clock timeout', async () => {
  const original = global.fetch
  let calls = 0
  try {
    global.fetch = (_url, options) => {
      calls += 1
      if (calls === 1) {
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                status: 429,
                headers: { get: () => '0.001' },
              }),
            80,
          )
        })
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true },
        )
      })
    }

    const started = Date.now()
    await assert.rejects(
      postToOpenRouter('k', { model: 'm' }, { timeoutMs: 200 }),
      /timed out/,
    )
    const elapsed = Date.now() - started
    assert.equal(calls, 2)
    assert.ok(elapsed >= 170, `timeout fired too early at ${elapsed}ms`)
    assert.ok(elapsed < 255, `retry received a fresh timeout (${elapsed}ms)`)
  } finally {
    global.fetch = original
  }
})

test('OpenRouter timeout includes a response body that stalls after headers', async () => {
  const original = global.fetch
  try {
    global.fetch = (_url, options) =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        arrayBuffer: () =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('body aborted')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true },
            )
          }),
      })

    const started = Date.now()
    await assert.rejects(
      postToOpenRouter('k', { model: 'm' }, { timeoutMs: 40 }),
      /timed out/,
    )
    assert.ok(Date.now() - started < 200)
  } finally {
    global.fetch = original
  }
})

test('executive summary page exposes Generate with AI for each section', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'executive-summary.html'),
    'utf8',
  )
  const buttons = [...html.matchAll(/data-summary-field="([^"]+)"/g)].map((m) => m[1])
  assert.equal(buttons.length, 12)
  for (const field of Object.keys(EXECUTIVE_SUMMARY_SECTIONS)) {
    assert.ok(buttons.includes(field), `missing button for ${field}`)
  }
  assert.match(html, /Generate with AI/)
})

test('main wires the building capital plan into summary generation', () => {
  const main =
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.js'), 'utf8')
  assert.match(main, /capitalPlan: db\.getBuildingCapitalPlan\(id\)/)

  const service = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai', 'caption-service.js'),
    'utf8',
  )
  // The plan must reach buildExecutiveSummaryPrompt, not stop at the service.
  assert.match(service, /buildExecutiveSummaryPrompt\(\{[^}]*capitalPlan,/s)

  const db = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')
  assert.match(db, /function getBuildingCapitalPlan\(buildingId\)/)
  assert.match(db, /^\s{2}getBuildingCapitalPlan,$/m)
})

test('the renderer IPC surface exposes generateBlankFields', () => {
  // The named surface lives in ipc-surface.js: preload.js is a generic
  // bridge and src/renderer-api.js builds window.electronAPI from this
  // one definition.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ipc-surface.js'),
    'utf8',
  )
  assert.match(source, /generateBlankFields/)
  assert.match(source, /ai:generateBlankFields/)
  assert.match(source, /previewBlankFields/)
  assert.match(source, /setAiBulkBusy/)
  assert.match(source, /onSummaryUpdated/)
})

test('settings panel offers generate AI for all blank fields', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'settings.html'),
    'utf8',
  )
  assert.match(html, /id="ai-generate-blank-captions"/)
  assert.match(html, /Generate AI for all blank fields/)
  assert.match(html, /id="ai-bulk-modal"/)
  assert.match(html, /id="ai-bulk-continue"/)
  assert.match(html, /id="ai-bulk-progress"/)

  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'settings.js'),
    'utf8',
  )
  assert.match(settings, /generateBlankFields/)
  assert.match(settings, /previewBlankFields/)
  assert.match(settings, /setAiBulkBusy/)
  assert.match(settings, /startAiBulkGeneration/)

  const main =
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.js'), 'utf8')
  assert.match(main, /ai:generateBlankFields/)
  assert.match(main, /ai:previewBlankFields/)
  assert.match(main, /ai:setBulkBusy/)
  assert.match(main, /listImagesNeedingCaptions/)
  assert.match(main, /listBlankExecutiveSummaryFields/)
  assert.match(main, /enqueueSummaryJobs/)
  // The navigation/quit lock the bulk modal holds. One labelled lock now serves
  // every long task that owns the window (bulk AI, report export), so this
  // asserts the shared mechanism plus the AI label that reaches the user.
  assert.match(main, /setBusyTask/)
  assert.match(main, /'AI generation'/)

  const db = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')
  assert.match(db, /function listImagesNeedingCaptions\(\)/)
  assert.match(db, /function listBlankExecutiveSummaryFields\(\)/)
  assert.match(db, /function updateExecutiveSummaryField\(/)
})
