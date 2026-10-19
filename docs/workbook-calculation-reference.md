# Workbook calculation reference and design rationale

This is the durable reference for how the sample BCA workbook derives asset
fields, how those formulas map into the app, and why the app intentionally
differs in a few places. For the current engine API and precedence rules, see
[capital-planning](capital-planning.md). For catalogue ownership and the
supplement contract, see [uniformat-pricing](uniformat-pricing.md). For the
assessor-facing controls and live calculation panel, see
[home-page](home-page.md).

**Source.** `samples/Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx`,
sheet `Worksheet`: header row 3, data rows 4–4146 (4,143 rows), columns A–BK.
Every formula below is the literal cell content from row 4, with Legend
references dereferenced in brackets.

---

## 1. The workbook documents its own colour code

Sheet *Project Specific Details*, cells A1:A4, is a swatch key with the meaning
written beside each fill. Reading the actual `styles.xml` fills confirms it, so
"white = input, grey = calculated" is the workbook's stated contract, not an
inference.

| Fill | Meaning (workbook's own words) | Worksheet columns |
|---|---|---|
| none (white) | User input required | K L M S U W AA AC AD AH AI |
| `#D9D9D9` (theme 0, tint −0.15) | Cell values determined by formula | D E F G H N P Q T V X Z AB AE AF AJ AK, AL:BK |
| `#82A356` (theme 6) | *not in the key* — marks catalogue-sourced picks | I Y AG |
| `#FF0000` | Formula reference. Do not touch. | B |
| `#C00000` | Do not populate | O R |
| `#FFC000` | *not in the key* — row keys | A C |

**Row 1 is a lookup index, not data.** It holds each column's 1-based position
(C=2, D=3 … BK=62) so formulas elsewhere read `Worksheet!AE1` instead of
hard-coding `30`. Legend, FCI, and Data Tracker each carry the same row, which
is how `FCI!$E$36`, `Legend!$F$52`, and `'Data Tracker'!$I$1` resolve to 5, 4,
and 8.

---

## 2. Column-by-column reference

### Identity and structure

| Col | Header | Source | App mapping |
|---|---|---|---|
| A | Component # | `A5 = A4+1` | `asset.id` + list order — nothing to port |
| B | Sheet ID | `CONCAT(C4," - ",A4)` → `"1 - 1"` | composite join key, replaced by real FKs |
| C | Site ID | manual | `asset.building_id` |
| D | Building | `VLOOKUP(C4, Legend!$A$4:$D$50, 2, FALSE)` | join to `building.property_name` |
| N | GROUP ID | `VLOOKUP(C4,'Data Tracker'!$B$4:$AD$29,'Data Tracker'!$M$1 [=12],FALSE)` | **no equivalent** — portfolio grouping between project and building. Out of scope. |

### Uniformat classification

```
F4 = LEFT(I4,1)                                              →  "A"
G4 = LEFT(I4,3)                                              →  "A10"
H4 = LEFT(I4,5)                                              →  "A1010"
E4 = CONCAT(G4," ",VLOOKUP(G4, Level_2[], 3, FALSE))         →  "A10 Foundations"
```

Column I is one picked string (`"A1010 Standard Foundations"`) that the rest is
sliced out of. The app represents this with four cascading selects and stored
level codes.

Column J (Asset Name) is grey-filled but carries no formula: it is a dropdown
off *Asset Templates* column E, 183 distinct names. It matters because it is
half the key into the canned description in column L. The app uses free text,
and 98 of the 270 names actually used in this workbook are not in the template
list.

### Narrative

- **K Reference Photo** — manual. The app uses `asset_image` rows with
  annotations and report-inclusion controls.
- **L General State of Repair** — a canned paragraph looked up by *asset name +
  condition rating*:
  ```
  IF(S4="","-",
     INDEX('Asset Templates'!$G$2:$G$946,
           MATCH($J4&$S4,
                 'Asset Templates'!$E$2:$E$946 & 'Asset Templates'!$F$2:$F$946, 0)))
  ```
  945 templates — 184 names × ratings 1–5, plus 5 strays keyed A–E — averaging
  268 characters (71–795). This is the one place the workbook writes prose for
  the assessor. The app deliberately uses its AI description workflow instead
  of porting this lookup table; see §10.
- **M Recommendation** — manual in the workbook; AI-drafted with an editable
  final value in the app.

### Condition and FCI

**O (Operational / Process Performance) and R (Maintainability)** are marked
*do not populate*, labelled `HIDE` in row 2, and empty in all 4,143 rows. They
were meant to be two of three sub-scores averaged into column S; that design was
dropped and S is now scored directly. **Do not build them.**

- **S Condition Average** — manual integer 1–6. Despite the name, nothing
  averages into it. Observed across 534 scored rows: 3 → 252, 2 → 230, 4 → 30,
  1 → 16, 5 → 6. The app stores the same 1–6 scale in `condition_rating`.
- **T Condition Rating** — `VLOOKUP(S4, Legend!$C$54:$F$59, Legend!$F$52 [=4], FALSE)`
  → `"C - Acceptable"`. The app derives this letter/revised label while keeping
  the legacy 1–6 value as the stored assessor input.
- **P / Q FCI Score / Grade**:
  ```
  P4 = VLOOKUP(C4, FCI!$A$39:$K$85, FCI!$E$36 [=5], FALSE)
  Q4 = VLOOKUP(C4, FCI!$A$39:$K$85, FCI!$F$36 [=6], FALSE)
  ```
  **These are building-level values, keyed on site id, printed identically on
  every asset row** — the 0–5 year FCI and its grade. Distribution across the
  sample: Poor 2,877 · Good 1,078 · Fair 130 — i.e. three distinct values across
  4,143 rows, one per building. The app therefore does not store an editable
  per-asset FCI field. It shows the live building FCI windows in the asset
  calculation panel and building report tables. The full chain is in §4.

### Life and timing

```
W4  vintage        VLOOKUP(C4,'Data Tracker'!$B$4:$I$43,'Data Tracker'!$I$1 [=8],FALSE)
X4  age            Legend!$B$2 [=2025] - (IF(W4>0, W4, Legend!$C$4))
Z4  remaining life IF(W4="", 0, Y4 - X4 + AA4)
AB4 repl. year     IF(Z4="", "", Legend!$B$2 + Z4)
AE4 action year    IF(AC4="", AB4, AC4)        ← allowance year wins over derived
AF4 absolute life  IF(AD4="", Y4,  AD4)        ← allowance interval wins over normal life
```

- **W Vintage** — white, so overwritable, but most rows still hold the prefill:
  the building's construction year. Assessors type over it for components
  installed later. `createAsset` copies `building.property_vintage`.
- **X Age** — assessment year minus vintage, falling back to the building's
  construction year. **The fallback is a workbook bug:** `Legend!$C$4` is an
  absolute reference to *site 1*, so every row in every building falls back to
  Playfair Lodge's 1980. The app implements the intended per-building fallback.
- **Y Normal Life** — green, so seeded from the catalogue, but no formula: it is
  assessor judgement anchored on the Uniformat life columns. Of 86 distinct
  (level 3, normal life) pairs, 56 match both `Mean Service Life` and
  `Practical Life`, 3 match mean only, 4 practical only, and **23 match
  neither**. The app therefore prefills mean life, falls back to practical life,
  and leaves the value overridable rather than forcing catalogue truth.
- **AA Adjustment** — manual, years added to remaining life for observed
  condition. The app stores it as `life_adjustment_years`.
- **Z / AB** — calculated by the engine and shown in the live asset calculation
  panel as remaining life and estimated replacement year.
- **AC / AD** — two manual overrides for allowance-style items: pin the first
  year, and set a repeat interval that replaces normal life. Barely used here
  (3 rows each). The app uses `action_year` and
  `allowance_interval_years`.
- **AE / AF** — the two values the 26 year-columns are driven from. The app uses
  `plan.actionYear` and `plan.recurrenceInterval` with the same precedence.

**V "Priority" — the header lies.** The formula returns a *Term*:

```
IF(Z4 <  Legend!$E$84 [=1],                              "Immediate",
IF(AND(Z4 >= Legend!$E$85 [=1], Z4 <= Legend!$F$85 [=2]), "Short Term",
IF(AND(Z4 >= Legend!$F$85 [=2], Z4 <= Legend!$F$86 [=5]), "Medium Term",
IF(AND(Z4 >  Legend!$F$86 [=5], Z4 <= Legend!$F$87 [=10]),"Long Term",
                                                          "End of Life"))))
```

It buckets remaining life into the Legend's term ranges and has nothing to do
with High / Medium / Low, which the workbook derives **nowhere**. Accordingly,
the app derives `term` (always, from the scheduled action year — never stored)
but keeps `priority` manual. See §8 for the term derivation and why the manual
term override was removed.

For whole-number remaining life the bounds behave exactly as the Legend states
and match `capital_planning_rules.json` term offsets. Two edge notes: the medium
lower bound reads `F85` (2) instead of `E86` (3), so a fractional 2.5 lands in
Medium; and the formula never emits `N/A` — the 4 rows showing it were typed
over. Observed: Immediate 2,611 · End of Life 918 · Long Term 279 · Medium Term
172 · Short Term 107 · N/A 4.

### Cost

```
AJ4  LF = VLOOKUP(C4, Legend!$A$4:$F$50, 6, FALSE)     ← building location factor
     IF(AI4 < 100,   ROUND(AI4*LF,  0),
     IF(AI4 < 1000,  ROUND(AI4*LF, -1),
                     ROUND(AI4*LF, -2)))

AK4  IF(AJ4*AH4 > 1000000, ROUND(AJ4*AH4, -3), ROUND(AJ4*AH4, -2))
```

- The AJ rounding band keys off the **unadjusted** reference cost, not the
  product. `adjustUnitCost` gets this right.
- AK: strictly greater than a million rounds to thousands; exactly a million
  rounds to hundreds.
- **AG Unit** — the catalogue's `Unit of Measure`, abbreviated. Used: EA 2,527 ·
  Sq. Ft. 1,042 · Ln. Ft. 195 · Lump Sum 153 · Per Tread 117 · Per Starter 23 ·
  Per Rung 19 · Per Floor 15. The app's mapping includes the catalogue values
  `Set`, `Per Floor`, `Per Point`, `Per Hose`, and `Per Toilet`, plus the
  assessor-specific `Per Tread`, `Per Rung`, and `Per Starter` units. Those
  specific units remain distinct rather than being collapsed into `EA`, because
  their quantity semantics differ.
- **AI Unit Repl. Cost (Ref)** — white, seeded from the catalogue's `Unit Price`.
  174 rows hold composed arithmetic rather than a single price —
  `(1206.12*1)+2928.94`, `3.68*0.5`, `1250*1` — assessors summing several
  catalogue line items into one component. The app's
  single-price-plus-override model covers this only if the assessor does that
  arithmetic before entering the override.

### The 26-year reserve schedule (AL:BK, 2025–2050)

```
IF(AL$3 = $AE4,            $AK4,
IF(AL$3 = $AE4+($AF4*1),   $AK4,
…  26 branches, k = 0 … 25  …
                           "")))
```

Drop the full OPC into the column whose year header equals the action year, then
again at every multiple of the recurrence interval. Header years come from
`AL3 = Legend!$B$2`, then `+1` across. Per-building subtotal rows carry
`J = CONCAT("Total"," ",VLOOKUP(C,'Data Tracker'!$B$4:$O$43,2,FALSE))` and
`SUM()` down each year column; those subtotal rows are what the FCI sheet reads.

---

## 3. Reference tables, resolved

### Condition scale — `Legend!$C$54:$F$59`, column T reads column 4

| S | Letter | Revised label (column T output) | Legacy label (Legend col A) | App dropdown |
|---|---|---|---|---|
| 1 | A | A - Excellent | Very Good | 1 - Very good |
| 2 | B | B - Good | Good | 2 - Good |
| 3 | C | C - Acceptable | Fair | 3 - Fair |
| 4 | D | D - Marginal | Poor | 4 - Poor |
| 5 | E | E - Poor | Very Poor | 5 - Very poor |
| 6 | F | F - Critical | Critical | 6 - Critical |

The stored app labels are the workbook's **legacy** set. Row 2 marks column T
"Revised", and the letter grades are what the sample report prints. Note the
trap: *"Poor" means 4 on the stored scale and 5 on the revised one.*

### Term ranges — `Legend!$A$83:$F$88`

| Term | From | To | rules.json |
|---|---|---|---|
| Immediate | 0 | 0 | `immediate 0–0` |
| Short Term | 1 | 2 | `short 1–2` |
| Medium Term | 3 | 5 | `medium 3–5` |
| Long Term | 6 | 10 | `long 6–10` |
| End of Life | 11 | 25 | `end_of_life 11–25` |
| N/A | — | — | `suppressed_terms` |

### Two FCI grade scales

| Window | FCI sheet cols | Scale | Bands |
|---|---|---|---|
| 0–2 yr (IFMA) | C / D | IFMA, 5 bands | Very Good ≤2.5% · Good ≤5% · Fair ≤10% · Poor ≤30% · Critical >30% |
| **0–5 yr** | E / F | **Revised, 3 bands** | Good <15% · Fair 15–40% · Poor >40% |
| 0–10 yr | G / H | IFMA, 5 bands | as above |
| 0–25 yr | I / J | IFMA, 5 bands | as above |

**The Worksheet's FCI Grade column reads the 0–5 year window on the revised
3-band scale.** The app originally mirrored that (revised for 0–5, IFMA for the
other three), but the client required one consistent grade table, so the app
now applies the IFMA scale to **all four** windows (see §8). The Legend's prose
calls the worst IFMA band "Very Poor" while the formula string returns
`"Critical"`; the formula wins, so the app also returns Critical.

### CRV soft costs — `'Replacement Cost'!$B$1:$B$7`

Installation 35 · Commissioning 5 · Training 1 · Engineering 12 · Design Review 3
· Contingency 15 · Project Management 15 → **86% uplift, ×1.86**.
Verified against the sample: 5,500 × 1.86 = 10,230.

---

## 4. How FCI reaches the asset row

1. Asset rows place OPC into year columns — `Worksheet!AL:BK`.
2. A per-building subtotal row sums each year — `SUM(AL4:AL188)` on the row named
   `"Total Playfair Lodge"`.
3. The FCI sheet pulls those 26 yearly totals and divides by CRV:
   ```
   FCI!P39 = VLOOKUP($O39, Worksheet!$J$4:$BK$4146, P$36, FALSE)   ← O39 = "Total <building>"
   FCI!K39 = HLOOKUP(A39, 'Replacement Cost'!$C$44:$AW$68, 25, FALSE)   ← CRV

   FCI!C39 = SUM(P39:R39)  / $K39     0–2 yr
   FCI!E39 = SUM(P39:U39)  / $K39     0–5 yr   ← what Worksheet column P shows
   FCI!G39 = SUM(P39:Z39)  / $K39     0–10 yr
   FCI!I39 = SUM(P39:AO39) / $K39     0–25 yr
   ```
   CRV itself is `'Replacement Cost'!C68 = SUM(C46:C67)`, each row being
   `SUMIFS(Worksheet!AK, by level 2, by site) × (1 + 0.86)`.
4. Every asset row looks the building's score back up by site id. One number per
   building, printed 4,143 times.

**CRV scope quirk.** `'Replacement Cost'!C46:C67` enumerates 22 specific Level-2
codes — including a non-Uniformat `C33 Accessibility`. An asset in any other
Level-2 code contributes nothing to CRV, silently. The app engine sums every
asset, so its derived CRV may not tie exactly to a workbook figure.

---

## 5. Current app implementation

`src/lib/capital-planning.js` implements the complete numerical chain. It
matches the workbook for:

- unit-cost rounding bands keyed on the unadjusted reference cost
- action-year and recurrence-interval precedence
- the 26-year horizon and five term ranges
- the 86% CRV uplift and its seven factors
- all four FCI windows on one consistent IFMA grade scale (see §8)
- the condition score-to-letter mapping
- 74 location factors and the 1,773-row extracted catalogue

The app also exposes the intermediate chain rather than asking assessors to
recalculate it. The asset calculation panel shows catalogue price, adjusted
cost, OPC, condition grade, age, remaining life, estimated replacement year,
effective action year and source, recurrence and source, effective term and
source, and all four live building FCI windows. A stored unit cost, OPC, action
year, recurrence interval, service life, vintage, or term is an explicit
assessor override.

`calculateCapitalPlan` is the one shared engine for the editor preview, report,
and AI summary context. This prevents the displayed asset calculation, capital
tables, and narrative inputs from drifting apart.

---

## 6. Catalogue hierarchy finding and the C3300 supplement

An initial comparison appeared to show four missing Level-3 groups used by 159
sample assets:

| Worksheet code | Group | Assets | Observed sample values |
|---|---|---:|---|
| `G2034` | Guardrails & Barriers | 74 | bollards EA $585–1150; fencing/railing linear foot $43–65; life 15–30 |
| `C2012` | Exterior Stair Construction / Fire Escape | 30 | per tread $224 life 30; per floor $20,000 life 50 |
| `G2043` | Exterior Furnishings | 30 | metal ladder linear foot $163; metal platform EA $3,425; life 50 |
| `C3300` | Accessibility (AODA) | 25 | EA $750 and $8,000; life 12 |

Only `C3300` is actually absent. The apparent four-group gap came from treating
Worksheet column H as an independent hierarchy level. Its formula is
`LEFT(<Level 4>,5)`, and every catalogue code is already five characters, so it
simply repeats Level 4. `G2034`, `C2012`, and `G2043` are priced Level-4 rows
under `G2030`, `C2010`, and `G2040`; they were reachable all along. Adding
blank-price duplicates would create a second, inferior route and could hide the
real priced rows.

`C3300` and its `C33` parent are absent at every catalogue level, so the
FK-driven asset cascade genuinely could not represent accessibility work. The
declared `SUPP-C3300-01` row fixes that under the existing **C Interiors** tab.
It uses the observed 12-year life and unit but intentionally has no catalogue
price. The assessor must provide a unit-cost or OPC override, and the engine
surfaces `missing_unit_price` until then.

Two related findings prevent future false positives:

- The 276-row ASTM-versus-pricing material difference is a numbering-prefix
  artifact, such as `03 Revolving Doors, Stainless Steel` versus the same text
  without `03`.
- The ASTM tables call `C33` “AODA” in one place and “Interiors” in another. It
  still belongs under the existing C top-level group; it does not justify a new
  top-level tab.

The shipped and user-selectable catalogue lifecycle belongs to
[uniformat-pricing](uniformat-pricing.md).

---

## 7. Why extraction accepts a declared supplement

The data check protects several different contracts:

| Check | Contract and reason |
|---|---|
| Six byte-identical Worksheet formulas | Detect source-workbook changes that could invalidate the engine |
| Soft-cost sum equals 0.86 | Preserve the workbook CRV uplift |
| Condition and FCI formulas | Tie hand-authored rule constants back to Legend and FCI sheets |
| `capital_planning_rules.json` digest | Detect edits to generated rules instead of the extractor |
| `location_factors.csv` digest and 74-row count | Preserve the RSMeans transcription |
| Workbook catalogue count of 1,773 | Detect unexpected source extraction drift |
| Supplement count and combined digest | Allow declared local additions while detecting hand-edits to generated output |

Treating the final catalogue as necessarily byte-identical to the workbook
would be too restrictive. It is a replaceable application default, and the
source workbook is missing a classification the app must support. The adopted
contract therefore makes `data/uniformat_pricing_supplement.csv` a declared
input rather than manually mutating `uniformat_pricing.csv`.

`render_outputs()` concatenates the 1,773 workbook rows and one supplement row,
rejects duplicate IDs, and emits a deterministic 1,774-row catalogue.
`SUPP-C3300-01` cannot collide with numeric workbook IDs because the primary key
is TEXT. `--check` still fails after a hand-edit to generated output, while an
intentional supplement edit remains reproducible. Runtime seeding and the
Settings CSV flow continue to consume a single combined file.

---

## 8. Intentional differences from the workbook

These differences are deliberate product and correctness decisions.

### OPC is the exact product, not hundreds-rounded

The workbook's column AK rounds OPC to the nearest $100 (or $1,000 above a
million). That rounding destroys small components: `1 × $130` rounds to `$100`.
The client reported this as a defect and requires OPC to equal `Quantity ×
Adjusted Unit Cost`. The app therefore rounds OPC only to whole dollars.

