/**
 * Verify the "Import from Excel" button end to end in the running app.
 *
 * Clicking it runs the real `bca:import` handler, which parses the sample BCA
 * workbook and writes its buildings and assets into the selected project; the
 * property list then refreshes with the imported buildings and a success toast
 * appears. This is the one layer that proves the button is actually wired to the
 * handler in the live window — the unit tests cover the parser/importer and the
 * IPC surface, but never click the button.
 *
 * The native file-open dialog and the New/Update prompt are bypassed with the
 * CONDITION_ASSESSMENT_AUTO_IMPORT / _MODE env hooks (no driver can dismiss an OS
 * dialog); everything downstream of the button — parse, catalogue resolution,
 * the SQLite writes, the IPC round-trip, and the renderer refresh — is real.
 *
 * Uses an isolated userData profile because it imports thousands of rows.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { repoRoot, runScenario, sleep } = require('./ui-driver')

const samplePath = path.join(
  repoRoot,
  'samples',
  'Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx',
)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-import-ui-'))
const outDir = path.join(repoRoot, 'out', 'ui-driver')

async function scenario(session, checks) {
  const home = await session.page('index.html')
  await home.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
  checks.note('userData', await session.userDataPath())

  // Select the seeded project (selecting an already-selected project deselects
  // it, so only click when it is not already active).
  const projectId = await home.eval(
    `(async () => (await window.electronAPI.listProjects())[0]?.id ?? null)()`,
  )
  if (projectId == null) throw new Error('isolated dev database did not seed a project')
  const projectSelector = `[data-project-id="${projectId}"]`
  if ((await home.eval(`document.querySelector(${JSON.stringify(projectSelector)})?.getAttribute('aria-pressed')`)) !== 'true') {
    await home.click(projectSelector)
  }
  // Wait for the selection to be *applied*, not merely requested. The project row
  // fires `void selectProject(id)` and returns, so the import button passes
  // through an enabled-but-not-ready moment before the properties section has
  // finished re-rendering. Clicking in that window either misses the button
  // ("no on-screen box") or imports against a selection the renderer then drops,
  // leaving an empty property list. Require the row to be checked AND the button
  // to have a real on-screen box — which is exactly what `click` hit-tests.
  await home.until(
    `(() => {
      const row = document.querySelector('[data-project-id="${projectId}"]')
      if (!row || row.getAttribute('aria-pressed') !== 'true') return false
      const btn = document.getElementById('import-excel')
      if (!btn || btn.disabled) return false
      const box = btn.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })()`,
    'project selected and the import button clickable',
  )

  const beforeRows = Number(
    await home.eval(`document.querySelectorAll('.home-property-row').length`),
  )
  const beforeBuildings = Number(
    await home.eval(`(async () => (await window.electronAPI.listBuildings(${projectId})).length)()`),
  )
  checks.note('buildings before import', beforeBuildings)

  // The import button must be reachable by a real mouse before we use it — an
  // overlay left on screen swallows clicks while `el.hidden` still reads true.
  checks.check(
    'a real click on the import button reaches it',
    await home.topElementAt('#import-excel'),
    '#import-excel',
  )

  /*
   * Record the overlay from inside the page before starting the import.
   *
   * CDP is served by the main process, so while the import blocks it, no
   * evaluate and no screenshot is answered — polling the overlay from the driver
   * would only ever see the state after the work finished. An in-page timer runs
   * in the renderer, which stays live, so it captures what was actually on
   * screen during the freeze and we read the recording back afterwards.
   */
  //
  // Two recorders, because they answer different questions. The interval proves
  // the overlay was *on screen* for a stretch of wall-clock time, which only
  // sampling can show. The observer catches every *label* change, which sampling
  // cannot: a phase shorter than one tick slips between samples, and this trace
  // was already missing "Checking the workbook against this project…" for
  // exactly that reason.
  // A second, longer-lived recorder that keeps sampling after the import
  // resolves. The overlay recorder above is read back the moment the click
  // returns, so it cannot see anything that happens during the refresh that
  // follows — which is where the property list was going blank.
  await home.eval(`(() => {
    window.__selectionTrace = []
    window.__selectionTimer = setInterval(() => {
      const selected =
        document.querySelector('[data-project-id][aria-pressed="true"]')?.dataset.projectId ?? null
      const rows = document.querySelectorAll('.home-property-row').length
      const last = window.__selectionTrace[window.__selectionTrace.length - 1]
      if (last && last[1] === selected && last[2] === rows) return
      window.__selectionTrace.push([Date.now(), selected, rows])
    }, 100)
  })()`)

  await home.eval(`(() => {
    window.__importOverlay = []
    window.__importOverlayTimer = setInterval(() => {
      const modal = document.getElementById('import-modal')
      if (!modal) return
      window.__importOverlay.push([
        getComputedStyle(modal).display,
        document.getElementById('import-modal-label')?.textContent ?? '',
      ])
    }, 100)
    window.__importLabels = []
    const label = document.getElementById('import-modal-label')
    const record = () => {
      const text = label?.textContent?.trim()
      const seen = window.__importLabels
      if (text && seen[seen.length - 1] !== text) seen.push(text)
    }
    record()
    window.__importObserver = new MutationObserver(record)
    window.__importObserver.observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })()`)

  // Click the real button, hit-tested like a user's mouse. The handler imports
  // the sample workbook via the env hook, so this is a genuine
  // button -> handler -> import -> refresh round-trip. This call does not return
  // until the import is done, for the reason above.
  await home.click('#import-excel')

  const overlay = await home.eval(`(() => {
    clearInterval(window.__importOverlayTimer)
    window.__importObserver?.disconnect()
    const samples = window.__importOverlay || []
    const shown = samples.filter(([display]) => display !== 'none')
    return {
      samples: samples.length,
      shownSamples: shown.length,
      labels: [...new Set(window.__importLabels || [])],
      sampledLabels: [...new Set(shown.map(([, label]) => label))],
    }
  })()`)
  checks.note('import overlay trace', JSON.stringify(overlay))

  // Reading the workbook and committing its rows block the main process, so the
  // window stops repainting. The overlay is the only thing telling the user the
  // app is working rather than hung — without it the app just freezes, which is
  // what this asserts did not happen.
  checks.check(
    'the overlay was on screen while the main process was blocked',
    overlay.shownSamples > 5,
    true,
  )
  // The observer sees every transition, so name the phases rather than settling
  // for "something other than the placeholder". These two are the blocking ones:
  // reading a 4 MB workbook and committing its rows.
  checks.check(
    'the overlay named each blocking phase of the import',
    [
      overlay.labels.some((label) => /Reading the workbook/.test(label)),
      overlay.labels.some((label) => /Importing \d+ rows/.test(label)),
    ],
    [true, true],
  )
  // Duration, not sequence, so this one reads the sampled trace: the placeholder
  // must not be what was on screen for the whole import.
  checks.check(
    'the overlay moved off the placeholder while the import ran',
    overlay.sampledLabels.some((label) => label && label !== 'Starting…'),
    true,
  )

  // Poll the DOM (renderer process, not blocked by the synchronous import in the
  // main process): the property list re-renders once the import resolves. The
  // sample is ~4 MB and inserts ~4,000 rows, so allow generous time.
  // On timeout, say what the page was actually showing. The renderer refreshes
  // this list from `syncHome` after the import resolves, and if that throws, the
  // only visible trace is an error toast — which a bare "timed out" hides.
  await home.until(
    `document.querySelectorAll('.home-property-row').length > ${beforeRows}`,
    'property list refreshed with imported buildings',
    45_000,
    `({
      propertyRows: document.querySelectorAll('.home-property-row').length,
      projectRows: document.querySelectorAll('[data-project-id]').length,
      selectedProject: document.querySelector('[data-project-id][aria-pressed="true"]')?.dataset.projectId ?? null,
      toast: document.querySelector('.app-toast')?.textContent ?? null,
      projectIds: [...document.querySelectorAll('[data-project-id]')].map((el) => el.dataset.projectId),
      wantedProject: '${projectId}',
      importButton: document.getElementById('import-excel')?.textContent ?? null,
      overlay: getComputedStyle(document.getElementById('import-modal')).display,
      // How long THIS document has existed. A few seconds means the page
      // reloaded underneath the scenario rather than the state going wrong.
      documentAgeMs: Math.round(performance.now()),
      readyState: document.readyState,
      // Installed before the click and left running. An EMPTY trace here does
      // not mean "nothing changed" — it means this window is not the one the
      // recorder was installed in, i.e. the page reloaded underneath us.
      selectionTrace: (window.__selectionTrace || []).map(
        ([at, selected, rows], i, all) => [at - all[0][0], selected, rows],
      ),
    })`,
  )

  await home.eval(`clearInterval(window.__selectionTimer)`)

  const afterBuildings = Number(
    await home.eval(`(async () => (await window.electronAPI.listBuildings(${projectId})).length)()`),
  )
  checks.note('buildings after import', afterBuildings)

  // The success toast is built by the renderer from the handler's returned
  // summary, which came from the real DB writes — so it reports the created
  // properties and assets.
  const toast = String(await home.eval(`document.querySelector('.app-toast')?.textContent ?? ''`))
  checks.note('toast', toast)
  checks.check(
    'import shows a success toast for properties and assets',
    /Imported \d+ propert/.test(toast) && /\d+ new asset/.test(toast),
    true,
  )
  const importedProps = Number((toast.match(/Imported (\d+) propert/) || [])[1] || 0)
  const importedAssets = Number((toast.match(/(\d+) new asset/) || [])[1] || 0)

  // The buildings actually persisted match what the toast reported (ties the DB
  // state to the message), and the import was a real bulk load.
  checks.check(
    'persisted buildings match the toast property count',
    afterBuildings - beforeBuildings === importedProps,
    true,
  )
  checks.check('import created many properties', importedProps >= 20, true)
  checks.check('the toast reports thousands of imported assets', importedAssets > 3000, true)

  // Spot-check that an imported building actually holds assessed assets in a
  // generated report (the same path the Word export uses).
  const firstImportedHasAssets = await home.eval(`(async () => {
    const buildings = await window.electronAPI.listBuildings(${projectId})
    for (const b of buildings) {
      const data = await window.electronAPI.getPropertyReportData(${projectId}, b.id)
      if (data && data.assets && data.assets.length > 20) return true
    }
    return false
  })()`)
  checks.check('an imported building yields a report with assessed assets', firstImportedHasAssets, true)

  // The overlay must come down, and leave the page usable — an overlay stuck on
  // screen swallows every click behind it while `el.hidden` still reads true.
  await home.until(
    `getComputedStyle(document.getElementById('import-modal')).display === 'none'`,
    'import overlay dismissed',
    30_000,
  )
  checks.check(
    'a real click on the import button reaches it again after the import',
    await home.topElementAt('#import-excel'),
    '#import-excel',
  )
  checks.note('overlay labels seen', JSON.stringify(overlay.labels))

  await sleep(200)
  await home.screenshot(path.join(outDir, 'excel-import.png'))
}

void (async () => {
  try {
    await runScenario(
      'verify-excel-import',
      {
        rendererPort: 9353,
        mainPort: 9354,
        userDataDir,
        env: {
          CONDITION_ASSESSMENT_AUTO_IMPORT: samplePath,
          CONDITION_ASSESSMENT_AUTO_IMPORT_MODE: 'new',
        },
      },
      scenario,
    )
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true })
  }
})()
