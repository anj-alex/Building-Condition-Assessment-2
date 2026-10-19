# Uniformat pricing catalogue

The app uses a Uniformat II-based pricing reference to classify building assets and supply default service-life / unit-price data. The shipped catalogue is `data/uniformat_pricing.csv`, deterministically assembled by `scripts/extract-bca-reference-data.py` from the sample BCA workbook plus the hand-maintained `data/uniformat_pricing_supplement.csv` (see [capital-planning](capital-planning.md)). At runtime the app seeds SQLite from a **working copy** under userData (see below).

## Working CSV path (`src/app-settings.js`)

Operational path is always the stable file under userData:

```
<userData>/uniformat-pricing.csv
```

| Concern | Behavior |
|---|---|
| First launch / missing working file | Copy bundled `data/uniformat_pricing.csv` into that path (`ensureUniformatPricingCsv`) |
| Settings → choose a CSV | Parse once, reject empty/duplicate-id catalogues, then install the SQLite rows, working copy and settings as one recoverable operation (`installUniformatPricingCsv`). A database failure restores the prior file/settings; a file failure occurs before the database callback. The app never keeps reading the user's original path for seeding. |
| Display identity | `app-settings.json` stores `uniformatPricingCsvPath` (working path), plus `uniformatPricingCsvSourceName` / `uniformatPricingCsvSourcePath` (basename and full path of the last pick) so Settings can show which file the user chose |
| Missing configured path | If settings point at a path that no longer exists, all three keys are cleared and the bundled default is restored |
| Import of app data | `normalizeImportedUniformatPricingPath` rewrites every non-empty imported operational path — regardless of the foreign file's basename — to the included local working copy. Source path/name fields remain display metadata only. See [app-data-backups](app-data-backups.md). |

`getUniformatPricingCsvInfo()` returns `{ path, fileName, sourcePath, customPath, isDefault }` for the Settings UI and IPC (`uniformat-pricing:getCsvPath`, `chooseCsv`, etc.). `fileName` prefers the last chosen basename when a custom working path is active.

`seedUniformatPricing` and `openDatabase` resolve the CSV via `appSettings.getUniformatPricingCsvPath()`.

## CSV format

Bundled `data/uniformat_pricing.csv` has a blank first row, then a header row starting with `Uni-Format Pricing ID`, then 1,774 data rows: 1,773 extracted workbook rows plus one declared supplement row. Required columns (exact names):

- `Uni-Format Pricing ID` (TEXT primary key, e.g. `30004879` or `SUPP-C3300-01`)
- `Level 1` / `Level 1 Description` (e.g. `A` / `Substructure`)
- `Level 2` / `Level 2 Description` (e.g. `A10` / `Foundations`)
- `Level 3` / `Level 3 Description` (e.g. `A1010` / `Standard Foundations`)
- `Level 4` / `Level 4 Description` (e.g. `A1010` / `Standard Foundations`)
- `Material` (free text, e.g. `"Foundation Wall, Concrete, No Basement"`)
- `Mean Service Life (yrs)` (integer or blank)
- `Practical Life (yrs)` (integer or blank)
- `Unit Price` (text via `cleanCsvValue` — keeps `$` and other non-space characters; leading/trailing whitespace is trimmed)
- `Unit of Measure` (e.g. `Linear Feet`)

The parser (`parseCsv` in `src/lib/csv-utils.js`) is a hand-rolled state machine that handles quoted fields, doubled-quote escaping, and `\r\n` / `\n` / `\r` line endings. A header-only catalogue and duplicate `pricing_id` values are rejected before seeding; accepting zero rows would otherwise make the later stale-row cleanup erase the usable catalogue. Unit tests live in `test/csv-utils.test.js` and `test/app-settings.test.js` (see [dev-environment](dev-environment.md)).

### Supplement

`data/uniformat_pricing_supplement.csv` has the same 14-column contract and is an input to extraction, not a manual edit to the generated output. It exists for Uniformat groups the workbook prices nowhere. Today that is one group: `C33 / C3300 Accessibility (AODA)`, which no catalogue row reaches at any level, so without it an assessor cannot record accessibility work at all. IDs use the collision-free `SUPP-…` namespace. The row carries observed service-life and unit defaults but intentionally leaves `Unit Price` blank, so the calculation preview reports a missing catalogue price until the assessor supplies a unit-cost or OPC override.

