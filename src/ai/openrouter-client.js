/**
 * OpenRouter chat/completions client for vision captions and text summaries.
 * @see https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
 */

const {
  VISION_MODEL,
  SUMMARY_MODEL,
  OPENROUTER_API_URL,
  OPENROUTER_KEY_URL,
  APP_HTTP_REFERER,
  APP_TITLE,
  CAPTION_MAX_TOKENS,
  CAPTION_TEMPERATURE,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TEMPERATURE,
  OPENROUTER_REQUEST_TIMEOUT_MS,
} = require('./openrouter-config')
const {
  conditionScore,
  formatCapitalPositionLines,
  formatMoney,
  formatRollupLines,
  planIndex,
  termLabelForYear,
  rankAssetsByCost,
  rankAssetsBySeverity,
  resolveStartYear,
  summarizeAssets,
} = require('../lib/asset-rollup')

/** Executive summary field → human title used in prompts and the form. */
const EXECUTIVE_SUMMARY_SECTIONS = {
  accessibility: 'Accessibility Executive Summary',
  designated_substance_survey: 'Designated Substance Survey Executive Summary',
  architectural_structural: 'Architectural & Structural Executive Summary',
  plumbing: 'Plumbing Executive Summary',
  mechanical: 'Mechanical Executive Summary',
  electrical: 'Electrical Executive Summary',
  fire_life_safety: 'Fire and Life Safety Executive Summary',
  site: 'Site Executive Summary',
  code_compliance: 'Code Compliance Executive Summary',
  immediate_concerns: 'Immediate Concerns',
  facility_overview: 'Facility Overview',
  capital_needs: 'Capital Needs Summary',
}

function openRouterHeaders(apiKey, { jsonBody = false } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': APP_HTTP_REFERER,
    'X-OpenRouter-Title': APP_TITLE,
  }
  if (jsonBody) headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * POST a chat/completions body with a wall-clock timeout and one Retry-After-aware
 * retry on platform/provider rate limits.
 *
 * The timeout matters most under bulk fill, which holds navigation until every
 * queued job settles — without it one stalled socket blocks the whole run.
 *
 * @param {string} apiKey
 * @param {object} body
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
async function postToOpenRouter(apiKey, body, { timeoutMs = OPENROUTER_REQUEST_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  const timeoutError = () =>
    new Error(`OpenRouter request timed out after ${Math.round(timeoutMs / 1000)}s`)

  const send = async () => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw timeoutError()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remainingMs)
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: openRouterHeaders(apiKey, { jsonBody: true }),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      // Fetch resolves when response headers arrive, not when the body has
      // finished. Buffer the small chat payload while the abort timer is still
      // live; otherwise a provider that stalls mid-body bypasses the advertised
      // wall-clock deadline in the later response.json() call.
      if (typeof response.arrayBuffer !== 'function') return response
      const responseBody = await response.arrayBuffer()
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw timeoutError()
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  const response = await send()
  if (response.status !== 429 && response.status !== 503) return response

  const retryAfterMs = Math.min(
    parseRetryAfterMs(response.headers.get('Retry-After'), Date.now()) ?? 2000,
    60_000,
  )
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw timeoutError()
  await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterMs, remainingMs)))
  if (Date.now() >= deadline) throw timeoutError()
  return send()
}

/** Parse Retry-After delta-seconds or an HTTP-date into a non-negative delay. */
function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null
  }
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

/**
 * Format OpenRouter credit amounts for UI (USD-style credits).
 * @param {number|null|undefined} amount
 * @param {{ emptyLabel?: string }} [options] emptyLabel used when amount is null/invalid
 */
function formatOpenRouterCredits(amount, options = {}) {
  const emptyLabel = options.emptyLabel ?? '—'
  if (amount == null || !Number.isFinite(Number(amount))) return emptyLabel
  const value = Number(amount)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}

/**
 * Format optional per-key spending cap remaining (not account balance).
 * @param {number|null|undefined} limit
 * @param {number|null|undefined} limitRemaining
 */
function formatOpenRouterKeyLimitRemaining(limit, limitRemaining) {
  const hasLimit = limit != null && Number.isFinite(Number(limit))
  if (!hasLimit) return 'No key limit'
  return formatOpenRouterCredits(limitRemaining, { emptyLabel: '—' })
}

