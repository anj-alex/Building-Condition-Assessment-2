# Post-Temporary-Shares cleanup and test hardening — completed

**Status: COMPLETE (2026-08-16).** This records a finished work pass, kept for
provenance. It began as a forward plan written after auditing commit `0a0974b`
("Retire Temporary Shares from the desktop app"); everything below shipped to
`main`. Nothing here is outstanding except the one manual step noted at the end,
which is deliberately the developer's to run.

The removal itself was already correct; this pass cleaned up the residue it left
and closed the coverage holes it exposed.

## What shipped

### Windows verification restored (was P0)

`0a0974b` deleted the only Windows gate for the product along with the
share-specific workflow. Restored as a non-publishing gate:

- **`.github/workflows/verify-desktop.yml`** — `workflow_dispatch` only, matrix
  over `windows-2022` (pinned; `@electron/node-gyp` 10.2 rejects the VS 2026
  image) and `ubuntu-24.04`. Per leg: `npm ci`, `npm test` (Windows) /
  `npm run test:coverage` (Linux), package, packaged smoke, make, the Windows
  installer smoke (`test:installed`), and `verify:ui` (under `xvfb-run` on
  Linux). Uploads **only** `out/verify-desktop/**` logs + screenshots at
  `retention-days: 3` — never installers or packaged output, because
  `release-windows.yml` documents how default 90-day retention filled the 2 GB
  Actions quota in nine runs.
- **`test/workflows-manual-only.test.js`** now asserts `verify-desktop.yml`
  exists and defines both matrix legs (and publishes nothing) — so deleting the
  Windows gate again becomes a failing unit test.
- **`docs/releasing.md`** and **`AGENTS.md`** name Verify Desktop as the
  pre-release gate that must be green on the release commit before Release
  Desktop; neither workflow starts the other.

### Dead and redundant code removed

- The last Temporary Shares runtime vocabulary is gone: the preload bridge is
  `window.appBridge` (was `carshare`) and `src/renderer-api.js` (was
  `share-bridge-api.js`), updated across all seven page files, the IPC surface,
  and the tests + docs that referenced the old names.
- `src/data-files.js` lost its injectable source seam (a dead production path
  that only the retired share loader used); `readDataFileText` is now a direct
  read, with the name/traversal guard kept.
- `scripts/verify-project-report.js` (then `verify-project-pdf.js`) no longer
  defaults to the developer's real
  profile — it uses a `mkdtemp` profile cleaned up in `finally`, matching the
  other UI scenarios. (The audit caught this migrating the real dev DB v7→v9.)

Deliberately left alone: `src/ai/secret-crypto.js`'s password parameter, and
`src/db.js` migrations 5–7, which still carry the full historical share DDL that
`db-migrations.test.js` replays.

### The test suite now covers the program

- **`src/main.js`** (2,439 lines, 0% — never loaded by any test) was decomposed
  into dependency-injected modules under `src/main/` (`ipc-handlers`, `startup`,
  `menu`, `paths`, `linux-desktop`), leaving `src/main.js` a thin composition
  root. Each module is unit-tested (`test/ipc-handlers.test.js`,
  `test/main-startup.test.js`, `test/app-menu.test.js`, `test/main-paths.test.js`,
  `test/linux-desktop.test.js`). The composition root itself is exercised in CI
  by `test:packaged` — which launches the real packaged binary on both Verify
  Desktop legs — and locally by `scripts/smoke-boot.sh` (a headless bash-only
  boot check that no workflow runs) and `verify:ui`.
- **`test/repo-integrity.test.js`** catches the structural drift a large removal
  produces: IPC surface ↔ handler parity, resolvable relative `require()`s,
  resolvable `<script src>`/`<link href>`, live `window.electronAPI` call sites,
  and resolvable relative `*.md` links.
- **`test/app-data-io.test.js`** exercises backup/restore: round-trip, corrupt
  archive leaves data intact, path-traversal entries are contained, and a
  wrong-schema archive is refused.
