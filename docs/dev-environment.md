# Development environment

You are already inside the development environment. Work in the repo root and run project commands here — do not treat host vs container as part of the workflow.

Workspace path:

```
/home/dev/condition-assesment-report-generator
```

## Running the app

```bash
npm install        # installs deps; postinstall rebuilds native + downloads Electron
npm start          # electron-forge start with hot reload
```

`postinstall` runs `electron-rebuild -f -w better-sqlite3` so the native SQLite binding matches this environment’s Node/Electron headers, then `node node_modules/electron/install.js` so `dist/` is populated. Electron 43+ no longer registers an install script of its own (`hasInstallScript` is absent from the lockfile entry), so `npm ci` alone leaves `electron/dist` empty and any path that launches the Electron binary directly — including `npm run verify:ui` and the packaged smoke tests — fails on a clean checkout. The install step is idempotent (`isInstalled()` exits 0 when `dist/` is already present).

SheetJS CE is installed from the audited official tarball at
`vendor/xlsx-0.20.3.tgz`, not the stale npm-registry release. Do not regenerate
that file with `npm pack`; update it only from SheetJS's official CDN, then
update the pinned SHA-512 in `test/dependency-security.test.js` and run
`npm audit --omit=dev`. `tar`, which parses app-data backups in the privileged
main process, is likewise exact-pinned rather than range-pinned.

The root `overrides` also keeps Electron Forge's older nested `tar` and `tmp`
copies on their patched current releases. The full (development-inclusive)
`npm audit` still reports the unpatched `extract-zip@2.0.1` advisory propagated
through Forge's `@electron/packager@18`; Forge 7.11.2 is the current release and
its CommonJS core is not compatible with Packager 20's ESM-only replacement.
This dependency is build-only, and `npm run package` / `npm run make` preload
`scripts/fix-extract-zip.cjs`, which uses the platform extractor for the trusted
Electron distribution archive. Do not run `npm audit fix --force`: npm proposes
an older Forge version without removing that unsupported dependency seam.

## Tests

```bash
npm test                 # unit tests (node:test under Electron as Node)
npm run test:coverage    # unit tests + line/function/branch coverage, ratcheted
npm run verify:data      # hard-fail BCA reference-data integrity check
npm test -- --test-name-pattern=foo   # filter by name (flags kept; discovery still runs)
npm test -- test/csv-utils.test.js    # run one file (path-like args replace discovery)
npm run test:packaged    # smoke-test the packaged app + assert clean asar
npm run verify:ui        # asset calculations + project report in real Electron
npm run verify:ui:asset  # asset calculation scenario only
npm run verify:ui:project # project report scenario only
```

`npm test` runs `scripts/run-tests.js`, which first tries `python3`/`python`/`py` with `scripts/extract-bca-reference-data.py --check` when the sample workbook is present, then spawns Electron with `ELECTRON_RUN_AS_NODE=1 --test`. If the interpreter or workbook is missing, the reference-data gate is skipped with a warning (unit tests still run). Use `npm run verify:data` for a hard-fail integrity check (e.g. in CI). The generated files are never hand-edited — the extractor also normalises the workbook's title-cased acronyms (`restore_acronyms`, currently `HVAC`), so a wording fix in that data belongs in the script and is applied by re-running it. By default the runner collects **only** top-level `test/*.test.js` (not `test/helpers/` or other nested JS). New suites need no registration — add `test/<name>.test.js`.

- **Flag-only** extra args (e.g. `--test-name-pattern=…`) are forwarded and discovery still runs.
- **Path-like** extra args replace the discovered list (run specific files).

Tests use `node:test` + `node:assert/strict` and CommonJS `require`. No extra test dependencies.

**CI runs only when you start it.** Every workflow in `.github/workflows/` is `workflow_dispatch` only — no `push`, no `pull_request`, no `schedule` (`test/workflows-manual-only.test.js` fails if that changes). So a push verifies nothing on its own; local `npm test` is the only check a commit gets for free.

The only workflow is **Release Desktop**, and it publishes GitHub + Azure installers. Do not dispatch it unless you intend to ship. See [releasing](releasing.md). For driving the real window, see [ui-driver](ui-driver.md).

