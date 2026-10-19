// Pre-export quality-control checks for a building's report data. Produces a
// flat list of findings covering the client's validation requirements:
//
//   errors   — the report is not a deliverable until these are resolved, and the
//              report page keeps its Word save action disabled while any stands:
//                - missing mandatory project/facility information (client,
//                  facility name, address, gross floor area, floors, year built,
//                  assessment date)
//                - a CRV that is zero (FCI would divide by zero) or derived only
//                  from asset OPCs (the FCI would have no real denominator)
//                - duplicate asset records — two pages for one component, each
//                  counted separately in the capital totals
//   warnings — worth confirming, never blocking: contradictory condition vs.
//              action/priority/term, expired lifecycle dates now scheduled as
//              overdue, a vintage borrowed from the building, and costed actions
//              with no computable cost
//
// One shared implementation so the report page's pre-export review and any
// home-page quality-control screen show identical findings. Wrapped in an IIFE
// (publishes `window.reportValidation`) while `module.exports` serves the main
// process. See docs/property-report.md.
;(function () {
  const ERROR = 'error'
  const WARNING = 'warning'

  const REQUIRED_BUILDING_FIELDS = [
    ['property_name', 'Facility / building name'],
    ['address', 'Address'],
    ['gross_floor_area_m2', 'Gross floor area'],
    ['num_floors', 'Number of floors'],
    ['property_vintage', 'Year built'],
    ['date_of_assessment', 'Assessment date'],
  ]

  function isBlank(value) {
    return value == null || String(value).trim() === ''
  }

  function conditionScore(conditionRating, rules) {
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

  function buildingLabel(building) {
    return building?.property_name || 'This facility'
  }

  function localIsoDate(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  /**
   * @param {object} data `{ project, building, assets, capitalPlan }` — assets
   *   are the report's included assets, each with its `capital` snapshot.
   * @returns {{ findings: Array, errorCount: number, warningCount: number }}
   */
  function validateReport(data = {}) {
    const { project = {}, building = {}, assets = [], capitalPlan = {} } = data
    const now = new Date()
    const findings = []
    const add = (severity, code, message, extra = {}) =>
      findings.push({ severity, code, message, ...extra })

    // --- Required project / facility information -----------------------------
    // These are errors, not advice. A BCA deliverable without an address, an
    // assessment date, a floor area or a replacement value is not a deliverable,
    // and the client asked for it to be caught before the report is generated
    // rather than after it has been sent on. The report page blocks export while
    // any error stands; the user can still override deliberately.
    if (isBlank(project.client)) {
      add(ERROR, 'missing_project_field', 'Client name is missing.', { field: 'client' })
    }
    for (const [field, label] of REQUIRED_BUILDING_FIELDS) {
      if (isBlank(building[field])) {
        add(ERROR, 'missing_project_field', `${label} is missing.`, { field })
      }
    }

    // Presence is not validity: HTML number inputs can still be populated by
    // imported/restored data, and the autosave form deliberately permits an
    // incomplete draft. Enforce deliverable semantics at the report boundary.
    const floorArea = Number(building.gross_floor_area_m2)
    if (
      !isBlank(building.gross_floor_area_m2) &&
      (!Number.isFinite(floorArea) || floorArea <= 0)
    ) {
      add(ERROR, 'invalid_project_field', 'Gross floor area must be greater than zero.', {
        field: 'gross_floor_area_m2',
      })
    }

    const floors = Number(building.num_floors)
    if (
      !isBlank(building.num_floors) &&
      (!Number.isInteger(floors) || floors <= 0)
    ) {
      add(ERROR, 'invalid_project_field', 'Number of floors must be a positive whole number.', {
        field: 'num_floors',
      })
    }

    const locationFactor = Number(building.location_factor)
    if (
      !isBlank(building.location_factor) &&
      (!Number.isFinite(locationFactor) || locationFactor <= 0)
    ) {
      add(ERROR, 'invalid_project_field', 'Location factor must be greater than zero.', {
        field: 'location_factor',
      })
    }

    const assessmentText = String(building.date_of_assessment ?? '').trim()
    let assessmentYear = null
    if (assessmentText) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(assessmentText)
      const parsed = match ? new Date(`${assessmentText}T00:00:00.000Z`) : null
      const roundTrips =
        parsed && !Number.isNaN(parsed.getTime())
          ? parsed.toISOString().slice(0, 10) === assessmentText
          : false
      // Assessment dates are entered as local calendar dates. Comparing them
      // with UTC's date can reject today in time zones ahead of UTC or accept
      // tomorrow in time zones behind it near midnight.
      const today = localIsoDate(now)
      if (!roundTrips || assessmentText > today) {
        add(
          ERROR,
          'invalid_project_field',
          'Assessment date must be a real date that is not in the future.',
          { field: 'date_of_assessment' },
        )
      } else {
        assessmentYear = Number(match[1])
      }
    }

    const vintage = Number(building.property_vintage)
    if (!isBlank(building.property_vintage)) {
      const latestYear = assessmentYear ?? now.getFullYear()
      if (!Number.isInteger(vintage) || vintage < 1800 || vintage > latestYear) {
        add(
          ERROR,
          'invalid_project_field',
          `Year built must be a whole year from 1800 through ${latestYear}.`,
          { field: 'property_vintage' },
        )
      }
    }

    // --- CRV / FCI -----------------------------------------------------------
    const crv = capitalPlan.crv ?? {}
    const crvValue = Number(crv.value)
    if (!Number.isFinite(crvValue) || crvValue <= 0) {
      add(
        ERROR,
        'crv_zero',
        `Current Replacement Value for ${buildingLabel(building)} is zero or missing, so FCI cannot be calculated.`,
      )
    } else {
      if (crv.source === 'derived') {
        add(
          ERROR,
          'crv_derived_from_opc',
          'Current Replacement Value is derived from asset replacement costs, not a facility replacement basis. Enter a Current Replacement Value on the building so the FCI has a real denominator.',
          { field: 'current_replacement_value' },
        )
        // Derived CRV that omits costs is obviously incomplete.
        const missingCost = assets.filter(
          (asset) =>
            asset.assessed !== false &&
            asset.capital &&
            !asset.capital.suppressed &&
            asset.capital.opinionOfProbableCost == null,
        )
        if (missingCost.length > 0) {
          add(
            WARNING,
            'crv_incomplete',
            `Current Replacement Value may be understated: ${missingCost.length} assessed asset(s) have no cost estimate.`,
          )
        }
      }
    }

    // --- Per-asset checks ----------------------------------------------------
    const rules = capitalPlan.rules
    for (const asset of assets) {
      if (asset.assessed === false) continue
      const capital = asset.capital ?? {}
      const name = asset.asset_name || `Asset ${asset.id}`
      const score = conditionScore(asset.condition_rating, rules)
      const priority = String(asset.priority ?? '').trim().toLowerCase()
      const action = String(asset.action ?? '').trim().toLowerCase()
      const term = String(capital.effectiveTerm ?? '').trim().toLowerCase()

      // Contradictory condition vs. action/priority/term.
      if (score != null && score <= 2) {
        const conflicts = []
        if (priority === 'high') conflicts.push('High priority')
        if (term === 'immediate') conflicts.push('Immediate term')
        if (action === 'decommission') conflicts.push('Decommission')
        if (conflicts.length > 0) {
          add(
            WARNING,
            'condition_action_conflict',
            `${name} is in good condition but is marked ${conflicts.join(' / ')}. Confirm this is intended.`,
            { assetId: asset.id, assetName: asset.asset_name },
          )
        }
      }
      if (score != null && score >= 5 && (action === 'no action' || priority === 'low')) {
        add(
          WARNING,
          'condition_action_conflict',
          `${name} is in very poor/critical condition but is marked ${
            action === 'no action' ? 'No Action' : 'Low priority'
          }. Confirm this is intended.`,
          { assetId: asset.id, assetName: asset.asset_name },
        )
      }

      // Costed action with no computable cost (missing quantity or unit price).
      if (!capital.suppressed && capital.opinionOfProbableCost == null && !isBlank(asset.action)) {
        const reason = (capital.warnings ?? []).includes('missing_quantity')
          ? 'no quantity'
          : (capital.warnings ?? []).includes('missing_unit_price')
            ? 'no unit cost'
            : 'no cost estimate'
        add(
          WARNING,
          'missing_cost_for_action',
          `${name} has an action (${asset.action}) but ${reason}, so it carries no cost in the report.`,
          { assetId: asset.id, assetName: asset.asset_name },
        )
      }

      // An expired lifecycle date is reported as work that is already due, not
      // as a future recommendation. The report prints the assessment year and
      // marks it overdue; this says the same thing in the review list so the
      // assessor can confirm it rather than discover it in the exported report.
      if (capital.actionYearIsOverdue) {
        add(
          WARNING,
          'action_year_overdue',
          `${name} has a lifecycle date of ${capital.actionYear}, ${capital.overdueByYears} year(s) in the past. It is scheduled as overdue work in ${capital.scheduledActionYear}. Confirm the action year or the vintage.`,
          { assetId: asset.id, assetName: asset.asset_name },
        )
      }

      // A vintage the engine borrowed from the building is not this component's
      // construction year. The report labels it; flag it so it gets entered.
      if (capital.vintageSource === 'building') {
        add(
          WARNING,
          'vintage_from_building',
          `${name} has no vintage of its own, so its lifecycle is scheduled from the building's year built (${capital.vintage}).`,
          { assetId: asset.id, assetName: asset.asset_name },
        )
      }

      // Cannot be scheduled at all (no vintage/service life and no action year).
      if ((capital.warnings ?? []).includes('missing_life_inputs') && capital.actionYear == null) {
        add(
          WARNING,
          'unschedulable_asset',
          `${name} has no vintage/service life or action year, so it cannot be scheduled.`,
          { assetId: asset.id, assetName: asset.asset_name },
        )
      }
    }

    // --- Duplicate asset records --------------------------------------------
    // Two assets describing one component: two pages in the report, and both
    // counted in the capital totals. Imports can no longer create them (asset
    // rows are unique per building and import key), but a database that predates
    // that constraint still holds the ones an earlier re-import made, and
    // nothing stops a user adding the same component twice by hand.
    //
    // A shared name is NOT enough. A building legitimately has two roof areas or
    // two boilers under one Uniformat class, and flagging those would block a
    // perfectly good export — so the findings have to match as well. A real
    // duplicate is a copy: same name, same class, same measurements, same words.
    const byIdentity = new Map()
    for (const asset of assets) {
      const identity = [
        String(asset.asset_name ?? '').trim().toLowerCase(),
        String(asset.level_2_code ?? '').trim().toLowerCase(),
        String(asset.quantity ?? ''),
        String(asset.condition_rating ?? '').trim().toLowerCase(),
        String(asset.description ?? '').trim().toLowerCase(),
        String(asset.recommendation ?? '').trim().toLowerCase(),
      ].join('|')
      if (!String(asset.asset_name ?? '').trim()) continue
      if (!byIdentity.has(identity)) byIdentity.set(identity, [])
      byIdentity.get(identity).push(asset)
    }
    for (const copies of byIdentity.values()) {
      if (copies.length < 2) continue
      const first = copies[0]
      add(
        ERROR,
        'duplicate_asset',
        `${copies.length} identical assets in ${buildingLabel(building)} are named "${
          first.asset_name
        }" under ${
          first.level_2_group_element || first.level_2_code || 'the same group'
        }, with the same quantity, condition and findings. Each prints its own page and each is counted separately in the capital totals — merge or delete the extras.`,
        { assetId: first.id, assetName: first.asset_name },
      )
    }

    const errorCount = findings.filter((finding) => finding.severity === ERROR).length
    const warningCount = findings.filter((finding) => finding.severity === WARNING).length
    return { findings, errorCount, warningCount }
  }

  const reportValidation = { validateReport, conditionScore, localIsoDate, ERROR, WARNING }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = reportValidation
  } else if (typeof window !== 'undefined') {
    window.reportValidation = reportValidation
  }
})()