/**
 * Fetch usage / remaining credits for the current API key.
 * @see https://openrouter.ai/docs/api_reference/limits
 * @param {string} apiKey
 */
async function fetchOpenRouterKeyUsage(apiKey) {
  if (!apiKey) throw new Error('OpenRouter API key is not available')

  const response = await fetch(OPENROUTER_KEY_URL, {
    method: 'GET',
    headers: openRouterHeaders(apiKey, { jsonBody: false }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `OpenRouter HTTP ${response.status}`
    throw new Error(message)
  }

  const data = payload?.data ?? payload
  return {
    label: data?.label ?? null,
    limit: data?.limit ?? null,
    limitRemaining: data?.limit_remaining ?? null,
    limitReset: data?.limit_reset ?? null,
    usage: data?.usage ?? null,
    usageDaily: data?.usage_daily ?? null,
    usageWeekly: data?.usage_weekly ?? null,
    usageMonthly: data?.usage_monthly ?? null,
    isFreeTier: Boolean(data?.is_free_tier),
  }
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.imageDataUrl data:image/...;base64,...
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @returns {Promise<string>}
 */
async function captionImageWithOpenRouter({
  apiKey,
  imageDataUrl,
  prompt,
  model = VISION_MODEL,
}) {
  if (!apiKey) throw new Error('OpenRouter API key is not available')
  if (!model) {
    throw new Error(
      'OpenRouter vision model is not configured (set OPENROUTER_VISION_MODEL)',
    )
  }
  if (!imageDataUrl) throw new Error('Image data is required')

  const body = {
    model,
    temperature: CAPTION_TEMPERATURE,
    max_tokens: CAPTION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl },
          },
        ],
      },
    ],
  }

  const finalResponse = await postToOpenRouter(apiKey, body)

  const payload = await finalResponse.json().catch(() => ({}))
  if (!finalResponse.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `OpenRouter HTTP ${finalResponse.status}`
    throw new Error(message)
  }

  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter returned an empty caption')
  }
  // No finish_reason check here: a caption legitimately runs out at
  // CAPTION_MAX_TOKENS, and sanitizeCaption clamps to a single line anyway.
  return sanitizeCaption(text)
}

/**
 * Text-only chat completion (executive summaries, etc.).
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.prompt user message
 * @param {string} [options.system]
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @returns {Promise<string>}
 */
async function completeTextWithOpenRouter({
  apiKey,
  prompt,
  system,
  model = SUMMARY_MODEL,
  maxTokens = SUMMARY_MAX_TOKENS,
  temperature = SUMMARY_TEMPERATURE,
}) {
  if (!apiKey) throw new Error('OpenRouter API key is not available')
  if (!model) {
    throw new Error(
      'OpenRouter summary model is not configured (set OPENROUTER_SUMMARY_MODEL)',
    )
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt is required')
  }

  const messages = []
  if (system && String(system).trim()) {
    messages.push({ role: 'system', content: String(system).trim() })
  }
  messages.push({ role: 'user', content: String(prompt) })

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  }

  const finalResponse = await postToOpenRouter(apiKey, body)

  const payload = await finalResponse.json().catch(() => ({}))
  if (!finalResponse.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `OpenRouter HTTP ${finalResponse.status}`
    throw new Error(message)
  }

  const choice = payload?.choices?.[0]
  const text = choice?.message?.content

  // Hitting max_tokens is a failure whether or not any prose came back. A reasoning
  // model whose thinking fills the budget returns no content at all; one that starts
  // writing gets cut mid-sentence, and autosave would commit the fragment. Reporting
  // the first case as "empty response" named the symptom and hid the cause, which is
  // what made this expensive to diagnose.
  if (choice?.finish_reason === 'length') {
    throw new Error(budgetExhaustedMessage(maxTokens))
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter returned an empty response')
  }
  return sanitizeSummaryText(text)
}

/**
 * Message for a summary that hit `max_tokens`, with the fix named.
 * @param {number} maxTokens
 */
function budgetExhaustedMessage(maxTokens) {
  return (
    `OpenRouter hit the ${maxTokens}-token limit before finishing the summary. ` +
    'Reasoning models count thinking tokens against that limit — raise ' +
    'SUMMARY_MAX_TOKENS or pick a model that reasons less.'
  )
}

