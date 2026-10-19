# Report wording (`src/lib/report-content.js`)

Every word the report prints that does not come from the database is the
client's, supplied as a rewritten report-text template
(`ANJ_Hastings_Rewritten_Report_Text_for_Developer.txt` in the repo root). This
document records what that template asked for, what was already true, and the
handful of places the implementation deviates — so the next person does not
"fix" a deliberate deviation back into a bug.

The template is a *text* spec: it replaces prose and labels. Its own preamble
keeps every calculated value, table, photograph, date, UNIFORMAT code, FCI, CRV,
action year, quantity and cost figure generated from the project database. No
number in any report moved.

## Where the wording lives

`src/lib/report-content.js` holds all of it: the prose as blocks, and every
heading, table caption, column head and field label as `LABELS`,
`FACILITY_FIELDS` and `ASSET_FIELDS`. The authoritative Word builder
(`src/docx-report.js`) reads it once; the preview renders that resulting DOCX
instead of maintaining a second content renderer. Rewording therefore remains
one edit, and the review screen cannot promise wording absent from the
deliverable.

`test/report-content.test.js` defends the parts no rendering test can: that the
report never calls itself a Property Condition Assessment, never claims
compliance with every applicable code, and prints FCI bands that match the scale
that actually grades them.

The OpenRouter caption and executive-summary system prompts use the same
"Building Condition Assessment" name. Generated prose therefore is not primed
to reintroduce the retired "Property Condition Assessment" wording into an
otherwise corrected deliverable; `test/executive-summary-ai.test.js` pins all
three prompt paths.

## Behaviour the template changed

Most of the template is text. Four of its developer notes are not:

- **Missing attributes read as words.** `Not Provided` replaces the em dash in
  the Facility Information Summary, the asset fields, the CRV description cells
  and the FCI grade cells. Cost cells are deliberately excluded — a zero cost is
  a number the plan computed, not a gap in the record, so it stays `-`.
- **No dangling sentence fragments.** The Facility Overview fallback used to
  interpolate the address unconditionally, so a building with none produced
  "located at ." It now says the address is not recorded, in a sentence.
- **Acronyms restored.** The workbook title-cases its UNIFORMAT descriptions,
  which turned `HVAC` into `Hvac` in 605 rows of `data/uniformat_pricing.csv`.
  That file is generated, so the fix is `restore_acronyms` in
  `scripts/extract-bca-reference-data.py`, not a hand edit — see
  [dev-environment](dev-environment.md).
- **Code-compliance claims removed.** The executive summary used to say the
  assessment predicts what is needed to keep the site "in compliance with all
  applicable codes". A visual, non-destructive walk-through cannot establish
  that, and the template says so explicitly. The ASTM framing is softer for the
  same reason: "in general accordance with the assessment framework identified
  for the assignment, including ASTM E2018 where applicable to the project
  scope".

## Notes that were already satisfied

- **Repeated narrative is not hard-coded per property** — it never was, since
  `report-content.js` was introduced.
- **An overdue action year is already reclassified.** `calculateCapitalPlan`
  clamps the scheduled year to `max(startYear, actionYear)`, flags
  `actionYearIsOverdue`, and retains the original lifecycle year;
  `displayActionYear` prints `2026 — overdue (lifecycle date 1990)`.
- **"Services", not "Service"** — the pricing data already says Services.
- **"Hastings", not "Hasting"** — that misspelling does not appear in this repo.
- **One limitations section per facility** — the template's own first option,
  and what the report already does.

## Added after the template

- **The Component Summary is a later client request, not part of the template.**
  The template's summary tables are the Facility Information Summary and the
  Major System Capital Summary, both of which already existed. The client
  afterwards asked for an asset-level summary beside the capital summary at the
  top of the report; `componentSummaryBlocks` is its prose and
  `componentSummaryRows` its data. Its total deliberately does not match the
  capital table's — see [property-report](property-report.md#the-component-summary).

## Deviations, and why

- **The firm name stays dynamic.** The template writes "ANJ ENGINEERING LTD"
  into every legal notice. The app reads `firm.name` from the database, and the
  rendered output is identical for ANJ. Hardcoding it would put the wrong
  company's name in another firm's legal notices, and the template's own
  preamble says database-driven values keep coming from the database.
- **`{PROJECT_NAME}` resolves to the client.** The schema has no project name —
  a project is identified by its client — so a portfolio is named
  "<Client> Building Condition Assessment program".
- **"Assessment Basis" appears once per report, not once per asset.** The
  template says to add it to asset pages. A 27-property report has hundreds of
  those; repeating a methodology note on each would be noise, and the template's
  own notes 1 and 15 say not to duplicate narrative. It opens the Condition
  Assessment Findings section instead, which is the asset pages' own section.
- **All four FCI windows are kept.** The template's replacement text defines the
  0–2 year formula only. The report also prints 0–5, 0–10 and 0–25 columns, and
  the template does not ask for them to be removed — its preamble keeps existing
  tables. There is no contradiction in doing so: `calculateCapitalPlan` grades
  **every** window on the IFMA scale (`FCI_GRADE_SCALE = 'ifma'`), which is
  exactly the band table the new prose prints. The workbook's separate
  `revised_0_5` scale is recorded in the rules but never applied — see
  [workbook-calculation-reference](workbook-calculation-reference.md) §8.
- **Test-data placeholders were not renamed.** The template replaces "TEST DATA
  ONLY" and "Verify during field inspection"; neither string exists in this
  repo. They came from the client's own sample data.
