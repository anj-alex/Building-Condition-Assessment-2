# Architecture

Electron desktop application for producing Building Condition Assessment (BCA/FCA) reports. The app is a single-window Electron process backed by a local SQLite database (`better-sqlite3`). There is no server component and no companion Viewer — all data and images live on the user's machine.

## Process model

- **Main process** (`src/main.js`): a thin composition root that owns the `BrowserWindow`, app lifecycle, file dialogs, and page loading, and wires real Electron objects into the dependency-injected modules under `src/main/` — `ipc-handlers.js` (every IPC channel), `startup.js` (database open + migration/reset prompts), `menu.js` (application menu), `paths.js` (image directories + copies), `report-export.js` / `atomic-file.js` (prepared DOCX ownership and authorized durable report writes), and `linux-desktop.js` (`.desktop` integration). Splitting the logic out of the load-time `whenReady` path is what makes it unit-testable. See [electron-main-process](electron-main-process.md).
- **Preload** (`src/preload.js`): a sandboxed preload cannot require siblings, so it exposes allowlisted `invoke` / `on` transport methods as `window.appBridge`; a drift test keeps its duplicated channel sets equal to `src/ipc-surface.js`. Pages then build the named `window.electronAPI` in page scope via `src/renderer-api.js`. Context isolation is on, node integration is off, and sandbox is enabled — renderer code never touches Node directly.
- **Renderer**: vanilla JavaScript (no framework). Each page ships its own `.js` file that reads `window.electronAPI` and manipulates the DOM directly. Pages communicate selection state through the URL hash (e.g. `#1001` for a project, `#1001:1001` for project + building).

## File layout

```
src/main.js              – Electron main process: thin composition root (lifecycle, window, .env, smoke-test hooks)
src/main/ipc-handlers.js – Every IPC channel registration (registerIpcHandlers, dependency-injected)
src/main/startup.js      – Database open with migration/reset prompts + pre-migration backup
src/main/menu.js         – Application menu template (version from app.getVersion())
src/main/paths.js        – userData image directories + image copy/safeUnlink helpers
src/main/linux-desktop.js – User-level .desktop entry + hicolor icon integration
src/main/window-close.js – Bounded renderer-draft flush handshake for normal window close
src/main/report-export.js – Prepared-DOCX ownership, snapshot fingerprints, save-path capabilities, relevant-AI matcher
src/main/atomic-file.js  – Adjacent fsynced temp + atomic report replacement
src/preload.js           – Allowlisted contextBridge (`window.appBridge` invoke/on)
src/ipc-surface.js       – Named `window.electronAPI` methods (one per channel)
src/renderer-api.js      – Page shim: builds `electronAPI` over `window.appBridge`
src/db.js                – SQLite open, schema versioning + migrations, and all data-access functions
src/database-integrity.js – Shared SQLite quick_check + foreign_key_check invariant
src/file-durability.js   – Strict cross-platform flush for existing regular files
src/app-settings.js      – userData app-settings.json + working Uniformat pricing CSV path
src/undo-history.js      – In-memory undo/redo stacks (session lifetime; home-page edits)
src/app-data-io.js       – Validated `.projectdata` export/import + durable workspace replacement
src/lib/csv-utils.js     – Shared CSV parsing + Uniformat pricing reader (used by db.js and scripts/)
src/lib/annotations.js   – Photo-annotation shape contract + drawing (used by db.js, renderer-photos.js, docx-report.js)
src/docx-report.js       – Authoritative DOCX builder (content, Word layout, image conversion/annotation fallbacks)
src/property-report.js   – Word-derived preview controller, validation gate, stale/rebuild/save state
src/lib/property-report-rules.js – Canonical report taxonomy (capital/CRV/FCI rows; see [property-report](property-report.md))
src/renderer.js          – Home page controller (project/property lists, building detail, asset list, undo, bootstrap)
src/renderer-asset-form.js – Home page asset editor (field schema, Uniformat cascade, generated text, autosaving form)
src/renderer-photos.js   – Home page photos (asset photo strip, annotated thumbnails, gallery + annotation editor)
src/shared.js            – Renderer utilities loaded on every page (toFileUrl, formTextValue, unit-measure helpers, etc.)
src/theme.js             – Applies light/dark/system theme preference on every page
src/settings.js          – Settings page (theme radiogroup + Uniformat pricing CSV)
src/*.js (per page)      – Page-specific renderer scripts (building-info, firm-setup, etc.)
pages/*.html             – One HTML file per screen (including settings.html)
styles/*.css             – Stylesheets (see [styles](styles.md))
data/schema.sql          – Fresh-database table definitions (existing files change only through migrations)
data/uniformat_pricing.csv – Bundled seed catalogue (copied to userData as working copy; regenerated from sample workbook)
data/location_factors.csv – RSMeans locality factors for capital planning
data/capital_planning_rules.json – Term/horizon/rounding/CRV/FCI rules for the calculation engine
data/dummy_data.sql      – Sample firm, projects, buildings, assets, executive summary
scripts/run-tests.js     – Unit-test runner (Electron as Node; see [dev-environment](dev-environment.md))
scripts/write-uniformat-pricing-sql.js – Emits SQL INSERTs from the CSV (used by load-local-db.sh)
test/*.test.js           – Unit tests (node:test); helpers under test/helpers/
samples/                 – Reference BCA reports, sample worksheets, and Uniformat level reference
load-local-db.sh         – Dev helper: rebuilds a standalone SQLite DB from schema + CSV + dummy data
forge.config.js          – Electron Forge packaging config (asar, makers, fuses, icon)
assets/icon.png          – App icon (window/taskbar); master 1024² PNG
assets/icon.ico          – Windows multi-size icon (packager + Squirrel setupIcon)
```

