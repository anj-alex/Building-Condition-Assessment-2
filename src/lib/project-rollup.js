// Aggregate several buildings' capital plans into one project-level plan with
// the same shape (terms, groups, years, crv, fci) so the consolidated report
// can render a project total using the same renderers as a single building.
//
// The portfolio uses one absolute calendar horizon beginning with its earliest
// assessment year. Every event is re-bucketed into that horizon; summing each
// building's relative "Immediate" column would mislabel a 2028 assessment as
// portfolio-Immediate when the portfolio starts in 2026.
//
// Wrapped in an IIFE (publishes `window.projectRollup`) while `module.exports`
// serves tests. See docs/property-report.md.
;(function () {
  function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  // Mirror of capital-planning's IFMA grading, reading bands from the rules that
  // each building plan already carries.
  function gradeForRatioIfma(ratio, rules) {
    if (ratio == null || !Number.isFinite(ratio)) return null
    const grades = rules?.fci?.grade_scales?.ifma ?? []
    for (const grade of grades) {
      if (grade.max_inclusive == null && grade.max_exclusive == null) return grade.label
      if (grade.max_exclusive != null && ratio < grade.max_exclusive) return grade.label
      if (grade.max_inclusive != null && ratio <= grade.max_inclusive) return grade.label
    }
    return grades.at(-1)?.label ?? null
  }

  function aggregateProjectPlan(plans = [], rulesArg = null) {
    const active = plans.filter(Boolean)
    const rules = rulesArg ?? active.find((plan) => plan.rules)?.rules ?? null
    const startYears = active.map((plan) => num(plan.startYear)).filter(Boolean)
    const startYear = startYears.length > 0 ? Math.min(...startYears) : null
    const base =
      active.slice().sort((a, b) => num(a.startYear) - num(b.startYear))[0] ?? {}
    const offsets = rules?.horizon?.offsets ?? (base.years ?? []).map((row) => row.offset)
    const endOffset = offsets.length > 0 ? Math.max(...offsets.map(num)) : 0
    const endYear = startYear == null ? null : startYear + endOffset

    // Rebuild the event stream by absolute year, clipped to the one portfolio
    // horizon. This is the source for terms, groups, years, FCI and scheduled
    // total below, so all five views reconcile.
    const events = active
      .flatMap((plan) => plan.events ?? [])
      .filter(
        (event) =>
          startYear != null &&
          Number.isFinite(Number(event.year)) &&
          Number(event.year) >= startYear &&
          Number(event.year) <= endYear,
      )
      .map((event) => ({
        ...event,
        year: Number(event.year),
        amount: num(event.amount),
        offset: Number(event.year) - startYear,
      }))

    const termDefinitions = rules?.terms ?? (base.terms ?? []).map((term) => ({
      id: term.id,
      label: term.label,
      offset_from: term.offsetFrom,
      offset_to: term.offsetTo,
    }))
    const terms = termDefinitions.map((term) => {
      const offsetFrom = num(term.offset_from)
      const offsetTo = num(term.offset_to)
      return {
        id: term.id,
        label: term.label,
        offsetFrom,
        offsetTo,
        yearFrom: startYear == null ? null : startYear + offsetFrom,
        yearTo: startYear == null ? null : startYear + offsetTo,
        total: events
          .filter((event) => event.offset >= offsetFrom && event.offset <= offsetTo)
          .reduce((sum, event) => sum + event.amount, 0),
      }
    })

    const termForOffset = (offset) =>
      terms.find((term) => offset >= term.offsetFrom && offset <= term.offsetTo) ?? null

    // Groups (Building System A–G), re-bucketed from those same events.
    const groupMetadata = new Map()
    for (const plan of active) {
      for (const group of plan.groups ?? []) {
        groupMetadata.set(group.name, { name: group.name, code: group.code })
      }
    }
    const groupMap = new Map()
    for (const event of events) {
      const metadata = groupMetadata.get(event.level1Group) ?? {
        name: event.level1Group ?? 'Unclassified',
        code: null,
      }
      const key = metadata.code ?? metadata.name
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          ...metadata,
          byTerm: Object.fromEntries(terms.map((term) => [term.id, 0])),
          total: 0,
        })
      }
      const target = groupMap.get(key)
      const term = termForOffset(event.offset)
      if (!term) continue
      target.byTerm[term.id] += event.amount
      target.total += event.amount
    }

    // Annual forecast: include zero years so it has the same stable 0–25 shape
    // as a building plan.
    const yearMap = new Map()
    if (startYear != null) {
      for (const offset of offsets) yearMap.set(startYear + num(offset), 0)
    }
    for (const event of events) {
      yearMap.set(event.year, num(yearMap.get(event.year)) + event.amount)
    }
    const years = [...yearMap.entries()]
      .map(([year, total]) => ({ year, offset: year - startYear, total }))
      .sort((a, b) => a.year - b.year)

    // CRV: sum of building replacement values.
    const crvValue = active.reduce((sum, plan) => sum + num(plan.crv?.value), 0)
    const crvBase = active.reduce((sum, plan) => sum + num(plan.crv?.base), 0)

    // FCI windows use portfolio offsets too; a later building's relative 0–2
    // numerator is not blindly added to an earlier portfolio 0–2 window.
    const fciDefinitions = rules?.fci?.windows ?? (base.fci ?? []).map((window) => ({
      id: window.id,
      label: window.label,
      offset_from: window.offsetFrom,
      offset_to: window.offsetTo,
    }))
    const fci = fciDefinitions.map((definition) => {
      const window = {
        id: definition.id,
        label: definition.label,
        offsetFrom: num(definition.offset_from),
        offsetTo: num(definition.offset_to),
      }
      const numerator = years
        .filter(
          (row) => row.offset >= window.offsetFrom && row.offset <= window.offsetTo,
        )
        .reduce((sum, row) => sum + row.total, 0)
      const ratio = crvValue > 0 ? numerator / crvValue : null
      return {
        ...window,
        numerator,
        denominator: crvValue,
        ratio,
        percent: ratio == null ? null : ratio * 100,
        gradeScale: 'ifma',
        grade: gradeForRatioIfma(ratio, rules),
        unavailableReason: crvValue > 0 ? null : 'Current replacement value is missing or zero.',
      }
    })

    return {
      startYear,
      endYear,
      rules,
      buildingCount: active.length,
      events,
      terms,
      groups: [...groupMap.values()],
      years,
      crv: {
        source: 'aggregated',
        base: crvBase,
        value: crvValue,
        factors: base.crv?.factors ?? [],
        multiplier: base.crv?.multiplier,
        upliftPercent: base.crv?.upliftPercent,
        level2: aggregateLevel2Crv(active),
      },
      fci,
      totals: {
        scheduled: events.reduce((sum, event) => sum + event.amount, 0),
        replacementBase: crvBase,
      },
    }
  }

  function aggregateLevel2Crv(plans) {
    const map = new Map()
    for (const plan of plans) {
      for (const row of plan.crv?.level2 ?? []) {
        const key = row.code ?? row.label
        if (!map.has(key)) map.set(key, { code: row.code, label: row.label, crv: 0 })
        map.get(key).crv += num(row.crv)
      }
    }
    return [...map.values()].sort((a, b) =>
      String(a.code ?? '').localeCompare(String(b.code ?? '')),
    )
  }

  const projectRollup = { aggregateProjectPlan, gradeForRatioIfma }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = projectRollup
  } else if (typeof window !== 'undefined') {
    window.projectRollup = projectRollup
  }
})()
