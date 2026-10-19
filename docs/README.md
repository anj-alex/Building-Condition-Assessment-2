# Documentation index

- [editing-model](editing-model.md) — App-wide autosave + undo/redo (intended behaviour for all editors).
- [architecture](architecture.md) — App entry points, process model, and file layout.
- [electron-main-process](electron-main-process.md) — IPC handlers, page navigation, image/file management in `src/main.js`.
- [database](database.md) — SQLite schema, schema versioning and user-approved migrations, and the `src/db.js` data-access layer.
- [app-data-backups](app-data-backups.md) — Portable `.projectdata` export/import, archive validation, media rebasing, and crash-safe workspace replacement.
- [ai-photo-labels](ai-photo-labels.md) — OpenRouter vision captions, startup session key (no unlock password), `.env` key + auto secret sync.
- [uniformat-pricing](uniformat-pricing.md) — Working CSV path under userData, catalogue format, seed logic, level 1–4 hierarchy.
- [capital-planning](capital-planning.md) — Extracted cost rules, location factors, OPC/CRV/FCI engine, and constant-dollar assumptions.
- [workbook-calculation-reference](workbook-calculation-reference.md) — Literal sample-workbook formulas, column mappings, observed evidence, and reasons for intentional app divergences.
- [excel-import](excel-import.md) — Importing a client BCA Excel workbook into a project: the parser, the importer, re-import matching by import key, and the New/Update flow.
- [home-page](home-page.md) — Project/property selection, asset editing, and entry to Settings (`src/renderer*.js`).
- [project-setup](project-setup.md) — Project create/edit form (`src/project-setup.js` / `pages/project-setup.html`).
- [firm-setup](firm-setup.md) — Firm details and logo management (`src/firm-setup.js` / `pages/firm-setup.html`).
- [building-info](building-info.md) — Building create/edit form and property photos (`src/building-info.js` / `pages/building-info.html`).
- [executive-summary](executive-summary.md) — Per-building narrative summary editor (`src/executive-summary.js` / `pages/executive-summary.html`).
- [property-report](property-report.md) — DOCX-authoritative preview lifecycle,
  validation/staleness gate, and exact-artifact save flow (`src/property-report.js`
  / `pages/property-report.html`).
- [word-export](word-export.md) — the delivered Word document, its content and
  layout model, image handling, and the limits of browser-side DOCX rendering
  (`src/docx-report.js` / `src/lib/report-content.js`).
- [report-wording](report-wording.md) — the client's report-text template: what it changed, what was already true, and where the implementation deviates (`src/lib/report-content.js`).
- [styles](styles.md) — CSS organization, dark/light theme system, form layouts,
  and the Word-preview shell.
- [local-db-loader](local-db-loader.md) — `load-local-db.sh` and the `write-uniformat-pricing-sql.js` SQL generator for dev seeding.
- [dummy-data](dummy-data.md) — Sample firm, projects, buildings, assets, and executive summary in `data/dummy_data.sql`.
- [dev-environment](dev-environment.md) — Install, run, unit tests (`npm test`), build, and dev DB (already inside the env).
- [ui-driver](ui-driver.md) — Driving the real app over CDP (`npm run verify:ui`), and the Electron gotchas that come with it.
- [temporary-shares-retired](temporary-shares-retired.md) — Temporary Shares is retired. Do not rebuild the dashboard, the Share Viewer, or a desktop `.carshare` pipeline.
- [releasing](releasing.md) — The Release Desktop workflow, the Verify Desktop pre-release gate, version bumps, required repo permissions, artifact retention, and the Azure mirror.
- [post-shares-cleanup](post-shares-cleanup.md) — Completed record of the cleanup and test-hardening pass that followed the Temporary Shares removal: the Windows verification gate, the `src/main/` decomposition, and the coverage ratchet.

## Notes

- These docs are AI-generated, after-the-fact, and implementation-accurate (not design-accurate).
- Information is not repeated across files; each topic lives in exactly one file. When a detail spans two topics, it is documented in the better-fit file and referenced from the other.
- Experiments and dead-ends should get their own doc files.