The adjusted *unit* cost keeps the workbook's order-of-magnitude rounding bands
(column AJ), so the product is still a clean estimating figure — this change
only removes the second, lossy rounding step. `capital_planning_rules.json`
still records the workbook's `opc_rounding` block as the faithful source
extraction; the engine intentionally does not apply it. CRV and FCI, which sum
OPCs, shift accordingly.

### One FCI grade scale for current and projected windows

The workbook grades its displayed 0–5 year FCI on a revised 3-band scale (Good
<15%, Fair 15–40%, Poor >40%) while the other windows use the 5-band IFMA scale.
That split makes a single FCI read differently across columns — e.g. 53.8% is
"Poor" on the 0–5 scale but "Critical" on IFMA. The client requires one grade
table everywhere, so the app grades **all four windows on the IFMA scale**
(Critical > 30%), which is the scale the report itself prints as its guideline.
`grade_scales.revised_0_5` and the 0–5 window's `grade_scale` remain in
`capital_planning_rules.json` as the faithful workbook record; the engine
applies IFMA to every window regardless.

### Overdue components are due now

The workbook only places a cost when a year header exactly matches the action
year or recurrence. An initial action year before the 2025 horizon therefore
disappears unless a later recurrence happens to land in range. The app clamps
the first event to the assessment year and reports
`overdue_moved_to_assessment_year`.