function sanitizeCaption(raw) {
  let text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  // Drop wrapping quotes the model sometimes adds.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim()
  }
  // Single line, report-friendly length.
  if (text.length > 160) text = `${text.slice(0, 157).trim()}…`
  return text
}

/**
 * Normalize multi-paragraph executive summary text from the model.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeSummaryText(raw) {
  let text = String(raw ?? '').trim()
  // Strip common markdown fences.
  if (text.startsWith('```')) {
    text = text
      .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
      .replace(/\s*```$/, '')
      .trim()
  }
  // Drop a single pair of wrapping quotes around the whole block.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim()
  }
  // Collapse runs of blank lines; keep paragraph breaks.
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Soft cap so a runaway response cannot flood the form.
  if (text.length > 4000) text = `${text.slice(0, 3997).trim()}…`
  return text
}

function buildAssetCaptionPrompt(context = {}) {
  const lines = [
    'You write photo captions for Building Condition Assessment (BCA) reports.',
    'Return ONE plain-text caption, max 12 words. No quotes, no markdown, no bullet points.',
    'Focus on the visible building component and any clear defect or condition.',
    'Do not invent locations, ages, causes, or costs you cannot see.',
    '',
    'Context:',
  ]
  if (context.propertyName) lines.push(`- Property: ${context.propertyName}`)
  if (context.assetName) lines.push(`- Asset: ${context.assetName}`)
  if (context.material) lines.push(`- Material/system: ${context.material}`)
  if (context.condition) lines.push(`- Condition rating: ${context.condition}`)
  if (context.level1Group) lines.push(`- Uniformat group: ${context.level1Group}`)
  lines.push('', 'Describe only what is visible in the image.')
  return lines.join('\n')
}

function buildBuildingCaptionPrompt(context = {}) {
  const lines = [
    'You write photo captions for Building Condition Assessment (BCA) reports.',
    'Return ONE plain-text caption, max 12 words. No quotes, no markdown, no bullet points.',
    'Focus on the exterior, site, or building feature shown.',
    'Do not invent addresses, ages, or defects you cannot see.',
    '',
    'Context:',
  ]
  if (context.propertyName) lines.push(`- Property: ${context.propertyName}`)
  if (context.address) lines.push(`- Address: ${context.address}`)
  lines.push('', 'Describe only what is visible in the image.')
  return lines.join('\n')
}

/**
 * Whether a field key is a known executive summary section.
 * @param {string} field
 */
function isExecutiveSummaryField(field) {
  return Object.prototype.hasOwnProperty.call(EXECUTIVE_SUMMARY_SECTIONS, field)
}

/**
 * Human-readable title for a summary field key.
 * @param {string} field
 */
function executiveSummarySectionTitle(field) {
  return EXECUTIVE_SUMMARY_SECTIONS[field] || String(field || 'Executive Summary')
}

/**
 * The section a Uniformat code assigns an asset to, if any.
 * @param {object} asset
 * @param {{ level1: (asset: object) => string, level2: (asset: object) => string }} accessors
 * @returns {string|null}
 */
function codeOwnedSection(asset, { level1, level2 }) {
  const l2 = level2(asset)
  if (l2.startsWith('D20')) return 'plumbing'
  if (l2.startsWith('D30')) return 'mechanical'
  if (l2.startsWith('D40')) return 'fire_life_safety'
  if (l2.startsWith('D50')) return 'electrical'
  const l1 = level1(asset)
  if (l1 === 'G') return 'site'
  if (['A', 'B', 'C'].includes(l1)) return 'architectural_structural'
  return null
}

/** Worst two labels on the 1–6 condition dropdown (Very poor, Critical). */
const SEVERE_CONDITION_SCORE = conditionScore('Very poor')

/**
 * Whether the capital plan schedules any work for this asset.
 *
 * `plan.suppressed` is authoritative — it comes from `capital_planning_rules.json`
 * — and the literal check gives the same answer for today's rules when no plan
 * was supplied, so a suppressed asset is never presented as work either way.
 * @param {object} asset
 * @param {object|null} [plan] per-asset entry from `calculateCapitalPlan`
 */
