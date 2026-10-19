# Excel import (`src/lib/bca-workbook.js`, `src/import-bca.js`)

Bulk-loads a client BCA Excel workbook (the `Asset-List_*-BCA_Worksheet_draft_v1.xlsx`
template) into a project's buildings and assets, so an assessor's spreadsheet
becomes editable app data instead of being retyped. Two pure modules do the
work and one IPC handler drives the UI.

## Two stages

**Parse — `parseBcaWorkbook(workbook)`** turns an already-read
[SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
workbook into a normalized
`{ baseYear, buildings, rows, missingColumns, errors, warnings, skipped }`
structure. It is pure (takes a workbook, touches no database, boots no Electron)
so it is unit-tested against the sample file directly.

- **Fixed column layout.** The template's `Worksheet` sheet has its header on
  row 3 and data from row 4. Each imported field is read from a fixed column
  letter (`FIELD_COLUMNS`); the header text at that letter is checked against the
  expected name, so a changed or renamed template surfaces as a
  `missingColumns` entry (or a hard `missing_column` error for a required field)
  rather than silently mis-reading a neighbour. The letter→field mapping is the
  one documented in [workbook-calculation-reference](workbook-calculation-reference.md) §2.
- **Row inclusion.** A real asset row has both an **Asset Name** (col J) and a
  **Site ID** (col C). Subtotal rows (`Total <building>`), blank rows, and
  template rows whose broken formulas read as `#REF!` carry no usable asset name
  and are counted in `skipped`, not imported.
- **Error cells.** A formula-error cell (`cell.t === 'e'`) reads as `null`, and
  an error in an imported field is reported in `errors`. Errors in the two
  columns the importer never uses (Component #, Sheet ID) are ignored — those
  are the template's own broken cross-sheet formulas and are not the importer's
  concern.
- **Legend sheet.** `parseLegend` reads the base assessment year from `B2` and,
  per Site ID, the building name and location factor. Buildings seen only in the
  `Worksheet` (not the Legend) still get a record from their first data row.

  The site block starts at row 4 and is read to the end of the sheet. It used to
  stop at row 60 — roughly the `Legend!$A$4:$F$50` the template's own
  `VLOOKUP`s use — which was enough for the 26-property sample but not for the
  75-property export, whose last eighteen sites start at row 61. Those buildings
  were created with no location factor and costed at 1.0 while the workbook
  priced them at their own. Only site ids that the `Worksheet` rows actually
  carry are looked up, so the reference tables below the sites (condition
  ratings, action types, unit measures) are read past rather than mistaken for
  buildings — seven of them used to reach `parsed.buildings` from the sample,
  though nothing downstream ever asked about them.

**Apply — `src/import-bca.js`** maps each parsed row onto the app's asset fields
and writes them under a better-sqlite3 transaction:

- `resolvePricingId` matches the catalogue by Uniformat code, most specific
  first (level 3 → level 2 → level 1). A row that matches nothing is skipped and
  counted in `unresolved` — it is never imported without a pricing link.
- `conditionLabelForScore` maps the numeric Condition Average (1–6) to the
  stored condition label from [capital-planning](capital-planning.md) rules.
- **Placeholder cells are stored as NULL, not as content.** The template writes
  `"-"` in General State of Repair on every un-inspected row (3,532 of the
  sample's 4,091), and similar filler in Recommendation and Action Type. Stored
  verbatim, that reaches the report as a description *and* makes the row look
  assessed, which is how a 201-page report of master-library placeholders happened.
  `importedText` maps the placeholder vocabulary shared with
  `src/lib/asset-completeness.js` to NULL.
- **An implausible vintage is no vintage.** The template writes `0` in Vintage on
  576 sample rows. Carried through, the component is 2,025 years old and its
  whole lifecycle is back-dated. `importedVintage` keeps only a year of 1800 or
  later that is not more than five years after the assessment year.
- `mapRowToAssetFields` **stores inputs, not the workbook's computed columns.**
  The unit replacement cost is kept as `unit_cost_override`; quantity, unit,
  vintage, normal life, and the life adjustment are stored as-is. Action year,
  adjusted unit cost, OPC, planning term, and CRV/FCI are then **recomputed by
  the shared engine** from those inputs (see
  [capital-planning](capital-planning.md)). The workbook OPC is carried only as
  an override when there is nothing to recompute it from (no quantity and no unit
  cost). Because `date_of_assessment` is set to `<baseYear>-01-01` and the
  building's `location_factor` comes from the Legend, the engine reproduces the
  workbook's derived columns — e.g. Pines Lodge's foundation, vintage 1976 with a
  100-year life, yields action year 2076, and its $25 reference cost at location
  factor 1.02 adjusts to $26.

## Re-import: matching by import key

Every imported row carries a stable **import key** (`importKeyFor`) — the
workbook Sheet ID where the template supplies one (unique across all 3,179 rows
that have one in the sample), otherwise the row's Site ID + Uniformat
classification + asset name, plus an occurrence number so a building that
genuinely lists the same component twice keeps two distinct assets.

**The key must never depend on where the row sits.** It used to fall back to
`<siteId>-r<row>` — the spreadsheet row number — for the 912 sample rows with no
Sheet ID. Inserting or deleting a single line above them re-keyed every one, so
the next import inserted a second copy of each instead of updating it: duplicate
asset records, and a duplicate page apiece in the report. `asset(building_id,
import_key)` is now a unique index (schema v12), so the database refuses a second
copy even if a key ever collides again; the v12 migration suffixes any duplicates
an older build already created rather than deleting them, because the duplicate
may be the row the user attached photos and findings to, and the pre-export
review reports what is left to merge by hand.

**Rows an older build imported are adopted, not duplicated.** A database written
before this change holds row-number keys that the content-derived scheme can
never produce, so the first re-import would have inserted a second copy of all
912 of them — reproducing the very duplication the change prevents.
`planWorkbookImport` recognizes an asset in the same building with the same
pricing row and asset name whose key still has the legacy `<siteId>-r<row>`
shape. **Add new only** treats that as an existing row and leaves even its key
untouched; **Update existing + add new** moves it onto the stable key (counted
as `summary.rekeyedAssets`) and updates it. Each legacy row is matched at most
once, so a building that genuinely lists the same component twice keeps two
distinct assets. Adoption happens on the first update import and never again.

The key is stored on the asset (`asset.import_key`) and the building's Site ID on
`building.site_id`. On a second import of a revised file:

- **Add new only** (`mode: 'new'`) inserts rows whose import key is not already
  present and leaves existing rows untouched — the safe default.
- **Update existing + add new** (`mode: 'update'`) refreshes the workbook-sourced
  fields of a matched asset and inserts the rest.

Either way **photos are never touched** — re-importing a spreadsheet never
disturbs the assessment photos already attached to an asset. Both
`previewImport` and `applyImport` consume the same read-only import plan. New and
unresolved counts therefore match apply; the preview's update count identifies
rows eligible for **Update existing + add new**, while **Add new only** reports
those rows as skipped instead.
The preview still lists a workbook site whose every row is unresolved so the
skipped rows remain visible, but it counts that site as a new building only when
at least one resolved asset will cause apply to create it.
That planner also preloads the Uniformat catalogue once instead of querying it
up to three times for every one of the 4,091 sample rows.

## Entry point

`Import from Excel` on the home page (enabled once a project is selected) calls
the `importBcaWorkbook(projectId)` surface method → the `bca:import` main-process
handler. The handler runs the whole flow with native dialogs, matching
`app-data:import`: pick the file, parse it, and — if there are no blocking errors
— show a preview (building count, new vs. updated assets, skipped rows) with the
`Add new only` / `Update existing + add new` / `Cancel` choice. On commit it
returns the summary; the renderer refreshes the property list and shows a toast.
Workbook read errors, template problems, and an empty workbook are reported as
their own dialogs and abort before any write.

### Progress overlay

Reading a ~4 MB workbook and committing its thousands of rows both run
synchronously in the main process, which stops the window repainting — several
seconds in which the app simply looks frozen. The handler therefore announces
each blocking step on `bca:import-phase` (`onImportPhase` in the IPC surface),
and the home page shows the `#import-modal` overlay with that label while it
runs. The same message takes the app-wide busy lock (`setBusyTask('Excel
import')`), so navigation and quit are refused for the duration, exactly as the
report export and bulk AI generation do.

The handler sends `null` before every native dialog, so the user never answers a
question with a "working…" overlay behind it, and a `finally` clears the phase on
every exit path — a throw that stranded the lock would leave the app unable to
navigate or quit at all.

The overlay is indeterminate on purpose: the main process is blocked, so there
is no progress to report, and an animated sweep is honest about that while still
showing the app is alive. `scripts/verify-excel-import.js` asserts it is
genuinely on screen during the freeze by recording it from inside the page — the
driver itself cannot observe a blocked main process, see [ui-driver](ui-driver.md).

## Tests and dependency

`test/import-bca.test.js` parses the bundled sample once at module scope (only
the `Worksheet` and `Legend` sheets, for speed), then imports all ~4,000 rows
into a fresh database, re-imports to prove no duplication — including a re-import
of the same workbook with every row shifted down, which is the case the old row-
number key failed — and asserts an imported building's report reproduces the
workbook's derived action year and adjusted cost through `getPropertyReportData`.

**Importing is not assessing.** The whole master library is imported and stays
editable in the app, but only rows carrying property-specific data reach the
report. In the sample that is 661 of 4,091 rows: a building the assessor walked
(Pines Lodge, 89 rows) keeps all of them, while an untouched one (Playfair Lodge,
185 rows) contributes the three somebody actually recorded something about. See
[property-report](property-report.md) for the rule.

`test/acceptance.test.js` is the requirements' end-to-end acceptance test: it
imports the sample project, generates the project report, builds the Word
document from that same snapshot, and asserts the two agree on CRV, FCI, and
action years, with no incomplete-asset pages and no formula errors in the
output.

`scripts/verify-excel-import.js` proves the button is wired in the **live
window**: it clicks **Import from Excel** and confirms the real handler imports
the sample and refreshes the property list. Because no driver can dismiss the OS
file picker, the handler takes the file path and mode from
`CONDITION_ASSESSMENT_AUTO_IMPORT` / `CONDITION_ASSESSMENT_AUTO_IMPORT_MODE`
instead of the dialogs when those are set (mirroring `CONDITION_ASSESSMENT_AUTO_DOCX`);
everything else runs for real. It is part of `npm run verify:ui` and both CI UI
workflows — see [ui-driver](ui-driver.md).

`xlsx` (SheetJS) is pure JavaScript, so it bundles into the Electron package with
no native build. The npm registry package stopped at the vulnerable 0.18.5;
`vendor/xlsx-0.20.3.tgz` is therefore the exact official CE tarball and
`package.json` installs that local file. Its SHA-512 and installed version are
locked by `test/dependency-security.test.js`. The source tarball itself is
excluded from the packaged app because the installed `node_modules/xlsx` is the
runtime copy. `xlsx` is required lazily inside the handler so it stays out of
the app's startup path.