Reason: a past-due deficiency is an immediate need. Dropping it would understate
both the Immediate term and FCI.

### `No Action` and `N/A` suppress reserve events

The workbook year formula has no guard, so such a row can still place a cost.
The app suppresses its schedule while retaining its replacement OPC in CRV.

Reason: a row explicitly marked not actionable should not appear as funded
work, but its component still contributes to the cost of replacing the
building.

### Unknown age stays unknown

The workbook normally falls back from asset vintage to building construction
year, but its absolute reference points every building at site 1’s 1980 value.
If vintage is genuinely empty, it then forces remaining life to zero. The app
uses the current building’s `property_vintage`; if both sources are absent, it
reports `missing_life_inputs` and leaves the asset unscheduled.

Reason: this fixes the cross-building reference bug without silently treating
an unknown-age asset as due today.

### IFMA upper edges are inclusive

The app matches the workbook’s `<=` comparisons at exactly 2.5%, 5%, 10%, and
30%. These exact ratios are realistic because costs are rounded.

### Stored condition values remain stable

The app stores the existing legacy 1–6 vocabulary and derives the workbook’s
letter/revised display alongside it—for example stored `Fair` becomes
`C - Acceptable`.

Reason: the two scales reuse words with different meanings; “Poor” is score 4
on the legacy scale but score 5 on the revised scale. Storing one and deriving
the other avoids ambiguity.

