/**
 * Aggregate rollups over a building's asset register, for AI prompt context.
 *
 * Pure functions — no database, no network. Dollar figures always come from a
 * capital plan produced by `src/lib/capital-planning.js`, so numbers quoted in
 * generated prose match the numbers rendered in the report tables.
 */

const { assessmentYearFromDate, termForOffset } = require('./capital-planning')

/**
 * condition_rating dropdown values in severity order (see CONDITION_RATINGS in
 * `src/renderer.js`, which shows them numbered 1–6). Higher score is worse.
 * 'Not applicable' is deliberately unscored and never averaged.
 */
const SCORED_CONDITION_LABELS = [
  'Very good',
  'Good',
  'Fair',
  'Poor',
  'Very poor',
  'Critical',
]

const CONDITION_SCALE = new Map(
  SCORED_CONDITION_LABELS.map((label, index) => [label.toLowerCase(), index + 1]),
)

/** Canonical histogram orders; unrecognized values sort alphabetically after these. */
const CONDITION_ORDER = [...SCORED_CONDITION_LABELS, 'Not applicable']
const ACTION_ORDER = [
  'Replace',
  'Refurbish',
  'Repair',
  'Investigate',
  'Install',
  'Maintain',
  'Decommission',
  'No Action',
]
const PRIORITY_ORDER = ['High', 'Medium', 'Low', 'No Priority']
const TERM_ORDER = [
  'Immediate',
  'Short Term',
  'Medium Term',
  'Long Term',
  'End of Life',
  'N/A',
]

/** Ranking used when picking which assets earn a detail line. */
const PRIORITY_RANK = new Map([
  ['high', 0],
  ['medium', 1],
  ['low', 2],
])
const UNRANKED_PRIORITY = 3

/**
 * Numeric severity for a condition_rating value.
 * @param {unknown} value
 * @returns {number|null} 1 (Very good) … 6 (Critical), or null when unscored
 */
function conditionScore(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!key) return null
  return CONDITION_SCALE.get(key) ?? null
}

/**
 * Nearest label (or straddled pair) for a mean condition score.
 * @param {number|null} mean
 * @returns {string|null}
 */
function conditionBandLabel(mean) {
  if (mean == null || !Number.isFinite(mean)) return null
  const clamped = Math.min(Math.max(mean, 1), SCORED_CONDITION_LABELS.length)
  const lower = Math.floor(clamped)
  const upper = Math.ceil(clamped)
  const lowerLabel = SCORED_CONDITION_LABELS[lower - 1] ?? null
  const upperLabel = SCORED_CONDITION_LABELS[upper - 1] ?? null
  if (lower === upper || !lowerLabel || !upperLabel) return lowerLabel ?? upperLabel
  return `between ${lowerLabel} and ${upperLabel}`
}

/**
 * Money for prompts: rounded to the nearest $1,000 above $1,000 so the model
 * has no spurious precision to quote.
 * @param {unknown} value
 * @returns {string|null}
 */
function formatMoney(value) {
  const raw = Number(value)
  if (value == null || value === '' || !Number.isFinite(raw)) return null
  const rounded = Math.round(raw)
  if (rounded === 0) return '$0'
  const sign = rounded < 0 ? '-' : ''
  const abs = Math.abs(rounded)
  const display = abs < 1000 ? abs : Math.round(abs / 1000) * 1000
  return `${sign}$${display.toLocaleString('en-US')}`
}

/**
 * @param {unknown} value ratio-derived percentage (already 0–100)
 * @returns {string|null}
 */
function formatPercent(value) {
  const raw = Number(value)
  if (value == null || !Number.isFinite(raw)) return null
  return `${raw.toFixed(1)}%`
}

/**
 * Count occurrences of a field, ordered by a canonical vocabulary first.
 * Values outside the vocabulary are kept (never dropped) and sorted after it.
 * @param {Array<object>} assets
 * @param {string} key
 * @param {Array<string>} canonicalOrder
 * @returns {Array<{ label: string, count: number }>}
 */
