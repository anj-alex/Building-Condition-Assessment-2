// Wrapped in an IIFE so nothing leaks into the renderer's global scope. Loaded as a
// classic <script>, top-level declarations here would otherwise collide with same-named
// declarations in property-report.js and break parsing of the whole file.
;(function () {
const CAPITAL_LEVEL1_GROUPS = Object.freeze([
  ['A', 'A Substructure'],
  ['B', 'B Shell'],
  ['C', 'C Interior'],
  ['D', 'D Service'],
  ['E', 'E Equipment'],
  ['F', 'F Special Construction'],
  ['G', 'G Building Sitework'],
])

// Match the reference workbook order, including D50 before D40.
const CRV_LEVEL2_ROWS = Object.freeze([
  ['A10', 'Foundations'],
  ['A20', 'Basement construction'],
  ['B10', 'Superstructure'],
  ['B20', 'Exterior Enclosure'],
  ['B30', 'Roofing'],
  ['C10', 'Interior Construction'],
  ['C20', 'Stairs'],
  ['C30', 'Interior Finishes'],
  ['C33', 'Accessibility'],
  ['D10', 'Conveying'],
  ['D20', 'Plumbing'],
  ['D30', 'HVAC'],
  ['D50', 'Electrical'],
  ['D40', 'Fire Protection'],
  ['E10', 'Equipment'],
  ['E20', 'Furnishings'],
  ['F10', 'Special Construction'],
  ['F20', 'Selective Building Demolition'],
  ['G20', 'Site Improvements'],
  ['G30', 'Site Civil/Mechanical Utilities'],
  ['G40', 'Site Electrical Utilities'],
  ['G90', 'Other Site Construction'],
])

function capitalLevel1Rows(groups = []) {
  const groupsByCode = new Map(groups.map((group) => [group.code, group]))
  const rows = CAPITAL_LEVEL1_GROUPS.map(([code, name]) => ({
    ...(groupsByCode.get(code) ?? {}),
    code,
    // The report wording is controlled by the reference taxonomy, not DB labels.
    name,
    byTerm: groupsByCode.get(code)?.byTerm ?? {},
  }))
  const knownCodes = new Set(CAPITAL_LEVEL1_GROUPS.map(([code]) => code))
  for (const group of groups) {
    if (!knownCodes.has(group.code)) rows.push(group)
  }
  return rows
}

function displayCrvRows(crv) {
  const level2ByCode = new Map((crv?.level2 ?? []).map((row) => [row.code, row]))
  const rows = CRV_LEVEL2_ROWS.map(([code, label]) => ({
    code,
    label,
    crv: level2ByCode.get(code)?.crv ?? 0,
  }))
  const knownLevel2Codes = new Set(CRV_LEVEL2_ROWS.map(([code]) => code))
  for (const row of crv?.level2 ?? []) {
    if (!knownLevel2Codes.has(row.code)) rows.push(row)
  }
  return rows
}

/**
 * The construction year to print for this component.
 *
 * Only a vintage the assessor (or the imported workbook) actually supplied is
 * shown as a bare year. When the capital engine had none and fell back to the
 * building's year built to schedule the asset, the fallback is labelled rather
 * than printed as though it were a finding — the client saw "1980" on every page
 * of a report where nobody had entered a vintage at all.
 */
function displayVintage(asset) {
  if (asset.vintage != null && String(asset.vintage).trim() !== '') return asset.vintage
  const capital = asset.capital
  if (capital?.vintageSource === 'building' && capital.vintage != null) {
    return `${capital.vintage} (building year built)`
  }
  return null
}

/**
 * The action year to print for this component.
 *
 * A lifecycle date that has already passed is not a recommendation. The engine
 * schedules that work in the assessment year; the page says so, and names the
 * date it slipped from, instead of printing an expired 1990 as the current
 * recommended action year.
 */
function displayActionYear(capital, asset) {
  const scheduled = capital?.scheduledActionYear
  if (scheduled == null) return capital?.actionYear ?? asset.action_year
  if (!capital?.actionYearIsOverdue) return scheduled
  return `${scheduled} — overdue (lifecycle date ${capital.actionYear})`
}

// The identifier the reader uses to tie a report back to their own records.
// `site_id` is the workbook's Site ID column — the client's own property
// number, and the only id that means anything outside this app. Buildings
// created by hand have none, so they fall back to the database record number,
// marked with `#` so nobody mistakes it for a Site ID.
function displayBuildingId(building) {
  const siteId = String(building?.site_id ?? '').trim()
  if (siteId) return siteId
  const id = Number(building?.id)
  return Number.isFinite(id) && id > 0 ? `#${id}` : null
}

function termDisplayLabel(term) {
  if (!term) return ''
  if (term.yearFrom == null || term.yearTo == null) return term.label || ''
  const years = term.yearFrom === term.yearTo ? String(term.yearFrom) : `${term.yearFrom}-${term.yearTo}`
  return `${term.label} (${years})`
}

function fciColumnHeadings(windows = []) {
  return windows.map((row, index) => ({
    title: index === 0 ? 'FCI Score (IFMA)' : `Projected FCI Score (${fciWindowRange(row)})`,
    score: 'FCI Score',
    grade: 'FCI Grade',
  }))
}

function fciWindowRange(row) {
  if (!row || row.offsetFrom == null || row.offsetTo == null) return row?.label || ''
  return `${row.offsetFrom}-${row.offsetTo} years`
}

/**
 * Assets grouped by UNIFORMAT Level 1, in the order the report prints them:
 * groups A-G with Unclassified last, then Level 2 code, then asset name.
 *
 * Both renderers and the Component Summary read it, so the summary rows index
 * the asset pages in the order those pages actually appear.
 */
function orderedAssetGroups(assets = []) {
  const groups = new Map()
  for (const asset of assets) {
    const key = String(asset.level_1_group ?? '').trim() || 'Unclassified'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(asset)
  }
  const byLevel2 = (a, b) =>
    String(a.level_2_code ?? '').localeCompare(String(b.level_2_code ?? '')) ||
    String(a.asset_name ?? '').localeCompare(String(b.asset_name ?? ''))
  return new Map(
    [...groups.entries()]
      .map(([key, list]) => [key, list.slice().sort(byLevel2)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
}

/**
 * The action year in a one-line summary cell.
 *
 * The asset page spells out the lifecycle date an overdue item slipped from
 * (`displayActionYear`); a column in a seven-wide grid has no room for it, so
 * the summary flags the year as overdue rather than explaining it.
 */
function summaryActionYear(capital, asset) {
  const scheduled = capital?.scheduledActionYear
  if (scheduled == null) return capital?.actionYear ?? asset?.action_year ?? null
  return capital?.actionYearIsOverdue ? `${scheduled} (overdue)` : scheduled
}

/**
 * One row per included component for the Component Summary.
 *
 * The capital table above it answers "what does this facility need, by system";
 * this answers "which components, and what does each cost" without paging
 * through every asset block in the findings section. Values are the same ones
 * those blocks print, so the two cannot disagree.
 *
 * An asset carried into the report as Not Assessed has no findings to
 * summarize: it is listed for completeness with its condition column saying so,
 * and contributes nothing to the total, exactly as it contributes nothing to
 * the capital plan.
 */
function componentSummaryRows(assets = []) {
  const rows = []
  for (const [system, groupAssets] of orderedAssetGroups(assets)) {
    for (const asset of groupAssets) {
      const assessed = asset.assessed !== false
      const capital = asset.capital ?? {}
      rows.push({
        name: asset.asset_name ?? null,
        system,
        condition: assessed ? (asset.condition_rating ?? null) : 'Not Assessed',
        priority: assessed ? (asset.priority ?? null) : null,
        action: assessed ? (asset.action ?? null) : null,
        year: assessed ? summaryActionYear(capital, asset) : null,
        cost: assessed ? (capital.opinionOfProbableCost ?? null) : null,
        assessed,
      })
    }
  }
  return rows
}

/**
 * The last plan offset counted as near-term work.
 *
 * Five years is the window the scorecard reports on, and it is the same window
 * the plan's own `0-5 years` FCI covers, so the two agree by construction.
 */
const NEAR_TERM_LAST_OFFSET = 5

/**
 * The six-point condition scale collapsed to the three bands an owner acts on:
 * what is sound, what to watch, and what needs money.
 */
const CONDITION_BANDS = Object.freeze([
  { id: 'sound', label: 'Very Good / Good', from: 1, to: 2 },
  { id: 'fair', label: 'Fair', from: 3, to: 3 },
  { id: 'poor', label: 'Poor / Critical', from: 4, to: 6 },
])

/**
 * The 1-6 score for a stored condition rating, or null when it is blank or
 * unrecognised.
 *
 * This mirrors `conditionScore` in report-validation.js. The duplication is
 * deliberate: that module is the pre-export review's and pulling it in here
 * would give this file its first cross-module dependency. What stops the two
 * drifting is a test — test/facility-scorecard.test.js walks the whole scale,
 * every label spelling included, and fails if they ever disagree.
 */
function scorecardConditionScore(conditionRating, rules) {
  const value = String(conditionRating ?? '').trim().toLowerCase()
  if (!value) return null
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 6) return numeric
  const match = (rules?.condition_ratings ?? []).find((rating) =>
    [rating.stored_value, rating.legacy_label, rating.display, rating.revised_label].some(
      (candidate) => String(candidate ?? '').toLowerCase() === value,
    ),
  )
  return match?.score ?? null
}

/**
 * The one-page management view of a facility.
 *
 * Every figure is read from the capital plan the rest of the report already
 * prints, so the scorecard summarises those pages rather than recomputing them
 * and cannot disagree with them.
 *
 * The near-term need is summed from the plan's own year totals rather than by
 * naming terms, so retuning the term bands cannot silently change what "0-5
 * years" means here; the component count and the priority rows below are drawn
 * from the same window, so all three reconcile with each other.
 *
 * Assets carried into the report as Not Assessed are excluded throughout: they
 * contribute no cost to the capital plan and have no condition to band, exactly
 * as in the Component Summary.
 */
function facilityScorecard(report, { priorityLimit = 5 } = {}) {
  const plan = report?.capitalPlan ?? {}
  const assets = (report?.assets ?? []).filter((asset) => asset?.assessed !== false)
  const inWindow = (event) => {
    const offset = Number(event?.offset)
    return Number.isFinite(offset) && offset >= 0 && offset <= NEAR_TERM_LAST_OFFSET
  }

  const nearTermNeed = (plan.years ?? [])
    .filter(inWindow)
    .reduce((sum, row) => sum + (Number(row.total) || 0), 0)

  const priorities = []
  for (const asset of assets) {
    const events = (asset.capital?.events ?? []).filter(inWindow)
    if (events.length === 0) continue
    priorities.push({
      name: asset.asset_name ?? null,
      // The bare Level 2 code, not the spelled-out group: the scorecard's grid
      // has five columns on a portrait page, and a wrapping classification
      // column is what pushes the card past the one page it promises to be.
      element: asset.level_2_code || asset.level_2_group_element || null,
      condition: asset.condition_rating ?? null,
      horizon: asset.capital?.effectiveTerm ?? null,
      year: summaryActionYear(asset.capital, asset),
      // The occurrences scheduled inside the window, not the component's whole
      // life-cycle cost, so these rows add up to a share of the need above.
      cost: events.reduce((sum, event) => sum + (Number(event.amount) || 0), 0),
    })
  }
  priorities.sort(
    (a, b) => b.cost - a.cost || String(a.name ?? '').localeCompare(String(b.name ?? '')),
  )

  const bands = CONDITION_BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    count: 0,
    percent: null,
  }))
  let rated = 0
  for (const asset of assets) {
    const score = scorecardConditionScore(asset.condition_rating, plan.rules)
    const index = CONDITION_BANDS.findIndex((band) => score >= band.from && score <= band.to)
    if (score == null || index < 0) continue
    bands[index].count += 1
    rated += 1
  }
  for (const band of bands) band.percent = rated > 0 ? (band.count / rated) * 100 : null

  const current = (plan.fci ?? [])[0] ?? null
  return {
    fci: current,
    grade: current?.grade ?? null,
    crv: plan.crv?.value ?? null,
    nearTermNeed,
    nearTermCount: priorities.length,
    priorities: priorities.slice(0, priorityLimit),
    conditionBands: bands,
    ratedCount: rated,
    assessedCount: assets.length,
  }
}

/** The summary's own total, so the grid adds up to what it prints. */
function componentSummaryTotal(rows = []) {
  return rows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0)
}

const propertyReportRules = {
  CAPITAL_LEVEL1_GROUPS,
  CRV_LEVEL2_ROWS,
  capitalLevel1Rows,
  componentSummaryRows,
  componentSummaryTotal,
  facilityScorecard,
  scorecardConditionScore,
  CONDITION_BANDS,
  NEAR_TERM_LAST_OFFSET,
  displayCrvRows,
  displayVintage,
  displayActionYear,
  displayBuildingId,
  orderedAssetGroups,
  summaryActionYear,
  termDisplayLabel,
  fciColumnHeadings,
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = propertyReportRules
} else if (typeof window !== 'undefined') {
  window.propertyReportRules = propertyReportRules
}
})()