### Term is always derived from the effective action year

Worksheet column V buckets raw remaining life, ignoring an allowance-year
override. The app derives term from the effective scheduled action year after
that override. The term is **never** a stored value: there is no manual term
override in the asset form, and the engine ignores any stored `term`. The
client reported the earlier override behaviour as a defect — an asset scheduled
for the assessment year (Immediate) could still display a stored "Short Term".
Priority remains manual because the workbook never derives High/Medium/Low.

Suppression (an asset that funds no scheduled work) is driven only by the
Action Type — `No Action`. The old `N/A` term never reaches the engine now, so
a stored term can no longer mark an asset not-actionable.

Reason: the displayed term, annual reserve, and term totals must describe the
same scheduled event, with one derivation and no value that can drift.

### CRV includes every classified Level-2 group

The workbook’s Replacement Cost sheet enumerates 22 specific Level-2 codes; a
code outside that list silently contributes nothing. The app sums replacement
OPC for every asset before the 1.86 uplift.

Reason: a new or supplemented classification must not disappear from building
replacement value. This deliberate scope difference can prevent an exact CRV
tie to the workbook.

---

## 9. Implementation ownership and verification

| Concern | Owning implementation |
|---|---|
| Workbook extraction, formula assertions, supplement merge | `scripts/extract-bca-reference-data.py` |
| Constants and scales | `data/capital_planning_rules.json` |
| Cost, life, timing, schedule, CRV, and FCI engine | `src/lib/capital-planning.js` |
| Asset creation defaults and live full-building preview | `src/db.js` |
| Untouched-only service-life/unit prefills and calculation panel | `src/renderer-asset-form.js` |
| Unit vocabulary and catalogue mapping | `src/shared.js` |
| Report output | `src/docx-report.js` (authoritative DOCX); `src/property-report.js` renders the prepared artifact |
| AI rollups and prompt context | `src/lib/asset-rollup.js`, `src/ai/openrouter-client.js` |