function histogram(assets, key, canonicalOrder = []) {
  const counts = new Map()
  for (const asset of assets) {
    const value = String(asset?.[key] ?? '').trim()
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const rank = new Map(canonicalOrder.map((label, index) => [label.toLowerCase(), index]))
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      const aRank = rank.get(a.label.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      const bRank = rank.get(b.label.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      if (aRank !== bRank) return aRank - bRank
      return a.label.localeCompare(b.label)
    })
}

/** `Good 18, Fair 22, Poor 12` */
function formatHistogram(entries) {
  if (!entries?.length) return null
  return entries.map((entry) => `${entry.label} ${entry.count}`).join(', ')
}

/**
 * Index a capital plan's per-asset results by asset id.
 * @param {object|null} capitalPlan
 * @returns {Map<number, object>}
 */
function planIndex(capitalPlan) {
  return new Map((capitalPlan?.assets ?? []).map((plan) => [plan.assetId, plan]))
}

/**
 * Assessment year for age math: the capital plan's own start year when present.
 * @param {{ capitalPlan?: object|null, building?: object|null }} options
 * @returns {number|null}
 */
function resolveStartYear({ capitalPlan = null, building = null } = {}) {
  if (Number.isFinite(Number(capitalPlan?.startYear))) return Number(capitalPlan.startYear)
  if (building?.date_of_assessment) return assessmentYearFromDate(building.date_of_assessment)
  return null
}

/**
 * Scheduled capital totals per term for an arbitrary subset of assets.
 * Mirrors `calculateCapitalPlan`'s own term bucketing so a section's figures
 * always reconcile with the building totals.
 * @param {Array<object>} assets
 * @param {{ capitalPlan: object|null, planByAssetId?: Map<number, object> }} options
 * @returns {Array<{ id: string, label: string, yearFrom: number, yearTo: number, total: number }>}
 */
function termTotalsForAssets(assets, { capitalPlan = null, planByAssetId = null } = {}) {
  const rules = capitalPlan?.rules
  const startYear = capitalPlan?.startYear
  if (!rules?.terms?.length || !Number.isFinite(Number(startYear))) return []
  const plans = planByAssetId ?? planIndex(capitalPlan)
  const totals = new Map(rules.terms.map((term) => [term.id, 0]))
  for (const asset of assets ?? []) {
    const plan = plans.get(asset?.id)
    if (!plan) continue
    for (const event of plan.events ?? []) {
      const term = termForOffset(event.offset, rules)
      if (!term) continue
      totals.set(term.id, (totals.get(term.id) ?? 0) + event.amount)
    }
  }
  return rules.terms.map((term) => ({
    id: term.id,
    label: term.label,
    yearFrom: Number(startYear) + term.offset_from,
    yearTo: Number(startYear) + term.offset_to,
    total: totals.get(term.id) ?? 0,
  }))
}

/**
 * Term bucket label a scheduled year falls into.
 *
 * Legacy callers and no-plan fallbacks can still need to bucket a raw action
 * year. Normal plan consumers should use `plan.effectiveTerm`, which already
 * applies the derived bucket and any explicit override.
 *
 * @param {Array<{ label: string, yearFrom: number, yearTo: number }>|null|undefined} terms
 * @param {number|null|undefined} year
 * @returns {string|null} null when there are no terms or the year sits outside them
 */
function termLabelForYear(terms, year) {
  const target = Number(year)
  if (!Array.isArray(terms) || !Number.isFinite(target)) return null
  const match = terms.find(
    (term) => target >= Number(term?.yearFrom) && target <= Number(term?.yearTo),
  )
  return match?.label ? String(match.label) : null
}

/**
 * Aggregate statistics for a set of assets. Works for the whole register or a
 * single section's subset — the caller decides the scope.
 *
 * @param {Array<object>} assets
 * @param {{ capitalPlan?: object|null, planByAssetId?: Map<number, object>, startYear?: number|null }} [options]
 */
function summarizeAssets(assets, options = {}) {
  const list = Array.isArray(assets) ? assets : []
  const { capitalPlan = null } = options
  const plans = options.planByAssetId ?? planIndex(capitalPlan)
  const startYear =
    options.startYear ?? (capitalPlan ? resolveStartYear({ capitalPlan }) : null)

  let scoreTotal = 0
  let ratedCount = 0
  let ageTotal = 0
  let agedCount = 0
  let oldestVintage = null
  let newestVintage = null
  let overdueCount = 0
  let opcTotal = 0
  let costedCount = 0

  for (const asset of list) {
    const score = conditionScore(asset?.condition_rating)
    if (score != null) {
      scoreTotal += score
      ratedCount += 1
    }

    const vintage = Number(asset?.vintage)
    if (Number.isFinite(vintage) && vintage > 0) {
      if (oldestVintage == null || vintage < oldestVintage) oldestVintage = vintage
      if (newestVintage == null || vintage > newestVintage) newestVintage = vintage
      if (startYear != null) {
        ageTotal += startYear - vintage
        agedCount += 1
      }
    }

    const plan = plans.get(asset?.id)
    if (plan?.remainingLife != null && Number(plan.remainingLife) <= 0) overdueCount += 1
    const opc = Number(plan?.opinionOfProbableCost ?? asset?.opinion_of_probable_cost)
    if (Number.isFinite(opc) && opc > 0) {
      opcTotal += opc
      costedCount += 1
    }
  }

  const mean = ratedCount > 0 ? scoreTotal / ratedCount : null
  const effectiveTermAssets = list.map((asset) => ({
    term: plans.get(asset?.id)?.effectiveTerm ?? null,
  }))

  return {
    count: list.length,
    condition: {
      mean,
      band: conditionBandLabel(mean),
      ratedCount,
      unratedCount: list.length - ratedCount,
      histogram: histogram(list, 'condition_rating', CONDITION_ORDER),
    },
    actions: histogram(list, 'action', ACTION_ORDER),
    priorities: histogram(list, 'priority', PRIORITY_ORDER),
    terms: histogram(effectiveTermAssets, 'term', TERM_ORDER),
    vintage: {
      oldest: oldestVintage,
      newest: newestVintage,
      meanAge: agedCount > 0 ? ageTotal / agedCount : null,
    },
    overdueCount,
    capital: {
      opcTotal: costedCount > 0 ? opcTotal : null,
      costedCount,
      byTerm: termTotalsForAssets(list, { capitalPlan, planByAssetId: plans }),
    },
  }
}

/**
 * Prompt lines for a rollup produced by `summarizeAssets`.
 * @param {object} summary
 * @returns {Array<string>}
 */
function formatRollupLines(summary) {
  if (!summary || summary.count === 0) return []
  const lines = [`- Assets in scope: ${summary.count}`]

  if (summary.condition.mean != null) {
    const band = summary.condition.band ? ` (${summary.condition.band})` : ''
    const unrated =
      summary.condition.unratedCount > 0
        ? `; ${summary.condition.unratedCount} unrated or not applicable`
        : ''
    lines.push(
      `- Mean condition rating: ${summary.condition.mean.toFixed(1)} of 6${band}, ` +
        `from ${summary.condition.ratedCount} rated asset(s)${unrated}`,
    )
  }

  const pairs = [
    ['Condition mix', summary.condition.histogram],
    ['Recommended actions', summary.actions],
    ['Work priorities', summary.priorities],
    ['Assessment terms', summary.terms],
  ]
  for (const [label, entries] of pairs) {
    const text = formatHistogram(entries)
    if (text) lines.push(`- ${label}: ${text}`)
  }

  if (summary.vintage.oldest != null && summary.vintage.newest != null) {
    const range =
      summary.vintage.oldest === summary.vintage.newest
        ? `${summary.vintage.oldest}`
        : `${summary.vintage.oldest}–${summary.vintage.newest}`
    const age =
      summary.vintage.meanAge != null
        ? `; mean age ${Math.round(summary.vintage.meanAge)} years`
        : ''
    lines.push(`- Installation vintages: ${range}${age}`)
  }

  if (summary.overdueCount > 0) {
    lines.push(
      `- ${summary.overdueCount} asset(s) are at or past the end of their expected service life`,
    )
  }

  const opc = formatMoney(summary.capital.opcTotal)
  if (opc) {
    lines.push(`- Total opinion of probable cost for these assets: ${opc}`)
  }

  const termText = summary.capital.byTerm
    .filter((term) => term.total > 0)
    .map((term) => {
      const years = term.yearFrom === term.yearTo ? `${term.yearFrom}` : `${term.yearFrom}–${term.yearTo}`
      return `${term.label} (${years}) ${formatMoney(term.total)}`
    })
    .join('; ')
  if (termText) lines.push(`- Scheduled capital by term: ${termText}`)

  return lines
}

/**
 * Prompt lines for building-wide capital position (CRV, FCI, term totals).
 * @param {object|null} capitalPlan
 * @returns {Array<string>}
 */
function formatCapitalPositionLines(capitalPlan) {
  if (!capitalPlan) return []
  const lines = []

  const crv = formatMoney(capitalPlan.crv?.value)
  if (crv) {
    const source = capitalPlan.crv?.source === 'override' ? 'manual override' : 'derived'
    const uplift = Number(capitalPlan.crv?.upliftPercent)
    const upliftText = Number.isFinite(uplift) ? `, includes ${uplift}% soft costs` : ''
    lines.push(`- Current replacement value: ${crv} (${source}${upliftText})`)
  }

  const fciText = (capitalPlan.fci ?? [])
    .filter((window) => window.percent != null)
    .map((window) => {
      const grade = window.grade ? ` (${window.grade})` : ''
      return `${window.offsetFrom}–${window.offsetTo} yr ${formatPercent(window.percent)}${grade}`
    })
    .join('; ')
  if (fciText) {
    lines.push(`- Facility Condition Index by window: ${fciText}`)
  }

  const termText = (capitalPlan.terms ?? [])
    .filter((term) => term.total > 0)
    .map((term) => {
      const years = term.yearFrom === term.yearTo ? `${term.yearFrom}` : `${term.yearFrom}–${term.yearTo}`
      return `${term.label} (${years}) ${formatMoney(term.total)}`
    })
    .join('; ')
  if (termText) {
    lines.push(`- Building capital plan by term: ${termText}`)
  }

  const scheduled = formatMoney(capitalPlan.totals?.scheduled)
  if (scheduled) {
    const unscheduled = Number(capitalPlan.totals?.unscheduled)
    const unscheduledText =
      Number.isFinite(unscheduled) && unscheduled > 0
        ? `; a further ${formatMoney(unscheduled)} is unscheduled (no action year could be derived)`
        : ''
    lines.push(`- Total scheduled 25-year renewal: ${scheduled}${unscheduledText}`)
  }

  return lines
}

/**
 * Severity ordering for detail-line selection: priority, then condition, then
 * cost, then how overdue the asset is.
 * @param {Array<object>} assets
 * @param {Map<number, object>} planByAssetId
 * @returns {Array<object>} new sorted array
 */
function rankAssetsBySeverity(assets, planByAssetId = new Map()) {
  const priorityRank = (asset) =>
    PRIORITY_RANK.get(
      String(asset?.priority ?? '')
        .trim()
        .toLowerCase(),
    ) ?? UNRANKED_PRIORITY
  const severity = (asset) => conditionScore(asset?.condition_rating) ?? 0
  const cost = (asset) =>
    Number(
      planByAssetId.get(asset?.id)?.opinionOfProbableCost ??
        asset?.opinion_of_probable_cost ??
        0,
    ) || 0
  const remaining = (asset) => {
    const value = Number(planByAssetId.get(asset?.id)?.remainingLife)
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
  }

  return [...(assets ?? [])].sort(
    (a, b) =>
      priorityRank(a) - priorityRank(b) ||
      severity(b) - severity(a) ||
      cost(b) - cost(a) ||
      remaining(a) - remaining(b),
  )
}

/**
 * Cost ordering for detail-line selection (capital-focused sections).
 * @param {Array<object>} assets
 * @param {Map<number, object>} planByAssetId
 * @returns {Array<object>} new sorted array
 */
function rankAssetsByCost(assets, planByAssetId = new Map()) {
  const cost = (asset) =>
    Number(
      planByAssetId.get(asset?.id)?.opinionOfProbableCost ??
        asset?.opinion_of_probable_cost ??
        0,
    ) || 0
  return [...(assets ?? [])].sort((a, b) => cost(b) - cost(a))
}

module.exports = {
  CONDITION_ORDER,
  SCORED_CONDITION_LABELS,
  ACTION_ORDER,
  PRIORITY_ORDER,
  TERM_ORDER,
  conditionScore,
  conditionBandLabel,
  formatMoney,
  formatPercent,
  histogram,
  formatHistogram,
  planIndex,
  resolveStartYear,
  termTotalsForAssets,
  termLabelForYear,
  summarizeAssets,
  formatRollupLines,
  formatCapitalPositionLines,
  rankAssetsBySeverity,
  rankAssetsByCost,
}