- **One renderer harness** — `test/helpers/renderer-page.js` (jsdom) — loads a
  real page's scripts into one realm with a recording `electronAPI`, and is used
  by the renderer tests (settings, home, firm-setup, executive-summary,
  building-info, project-setup, property-report). The three former hand-rolled
  `vm` loaders (`active-building-ids`, `caption-generation-controls`,
  `photo-annotations`) were migrated onto shared harnesses.
- Remaining gaps filled: `property-report.js` (9.86% → ~88%, driven against a
  real seeded report), `settings.js` (6.64% → ~63%), `annotations.js`
  (71% → 98%), the `db.js` CRUD half, `load-env.js`, and `theme.js`.

### Coverage is now a standing number

`npm run test:coverage` runs under `--experimental-test-coverage` with
`--test-coverage-lines/functions/branches` set just below the achieved figures,
so it ratchets; the verify-desktop Linux leg enforces it.

| | Baseline | After |
|---|---:|---:|
| Lines | 43.97% | ~74% |
| Functions | 42.61% | ~66% |
| Branches | — | ~66% |

Every instrumented `src/` file is at or above 40% — but that is a measured fact,
not an enforced one. The three `--test-coverage-*` thresholds are **whole-repo
totals**; there is no per-file floor, so a single file can sink while the total
holds. `src/ai/caption-service.js` sits closest to the line at 40.29%.

`src/main.js`, `src/preload.js`, and `src/ai/caption-service.js`'s network/worker
machinery are validated by other means (the packaged smoke test, `verify:ui`, and
the vm-injection behavioural tests) rather than by chasing the instrumented
number — see [dev-environment](dev-environment.md#coverage).

## Verified

- `npm test` — 273 tests green (locally, and on the Windows runner).
- `npm run test:coverage` — green at the ratchet (~74% lines, no `src/` file
  below 40%).
- `npm run verify:ui` — all three real-app scenarios green, each on a temp
  profile.
- Residue grep (`carshare|share-bridge|DataFileSource`) returns nothing but the
  retirement doc; `package.json` version stays `1.4.0` (this was not a release).

## The manual step, run to green

Per the repo's deliberate manual-CI model, **Verify Desktop is not dispatched
automatically.** To close the loop on real Windows + Linux runners, dispatch it
on the release/HEAD commit and read the result:

```bash
gh workflow run verify-desktop.yml --ref main
gh run watch
```

This was done, and — exactly as anticipated — the first runs surfaced real,
never-exercised platform failures before both legs went green on commit
`caa03f3`:

- **Windows unit tests — EPERM on temp-dir cleanup.** `db-media-url` and
  `db-migrations` removed a temp userData dir while SQLite handles were still
  open. Linux unlinks an open file; Windows refuses. `node:test`'s `t.after`
  hooks run FIFO, so the fix is one ordered teardown per test that closes every
  handle *before* `rmSync`.
- **Linux `verify:ui` — renderer killed by a full `/dev/shm`.** Under `xvfb`,
  CI's small shared-memory mount fills and Chromium kills the renderer while the
  browser process lives on, leaving no CDP page target. Fixed with
  `--disable-dev-shm-usage` in `scripts/ui-driver.js`, which also now captures
  the app's stdout/stderr and prints the tail on any driver error.
- **Linux `verify:ui` (round two) — a missing icon-cache helper crashed the
  app.** With `/dev/shm` handled, the tail from the previous fix revealed the
  true cause: `ensureLinuxDesktopIntegration` spawns `update-desktop-database` /
  `gtk-update-icon-cache`, absent on a headless runner. `spawn()` reports a
  missing binary as an async `'error'` event, not a throw, so the `try/catch`
  never saw it and the unhandled event crashed the app before its window opened.
  Fixed by attaching a no-op `'error'` listener to each spawned helper, with a
  regression test (`test/linux-desktop.test.js`) that emits ENOENT on a real
  `EventEmitter` child.

With both legs green on `caa03f3`, this pass — and the manual verification it
was waiting on — is complete.
