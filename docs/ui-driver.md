# UI driver (`scripts/ui-driver.js`)

A dependency-free way to launch the real app, click through it, read the DOM back, and screenshot it from Node.

This is the only layer that can answer "does the window actually do this?". `npm test` runs under `ELECTRON_RUN_AS_NODE=1` with no renderer at all, and `scripts/smoke-packaged-app.js` proves a packaged build opens a window but never interacts with it. See [dev-environment](dev-environment.md) for those.

## Why not Playwright

Playwright's `_electron` fixture is the better tool when it is installed. The driver exists because it does not have to be: Electron already speaks the Chrome DevTools Protocol over `--remote-debugging-port`, and Node has a global `WebSocket`. Nothing to install, nothing to keep in step with the Electron version, and it works in a container with no browsers.

## Files

| File | Role |
|---|---|
| `scripts/ui-driver.js` | Library: `launchApp`, `AppSession`, `Cdp`, `runScenario`, `createChecks` |
| `scripts/verify-ui.js` | Sequential runner used by `npm run verify:ui` |
| `scripts/verify-asset-calculations.js` | Isolated-profile scenario: pricing prefills, override discipline, derived panel/FCI, term suppression, C3300 cascade, autosave |
| `scripts/verify-project-report.js` | Scenario: the project-wide report picker and DOCX-derived combined preview |
| `scripts/verify-project-recovery.js` | Isolated-profile scenario: soft-delete a seeded project, recover it through Settings, and verify it returns to Home |
| `scripts/verify-excel-import.js` | Isolated-profile scenario: click **Import from Excel** and confirm the real handler imports the sample workbook into the selected project and the property list refreshes |
| `scripts/verify-word-export.js` | Isolated-profile scenario: import the sample workbook, prepare its DOCX-derived preview, then click **Save Word Report…** and require a real `.docx` at the chosen path (see [word-export](word-export.md)) |

Output (screenshots, exported `.docx` files) goes to `out/ui-driver/`, which is gitignored.

## Running

```bash
npm run verify:ui                                    # full run
node scripts/verify-asset-calculations.js             # asset calculation scenario only
node scripts/verify-project-recovery.js                # Settings recovery scenario only
node scripts/verify-project-report.js --quick        # skip the per-building baseline
node scripts/verify-project-report.js --user-data-dir=/tmp/ui-profile   # isolated profile
```

Needs a display. On a headless machine wrap it the same way the packaged smoke test is wrapped: `xvfb-run --auto-servernum npm run verify:ui`.

## Shape of a scenario

```js
const { runScenario, sleep } = require('./ui-driver')

async function scenario(session, checks) {
  const home = await session.page('index.html')          // attach to a page target by URL
  await home.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
  await home.click('#generate-project-report')
  checks.check('label', await home.eval(`btn.textContent`), 'Generate report (2 properties)')
  await home.screenshot('out/ui-driver/picker.png')
  await session.evalInMain(`req('electron').app.getPath('userData')`)  // runs in the main process
}

void runScenario('name', { rendererPort: 9333, mainPort: 9334 }, scenario)
```

`runScenario` always stops the app, and exits non-zero if a check failed or the scenario threw. `checks.check` compares by JSON, so a DOM readback (array of strings, small object) can be asserted whole; `checks.note` records a measurement without asserting on it.

`launchApp` defaults to the development Electron executable and repository root,
but also accepts `executablePath`, `appPath`, and `appArgs` for a packaged
Electron executable. Set `appPath: null` for a packaged executable and pass its
arguments through `appArgs`. `mainPort: null` deliberately omits `--inspect`;
renderer CDP remains available. The driver includes `--disable-gpu` by default,
matching the Windows packaged smoke tests.

## Gotchas

Every item here cost a debugging cycle. They are properties of Electron and of this app, not of the driver.

### Electron APIs are not reachable over the renderer's CDP

The renderer endpoint exposes only what Electron implements of the Page/Runtime
domains, which is not everything Chromium offers — `Page.printToPDF`, for
instance, returns `{"code":-32601,"message":"'Page.printToPDF' wasn't found"}`.
Anything on `app`, `BrowserWindow` or `webContents` is out of reach there
entirely.

So the app is launched with **two** debugging endpoints — `--remote-debugging-port` for the renderer and `--inspect` for the main process — and `AppSession.evalInMain` runs expressions in the main process, where the Electron API actually lives.

In the main-process inspector context, bare `require` may be undefined; `process.mainModule.require` is the reliable fallback. `AppSession.evalInMain` puts a working `req` in scope for you.

