const fs = require('node:fs')

const { readDataFileText } = require('../data-files')

let cachedRules = null

/**
 * The default rules are read through `src/data-files.js`, never a hardcoded
 * checkout path. Tests can pass an explicit `rulesPath` to read a fixture from
 * disk instead.
 */
function loadCapitalPlanningRules(rulesPath = null) {
  if (rulesPath == null) {
    if (!cachedRules) {
      cachedRules = JSON.parse(readDataFileText('data/capital_planning_rules.json'))
    }
    return cachedRules
  }
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
}

function roundToPlaces(value, places) {
  if (!Number.isFinite(value)) return null
  if (places >= 0) {
    const factor = 10 ** places
    return Math.round(value * factor) / factor
  }
  const factor = 10 ** Math.abs(places)
  return Math.round(value / factor) * factor
}

function parseMoney(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const text = String(value).trim()
  if (!text) return null
  if (/[a-zA-Z]| to |–|—/i.test(text)) return null
  const cleaned = text.replace(/[^0-9.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function parseOptionalNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assessmentYearFromDate(dateOfAssessment, fallbackYear = new Date().getFullYear()) {
  if (!dateOfAssessment) return fallbackYear
  const match = String(dateOfAssessment).match(/^(\d{4})/)
  if (match) return Number(match[1])
  const parsed = new Date(dateOfAssessment)
  if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear()
  return fallbackYear
}

function adjustUnitCost(referenceCost, locationFactor, rules) {
  if (!Number.isFinite(referenceCost) || !Number.isFinite(locationFactor)) return null
  const adjusted = referenceCost * locationFactor
  for (const band of rules.unit_cost_rounding) {
    if (band.max_exclusive == null || referenceCost < band.max_exclusive) {
      return roundToPlaces(adjusted, band.places)
    }
  }
  return roundToPlaces(adjusted, -2)
}

function roundOpinionOfCost(raw) {
  if (!Number.isFinite(raw)) return null
  // OPC is Quantity × Adjusted Unit Cost in whole dollars. The adjusted unit
  // cost is already order-of-magnitude rounded (see adjustUnitCost), so this
  // product is a clean figure. The reference workbook additionally rounded OPC
  // to the nearest $100/$1000, but that destroyed small values — 1 × $130
  // became $100 — which the client reported as a defect. OPC now equals the
  // product exactly. See docs/workbook-calculation-reference.md §8.
  return roundToPlaces(raw, 0)
}

function termForOffset(offset, rules) {
  for (const term of rules.terms) {
    if (offset >= term.offset_from && offset <= term.offset_to) return term
  }
  return null
}

function assetTermValue(term) {
  if (!term?.label) return null
  return term.label === 'Immediate Term' ? 'Immediate' : term.label
}

function termForActionYear(actionYear, startYear, rules) {
  if (!Number.isFinite(actionYear) || !Number.isFinite(startYear)) return null
  const offset = Math.max(0, Math.trunc(actionYear) - Math.trunc(startYear))
  const inHorizon = termForOffset(offset, rules)
  if (inHorizon) return inHorizon
  const last = rules.terms.at(-1)
  return last && offset > last.offset_to ? last : null
}

function gradeForRatio(ratio, rules, scaleId = 'ifma') {
  if (!Number.isFinite(ratio)) return null
  const grades = rules.fci.grade_scales?.[scaleId] ?? rules.fci.grades ?? []
  for (const grade of grades) {
    if (grade.max_exclusive != null && ratio < grade.max_exclusive) {
      return grade.label
    }
    if (grade.max_inclusive == null && grade.max_exclusive == null) {
      return grade.label
    }
    if (grade.max_inclusive != null && ratio <= grade.max_inclusive) {
      return grade.label
    }
  }
  return grades.at(-1)?.label ?? null
}

function conditionGradeForRating(conditionRating, rules) {
  const value = String(conditionRating ?? '').trim().toLowerCase()
  if (!value || value === 'not applicable') return null
  const numeric = Number(value)
  const match = rules.condition_ratings?.find((rating) =>
    Number.isInteger(numeric)
      ? rating.score === numeric
      : [rating.stored_value, rating.legacy_label, rating.display]
          .some((candidate) => String(candidate ?? '').toLowerCase() === value),
  )
  return match?.display ?? null
}

function isSuppressed(asset, rules) {
  // Suppression (an asset that funds no scheduled work) is driven only by the
  // Action Type — e.g. "No Action". Term is derived from the action year and is
  // never a manual input, so it can no longer mark an asset not-actionable.
  const action = String(asset.action ?? '').trim()
  return rules.suppressed_actions.includes(action)
}

function resolveLocationFactor(building) {
  const custom = parseOptionalNumber(building?.location_factor)
  if (custom != null && custom > 0) return custom
  return 1
}

function calculateAssetPlan(asset, options, rules) {
  const startYear = options.startYear
  const warnings = []
  const quantity = parseOptionalNumber(asset.quantity)
  const lifeAdjustment = parseOptionalNumber(asset.life_adjustment_years) ?? 0
  const allowanceInterval = parseOptionalNumber(asset.allowance_interval_years)
  const unitCostOverride = parseMoney(asset.unit_cost_override)
  const opcOverride = parseMoney(asset.opinion_of_probable_cost)
  const actionYearOverride = parseOptionalNumber(asset.action_year)
  const assetVintage = parseOptionalNumber(asset.vintage)
  const buildingVintage = parseOptionalNumber(options.buildingVintage)
  const vintage = assetVintage ?? buildingVintage
  const vintageSource =
    assetVintage != null ? 'asset' : buildingVintage != null ? 'building' : null
  const serviceLife =
    parseOptionalNumber(asset.service_life) ??
    parseOptionalNumber(asset.mean_service_life) ??
    parseOptionalNumber(asset.practical_life)
  const serviceLifeSource =
    parseOptionalNumber(asset.service_life) != null
      ? 'asset_value'
      : parseOptionalNumber(asset.mean_service_life) != null
        ? 'catalogue_mean'
        : parseOptionalNumber(asset.practical_life) != null
          ? 'catalogue_practical'
          : null
  const catalogueUnitPrice = parseMoney(asset.unit_price)
  const locationFactor = options.locationFactor

  let referenceUnitCost = unitCostOverride
  let unitCostSource = unitCostOverride != null ? 'override' : null
  if (referenceUnitCost == null) {
    if (catalogueUnitPrice == null) {
      if (asset.unit_price) {
        warnings.push('non_numeric_unit_price')
      } else {
        warnings.push('missing_unit_price')
      }
    } else {
      referenceUnitCost = catalogueUnitPrice
      unitCostSource = 'catalogue'
    }
  }

  const adjustedUnitCost =
    referenceUnitCost == null ? null : adjustUnitCost(referenceUnitCost, locationFactor, rules)

  let opinionOfProbableCost = null
  let opcSource = null
  if (opcOverride != null) {
    opinionOfProbableCost = roundOpinionOfCost(opcOverride)
    opcSource = 'override'
  } else if (quantity == null) {
    warnings.push('missing_quantity')
  } else if (adjustedUnitCost == null) {
    warnings.push('cannot_compute_opc')
  } else {
    opinionOfProbableCost = roundOpinionOfCost(quantity * adjustedUnitCost)
    opcSource = 'calculated'
  }

  let age = null
  let remainingLife = null
  let derivedActionYear = null
  if (vintage != null && serviceLife != null) {
    age = startYear - vintage
    remainingLife = serviceLife - age + lifeAdjustment
    derivedActionYear = startYear + remainingLife
  } else {
    warnings.push('missing_life_inputs')
  }

  let actionYear = actionYearOverride
  let actionYearSource = actionYearOverride != null ? 'override' : null
  if (actionYear == null && derivedActionYear != null) {
    actionYear = derivedActionYear
    actionYearSource = 'derived'
  }

  const recurrenceInterval = allowanceInterval ?? serviceLife
  const recurrenceIntervalSource =
    allowanceInterval != null ? 'allowance_override' : serviceLife != null ? serviceLifeSource : null
  // The scheduled year is the one the report recommends. An action year that has
  // already passed is not a recommendation — the lifecycle event it describes is
  // simply due, so it lands on the assessment year and is flagged overdue.
  // Printing the raw 1990 as "the recommended action year" is what the client
  // rejected; see docs/capital-planning.md.
  const scheduledActionYear =
    actionYear == null || !Number.isFinite(actionYear)
      ? null
      : Math.max(startYear, Math.trunc(actionYear))
  const actionYearIsOverdue =
    actionYear != null && Number.isFinite(actionYear) && Math.trunc(actionYear) < startYear
  const overdueByYears = actionYearIsOverdue ? startYear - Math.trunc(actionYear) : null
  const derivedTerm = assetTermValue(
    termForActionYear(scheduledActionYear, startYear, rules),
  )
  if (actionYearIsOverdue) warnings.push('overdue_moved_to_assessment_year')
  const conditionGrade = conditionGradeForRating(asset.condition_rating, rules)
  const suppressed = isSuppressed(asset, rules)
  if (suppressed) {
    warnings.push('suppressed_action')
  }
  // Term is always derived from the effective (scheduled) action year — never a
  // stored value — so the asset's displayed term, its annual reserve placement,
  // and the term totals always describe the same scheduled event. A suppressed
  // asset funds no window, so it claims no term.
  const effectiveTerm = suppressed ? null : derivedTerm
  const termSource = effectiveTerm == null ? null : 'derived'

  const events = []
  if (!suppressed && opinionOfProbableCost != null && opinionOfProbableCost > 0) {
    if (actionYear == null || !Number.isFinite(actionYear)) {
      warnings.push('unscheduled')
    } else {
      const firstYear = scheduledActionYear
      const endYear = startYear + rules.horizon.offsets.at(-1)
      // Intervals below 1 year truncate to 0 and would infinite-loop; treat as one-shot.
      const interval =
        recurrenceInterval != null && recurrenceInterval >= 1
          ? Math.trunc(recurrenceInterval)
          : null

      if (interval == null) {
        if (firstYear > endYear) {
          warnings.push('out_of_horizon')
        } else {
          events.push({
            year: firstYear,
            amount: opinionOfProbableCost,
            kind: 'initial',
            offset: firstYear - startYear,
          })
        }
      } else {
        let occurrence = 0
        for (let year = firstYear; year <= endYear; year += interval) {
          events.push({
            year,
            amount: opinionOfProbableCost,
            kind: occurrence === 0 ? 'initial' : 'renewal',
            offset: year - startYear,
          })
          occurrence += 1
        }
        if (events.length === 0) warnings.push('out_of_horizon')
      }
    }
  }

  // Replacement value for CRV uses full OPC even when action is suppressed/maintain.
  const replacementValue =
    opinionOfProbableCost != null && opinionOfProbableCost > 0 ? opinionOfProbableCost : 0

  return {
    assetId: asset.id,
    assetName: asset.asset_name ?? null,
    level1Code: asset.level_1_code ?? null,
    level1Group: asset.level_1_group ?? 'Unclassified',
    level2Code: asset.level_2_code ?? null,
    level2Group: asset.level_2_code
      ? `${asset.level_2_code} ${asset.level_2_description ?? ''}`.trim()
      : 'Unclassified',
    quantity,
    unitMeasure: asset.unit_measure ?? asset.unit_of_measure ?? null,
    catalogueUnitPrice,
    catalogueUnitPriceText: asset.unit_price ?? null,
    referenceUnitCost,
    adjustedUnitCost,
    unitCostSource,
    locationFactor,
    opinionOfProbableCost,
    opcSource,
    vintage,
    vintageSource,
    age,
    serviceLife,
    serviceLifeSource,
    remainingLife,
    estimatedReplacementYear: derivedActionYear,
    actionYear,
    scheduledActionYear,
    actionYearIsOverdue,
    overdueByYears,
    actionYearSource,
    recurrenceInterval,
    recurrenceIntervalSource,
    derivedTerm,
    effectiveTerm,
    termSource,
    conditionGrade,
    replacementValue,
    suppressed,
    warnings,
    events,
  }
}

function emptyYearMap(startYear, rules) {
  const map = new Map()
  for (const offset of rules.horizon.offsets) {
    map.set(startYear + offset, 0)
  }
  return map
}

function calculateCapitalPlan({ assets = [], building = {}, rulesPath } = {}) {
  const rules = loadCapitalPlanningRules(rulesPath)
  const startYear = assessmentYearFromDate(building.date_of_assessment)
  const locationFactor = resolveLocationFactor(building)
  const assetPlans = assets.map((asset) =>
    calculateAssetPlan(
      asset,
      {
        startYear,
        locationFactor,
        buildingVintage: building.property_vintage,
      },
      rules,
    ),
  )

  const byYear = emptyYearMap(startYear, rules)
  const events = []
  const exceptions = []
  let scheduledTotal = 0
  let unscheduledTotal = 0
  let replacementBase = 0

  for (const plan of assetPlans) {
    replacementBase += plan.replacementValue
    for (const warning of plan.warnings) {
      exceptions.push({
        assetId: plan.assetId,
        assetName: plan.assetName,
        code: warning,
      })
    }
    if (plan.warnings.includes('unscheduled') && plan.opinionOfProbableCost) {
      unscheduledTotal += plan.opinionOfProbableCost
    }
    for (const event of plan.events) {
      events.push({
        assetId: plan.assetId,
        assetName: plan.assetName,
        level1Group: plan.level1Group,
        level2Code: plan.level2Code,
        year: event.year,
        amount: event.amount,
        kind: event.kind,
        offset: event.offset,
        termId: termForOffset(event.offset, rules)?.id ?? null,
        termLabel: termForOffset(event.offset, rules)?.label ?? null,
      })
      if (byYear.has(event.year)) {
        byYear.set(event.year, byYear.get(event.year) + event.amount)
        scheduledTotal += event.amount
      }
    }
  }

  const years = [...byYear.entries()].map(([year, total]) => ({
    year,
    offset: year - startYear,
    total,
  }))

  const terms = rules.terms.map((term) => {
    const total = years
      .filter((row) => row.offset >= term.offset_from && row.offset <= term.offset_to)
      .reduce((sum, row) => sum + row.total, 0)
    return {
      id: term.id,
      label: term.label,
      offsetFrom: term.offset_from,
      offsetTo: term.offset_to,
      yearFrom: startYear + term.offset_from,
      yearTo: startYear + term.offset_to,
      total,
    }
  })

  const groupMap = new Map()
  for (const plan of assetPlans) {
    if (!groupMap.has(plan.level1Group)) {
      groupMap.set(plan.level1Group, {
        name: plan.level1Group,
        code: plan.level1Code,
        byTerm: Object.fromEntries(rules.terms.map((term) => [term.id, 0])),
        total: 0,
      })
    }
    const group = groupMap.get(plan.level1Group)
    for (const event of plan.events) {
      const term = termForOffset(event.offset, rules)
      if (!term) continue
      group.byTerm[term.id] += event.amount
      group.total += event.amount
    }
  }
  const groups = [...groupMap.values()]

  const upliftFactors = rules.crv_uplift.factors.map((factor) => ({
    name: factor.name,
    percent: factor.percent,
  }))
  const derivedCrv = roundToPlaces(replacementBase * rules.crv_uplift.multiplier, 0)
  const crvOverride = parseMoney(building.current_replacement_value)
  const currentReplacementValue = crvOverride != null ? crvOverride : derivedCrv
  const crvSource = crvOverride != null ? 'override' : 'derived'

  const level2Map = new Map()
  for (const plan of assetPlans) {
    const key = plan.level2Code || 'Unclassified'
    if (!level2Map.has(key)) {
      level2Map.set(key, {
        code: plan.level2Code,
        label: plan.level2Group,
        base: 0,
      })
    }
    level2Map.get(key).base += plan.replacementValue
  }
  const level2Crv = [...level2Map.values()]
    .map((row) => ({
      ...row,
      crv: roundToPlaces(row.base * rules.crv_uplift.multiplier, 0),
    }))
    .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')))

  // One consistent grade table across the current window and every projected
  // window (client requirement). The workbook graded its displayed 0–5 window
  // on a separate revised 3-band scale, but that made an FCI of e.g. 53.8%
  // "Poor" in one column and "Critical" in the others. The app applies the
  // IFMA scale (Critical > 30%) — the scale the report itself states — to all
  // four windows. The revised scale remains recorded in the rules as the
  // workbook source. See docs/workbook-calculation-reference.md §8.
  const FCI_GRADE_SCALE = 'ifma'
  const fci = rules.fci.windows.map((window) => {
    const numerator = years
      .filter((row) => row.offset >= window.offset_from && row.offset <= window.offset_to)
      .reduce((sum, row) => sum + row.total, 0)
    const ratio =
      currentReplacementValue > 0 ? numerator / currentReplacementValue : null
    return {
      id: window.id,
      label: window.label,
      offsetFrom: window.offset_from,
      offsetTo: window.offset_to,
      numerator,
      denominator: currentReplacementValue,
      ratio,
      percent: ratio == null ? null : ratio * 100,
      gradeScale: FCI_GRADE_SCALE,
      grade: gradeForRatio(ratio, rules, FCI_GRADE_SCALE),
      unavailableReason:
        currentReplacementValue > 0 ? null : 'Current replacement value is missing or zero.',
    }
  })

  return {
    startYear,
    endYear: startYear + rules.horizon.offsets.at(-1),
    locationFactor,
    rules,
    assets: assetPlans,
    events,
    years,
    terms,
    groups,
    exceptions,
    totals: {
      scheduled: scheduledTotal,
      unscheduled: unscheduledTotal,
      replacementBase,
    },
    crv: {
      source: crvSource,
      base: replacementBase,
      upliftPercent: rules.crv_uplift.uplift_percent,
      multiplier: rules.crv_uplift.multiplier,
      factors: upliftFactors,
      derived: derivedCrv,
      override: crvOverride,
      value: currentReplacementValue,
      level2: level2Crv,
    },
    fci,
  }
}

module.exports = {
  loadCapitalPlanningRules,
  roundToPlaces,
  parseMoney,
  parseOptionalNumber,
  assessmentYearFromDate,
  resolveLocationFactor,
  adjustUnitCost,
  roundOpinionOfCost,
  termForOffset,
  termForActionYear,
  gradeForRatio,
  conditionGradeForRating,
  calculateAssetPlan,
  calculateCapitalPlan,
}