**A code the catalogue files under a different parent is not a gap.** The workbook Worksheet derives its Level 3 as `LEFT(<Level 4>,5)`, and every catalogue code is exactly five characters, so that column always just repeats Level 4 and says nothing about the hierarchy. `G2034 Guardrails & Barriers`, `C2012 Exterior Stair Construction`, and `G2043 Exterior Furnishings` all ship as priced Level-4 rows (under `G2030`, `C2010`, and `G2040`); adding blank-price Level-3 twins for them would create a second, unpriced path to the same components and hide the real prices behind it.

`render_outputs()` verifies the workbook count (1,773) and supplement count (1) independently, rejects duplicate IDs across both inputs, and emits their concatenation. `--check` therefore still catches hand-edits to `uniformat_pricing.csv`, while an intentional supplement edit remains reproducible.

## Seeding logic (`seedUniformatPricing`)

1. `readUniformatPricingRows` finds the header row by searching for `Uni-Format Pricing ID`, maps each subsequent row to a record, and validates that all level 1–4 code/description fields are present (throws with the CSV source row number on failure). Empty `Uni-Format Pricing ID` cells are skipped.
2. Each record is upserted by `pricing_id` (`ON CONFLICT DO UPDATE`), so editing the CSV and relaunching updates existing rows.
3. A temp table `current_uniformat_pricing_ids` collects every pricing_id from the CSV.
4. Pricing rows whose id is not in the temp table are deleted — **unless** an `asset.uniformat_pricing_id` still references them (the `assetHasPricingId` guard). This prevents orphaning assets when a pricing row is removed from the CSV.
5. The temp table is dropped and the transaction commits.

This runs on every `openDatabase()`, so the in-app catalogue always reflects the current **working** CSV contents.

Existing installs keep their userData working copy until it is rebuilt (Settings → choose CSV, or delete the working file so the next launch re-copies the bundled catalogue). Regenerating `data/uniformat_pricing.csv` does not silently refresh prices already copied into userData — consistent with the project’s rule that nothing about a user’s data changes without them asking.

### Seeding without a path (`seedUniformatPricingRecords`)

`seedUniformatPricing(database, csvPath)` reads the file and delegates to
`seedUniformatPricingRecords(database, records)`; `readUniformatPricingRows(path)`
reads the file and delegates to `parseUniformatPricingRows(text)`. Everything
above step 1 is identical either way. The records helper is the in-memory
upsert, so tests and the CSV path share one write. `test/csv-utils.test.js` and
`test/db-initialization.test.js` pin the two entry points to identical results
so they cannot drift apart.

## Hierarchy queries

The UI drills down through four levels. Each query groups by code+description and orders by code:

| Function | Filters by | Returns |
|---|---|---|
| `listUniformatLevel1Groups` | — | `level_1_code`, `level_1_description`, `name` (`"<code> <description>"`) |
| `listUniformatLevel2Groups(level1GroupName)` | level-1 code extracted from the group name | `level_2_code`, `level_2_description`, `label` |
| `listUniformatLevel3Groups(level1GroupName, level2Code)` | level-1 code + level-2 code | `level_3_code`, `level_3_description`, `label` |
| `listUniformatLevel4Groups(level1GroupName, level2Code, level3Code)` | + level-3 code | `level_4_code`, `level_4_description`, `label` |
| `listUniformatPricingItems(level1GroupName, level2Code, level3Code, level4Code)` | all four codes | `pricing_id`, `label` (material, falling back to level-4 description), `unit_of_measure`, mean/practical life |

`level1CodeFromName` splits the level-1 group display name on whitespace and takes the first token as the code (e.g. `"A Substructure"` → `"A"`).

## How assets use it

An `asset.uniformat_pricing_id` foreign key ties each assessed component to a pricing row. `listAssets` and `listBuildingAssets` join `asset` to `uniformat_pricing` so the renderer gets the full level-1–4 hierarchy and material label alongside the asset's own fields. `createAsset(buildingId, level1GroupName)` picks the first pricing row for the level-1 code (ordered by level 2/3/4 + material) and prefills `service_life` from catalogue mean life (practical life fallback). It deliberately does **not** store the building vintage as the component vintage; the form may display that fallback and the capital engine may schedule from it, but a borrowed construction year is not presented as an assessor-entered asset fact.

The home-page asset form hydrates four cascading `<select>` dropdowns (level 2 → 3 → 4 → material) from these queries. A pricing change refreshes service-life and unit defaults only while the assessor has not touched those fields; see [home-page](home-page.md).
