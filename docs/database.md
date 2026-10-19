# Database

All persistence is a single SQLite file managed by `src/db.js` through `better-sqlite3`. The DB path is `app.db` under Electron's `userData` directory. The connection is a module-level singleton opened lazily by `openDatabase()` and reused for every query.

## Live file replacement detection

Development tools can replace `app.db` while the app is running. `openDatabase`
compares the open file identity with the path on disk and reopens when they
differ. The first caller to notice may be any data-access function (for example,
home bootstrap can call `listProjects` before the focus-time check), so detecting
a replacement sets a latch. `ensureDatabaseCurrent()` consumes that latch
exactly once; reopening the connection in an earlier query cannot erase the
signal.

The main-process consumers of that signal clear undo/redo and increment the AI
workspace epoch. AI persistence calls `ensureDatabaseCurrent()` before every
caption/summary read and write. A changed identity invalidates queued and
in-flight work before the reused numeric row ids are read or written, and the
AI worker rechecks its epoch after each persistence hook. An HTTP response from
the old file therefore cannot land in a same-id row in the replacement file.
Intentional full-workspace import invalidates these states before its own
close/swap/open transaction.

## Versioning policy

**Databases are migrated forward, only when the user says so.** Every database records the schema it was written for in `PRAGMA user_version`; `SCHEMA_VERSION` in `src/db.js` is the version this build requires.

On open, `inspectDatabase` classifies the file *before* anything is written to it:

| State | Meaning | What happens |
|---|---|---|
| `fresh` | No tables yet | `schema.sql` is applied and stamped with `SCHEMA_VERSION` |
| `current` | Already at `SCHEMA_VERSION` | Opens normally |
| `needs-migration` | Older, migratable shape | `DatabaseMigrationRequiredError` — startup **prompts the user** |
| `too-new` | Written by a newer release | `IncompatibleDatabaseError` — install the newer release |
| `unsupported` | Shape with no migration path (e.g. pre-1.0 `element`/`section` tables) | `IncompatibleDatabaseError` — offer to start a new data file |

Databases written by releases **1.0.0–1.0.2** predate `user_version` and report 0. They all shipped the same schema, which is version 1 and is detected by shape (`RELEASE_1_SIGNATURE`). An unstamped database that already matches the current schema — a dev DB built before versioning existed — is adopted silently, because there is nothing to migrate.

"Matches the current schema" is decided by `describeSchemaIncompatibility`, which compares the file against a database built from `data/schema.sql` itself: every table's columns, types, NOT NULL, defaults, primary keys, foreign keys and indexes. It deliberately does not use a hand-maintained list of expected columns — a list that has to be updated by hand is a list that gets forgotten, and a forgotten entry means stamping a database as current that the code cannot actually query. The comparison is pragma-derived rather than text-derived because `ALTER TABLE ADD COLUMN` leaves a migrated table's stored `CREATE TABLE` text different from a freshly created one even when the two are structurally identical.

Before classification and again after a fresh create/migration,
`src/database-integrity.js` runs SQLite `quick_check` plus
`foreign_key_check`. Enabling foreign keys only constrains future writes; the
explicit check is what refuses orphan rows already present in a copied or
hand-edited current database. Integrity failures use the same incompatible-file
recovery path rather than handing a corrupt handle to normal queries. Imported
databases are checked through the same module while still staged; see
[app-data-backups](app-data-backups.md).

### Migrating

Nothing is upgraded in the background. `src/main.js` catches `DatabaseMigrationRequiredError`, shows a dialog naming the version change and summarising what each pending step does, and only calls `db.migrateDatabaseWithBackup()` if the user picks **Update Data File**. That helper:

1. snapshots `app.db` to `app.db.v<from>-backup-<timestamp>.bak` **beside** the live file, before altering anything;
2. runs every pending step from `MIGRATIONS` in one transaction, with `foreign_key_check` verified before commit;
3. restores the snapshot over `app.db` if anything fails, so the user is never left with a half-migrated file.

The snapshot is taken with `VACUUM INTO`, not a file copy. A plain copy of a live SQLite file is not a valid backup: it takes no lock, so a concurrent writer can tear it, and it leaves behind any `-journal`/`-wal` sidecar the file depends on to be consistent. `VACUUM INTO` writes a complete, self-contained, transaction-consistent database in one operation, and preserves both `user_version` and `sqlite_sequence`.