Current suites (names may grow): `app-settings`, `csv-utils`, `db-initialization`, `db-migrations`, `undo-history`, `secret-crypto`, `property-report`, `page-scripts`.

`db-migrations` runs against frozen schema fixtures under `test/fixtures/schema/` — `v1.sql` (the shape all three 1.0.x releases shipped) and `v1-dev-capital-planning.sql` (an unreleased dev shape that is detected as version 1 but already has some v2 columns). They are snapshots of real historical schemas and must not be edited; migrations have to keep working against exactly those shapes.

`page-scripts` is the one suite that does not test a module in isolation. `require()` gives every file its own module scope, which hides the two ways a page's classic `<script>` tags — which all share one global scope — break each other. The suite replays each page's scripts in a single shared `vm` context and fails on either:

- **a collision** — a global `let`/`const` clashing with an earlier `function`/`var` of the same name, which stops the later file from instantiating at all;
- **a forward read** — a top-level statement reading a binding that a later script declares, which throws where it stands and leaves everything below it in the temporal dead zone, so unrelated functions fail whenever they are eventually called.

Scripts are expected to throw once they touch the missing DOM (declarations are instantiated before the first statement), so a missing *host* global is ignored while any other missing name is a failure.

Suites that replay renderer scripts in a separate realm (a raw `vm` context, or the jsdom window the renderer harness builds) must rebuild results in the host realm before comparing — the other realm has its own `Object` and `Array` prototypes, and `deepStrictEqual` reports a structurally identical value as "same structure but not reference-equal". Destructure the object or spread the array (see `test/active-building-ids.test.js`).

### Renderer harness (jsdom)

`test/helpers/renderer-page.js` — `loadPage('settings.html', { hash, electronAPI, localStorage })` — is the one harness for renderer-page tests. It loads a real page's HTML into jsdom, runs its `<script src>` files in document order into one shared realm (the way a browser loads classic scripts, so page globals see each other), injects a recording `window.electronAPI` proxy (`{ method, args }` per call; `list*` → `[]`, everything else → `null` unless overridden), and returns `{ window, document, calls, flush }`. `await flush()` settles a page bootstrap's awaited `electronAPI` calls. Use it for anything that dispatches events, carries focus, or renders DOM — the earlier hand-rolled `vm` + stub-`document` loaders could not do any of that. jsdom is a `devDependency` (electron-packager prunes devDeps and `forge.config.js` ignores `/test`). It has no layout engine and no 2D canvas: tests that need real pixel geometry or `canvas.getContext('2d')` (e.g. photo-annotation arrows) still use a minimal fake element.

### Coverage

`npm run test:coverage` runs the suite under `node --experimental-test-coverage` with `--test-coverage-lines/functions/branches` thresholds set just below the achieved numbers, so coverage ratchets and cannot silently regress; the verify-desktop Linux leg runs it. Baseline before this hardening pass was **43.97% lines / 42.61% functions**; it now sits at roughly **74% lines / 66% functions / 66% branches**.

The thresholds are whole-repo totals, so they hold the overall number up but do not stop one file from sinking while the rest carries it. Every instrumented `src/` file currently measures at or above 40% — `src/ai/caption-service.js` is the closest to that line at 40.29% — but nothing enforces it per file. Check the per-file column, not just the pass/fail.

Three files read low or absent in the report and are validated by other means, not by chasing the number:

- **`src/main.js`** and **`src/preload.js`** never load under the unit runner (one boots Electron at `whenReady`, the other runs in the preload sandbox). `src/main.js`'s logic lives in the unit-tested `src/main/` modules; both files are covered in CI by `npm run test:packaged` (the packaged binary really boots, on both Verify Desktop legs) and `npm run verify:ui`. `scripts/smoke-boot.sh` is a local shortcut to the same headless boot path — bash-only, and no workflow runs it.
- **`src/ai/caption-service.js`**'s queue/worker machinery needs a live key and network, which only `test/caption-service.test.js` can safely simulate by injecting dependencies through a `vm` context (a copy the coverage tool does not instrument). `test/caption-service-boot.test.js` `require`s the real module and measures its offline surface directly.