Removing the obsolete editable `asset.fci` column was schema version 4. The
user-approved migration drops it only after the existing backup workflow; the
fresh schema and migration fixture are kept equivalent by
`test/db-migrations.test.js`. FCI remains visible on asset screens as live,
read-only building context rather than duplicated stored asset data.

Calculation edges, rule constants, supplement seeding, migration behavior, and
unit mappings have unit coverage. `scripts/verify-asset-calculations.js` drives
the real Electron app to verify catalogue prefills, assessor overrides, the
derived panel, all four FCI windows, C3300 selection, and autosave. The combined
`npm run verify:ui` runner also retains the full project-report scenario.

---

## 10. Deliberately out of scope

**Asset Templates.** The 945-paragraph canned-description library (184 asset
names × condition 1–5, keyed on `asset_name & condition_rating`) plus its
`Asset Name` dropdown would replace the AI description panel with a lookup. That
is a product decision about how descriptions get written, not part of
auto-calculating the numeric fields. Flagged, not planned. If wanted, it is a
new CSV plus a constrained `asset_name` vocabulary — and note 98 of the 270 names
used in the sample are not in the template list, so the vocabulary is not closed.

**GROUP ID.** Portfolio grouping between project and building (`Financial
Summary (GROUP)`, `Grouping Details`). No equivalent in our schema, and nothing
in the current task needs one.

**Inflation.** The workbook carries a Bank of Canada inflation factor (0.1867) in
`Legend!G4:G29` and never applies it. Costs stay in constant assessment-year
dollars; `capital_planning_rules.json` already records this.

---

## 11. History

This reference records the calculation work completed on 2026-07-30. It
replaces the temporary implementation plan that previously lived at the
repository root. An older, unrelated post-1.0.3 deferred-review plan remains
available in commit `7ebb9b1` if its historical context is ever needed.