`restoreDatabaseFile` puts the snapshot back without ever exposing a partly-written `app.db`. Copying straight over the live file is not atomic — an interruption mid-copy truncates it, which is worse than the failed migration being recovered from — so the copy lands at `app.db.restoring`, is `fsync`ed, and is then `rename`d into place (atomic, and on Windows libuv maps `rename` to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` so it overwrites). Stale sidecars are cleared **before** the rename, not after: they describe the file being replaced, and SQLite would apply that journal to the restored copy and corrupt it. In that order every interruption point leaves either the old file or the restored one, never a good file with a bad journal.

If restoring also fails, `DatabaseRestoreFailedError` carries both failures and the backup path. It is typed rather than a plain `Error` because the user-facing advice inverts: after an ordinary migration failure the live file is untouched, but here it may be unusable and the `.bak` is the only complete copy. `promptForMigration` branches on that type, so the dialog never tells the user their data file was left unchanged when it was not.

The backup is never deleted. It stays openable by the release that wrote it.

`CONDITION_ASSESSMENT_RESET_DB=1` performs the same upgrade without a prompt — for CI and for users who cannot reach the dialog.

### Adding a migration

1. Edit `data/schema.sql`.
2. Bump `SCHEMA_VERSION` in `src/db.js`.
3. Append a step to `MIGRATIONS` with the new `to` version and a `summary` written for the user — it is shown verbatim in the upgrade prompt.
4. Migration steps are **frozen once released**: they run against old shapes, so they must spell out their SQL rather than read `schema.sql`.

`test/db-migrations.test.js` enforces this. It migrates the frozen `test/fixtures/schema/v1.sql` fixture and asserts the result is structurally identical to a freshly created database, so changing `schema.sql` without a migration fails the suite. `schema.sql` is not run after migrations, so it cannot silently fill a missing table/index and mask an omitted step. Its fingerprint is written independently of `describeSchemaIncompatibility` on purpose: two implementations that have to agree catch a blind spot in either, where a shared helper would hide one.

Column *types* cannot be altered in place in SQLite. Retypes need a table rebuild — see `rebuildAssetTableForV2`, which is how `asset.action_year` went TEXT → INTEGER. Values are copied straight across so column affinity converts numeric strings (`'2029'` → `2029`) while leaving genuine text (`'TBD'`) intact.

Two things a table rebuild has to get right, both of which are silent when wrong:

- **Copy the intersection of the old and new column lists, not a hardcoded one.** Dev builds between 1.0.2 and 2 already grew some v2 columns while still reporting version 0, so they are detected as version 1 and rebuilt; a hardcoded legacy list blanks out whatever they had stored. `test/fixtures/schema/v1-dev-capital-planning.sql` freezes one such shape.
- **Carry `sqlite_sequence` across.** `DROP TABLE` deletes the table's row there, so `AUTOINCREMENT` would restart from the highest *surviving* id and reissue ids belonging to deleted rows — the exact thing `AUTOINCREMENT` exists to prevent. The rebuild restores `max(previous, migrated)`.

The app version (`package.json` / `app.getVersion()`) is shown in the Help menu and Settings → About so operators can match data to a release.

## Schema (`data/schema.sql`)

Applied only when creating a fresh database. Current files must already match it,
and older files reach it exclusively through the explicit migration chain; the
app never uses `CREATE ... IF NOT EXISTS` as a silent repair path. Tables:

| Table | Purpose | Key columns |
|---|---|---|
| `project` | Top-level client engagement | `id`, `client`, `hidden`, `deletion_snapshot` while soft-deleted |
| `firm` | Single-row consultant firm record | `id` (fixed), `name`, `short_name`, address lines, `logo_path` |
| `building` | A property assessed under a project | `project_id` → project, `property_name`, address, `gross_floor_area_m2`, `property_vintage`, `date_of_assessment`, `num_floors`, `location_factor_province`, `location_factor_city`, `location_factor` (default 1), `current_replacement_value` (optional CRV override) |
| `executive_summary` | One narrative row per building | `building_id` → building, twelve TEXT sections (accessibility, designated_substance_survey, architectural_structural, plumbing, mechanical, electrical, fire_life_safety, site, code_compliance, immediate_concerns, facility_overview, capital_needs) |
| `uniformat_pricing` | Reference catalogue seeded from CSV | `pricing_id` (PK), level 1–4 codes/descriptions, `material`, `mean_service_life`, `practical_life`, `unit_price`, `unit_of_measure` |
| `asset` | A building component being assessed | `building_id` → building, `uniformat_pricing_id` → uniformat_pricing, `asset_name`, `vintage`, `service_life`, `description`, `recommendation`, `condition_rating`, `priority`, `action`, optional `term` override, `conservation_lens`, `unit_measure`, quantity/cost/life/action-year overrides, `import_key`, `hidden`. **`(building_id, import_key)` is UNIQUE** where `import_key` is set, so re-importing a revised workbook can never insert a second copy of a row it already holds — see [excel-import](excel-import.md). |
| `asset_image` | Photos attached to an asset | `asset_id` → asset (ON DELETE CASCADE), `file_path`, `original_name`, `caption`, `bounding_boxes`, `include_in_report` (1 = appear in the exported property report; new imports include the first six by default), `sort_order` |
| `building_image` | Photos attached to a building | `building_id` → building (ON DELETE CASCADE), `file_path`, `original_name`, `caption`, `bounding_boxes`, `sort_order` |

Schema v8 adds `project.deletion_snapshot`. When a project is deleted, the app stores the exact visible descendants that were hidden with it. Settings uses that snapshot to recover the project after restart without restoring a property, asset, photo, or executive summary that the user had already deleted separately. A project hidden by an older version has no snapshot, so its first recovery falls back to its stored descendants.

Schema v9 drops the retired Temporary Shares tables (`temporary_share`, `temporary_share_extension`, `temporary_share_audit`, `temporary_share_return`) and the project import-provenance columns (`imported_from_license_id`, `imported_at`). Those objects are not part of the current schema. Historically, v5 added them, v6 reshaped the share expiry columns, and v7 dropped the recipient-machine columns; none of that is a live feature. See [temporary-shares-retired](temporary-shares-retired.md).

`PRAGMA foreign_keys = ON` is set on every open.

## Seeding

### Uniformat pricing (`seedUniformatPricing`)

Called on every open. Reads the working Uniformat pricing CSV under userData (resolved by `src/app-settings.js`; see [uniformat-pricing](uniformat-pricing.md)), upserts every row by `pricing_id`, then deletes pricing rows no longer present in the CSV — unless they are still referenced by an `asset.uniformat_pricing_id` (those are kept to preserve referential integrity). The whole operation runs inside a transaction.

`seedUniformatPricingRecords(database, records)` is the in-memory upsert that `seedUniformatPricing` calls after parsing the CSV: same transaction, same orphan-protection delete, taking an explicit handle and already-parsed rows.

### Dummy data (`seedDummyDataIfEmpty`)

Optional. Default is **on in unpackaged dev**, **off when `app.isPackaged`**. When enabled and the `project` table has zero rows (including soft-deleted), executes `data/dummy_data.sql`. The SQL file is not shipped in releases; missing file is a no-op. See [dummy-data](dummy-data.md).

## Data-access functions

`src/db.js` exports prepared-statement wrappers grouped by entity:

- **Projects**: `listProjects`, `listDeletedProjects`, `getProject`, `createProject`, `updateProject`, `deleteProject`, and `restoreDeletedProject`. Project deletion writes `deletion_snapshot`; recovery uses it to restore only the rows that were visible at deletion.
- **Firm**: `getFirm` (returns a hardcoded default object when no row exists), `updateFirm` (upsert keyed on `id`).
- **Buildings**: `listBuildings`, `getBuilding`, `createBuilding`, `updateBuilding`.
- **Location factors**: `listLocationFactors` reads and caches `data/location_factors.csv`.
- **Asset capital preview**: `previewAssetPlan(assetId, formValues)` merges live form/pricing values, replaces that row in a full building calculation, and returns the per-asset chain plus live building FCI/CRV.
- **Executive summary**: `getExecutiveSummary` (returns nulls for missing rows), `updateExecutiveSummary` (delete + insert in a transaction).
- **Assets**: `listBuildingAssets(buildingId, level1GroupName?)` returns assets joined with pricing; `createAsset` picks the first pricing row for the level-1 code and copies building vintage plus catalogue mean/practical life defaults; `updateAsset` writes all editable fields. Per-asset FCI was removed in schema version 4 because the calculation belongs to the building.
- **Property report aggregate**: `getPropertyReportData` includes `capitalPlan` from `src/lib/capital-planning.js` (see [capital-planning](capital-planning.md)).
- **Building capital plan**: `getBuildingCapitalPlan(buildingId)` returns `calculateCapitalPlan(...)` for one building without any project context, for AI executive-summary prompts. Returns `null` when the building is missing.
- **Images**: `listBuildingImages`, `createBuildingImage`, `listAssetImages`, `createAssetImage`. These delegate to shared `listImages` and `createImageRow` helpers that parameterize the table and owner column. Image-returning APIs also attach `media_url` alongside `file_path`; on this desktop app that URL is always a `file://` from `toFileUrl`. Renderers prefer `media_url` and fall back to `file_path`.
- **Uniformat hierarchy**: `listUniformatLevel1Groups`, `listUniformatLevel2Groups`, `listUniformatLevel3Groups`, `listUniformatLevel4Groups`, `listUniformatPricingItems`. See [uniformat-pricing](uniformat-pricing.md).
- **Report aggregate**: `getPropertyReportData(projectId, buildingId)` returns `{ project, firm, building, buildingImages, executiveSummary, assets[] }` where each asset includes its `images[]`. Returns `null` if the project/building pair is invalid or mismatched.

`level1CodeFromName` extracts the leading whitespace-delimited token from a level-1 group display name (e.g. `"A Substructure"` → `"A"`) and is used as the filter key for the hierarchy queries.