### Native OS dialogs are bypassed with env hooks, not clicked

No driver can dismiss an operating-system file dialog, so a scenario that needs one drives the button and lets the main process read the path from an environment variable instead:

- `CONDITION_ASSESSMENT_AUTO_DOCX` — **Save Word Report…** writes to this path instead of opening a save dialog.
- `CONDITION_ASSESSMENT_AUTO_IMPORT` (+ `CONDITION_ASSESSMENT_AUTO_IMPORT_MODE`, `new`/`update`) — the Excel import reads this workbook and applies this mode instead of opening the file picker and the New/Update prompt (`verify-excel-import.js` sets both through `launchApp`'s `env`).

`verify-word-export.js` sets `CONDITION_ASSESSMENT_AUTO_DOCX` to a deliberately non-default basename, so a handler that derived the path on its own rather than using the chosen one fails the scenario. A unit test that calls `buildProjectReportDocxBuffer` directly cannot see a prepared artifact fail to reach disk; only clicking the button can.

Everything downstream of the button — parsing, catalogue resolution, the SQLite writes, the IPC round-trip, and the renderer refresh — is real; only the OS dialog itself is skipped. Pass the variables through the `env` option of `runScenario`/`launchApp` so they reach the spawned main process.

### In CI

Two manual-dispatch workflows run these scenarios on GitHub-hosted runners under `xvfb` (see [releasing](releasing.md) and `test/workflows-manual-only.test.js`): **Verify Desktop** (`verify-desktop.yml`) runs the whole `verify:ui` suite on Windows and Linux as part of the pre-release gate, and **Verify UI** (`verify-ui.yml`) is a lighter Linux-only run for the UI scenarios alone, with a `scenario` input to run just one (e.g. `excel-import`). Neither starts itself.

### One running copy per data file

The app takes a single-instance lock on its `userData` directory (see [electron-main-process](electron-main-process.md)). A driver run **will not start while the dev app is open** — it exits before the debugging endpoint appears. `#findTarget` checks the child's exit code so this reports as "app exited … before page target appeared" rather than a bare timeout.

The same applies to an orphaned run: if a scenario is killed without `session.stop()`, the next run dies at startup. `runScenario` stops the app in a `finally` for this reason.

`stop()` waits for the process to actually be gone, and on Windows kills through `taskkill /t` rather than `child.kill()`. Node's `kill()` on Windows is `TerminateProcess` on the parent alone, so Electron's GPU, network and crashpad children survive as orphans still holding handles inside `userData`. A second launch against that same profile then opens its debugging port and never produces a window. A relaunch scenario is only meaningful once the first launch has finished leaving.

### A killed app is a crash, not a restart

`stop()` on Windows asks before it forces: `taskkill` with no `/f` posts WM_CLOSE, the window closes, `app.quit()` runs, and only after eight seconds of that not working does `/t /f` follow. The difference is not politeness. Chromium holds preferences in memory and commits them on a ~10-second timer, and one of them is the `Local State` key that `safeStorage` seals secrets with. Force-killing two seconds into a fresh profile takes that key to the grave, so the next launch finds ciphertext it cannot open.

So a scenario that kills the app is testing a crash. Only one that closes it is testing a restart, and any assertion about state surviving a relaunch depends on which one it did.

### The default run shares the developer's own profile

No `userDataDir` means the real dev database, the real image directories, and the real `localStorage` — theme preference included. A scenario that edits data or flips the theme leaves that behind in the app the developer opens next. Either restore it in a `finally`, or pass `userDataDir`. `verify-asset-calculations.js` always creates and removes its own temp profile:

- `--user-data-dir=<path>` becomes `userData` **verbatim** (no app-name subdirectory).
- An empty directory needs no seeding: a dev checkout seeds `data/dummy_data.sql` into any database with no projects (`seedDummyDataIfEmpty` in `src/db.js`), so an isolated profile comes up with the sample project and its buildings. See [dummy-data](dummy-data.md).

### Give a `until` wait something to say when it times out

`Cdp.until(expression, label, timeoutMs, diagnose)` takes an optional fourth
expression, evaluated once and only on timeout, whose value is appended to the
error. Condition reads and that diagnostic share the stated deadline; a hung
evaluation cannot silently turn a 20-second wait into 80 seconds. `Cdp.until`
deliberately swallows evaluation errors as "not yet", so a
wait that never comes true otherwise reports nothing but `timed out waiting for
X` — and an intermittent failure on the release gate then costs another full
dispatch (Windows bills at 2x) purely to find out what the page was showing.

Pass whatever would have answered that question. `scripts/verify-excel-import.js`
reports the row counts, the selected project, the import button's label, the
overlay's display and any error toast, because the renderer refreshes that list
from `syncHome` after the import resolves and a throw in there leaves the toast
as the only visible trace.

### Re-discover the page target after every navigation

The app navigates one `BrowserWindow` between pages rather than opening new windows, so the document, the execution context and any `Runtime.enable` state are replaced under an existing session. Call `session.page('<url-fragment>')` again after a navigation instead of reusing the old `Cdp`. `Cdp.until` treats evaluation errors as "not yet" so a poll that straddles a navigation does not fail.

For the same reason, **do not await the promise of an invoke that navigates**: `Cdp.eval` passes `awaitPromise: true`, and a promise that resolves through a context the invoke itself tears down intermittently comes back `-32000 Inspected target navigated or closed`. Evaluate `void window.electronAPI.openSettings()` (the `void` makes the expression a non-promise, so `awaitPromise` no-ops) and let the following `session.page(...)` poll for the new URL — that poll is the synchronization you actually wanted.

### Wait for a settled state, not the first frame that looks right

Waiting for "the button is enabled" is not the same as waiting for the app to be
ready to receive the click. A project row fires `void selectProject(id)` and
returns, so `#import-excel` passes through an enabled-but-not-ready moment before
the properties section has finished re-rendering. Clicking in that window failed
about one run in four, two different ways: `cannot click #import-excel — no
on-screen box`, or an import that ran against a selection the renderer then
dropped, leaving an empty property list 45 seconds later.

Wait on the condition the click actually needs — here, the project row is
`aria-pressed` **and** the button has a non-zero `getBoundingClientRect()`, which
is exactly what `Cdp.click` hit-tests.

### `element.click()` drives straight through anything covering the button

`element.click()` dispatches at the node, so it ignores hit-testing entirely: a
control buried under a full-screen overlay still "clicks" and every assertion
still passes. 1.6.1 shipped exactly that — the export overlay covered the whole
report page and swallowed every toolbar click, and this suite was green.

Use `Cdp.click(selector)`, which hit-tests with `elementFromPoint` and then
dispatches a real mouse event, or `Cdp.topElementAt(selector)` to assert
reachability without clicking. Both name the covering element when they fail
(`cannot click #export-word — covered by #export-modal`).

For the same reason, assert `getComputedStyle(el).display`, never `el.hidden`.
`hidden` is an attribute the UA stylesheet acts on at the lowest precedence, so
any author `display` rule leaves the element on screen while `el.hidden` still
reads `true`. `test/hidden-attribute.test.js` guards the CSS side of this.

### CDP is served by the main process, so a blocked main process blocks the driver

The renderer keeps running while the main process is busy, but every CDP command
— `Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchMouseEvent` —
is answered by the browser process. While the main process is blocked (the Excel
import parsing a workbook, the Word preview building a document) the driver gets
**no** replies, so polling cannot observe the UI mid-freeze; the polls simply all
answer afterwards, showing the finished state. A hit-tested `Cdp.click` on a
button that starts blocking work does not even return until that work is done.

To assert on what was on screen during the freeze, record it from inside the
page and read the recording back afterwards:

```js
await home.eval(`(() => {
  window.__trace = []
  window.__timer = setInterval(() => {
    window.__trace.push(getComputedStyle(document.getElementById('import-modal')).display)
  }, 100)
})()`)
await home.click('#import-excel')          // returns only once the import is done
const trace = await home.eval(`(clearInterval(window.__timer), window.__trace)`)
```

`verify-excel-import.js` uses this to prove the import overlay is actually up
while the main process is blocked.

### `element.click()` does not fire key handlers or `change`

- Anything the app handles on `keydown` (Escape closing the picker, undo/redo) needs a real browser key event: `Cdp.key('Escape', 27)`. Pass `{ code: 'KeyZ', modifiers: 2 }` for Ctrl+Z (`1` Alt, `2` Ctrl, `4` Meta, `8` Shift; combine them for chords).
- Setting `input.checked = false` from script does not fire `change`. Dispatch it: `input.dispatchEvent(new Event('change'))`.

### Clicking the selected project deselects it

`selectProject` toggles ([home-page](home-page.md)), so a scenario that selects the same project twice ends up with nothing selected and its next `until` times out. Check `aria-pressed` before clicking.

### DOCX-viewer pages are evidence, not a pagination contract

The old `.report-page` HTML assembly no longer exists. `docx-preview` emits
`.car-word-preview-wrapper > section.car-word-preview` nodes from the actual
DOCX, but their count is still the Chromium viewer's pagination, not Word's.
Do not pin that count or add standalone-building page totals: font metrics,
unsupported live fields, and viewer upgrades can change it without changing
the authoritative artifact.

Wait for `reportReady === 'true'` and
`reportPreviewSource === 'docx'`, assert that viewer pages exist, then verify
the saved DOCX/XML for structural content such as selected facilities and the
project summary. See [property-report](property-report.md).

### Look at the screenshots

A screenshot proves the window rendered; a blank frame is a failure to launch that every DOM assertion can still pass around. `Page.captureScreenshot` also captures only the visible viewport — `scrollIntoView` first, then wait a beat for layout.

## Waiting for a rendered report

Wait on both `document.body.dataset.reportReady === 'true'` and
`document.body.dataset.reportPreviewSource === 'docx'`, not on a save button.

The report page's pre-export review disables the export button whenever the
data holds a blocking error — missing address, floor area, storey count or
replacement value — which is a completely normal state for a freshly imported
project, because the workbook does not carry any of those. A scenario that used
"the export button is enabled" as its render signal therefore timed out waiting
for a report that had rendered correctly. `renderPreparedPreview` sets those
markers only after `docx-preview`, its delayed tab-stop pass, and image settling
complete. A rebuild or newly active AI job clears readiness first.

To get past the gate deliberately, click `#report-review-override` ("Export
anyway"); `unblockExport` in `scripts/verify-word-export.js` does that and
asserts the before/after states on the way through, so the gate itself stays
covered rather than merely tolerated.

## Time bounds

Four layers, each tighter than the one outside it, so a hang is caught and
*named* rather than just killed:

| Bound | Where | Typical | Catches |
| --- | --- | --- | --- |
| One CDP command | `Cdp.send`, 60s | ms | a wedged renderer, a promise that never settles |
| A click's dispatch | `Cdp.click`, 240s | ms | main not answering after the click started work |
| One wait | `Cdp.until`, 20s default, including diagnosis | ms–s | a condition that never comes true |
| One scenario | `SCENARIO_BUDGET_MS`, 6 min | 20–60s | everything moving but nothing finishing |
| The CI job | `timeout-minutes` in the workflow | 5–7 min | the run as a whole, including npm and packaging |

The scenario budget is the layer that used to be missing. Every individual wait
was bounded, but their sum was not, and neither was anything blocking *between*
them — a main process wedged inside an import answers no command, so nothing it
would have timed out ever gets asked. Without the budget the only backstop was
the CI job cap, which kills the run without saying which scenario hung.

`runScenario` races the scenario against the budget and lets its existing
`finally` do the cleanup, so the app's whole process tree is still shut down the
careful way (see `AppSession.stop`). Raise it with
`CONDITION_ASSESSMENT_UI_BUDGET_MS` on a slow machine rather than trimming a
scenario's own waits — those are what produce the specific messages worth
reading.

The workflow caps are set from measured step times, not guessed. The full Verify
Desktop run is 7 minutes on Windows and 5 on Linux; the whole five-scenario
suite inside it is 99 seconds. `test/workflows-time-bounded.test.js` fails if a
job has no `timeout-minutes` (GitHub's default is 360, billed at 2x on Windows)
or if one is left above 30.

## Sample for duration, observe for transitions

Both recorders exist because they answer different questions, and using the
wrong one is a flake.

A `setInterval` recorder proves something was *on screen for a stretch of
wall-clock time* — that is a duration question, and only sampling answers it.
`verify-excel-import` uses one to show the overlay was up while the main process
was blocked.

A `MutationObserver` catches *every change* to an element. Use it for anything
that asserts a sequence of states. Sampling the export modal's label at 100ms
missed a phase on the single-building export, which is small enough to move
through two phases inside one tick — an intermittent failure of a check that is
not itself flaky. The observer also revealed a phase the interval had never once
captured. Both run in the renderer, which keeps ticking while the main process
blocks.

## Adding a scenario

Add `scripts/verify-<thing>.js`, require `./ui-driver`, and give it its own port pair if it might run alongside another scenario. Prefer discovering fixtures at runtime (`verify-project-report.js` looks up the first project with more than one building) over hardcoded dummy-data ids, so the scenario survives a hand-edited dev database.
