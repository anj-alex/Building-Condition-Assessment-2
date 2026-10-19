# Electron main process (`src/main.js`)

Owns the `BrowserWindow`, registers all `ipcMain.handle` channels, and mediates file-system access. Renderer code never imports Node modules — every capability is exposed through the preload bridge (see [architecture](architecture.md)).

## Module layout

`src/main.js` is a thin composition root: it keeps the parts that must run at load or lifecycle time — the early `uncaughtException`/`reportFatalStartupError` handler, `.env` loading, the smoke-test env reads, `whenReady`, and the lifecycle handlers — and delegates everything else to dependency-injected modules under `src/main/`:

- **`ipc-handlers.js`** — `registerIpcHandlers({ ipcMain, app, dialog, shell, db, … })` registers every channel; `configureCaptionPersistence({ db, captionService })` wires the AI persistence seam at `whenReady`.
- **`startup.js`** — `promptForMigration`, `promptForReset`, `openDatabaseWithRecovery`, each taking `{ dialog, db, shell, … }`.
- **`menu.js`** — `buildMenuTemplate({ version, appName, … })`.
- **`paths.js`** — userData image directories and `copyImageInto` / `safeUnlink`.
- **`linux-desktop.js`** — `.desktop` + hicolor icon integration (see below).
- **`window-close.js`** — request-identity, timeout, and failure policy for the renderer draft-flush handshake.
- **`report-export.js`** — sender-bound prepared-DOCX ownership, single-use save
  authorizations, stable report-snapshot fingerprints, and the relevant-AI job
  matcher.
- **`atomic-file.js`** — adjacent, fsynced temp-file replacement for completed report bytes.

Each module takes its Electron dependencies as arguments rather than reaching for `app`/`dialog` at module scope, which is what lets `test/ipc-handlers.test.js`, `test/main-startup.test.js`, `test/app-menu.test.js`, `test/main-paths.test.js`, `test/linux-desktop.test.js`, and `test/window-close.test.js` exercise them without a running Electron instance. `src/main.js` itself is validated by running the real app, not by unit coverage — it does nothing but wire real objects into these modules. In CI that is `npm run test:packaged`, which launches the packaged binary on both Verify Desktop legs, plus `npm run verify:ui`. Locally, `scripts/smoke-boot.sh` is a quick headless boot check of the same path; it is bash-only and no workflow runs it.

## Window lifecycle