function schedulesWork(asset, plan = null) {
  if (plan?.suppressed) return false
  const term = plan?.effectiveTerm ?? asset?.term
  return (
    !/^no action$/i.test(String(asset?.action ?? '').trim()) &&
    !/^n\/a$/i.test(String(term ?? '').trim())
  )
}

/**
 * Whether the assessor flagged this asset as needing near-term attention.
 *
 * `action` is deliberately not a signal. Replace and Repair are the two most
 * common actions in a condition assessment and say nothing about *when* the work
 * is due, so matching them — the earlier behaviour — admitted most of the
 * register into Immediate Concerns. Urgency lives in priority, term, and the
 * severe end of the condition scale.
 * @param {object} asset
 * @param {object|null} [plan]
 */
function isUrgentAsset(asset, plan = null) {
  if (String(asset?.priority ?? '').trim().toLowerCase() === 'high') return true
  if (/^immediate$/i.test(String(plan?.effectiveTerm ?? asset?.term ?? '').trim())) return true
  const score = conditionScore(asset?.condition_rating)
  return score != null && score >= SEVERE_CONDITION_SCORE
}

/**
 * Pick assets most relevant to a summary section (Uniformat codes + keywords).
 * @param {string} field
 * @param {Array<object>} assets
 * @param {Map<number, object>} [planByAssetId] per-asset capital plans, when available
 * @returns {Array<object>}
 */