## Data flow

1. Renderer calls `window.electronAPI.<method>(...)`.
2. `src/renderer-api.js` maps that method onto `window.appBridge.invoke('<channel>', ...)`.
3. `src/preload.js` verifies the channel is allowlisted, then forwards via `ipcRenderer.invoke('<channel>', ...)`.
4. The handler registered by `src/main/ipc-handlers.js` handles the channel, calls into `src/db.js`, and returns the result. Report preparation is the deeper exception: main gathers/fingerprints a snapshot, builds and retains immutable DOCX bytes, then returns a copy for the renderer to lay out.
5. `src/db.js` opens the singleton `better-sqlite3` connection (lazily, on first use), verifies SQLite/foreign-key integrity, classifies the database by schema version, applies `schema.sql` only when fresh, prompts before migrating an older file, and executes prepared statements.

## Packaging

`forge.config.js` configures Electron Forge with asar enabled and `better-sqlite3` unpacked from the asar (native module). Makers: Squirrel (Windows Setup `.exe`), zip (macOS/Linux app folder). Electron Fuses lock down Node integration, cookie encryption, and asar integrity. `postinstall` runs `electron-rebuild` for the native sqlite binding and Electron’s own `install.js` (Electron 43+ dropped the package postinstall hook, so a clean `npm ci` would otherwise leave `dist/` empty).

The packager **ignore** list excludes dev-only material from the asar: `data/dummy_data.sql`, `docs/`, `samples/`, `test/`, `scripts/`, `vendor/`, `.venv/`, `.github/`, `load-local-db.sh`, and similar. Runtime ships `src/`, `pages/`, `styles/`, `assets/`, `data/schema.sql`, `data/uniformat_pricing.csv`, `data/location_factors.csv`, `data/capital_planning_rules.json`, `package.json`, and production `node_modules`. `vendor/` contains the pinned SheetJS install tarball; the installed runtime copy already lives under `node_modules/xlsx`, so shipping both would only duplicate bytes.

`packagerConfig.icon` points at `assets/icon` (no extension); Electron Packager picks `.ico` / `.icns` / `.png` per platform. Squirrel uses `assets/icon.ico` as `setupIcon`. The main process loads `assets/icon.png` for the window, and on Linux also installs a user-level `.desktop` + hicolor icon so Wayland/X11 shells can show the mark (see [electron-main-process](electron-main-process.md)).

`npm run package` / `npm run make` load `scripts/fix-extract-zip.cjs` so Electron’s zip is extracted with `bsdtar` / `unzip` / `python3` when available (works around `extract-zip` hanging on some Node versions).

Packaged first launch seeds schema + Uniformat pricing only — never dummy firm/projects (see [dummy-data](dummy-data.md)). `npm run test:packaged` asserts the asar excludes those paths, that a fresh smoke-test DB has zero projects, that the window actually loads, and that an upgrade over an existing database prompts rather than dying — see [dev-environment](dev-environment.md).

## Running

- `npm start` — `electron-forge start` (launches the app with hot reload via `electron-reloader` in dev).
- `npm test` / `npm run test:packaged` — unit tests and packaged smoke test (see [dev-environment](dev-environment.md)).
- `npm run package` / `npm run make` — produce distributables.
- `./load-local-db.sh` — rebuild the dev database with schema, pricing seed, and dummy data (see [local-db-loader](local-db-loader.md)).

## Database location

The live database is `app.db` inside `app.getPath('userData')` (platform-dependent: `~/.config/condition-assesment-report-generator/` on Linux). Sibling directories under the same userData root hold images (`asset-images/`, `building-images/`, `firm-assets/`), the working Uniformat pricing CSV (`uniformat-pricing.csv`), and `app-settings.json`. See [database](database.md), [uniformat-pricing](uniformat-pricing.md), and [app-data-backups](app-data-backups.md).