`createWindow()` builds a single 1280×720 `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `src/preload.js` loaded, and `icon` loaded from `assets/icon.png` via `nativeImage` (plus `win.setIcon` after create). The initial page is `pages/index.html`. On macOS, `activate` re-creates the window when none remain; other platforms quit on `window-all-closed`.

A normal window close is asynchronous and data-preserving. The `close` event is
prevented, `src/main/window-close.js` sends `app:close-requested` with a request
id, and the renderer's shared draft registry flushes form, asset, and gallery
queues before acknowledging through `app:close-response`. The response handler
resolves `BrowserWindow.fromWebContents(event.sender)`, so an acknowledgement
cannot approve a different window or an older attempt. A successful matching
response schedules `BrowserWindow.destroy()` on the next main-process task only
after the writes have completed; that one-task deferral lets Electron deliver
the invoke result before its renderer is disposed.
If the close originated from `app.quit()`/Cmd+Q, main resumes that canceled quit
after the last approved window is destroyed (needed on macOS); choosing **Keep
Window Open** cancels the stored quit intent.

The renderer wait is limited to 10 seconds and duplicate close events reuse the
same attempt. A save rejection or timeout opens a warning: **Keep Window Open**
is the default and clears the attempt for a later retry; **Close Without
Saving** is an explicit forced close. If even the warning dialog fails, the
window stays open. This prevents an unresolved renderer promise from deadlocking
shutdown without silently converting a known save failure into data loss.
Crashes, process kills, `app.exit`, direct `BrowserWindow.destroy()`, and the
explicit forced-close choice bypass the handshake. Long-running AI/report jobs
retain their stricter existing lock and cannot begin the close handshake until
the job finishes.

### Linux app icon (Wayland / X11)

`BrowserWindow.icon` alone is not enough on modern Linux: shells resolve the dock icon from an XDG `.desktop` file keyed by app id / `WM_CLASS`. Before `ready`, the main process calls `app.setName` + `app.setDesktopName('condition-assesment-report-generator.desktop')` (also settable via `package.json` `desktopName`). On first interactive launch it installs:

- `~/.local/share/icons/hicolor/512x512/apps/condition-assesment-report-generator.png` (copy of `assets/icon.png`)
- `~/.local/share/applications/condition-assesment-report-generator.desktop` (`Icon=` + `StartupWMClass=` matching that id; `Exec=` is the packaged binary, or `electron` + app path in dev)

Smoke tests skip the install so CI does not write under `$HOME`. After the first `npm start`, restart once (or log out/in) if the shell still shows the generic Electron glyph — some compositors only re-read desktop entries at launch.

`electron-reloader` is required at the top and silently ignored in production (wrapped in try/catch).

## Single instance

Only one copy of the app may run against a given data file. Two instances open the same `app.db` through independent connections with independent renderer state, so each one's edits are invisible to the other and the last writer wins — and a second copy could begin a migration on a file the first already has open. Double-clicking a Windows shortcut twice is enough to cause it.

`app.requestSingleInstanceLock()` runs at module scope. The lock is scoped to `userData`, so it is requested **after** the smoke-test `app.setPath('userData', …)` — otherwise a test run would contend with the developer's own app. The Squirrel install hooks skip it: that process has already been told to quit, and holding the lock during an install would deny it to the app being installed.

**A refused second launch must tell the user why** — never exit silently. A packaged Windows app has no attached console, so a quiet exit looks like "nothing happened" and leaves the user unsure whether the app is broken or already open. The losing copy logs to stderr immediately, then after `whenReady` shows a blocking warning dialog ("…is already running" / close the other window first) and exits — it must not quit before ready, because on Linux dialogs before ready are stderr-only with no GUI, and an early quit can race the dialog. Under `CONDITION_ASSESSMENT_SMOKE_TEST=1` the dialog is skipped and the process exits 1 with the explanatory stderr line (a silent exit 0 would read as a pass). The `whenReady` body returns early for both the lock-loss case and the Squirrel one rather than touching the database. The surviving instance handles `second-instance` by restoring and focusing its window; it ignores the event until `startupComplete`, since creating a window earlier would race the database open still in flight.

## Page loading

`loadPage(win, fileName, hash?)` calls `win.loadFile` with an optional `hash` fragment. Pages receive selection state exclusively through the URL hash:

| Channel | Page loaded | Hash |
|---|---|---|
| `project-setup:open` | `project-setup.html` | — |
| `project-setup:edit` | `project-setup.html` | `<projectId>` |
| `firm-setup:open` | `firm-setup.html` | — |
| `settings:open` | `settings.html` | — |
| `navigate:home` | `index.html` | `<projectId>` when `opts.selectProjectId` is a positive finite number |
| `building-info:open` | `building-info.html` | `<projectId>` |
| `building-info:edit` | `building-info.html` | `<projectId>:<buildingId>` |
| `executive-summary:edit` | `executive-summary.html` | `<projectId>:<buildingId>` |
| `property-report:open` | `property-report.html` | `<projectId>:<buildingId>[,<buildingId>…]` |

`getWindow(event)` resolves the sender's `BrowserWindow` via `BrowserWindow.fromWebContents`.

## Image and file management

Images are copied out of user-chosen source paths into dedicated directories under `app.getPath('userData')` and stored by absolute path in the database. Each copy gets a unique filename via `randomUUID()`.

| Helper | Directory | Filename prefix |
|---|---|---|
| `copyAssetImage` | `asset-images/` | `asset-<assetId>-<uuid>` |
| `copyBuildingImage` | `building-images/` | `building-<buildingId>-<uuid>` |
| `copyFirmLogo` | `firm-assets/` | `firm-logo-1-<uuid>` |

`copyAppImage` is the shared implementation: `mkdirSync({recursive:true})`, preserves the source extension (defaults to `.jpg`), and uses `fs.copyFileSync`.

### Import flows

- `property-images:import` — `dialog.showOpenDialog` with `multiSelections`; copies each file, calls `db.createBuildingImage` with an incrementing `sort_order` offset, returns the refreshed image list.
- `asset-images:import` — same pattern for asset images.
- `firm-logo:import` — single-file picker; copies the logo then upserts the firm row with `logo_path` and `logo_original_name`.

## Report preview and save

`property-report:prepare` collects one report-data snapshot for the selected
buildings, checks for relevant caption/summary AI work, fingerprints that
snapshot, and builds the DOCX. After the asynchronous ZIP pack resolves it
re-collects the data and rejects the result if the fingerprint changed. A
latest-wins `previewId` then commits an immutable buffer for the sending window;
the handler returns a byte copy for `docx-preview` plus compact review data from
the same snapshot.

`createPreparedReportArtifacts` retains one artifact per `BrowserWindow` in a
`WeakMap`. `begin` revokes the older artifact immediately and `commit` succeeds
only for the newest token. Top-level navigation, renderer destruction, or
window close releases it; same-document bookmark navigation does not. This is
the privileged boundary that makes “previewed bytes equal saved bytes” true.

`property-report:chooseExportPath` shows one save dialog for the `.docx`
(default name suggested by the renderer). Cancellation returns
`{ canceled: true }`; success stores the path only in main and returns an opaque
`exportId`. That authorization belongs to the sending `BrowserWindow`, a newer
selection replaces it, and a matching export consumes it exactly once. The
renderer can therefore select a destination but cannot submit an arbitrary
filesystem path. `CONDITION_ASSESSMENT_AUTO_DOCX` supplies the main-owned path
instead when set, so the UI driver can exercise the real handler
([ui-driver](ui-driver.md)).

`property-report:export` accepts the `previewId`, destination `exportId`, and a
validation-override flag — never building ids or a path. It resolves the exact
cached artifact, rechecks relevant AI work, re-collects and fingerprints the
current report, and enforces the stored validation error count. A stale,
AI-changing, or unapproved invalid report is rejected before the one-use path is
consumed. Otherwise the cached bytes are fsynced to a unique adjacent pending
file and renamed over the destination. A write/rename failure therefore leaves
an existing report intact rather than truncating it; saving never rebuilds the
DOCX. The handler sends `report:export-phase` so the renderer can name the
blocking step. See [word-export](word-export.md).

## Database IPC

Every `db:*` channel is a thin pass-through to the matching `src/db.js` function with argument coercion (e.g. `Number(projectId)`). See [database](database.md) for the function catalogue. The full channel list:

`db:listProjects`, `db:getProject`, `db:getFirm`, `db:updateFirm`, `db:listBuildings`, `db:listUniformatLevel1Groups`, `db:listUniformatLevel2Groups`, `db:listUniformatLevel3Groups`, `db:listUniformatLevel4Groups`, `db:listUniformatPricingItems`, `db:getBuilding`, `db:createBuilding`, `db:updateBuilding`, `db:getExecutiveSummary`, `db:updateExecutiveSummary`, `db:getPropertyReportData`, `db:listBuildingImages`, `db:listAssets`, `db:createAsset`, `db:updateAsset`, `db:listAssetImages`, `db:createProject`, `db:updateProject`.

AI channels (see [ai-photo-labels](ai-photo-labels.md)): `ai:getStatus`, `ai:getUsage`, `ai:previewBlankFields`, `ai:generateBlankFields`, `ai:setBulkBusy`, `ai:regenerateCaption`, `ai:generateExecutiveSummarySection`. (No unlock/lock IPC — session key loads at startup.) Window-close coordination uses main-to-renderer `app:close-requested` and renderer-to-main `app:close-response`.

`src/preload.js` permits only the invoke and subscription channels declared by
the named surface in `src/ipc-surface.js`; `test/ipc-surface.test.js` fails if
the two allowlists drift. It also strips Electron's event object from every
subscription callback, including the close request.

Related non-db channels for Settings: `settings:open`, `uniformat-pricing:getCsvPath`, `uniformat-pricing:chooseCsv`, `uniformat-pricing:reloadFromDisk`, `uniformat-pricing:showInFolder` (`window.electronAPI`: `openSettings`, `getUniformatPricingCsvPath`, `chooseUniformatPricingCsv`, etc.). Path/info resolution is in `src/app-settings.js` — see [uniformat-pricing](uniformat-pricing.md).

`app-data:export` and `app-data:import` own the Settings backup dialogs. Import
confirms full replacement, then delegates validation and the journalled swap to
`src/app-data-io.js`; see [app-data-backups](app-data-backups.md).

Before the first `db.openDatabase()` in `app.whenReady()`, main calls
`appDataIo.recoverInterruptedImport()`. That must precede SQLite open so an
`app.db` temporarily moved into rollback cannot be mistaken for a fresh
workspace. Schema/integrity checks then run before any renderer request.
The AI persistence adapter is configured with both `captionService` and
`undoHistory`; it consumes the database replacement latch before each AI
read/write and invalidates both state owners when the file identity changed.
The direct `ai:generateExecutiveSummarySection` path consumes that identity
check before calling OpenRouter, then checks again after the awaited request.
A replacement that already happened therefore becomes the current workspace
without wasting a model call, while a change during generation invalidates the
old workspace and returns a canceled, non-OK result with no prose for the
renderer to autosave.
`buildApplicationMenu()` installs File / Edit / View / Help; Help shows a
non-interactive `Version x.y.z` item and “About / debug info…” opens Settings.
App version is also exposed via `app:getVersion` (`app.getVersion()`); Settings
uses `app:getInfo` for expanded runtime/path debug fields.

## Startup failures

Startup must never fail invisibly — including when the app deliberately refuses to start (single-instance lock lost; see above). A packaged Windows app has no attached console, so a `console.error` before the first window exists reaches nobody — the process simply disappears, which is exactly how the v1.0.2 release presented as "crashes on open". If the user cannot see a window *or* a dialog explaining why, the failure is invisible.

`openDatabaseWithRecovery()` wraps the first open:

- **`DatabaseMigrationRequiredError`** → `promptForMigration()` explains the version change and what it will do, and migrates only if the user picks **Update Data File**. See [database](database.md).
- **`IncompatibleDatabaseError`** → `promptForReset()` offers **Start a New Data File** (keeping the old one as `.bak`), **Show Data Folder**, or **Quit**.
- Anything else reaching the `whenReady` catch shows `dialog.showErrorBox` with the stack before `app.exit(1)`.

That catch only covers failures *inside* the `whenReady` chain. The bootstrap `require`s above it — `./lib/load-env`, `./db`, `./app-settings`, the AI modules — run before the chain exists, and a native binding built for the wrong ABI or a missing packaged data file throws there. `process.on('uncaughtException', reportFatalStartupError)` is installed immediately after the Electron import to cover exactly that window; it stays installed afterwards so a later unhandled error also gets a dialog rather than an unexplained exit (the title distinguishes the two cases via `startupComplete`). `showErrorBox` is one of the few dialog calls Electron permits before `ready`.

`createWindow()` attaches `did-fail-load`, `preload-error` and `render-process-gone` listeners **before** starting the first load, and routes them through `reportWindowFailure()`. A renderer that fails to load leaves a blank window, which is indistinguishable from a hang. Failures accumulate in `windowFailures`; the window smoke test reads that list rather than attaching a second set of listeners after the load has already started. `did-fail-load` with code `-3` (`ERR_ABORTED`) is ignored — a superseded navigation is normal.

Under `CONDITION_ASSESSMENT_SMOKE_TEST=1` all of these become stderr messages and a non-zero exit instead of dialogs, so CI can assert on them without a human. `CONDITION_ASSESSMENT_RESET_DB=1` takes the recovery path non-interactively. `CONDITION_ASSESSMENT_SMOKE_WINDOW=1` opens the real window; `CONDITION_ASSESSMENT_SMOKE_SETTLE_MS` overrides how long that run holds the loaded window open (default 2000), which is how the single-instance scenario keeps a live first instance to launch a second one at.

## Squirrel install hooks (Windows)

`require('electron-squirrel-startup')` runs at the top of `src/main.js`. Electron binaries advertise `SquirrelAwareVersion`, so during install/update/uninstall Squirrel launches the app with `--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall` or `--squirrel-obsolete` and waits for it to create shortcuts and exit. Without the hook the app opens a real window mid-install, gets killed, and no shortcuts are created. `isSquirrelStartupEvent` also short-circuits the `whenReady` body so no database is opened during an install.

`npm run test:installed` covers this end to end — see [dev-environment](dev-environment.md).