Neither `npm test` nor the packaged smoke test opens a window and interacts with it. For that, see [ui-driver](ui-driver.md) — `npm run verify:ui` drives the real UI over CDP.

Main-process modules that call `require('electron')` (e.g. `app.getPath('userData')`) cannot load the real Electron API under `ELECTRON_RUN_AS_NODE=1`. For those, require `test/helpers/electron-stub.js` **before** the module under test, then point `setUserDataPath()` at a per-test temp dir (`fs.mkdtempSync` + cleanup in `t.after`). The stub only implements `getPath('userData')` (other names throw). Keep such tests filesystem-only — do not also pull in `src/db.js` through the same stub.

## Build

```bash
npm run package          # unpacked app bundle in out/
npm run make             # platform installer / zip (Windows Squirrel Setup.exe, Linux/macOS zip)
npm run test:packaged    # smoke-test the packaged app + assert clean asar
npm run test:installed   # Windows only: install Setup.exe for real, then launch it
```

Packaged builds exclude dev artifacts (dummy SQL, samples, docs, tests, local venv, etc.). First launch of a release creates an empty project list; only schema + Uniformat pricing are seeded.

### Packaged smoke scenarios

`scripts/smoke-packaged-app.js` runs the packaged binary through five scenarios, each covering a way a release has shipped broken:

| Scenario | Asserts |
|---|---|
| `freshInstall` | First launch builds its own DB, seeds pricing, ships no sample projects, stamps a schema version |
| `windowLoads` | The real `BrowserWindow` loads `index.html` with no load failure, preload error, renderer crash, or console error |
| `upgradeAsksBeforeMigrating` | An existing older DB stops startup **loudly** (exit 1 + explanation) and is left untouched |
| `approvedMigrationPreservesData` | An approved upgrade preserves rows, retypes columns, and keeps the pre-migration `.bak` |
| `secondInstanceIsRefused` | A second launch against a data file already in use bows out, and the first instance is unaffected |

`secondInstanceIsRefused` is the one scenario that runs two processes at once: the first is launched with a stretched `CONDITION_ASSESSMENT_SMOKE_SETTLE_MS` so it holds its window open, and the second is launched once `app.db` exists (the lock is taken before the database is opened, so the file's existence proves the lock is held). The scenario runner is `async` for it.

Opening a window needs a display. `--ozone-platform=headless` survives a main-process-only launch but segfaults on window creation, so the Linux run needs a virtual one:

```bash
xvfb-run --auto-servernum npm run test:packaged -- linux
```

The script fails rather than skipping the window scenario when no display is available — silently dropping that coverage is how the v1.0.2 Windows crash reached users.

`npm run test:installed` goes one step further on Windows: it runs `Setup.exe --silent`, checks Squirrel created a Start Menu shortcut (which only happens if the `electron-squirrel-startup` hook fires), launches what landed in `%LOCALAPPDATA%`, and uninstalls again. It snapshots existing shortcuts first so the assertion is about *this* install rather than leftovers, resolves the new shortcut's target through the shell to confirm it points into the install root, and fails on a non-zero exit from either `Setup.exe` or the uninstaller.

## Dev database

The running app stores SQLite at:

```
~/.config/condition-assesment-report-generator/app.db
```

Schema and Uniformat pricing seed on first open (and when the app reopens a replaced DB file). Rebuild from repo sources any time:

```bash
./load-local-db.sh
DB_PATH=/tmp/test.db ./load-local-db.sh
```

See [local-db-loader](local-db-loader.md) and [dummy-data](dummy-data.md).

## Assumptions

- Active development only — no production user data to preserve.
- **Schema changes need a migration step** (`SCHEMA_VERSION` + `MIGRATIONS` in `src/db.js`); locally you can also just rebuild with `./load-local-db.sh`.
- Schema/UI changes do not need free-text or shape shims for older data.
- Dev DBs can be wiped and reloaded freely.
- Match Help menu / Settings → About version to the release when reporting issues.