function filterAssetsForSummarySection(field, assets, planByAssetId = null) {
  const list = Array.isArray(assets) ? assets : []
  const key = String(field || '')
  const plans = planByAssetId instanceof Map ? planByAssetId : new Map()

  const level1 = (asset) => String(asset?.level_1_code || '').toUpperCase()
  const level2 = (asset) => String(asset?.level_2_code || '').toUpperCase()
  /**
   * Assessor-authored fields plus the level-1/2 group descriptions. The level-3
   * description and material are excluded: they describe the priced catalogue
   * line item rather than the asset (see `formatAssetForSummaryPrompt`), so
   * keywords found in them are about something the assessor never wrote down.
   */
  const haystack = (asset) =>
    [
      asset?.asset_name,
      asset?.level_1_description,
      asset?.level_2_description,
      asset?.description,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

  /**
   * A keyword fallback may only claim an asset that no Uniformat code already
   * assigns to a different section. Catalogue text such as the level-2
   * description "Site Civil/Mechanical Utilities" otherwise drags G-group site
   * assets into Mechanical.
   */
  const eligible = (asset) => {
    const owner = codeOwnedSection(asset, { level1, level2 })
    return owner == null || owner === key
  }
  const matches = (asset, pattern) => eligible(asset) && pattern.test(haystack(asset))

  switch (key) {
    case 'architectural_structural':
      return list.filter(
        (a) =>
          ['A', 'B', 'C'].includes(level1(a)) ||
          matches(
            a,
            /structur|envelope|curtain|roof|wall|found|slab|facade|sealant|parking deck|membrane/i,
          ),
      )
    case 'plumbing':
      return list.filter(
        (a) =>
          level2(a).startsWith('D20') ||
          matches(a, /plumb|domestic water|sanitary|storm|sump|water heater|fixture/i),
      )
    case 'mechanical':
      return list.filter(
        (a) =>
          level2(a).startsWith('D30') ||
          matches(a, /hvac|mechanical|heating|cooling|chiller|boiler|ventil|air handl|exhaust/i),
      )
    case 'electrical':
      return list.filter(
        (a) =>
          level2(a).startsWith('D50') ||
          matches(a, /electr|switchgear|panel|transformer|lighting|generator|ups/i),
      )
    case 'fire_life_safety':
      return list.filter(
        (a) =>
          level2(a).startsWith('D40') ||
          matches(a, /fire|life safety|sprinkler|standpipe|alarm|egress|emergency light/i),
      )
    case 'site':
      return list.filter(
        (a) =>
          level1(a) === 'G' ||
          matches(
            a,
            /site|paving|asphalt|curb|landscape|irrigation|parking lot|sidewalk|drainage/i,
          ),
      )
    case 'immediate_concerns':
      // An asset the plan schedules nothing for cannot be an immediate concern,
      // whatever its condition says.
      return list.filter((a) => {
        const plan = plans.get(a?.id)
        return schedulesWork(a, plan) && isUrgentAsset(a, plan)
      })
    case 'accessibility':
    case 'designated_substance_survey':
    case 'code_compliance':
    case 'facility_overview':
    case 'capital_needs':
    default:
      return list
  }
}

/**
 * Per-section policy for asset-level detail lines.
 *
 * Sections whose prose cannot be written from statistics alone (the building
 * systems, immediate concerns, capital needs) get ranked detail lines. Sections
 * that are building-wide statements, or that the register simply has no data
 * for, get rollups only — sending the asset list there is noise that invites
 * fabrication.
 *
 * `source: 'scope'` draws from the section's Uniformat-filtered subset;
 * `'all'` draws from every visible asset.
 */
const SECTION_DETAIL_POLICY = {
  accessibility: {
    mode: 'keyword',
    limit: 5,
    source: 'all',
    pattern:
      /accessib|elevator|lift|entrance|entry|vestibule|door|ramp|stair|handrail|washroom|restroom|corridor|signage|barrier|parking stall/i,
  },
  designated_substance_survey: { mode: 'none' },
  architectural_structural: { mode: 'severity', limit: 15, source: 'scope' },
  plumbing: { mode: 'severity', limit: 12, source: 'scope' },
  mechanical: { mode: 'severity', limit: 12, source: 'scope' },
  electrical: { mode: 'severity', limit: 12, source: 'scope' },
  fire_life_safety: { mode: 'severity', limit: 12, source: 'scope' },
  site: { mode: 'severity', limit: 12, source: 'scope' },
  code_compliance: { mode: 'none' },
  immediate_concerns: { mode: 'severity', limit: 10, source: 'scope' },
  facility_overview: { mode: 'none' },
  capital_needs: { mode: 'cost', limit: 10, source: 'all' },
}

/** Sections whose relevant scope is the whole building, so a section rollup would duplicate it. */
const BUILDING_WIDE_SECTIONS = new Set([
  'accessibility',
  'designated_substance_survey',
  'code_compliance',
  'facility_overview',
  'capital_needs',
])

/**
 * Which assets earn a detail line for a section, and in what order.
 * @param {object} options
 * @param {string} options.field
 * @param {Array<object>} options.assets every visible asset
 * @param {Array<object>} options.scopedAssets the section's filtered subset
 * @param {Map<number, object>} options.planByAssetId
 * @returns {Array<object>}
 */
function selectSectionDetailAssets({ field, assets, scopedAssets, planByAssetId }) {
  const policy = SECTION_DETAIL_POLICY[String(field)]
  if (!policy || policy.mode === 'none') return []

  const pool = policy.source === 'all' ? assets : scopedAssets
  const list = Array.isArray(pool) ? pool : []

  switch (policy.mode) {
    case 'keyword': {
      // Assessor-authored fields only: catalogue text drifts from the asset
      // (a curtain wall priced as "Exterior Doors" is not an accessible entrance).
      const matches = list.filter((asset) =>
        policy.pattern.test(
          [asset?.asset_name, asset?.description, asset?.recommendation]
            .filter(Boolean)
            .join(' '),
        ),
      )
      return rankAssetsBySeverity(matches, planByAssetId).slice(0, policy.limit)
    }
    case 'cost':
      return rankAssetsByCost(list, planByAssetId)
        .filter((asset) => {
          const plan = planByAssetId.get(asset?.id)
          // Suppressed assets (No Action / term N/A) carry a replacement value but
          // no scheduled work, so listing them as capital needs would contradict
          // the report's capital tables.
          if (!schedulesWork(asset, plan)) return false
          return Number(plan?.opinionOfProbableCost ?? asset?.opinion_of_probable_cost ?? 0) > 0
        })
        .slice(0, policy.limit)
    case 'severity':
    default:
      return rankAssetsBySeverity(list, planByAssetId).slice(0, policy.limit)
  }
}

/**
 * One detail line for an asset. Costs and lifecycle values come from the
 * capital plan when available so they match the report tables.
 * @param {object} asset
 * @param {{ plan?: object|null, startYear?: number|null, terms?: Array<object>|null }} [context]
 *   `terms` are the capital plan's term windows, used to state the asset's term as
 *   the plan buckets it rather than as the assessor typed it.
 */
function formatAssetForSummaryPrompt(asset, context = {}) {
  const { plan = null, startYear = null, terms = null } = context
  const parts = []
  const name = String(asset?.asset_name || '').trim() || 'Unnamed asset'
  parts.push(name)
  if (asset?.level_2_group_element || asset?.level_2_code) {
    parts.push(
      `(${asset.level_2_group_element || asset.level_2_code}${
        asset.level_1_code ? ` / ${asset.level_1_code}` : ''
      })`,
    )
  }
  // level_3_description and material come from the uniformat_pricing join —
  // they describe the priced catalogue line item, not the asset, and routinely
  // disagree with it ("Portable Roof Anchors" on an exterior sealant asset).
  // Only assessor-authored fields and the level-1/2 grouping are trustworthy.
  const bits = []
  const quantity = Number(asset?.quantity)
  if (Number.isFinite(quantity) && quantity > 0) {
    const unit = String(asset?.unit_measure || asset?.unit_of_measure || '').trim()
    bits.push(`quantity ${quantity}${unit ? ` ${unit}` : ''}`)
  }

  const vintage = Number(asset?.vintage)
  if (Number.isFinite(vintage) && vintage > 0) {
    const age = startYear != null ? `, age ${startYear - vintage} yr` : ''
    bits.push(`vintage ${vintage}${age}`)
  }
  const serviceLife = Number(asset?.service_life)
  if (Number.isFinite(serviceLife) && serviceLife > 0) {
    bits.push(`service life ${serviceLife} yr`)
  }
  if (plan?.remainingLife != null && Number.isFinite(Number(plan.remainingLife))) {
    bits.push(`remaining life ${Number(plan.remainingLife)} yr`)
  }

  if (asset?.condition_rating) bits.push(`condition ${asset.condition_rating}`)
  if (asset?.priority) bits.push(`priority ${asset.priority}`)
  if (asset?.action) bits.push(`action ${asset.action}`)

  // The plan's effective term already applies the scheduled action-year bucket.
  // Prefer it so the detail line and the capital-position totals share one
  // timing source. Suppressed/no-plan rows fall back to their stored value
  // because no scheduled bucket applies.
  const scheduledActionYearValue = plan?.scheduledActionYear ?? plan?.actionYear
  const scheduledActionYear =
    scheduledActionYearValue == null || scheduledActionYearValue === ''
      ? null
      : Number(scheduledActionYearValue)
  const scheduledTerm =
    plan?.suppressed
      ? null
      : plan?.effectiveTerm ?? termLabelForYear(terms, scheduledActionYear)
  const termLabel = scheduledTerm ?? (asset?.term ? String(asset.term) : null)
  if (termLabel) bits.push(`term ${termLabel}`)

  if (Number.isFinite(scheduledActionYear)) {
    const lifecycleYear = Number(plan?.actionYear)
    const overdueContext =
      plan?.actionYearIsOverdue &&
      Number.isFinite(lifecycleYear) &&
      lifecycleYear !== scheduledActionYear
        ? ` (overdue; lifecycle date ${lifecycleYear})`
        : ''
    bits.push(`action year ${scheduledActionYear}${overdueContext}`)
  }

  const opc = formatMoney(plan?.opinionOfProbableCost ?? asset?.opinion_of_probable_cost)
  if (opc) bits.push(`opinion of probable cost ${opc}`)

  const lens = String(asset?.conservation_lens ?? '').trim()
  if (lens && !/^not applicable$/i.test(lens)) bits.push(`conservation lens ${lens}`)

  if (asset?.recommendation) {
    const rec = String(asset.recommendation).replace(/\s+/g, ' ').trim()
    bits.push(`recommendation: ${rec.slice(0, 260)}${rec.length > 260 ? '…' : ''}`)
  }
  if (asset?.description) {
    const desc = String(asset.description).replace(/\s+/g, ' ').trim()
    bits.push(`observations: ${desc.slice(0, 220)}${desc.length > 220 ? '…' : ''}`)
  }
  if (bits.length) parts.push('—', bits.join('; '))
  return `- ${parts.join(' ')}`
}

/**
 * Build system + user prompts for an executive summary section.
 * @param {object} options
 * @param {string} options.field
 * @param {object|null} options.building
 * @param {Array<object>} [options.assets]
 * @param {object|null} [options.capitalPlan] result of `calculateCapitalPlan`
 * @returns {{ system: string, prompt: string, sectionTitle: string }}
 */
function buildExecutiveSummaryPrompt({
  field,
  building = null,
  assets = [],
  capitalPlan = null,
}) {
  const sectionTitle = executiveSummarySectionTitle(field)
  const allAssets = Array.isArray(assets) ? assets : []
  const planByAssetId = planIndex(capitalPlan)
  const scopedAssets = filterAssetsForSummarySection(field, allAssets, planByAssetId)
  const startYear = resolveStartYear({ capitalPlan, building })

  const detailAssets = selectSectionDetailAssets({
    field,
    assets: allAssets,
    scopedAssets,
    planByAssetId,
  })

  const system = [
    'You write professional executive-summary sections for Building Condition Assessment (BCA/FCA) reports.',
    'Write in clear Canadian professional English suitable for an ASTM-style condition assessment report.',
    'Return plain prose only: one or two short paragraphs, no markdown, no bullet lists, no headings, no quotes around the whole answer.',
    'Base statements only on the provided property, capital, and asset facts. Do not invent inspections, test results, code violations, or materials not supported by the context.',
    'You may cite the figures given in the context, but quote them exactly as provided — never derive, total, extrapolate, or estimate new costs, percentages, years, or quantities.',
    'Facility Condition Index and mean condition rating are separate metrics on different scales: report each as labelled and never average, blend, or substitute one for the other.',
    'If evidence is thin, state that findings are based on the limited information available and recommend further review where appropriate.',
    'Typical length: 60–140 words.',
  ].join(' ')

  const lines = [
    `Write the "${sectionTitle}" section for this property.`,
    '',
    'Property:',
  ]

  if (building?.property_name) lines.push(`- Name: ${building.property_name}`)
  const address = [
    building?.address,
    building?.city,
    building?.province_short || building?.province,
    building?.postal_code,
  ]
    .filter(Boolean)
    .join(', ')
  if (address) lines.push(`- Address: ${address}`)
  if (building?.gross_floor_area_m2 != null && building.gross_floor_area_m2 !== '') {
    lines.push(`- Gross floor area: ${building.gross_floor_area_m2} m²`)
  }
  if (building?.num_floors != null && building.num_floors !== '') {
    lines.push(`- Storeys / floors: ${building.num_floors}`)
  }
  if (building?.property_vintage != null && building.property_vintage !== '') {
    lines.push(`- Property vintage: ${building.property_vintage}`)
  }
  if (building?.date_of_assessment) {
    lines.push(`- Date of assessment: ${building.date_of_assessment}`)
  }

  const capitalLines = formatCapitalPositionLines(capitalPlan)
  if (capitalLines.length) {
    lines.push('', 'Building-wide capital position:', ...capitalLines)
  }

  const buildingSummary = summarizeAssets(allAssets, { capitalPlan, planByAssetId, startYear })
  const buildingRollup = formatRollupLines(buildingSummary)
  if (buildingRollup.length) {
    lines.push('', 'Building-wide asset register (aggregate):', ...buildingRollup)
  }

  // A section rollup only adds information when the section is a strict subset;
  // building-wide sections would otherwise repeat the block above verbatim.
  if (
    !BUILDING_WIDE_SECTIONS.has(String(field)) &&
    scopedAssets.length > 0 &&
    scopedAssets.length < allAssets.length
  ) {
    const sectionRollup = formatRollupLines(
      summarizeAssets(scopedAssets, { capitalPlan, planByAssetId, startYear }),
    )
    if (sectionRollup.length) {
      lines.push('', `${sectionTitle} — assets in this section (aggregate):`, ...sectionRollup)
    }
  }

  lines.push('', 'Section focus:')
  switch (String(field)) {
    case 'accessibility':
      lines.push(
        'Summarize accessible routes, entrances, elevators, and common-area accessibility based on available asset notes. Note if a detailed accessibility audit is still recommended.',
      )
      break
    case 'designated_substance_survey':
      lines.push(
        'Address designated / hazardous substances. If no survey data is present in the context, clearly say a specialist survey was not available and should be completed before intrusive work.',
      )
      break
    case 'architectural_structural':
      lines.push(
        'Summarize structure and building envelope condition and near-term renewal priorities from the architectural/structural assets.',
      )
      break
    case 'plumbing':
      lines.push(
        'Summarize domestic water, sanitary, and related plumbing systems and near-term lifecycle items.',
      )
      break
    case 'mechanical':
      lines.push(
        'Summarize HVAC / mechanical plant condition, maintenance posture, and major renewal planning.',
      )
      break
    case 'electrical':
      lines.push(
        'Summarize electrical distribution, service equipment, and near-term diligence items (e.g. scanning, labeling, documentation).',
      )
      break
    case 'fire_life_safety':
      lines.push(
        'Summarize fire protection and life-safety systems and ongoing testing / near-term focus areas.',
      )
      break
    case 'site':
      lines.push(
        'Summarize sitework: paving, curbs, drainage, landscaping, and related exterior components.',
      )
      break
    case 'code_compliance':
      lines.push(
        'Comment on code compliance based on a limited visual assessment only; do not invent violations. Note that future capital work may trigger code review.',
      )
      break
    case 'immediate_concerns':
      lines.push(
        'Highlight only items that appear to need near-term attention. The assets below are scoped to high priority, immediate term, or severely deteriorated condition. If none stand out, say immediate concerns are limited and point operators to asset recommendations.',
      )
      break
    case 'facility_overview':
      lines.push(
        'Give a concise facility overview (name, location, size, storeys, use if inferable), then characterize overall condition using the aggregate ratings and Facility Condition Index. Do not single out individual assets.',
      )
      break
    case 'capital_needs':
      lines.push(
        'Summarize capital-plan themes and highest-value near-term priorities. Cite the term totals, current replacement value, and Facility Condition Index exactly as given above; do not compute new totals or shares.',
      )
      break
    default:
      lines.push('Write a concise professional summary for this section.')
  }

  const policy = SECTION_DETAIL_POLICY[String(field)]
  if (policy?.mode === 'none') {
    lines.push(
      '',
      'Asset-level detail is intentionally omitted for this section: the asset register holds no',
      'findings specific to it. Write from the property facts and aggregates above, and say plainly',
      'where a specialist review would be required.',
    )
  } else if (detailAssets.length === 0) {
    lines.push('', 'Relevant assets:', '- (No matching asset records were available for this section.)')
  } else {
    const pool = policy?.source === 'all' ? allAssets : scopedAssets
    lines.push(
      '',
      policy?.mode === 'cost'
        ? 'Highest-cost assets (the aggregates above cover the full register):'
        : 'Highest-impact assets in this section, most significant first:',
      ...detailAssets.map((asset) =>
        formatAssetForSummaryPrompt(asset, {
          plan: planByAssetId.get(asset?.id) ?? null,
          startYear,
          // Same term windows the capital position block above was built from, so
          // each asset's term agrees with the totals the model is quoting.
          terms: capitalPlan?.terms ?? null,
        }),
      ),
    )
    if (pool.length > detailAssets.length) {
      lines.push(
        `- (${pool.length - detailAssets.length} further asset(s) are represented in the aggregates above but not listed individually.)`,
      )
    }
  }

  lines.push(
    '',
    `Return only the finished "${sectionTitle}" prose for pasting into the report.`,
  )

  return {
    system,
    prompt: lines.join('\n'),
    sectionTitle,
  }
}

module.exports = {
  postToOpenRouter,
  parseRetryAfterMs,
  captionImageWithOpenRouter,
  completeTextWithOpenRouter,
  fetchOpenRouterKeyUsage,
  formatOpenRouterCredits,
  formatOpenRouterKeyLimitRemaining,
  sanitizeCaption,
  sanitizeSummaryText,
  buildAssetCaptionPrompt,
  buildBuildingCaptionPrompt,
  buildExecutiveSummaryPrompt,
  filterAssetsForSummarySection,
  selectSectionDetailAssets,
  formatAssetForSummaryPrompt,
  isExecutiveSummaryField,
  executiveSummarySectionTitle,
  BUILDING_WIDE_SECTIONS,
  EXECUTIVE_SUMMARY_SECTIONS,
  SECTION_DETAIL_POLICY,
}
