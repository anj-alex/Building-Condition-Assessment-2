# Capital planning calculations

Reference data and engine that turn asset quantities, Uniformat unit prices, and building location factors into 25-year reserve projections, Current Replacement Value (CRV), and building Facility Condition Index (FCI).

For the underlying workbook cells, formulas, observed distributions, FCI
roll-up path, spreadsheet quirks, and the rationale behind deliberate
differences, see
[workbook-calculation-reference](workbook-calculation-reference.md).

## Source of truth

Deterministic extraction from `samples/Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx` via:

```bash
python3 scripts/extract-bca-reference-data.py
python3 scripts/extract-bca-reference-data.py --check
```

`npm test` runs `--check` before unit tests when Python and the sample workbook are available; otherwise it warns and continues. Use `npm run verify:data` in CI to fail hard on drift.

`--check` is read-only: it renders a fresh extraction in memory and compares SHA-256 digests to the files on disk without rewriting them.

Reference inputs and generated files under `data/`:

| File | Contents |
|---|---|
| `uniformat_pricing_supplement.csv` | Hand-maintained blank-price rows for groups the workbook prices nowhere (today: `C3300` only), merged during extraction |
| `uniformat_pricing.csv` | Generated 1,774-row catalogue: 1,773 workbook rows + one supplement row |
| `location_factors.csv` | 74 RSMeans 2018 locality factors (`province`, `city`, indexes, `factor`) |
| `capital_planning_rules.json` | Horizon/term ranges, condition letter grades, cost rounding, seven CRV soft-cost factors (86% uplift → ×1.86), FCI windows and both grade scales |

The extractor asserts the six source formulas, the 86% soft-cost total, condition scale, and both FCI grade formulas against workbook XML. Catalogue counts are split into workbook and supplement invariants; `--check` still fails if a generated output is hand-edited.

Workbook inflation is **not** applied. Costs stay in constant assessment-year dollars. Default building location factor in the app is **1.0** (neutral), not a sample Alberta site factor.

## Engine (`src/lib/capital-planning.js`)

`calculateCapitalPlan({ assets, building, rulesPath })` returns:

- per-asset effective vintage, age, service life/source, remaining life, estimated replacement year, effective action year/source, recurrence/source, condition letter grade, derived/effective term, unit cost, OPC, and scheduled events
- `scheduledActionYear` — the year the report recommends, which is the action year clamped forward to the assessment year — plus `actionYearIsOverdue` and `overdueByYears`. An expired lifecycle date is not a recommendation, so the report prints the scheduled year and marks it overdue rather than printing a bare `1990` as the current recommended action year; see [property-report](property-report.md).
- annual totals, term totals, Level-1 group rollups

One engine, one schedule: an asset's action year, its derived term, the Capital Renewal Summary (group × term), and the annual forecast (year grid) all come from the same per-asset `events`, so they cannot drift. A `test/capital-planning.test.js` case reconciles the term totals, the group-by-term totals, and the year grid to one scheduled total, and checks each asset's term contains its scheduled action year.
- CRV (derived or manual override) with Level-2 breakdown
- FCI for windows 0–2, 0–5, 0–10, and 0–25 against CRV

Precedence:

1. **Unit cost** — `unit_cost_override`, else parsed catalogue `unit_price`, then × building `location_factor` with workbook rounding bands.
2. **OPC** — `opinion_of_probable_cost` override, else quantity × adjusted unit cost, in whole dollars. The workbook's extra $100/$1000 OPC rounding is intentionally dropped (it destroyed small values — 1 × $130 became $100); see [workbook-calculation-reference](workbook-calculation-reference.md) §8.
3. **Life** — asset `vintage`, falling back to this building's `property_vintage`; asset `service_life`, falling back to catalogue mean then practical life. If neither vintage source exists, life remains unknown and the asset is flagged rather than silently scheduled.
4. **Action year** — `action_year` override, else assessment year + remaining life (`service_life − age + life_adjustment_years`).
5. **Recurrence** — `allowance_interval_years`, else effective service life.
6. **Term** — always derived from the effective scheduled action year; there is no stored `term` override (removed per client requirement — see [workbook-calculation-reference](workbook-calculation-reference.md) §8). Overdue actions are Immediate because their first event moves to the assessment year. A **suppressed** asset reports `effectiveTerm = null`: it funds no window, so claiming a bucket would contradict the term totals, which see $0 there. `derivedTerm` still carries the raw derivation for anything that wants it.

Intervals below 1 year are treated as one-shot. `No Action` assets are suppressed from the reserve schedule (via Action Type only, since term is derived) but still contribute replacement value to CRV. Overdue first events move to the assessment year; this deliberately avoids the workbook behavior that silently drops an overdue event. Costs remain constant-dollar.

CRV = sum of asset replacement OPCs × 1.86 unless `building.current_replacement_value` is set. FCI is exclusively building-level. All four windows (0–2, 0–5, 0–10, 0–25) use one consistent IFMA grade table with inclusive upper edges (2.5%, 5%, 10%, 30%; Critical > 30%), so a given FCI grades identically in the current and every projected column. The workbook's separate revised 0–5 scale is recorded in the rules but no longer applied — see [workbook-calculation-reference](workbook-calculation-reference.md) §8.

Condition storage remains the existing 1–6 legacy vocabulary, while `conditionGradeForRating` derives the report/display grade (`Fair` → `C - Acceptable`).

`getPropertyReportData` attaches `capitalPlan` and per-asset `capital` so the report does not re-derive costs in the renderer. The home asset editor uses `previewAssetPlan` over IPC; it replaces the edited asset with live form values in a full building calculation, so the asset chain and all four building FCI windows update together. `getBuildingCapitalPlan(buildingId)` returns the same plan for AI executive-summary prompts (see [executive-summary](executive-summary.md)).
