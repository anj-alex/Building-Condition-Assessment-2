/**
 * Verify "Save Word Report…" end to end in the running app.
 *
 * The unit tests exercise the Word artifact boundary in-process. They never
 * click the button, never run the native-path authorization, and never assert
 * that the already-previewed .docx lands on disk — which is exactly where a
 * user sees "nothing was saved". This scenario closes that gap.
 *
 * It also pins the three behaviours that make the Word file findable:
 *
 * - the .docx is written to the location the save dialog chose, not to some
 *   path the handler derived on its own;
 * - the Word-derived preview is ready before saving, and the page keeps that
 *   same preview mounted while the artifact is written;
 * - the app reports the written path instead of leaving a silent file.
 *
 * It runs at the size real reports actually reach: the scenario imports the
 * 4,091-row sample BCA workbook into one dev-seed project and exports the whole
 * 27-property result. Assessment completeness filters the master-library
 * placeholders, leaving 684 included asset entries. That still exercises the
 * large-document build, browser-side DOCX render, memory pressure, and save
 * path, and this scenario runs on Windows in the pre-release gate — the
 * platform the reports come back from.
 *
 * Every click here goes through `page.click`, which hit-tests before dispatching
 * a real mouse event. That is deliberate: 1.6.1 shipped an export overlay that
 * covered the whole report page and swallowed every toolbar click, and this
 * scenario passed anyway, because `element.click()` fires straight at the node.
 *
 * The native save dialog is bypassed with the CONDITION_ASSESSMENT_AUTO_DOCX
 * env hook (no driver can dismiss an OS dialog); everything downstream of the
 * button — the IPC round-trip and exact prepared-artifact write — is real. The
 * report data snapshot and DOCX build happen earlier, before the preview is
 * marked ready.
 *
 * Uses an isolated userData profile so it never writes into the dev database.
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-word-ui-'))
const outDir = path.join(repoRoot, 'out', 'ui-driver', 'word-export')
const docxPath = path.join(outDir, 'chosen-word-report.docx')

/**
 * Clear the pre-export gate, asserting on the way through that it did its job.
 *
 * The gate disables export while the review holds any error, and "Export
 * anyway" is the only way past it short of fixing the data. A scenario that just
 * clicked past a missing button would hide a regression in either direction, so
 * this asserts the before and after states rather than tolerating whichever it
 * finds.
 */
async function unblockExport(checks, page, label) {
  const blocked = await page.eval(`Boolean(document.getElementById('report-review-override'))`)
  if (!blocked) {
    checks.check(
      `${label}: export is available on a complete report`,
      await page.eval(`document.getElementById('export-word').disabled`),
      false,
    )
    return
  }
  checks.check(
    `${label}: the review blocks export until the data is complete`,
    await page.eval(`document.getElementById('export-word').disabled`),
    true,
  )
  await page.click('#report-review-override')
  await page.until(
    `document.getElementById('export-word').disabled === false`,
    `${label}: export unblocked by the user`,
  )
}

/** Clear the output so an assertion can never pass on a stale file. */
function clearOutputs() {
  fs.mkdirSync(outDir, { recursive: true })
  fs.rmSync(docxPath, { force: true })
}

/**
 * A real .docx is a zip. Checking the PK magic and that the archive names
 * `word/document.xml` proves Word has a document part to open — a zero-byte or
 * truncated write fails here rather than at the client's desk. Zip stores entry
 * names uncompressed in each local file header, so this needs no zip library.
 */
function inspectDocx(file) {
  if (!fs.existsSync(file)) return { exists: false }
  const buffer = fs.readFileSync(file)
  return {
    exists: true,
    bytes: buffer.length,
    isZip: buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b,
    hasDocumentPart: buffer.includes('word/document.xml'),
  }
}

/** Wait for the authoritative DOCX artifact to be rendered into review pages. */
async function waitForWordPreview(checks, report, label, expectedTitles, timeout = 180_000) {
  await report.until(
    `document.body.dataset.reportReady === 'true' &&
      document.body.dataset.reportPreviewSource === 'docx' &&
      document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview').length > 0`,
    `${label}: Word-derived preview render`,
    timeout,
  )
  checks.check(
    `${label}: ready state identifies a DOCX-derived preview`,
    {
      ready: await report.eval(`document.body.getAttribute('data-report-ready')`),
      source: await report.eval(`document.body.getAttribute('data-report-preview-source')`),
    },
    { ready: 'true', source: 'docx' },
  )
  checks.check(
    `${label}: docx-preview rendered pages for the prepared artifact`,
    await report.eval(
      `document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview').length > 0`,
    ),
    true,
  )
  checks.check(
    `${label}: the rendered document contains every selected property name`,
    await report.eval(`(() => {
      const text = document.querySelector('.car-word-preview-wrapper')?.textContent ?? ''
      return ${JSON.stringify(expectedTitles)}.filter((title) => !text.includes(title))
    })()`),
    [],
  )
}

/** Click the button and wait for the modal to reach its finished state. */
async function clickExport(report) {
  clearOutputs()
  // Saving must not swap or rebuild the reviewed document. Keep the live node
  // identity so the finished state can prove the same preview stayed mounted.
  await report.eval(
    `window.__previewNodeBeforeSave = document.querySelector('.car-word-preview-wrapper')`,
  )
  // A real, hit-tested mouse click: fails loudly if anything covers the button.
  await report.click('#export-word')
  await report.until(
    `(() => {
      const done = document.getElementById('export-modal-done')
      const modal = document.getElementById('export-modal')
      return !!modal && !modal.hidden && !!done && !done.hidden
    })()`,
    'export modal reached its finished state',
    180_000,
  )
  return {
    status: String(await report.eval(`document.getElementById('export-status').textContent`)),
    files: await report.eval(
      `[...document.querySelectorAll('#export-modal-files li')].map((li) => li.textContent)`,
    ),
    previewUnchanged: await report.eval(
      `window.__previewNodeBeforeSave === document.querySelector('.car-word-preview-wrapper')`,
    ),
  }
}

/** Assert the document exists for one export, labelled by which export it was. */
async function checkExport(checks, report, label) {
  const { status, files, previewUnchanged } = await clickExport(report)
  checks.note(`${label} status`, status)
  checks.note(`${label} files listed`, JSON.stringify(files))
  checks.check(
    `${label}: saving keeps the reviewed Word preview mounted`,
    previewUnchanged,
    true,
  )
  const docx = inspectDocx(docxPath)
  checks.note(`${label} docx`, JSON.stringify(docx))

  // The renderer reports this exact sentence only when the handler comes back
  // having actually written the document — a silent failure says otherwise.
  checks.check(`${label}: status reports a written Word report`, status, 'Word report saved.')
  checks.check(
    `${label}: the Word file was written to the chosen path`,
    docx.exists,
    true,
  )
  checks.check(
    `${label}: the Word file is a real openable document`,
    { isZip: docx.isZip, hasDocumentPart: docx.hasDocumentPart, nonTrivial: docx.bytes > 5_000 },
    { isZip: true, hasDocumentPart: true, nonTrivial: true },
  )
  // The whole point of the rework: the user is told where the file went.
  checks.check(
    `${label}: the finished modal names the written file`,
    files.some((f) => f.includes(docxPath)),
    true,
  )

  // Done releases the modal and re-enables the toolbar.
  await report.click('#export-modal-close')
  await report.until(
    `document.getElementById('export-modal').hidden === true`,
    'modal dismissed by Done',
  )
  checks.check(
    `${label}: Done re-enables the export button`,
    await report.eval(`document.getElementById('export-word').disabled`),
    false,
  )
  // `hidden` is only an attribute — assert what is actually on screen. An author
  // `display` rule beats the UA [hidden] rule and leaves the overlay up while
  // `el.hidden` still reads true, which is precisely how 1.6.1 shipped broken.
  await assertToolbarUsable(checks, report, `${label}: after Done`)
}

/**
 * The report toolbar is reachable by a real mouse: the export overlay is not
 * painted, and each toolbar control is the topmost element at its own centre.
 */
async function assertToolbarUsable(checks, report, label) {
  checks.check(
    `${label}: the export overlay is not on screen`,
    await report.eval(`getComputedStyle(document.getElementById('export-modal')).display`),
    'none',
  )
  for (const selector of ['#back-home', '#export-word']) {
    checks.check(
      `${label}: a real click on ${selector} reaches it`,
      await report.topElementAt(selector),
      selector,
    )
  }
}

async function scenario(session, checks) {
  const home = await session.page('index.html')
  await home.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
  checks.note('userData', await session.userDataPath())

  // Load the sample BCA workbook first, so the export runs against a real-world
  // report rather than the three-building dev seed. The workbook has 4,091
  // source rows; assessment completeness deliberately removes its unassessed
  // component-library placeholders from the report. The surviving hundreds of
  // asset pages still exercise the large-document path.
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
  await home.click('#import-excel')
  await home.until(
    `document.querySelectorAll('.home-property-row').length > ${beforeRows}`,
    'property list refreshed with the imported workbook',
    120_000,
  )

  // Discover buildings rather than hardcoding ids, so the scenario survives a
  // hand-edited database (same rule as the project-report scenario).
  const target = await home.eval(`(async () => {
    const buildings = await window.electronAPI.listBuildings(${projectId})
    if (buildings.length === 0) return null
    return {
      id: ${projectId},
      buildingIds: buildings.map((b) => b.id),
      titles: buildings.map((b) => getBuildingTitle(b)),
    }
  })()`)
  if (!target) throw new Error('no project with a building in the database (run ./load-local-db.sh)')
  checks.note('project', `${target.id} — ${target.buildingIds.length} building(s)`)
  checks.check('the imported project is a real-world sized report', target.buildingIds.length >= 20, true)

  // --- Whole-project export (multi-building also covers the consolidated
  // project summary path inside the docx builder). ---
  const allIds = JSON.stringify(target.buildingIds)
  await home.eval(`void window.electronAPI.openPropertyReport(${target.id}, ${allIds})`)
  const report = await session.page('property-report.html')
  await waitForWordPreview(checks, report, 'project export', target.titles)
  // An imported workbook carries no address, floor area, storey count or
  // replacement value — the assessor supplies those — so the pre-export review
  // legitimately blocks export on a freshly imported project. Clearing it here
  // is real coverage of the gate: the button must be unusable until it is.
  await unblockExport(checks, report, 'project export')
  const previewPages = Number(
    await report.eval(
      `document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview').length`,
    ),
  )
  checks.note('rendered Word preview pages', previewPages)
  // Nothing has been clicked yet: the export overlay must not be on screen, and
  // every toolbar control must be reachable by a real mouse. This is the check
  // that 1.6.1 needed and did not have.
  await assertToolbarUsable(checks, report, 'freshly rendered report')
  await checkExport(checks, report, 'project export')
  await sleep(200)
  await report.screenshot(path.join(outDir, 'word-export.png'))

  // --- Single-building export (the other way users reach this button). ---
  if (target.buildingIds.length > 1) {
    await report.eval(`void window.electronAPI.goHome({})`)
    const backHome = await session.page('index.html')
    await backHome.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
    await backHome.eval(
      `void window.electronAPI.openPropertyReport(${target.id}, [${target.buildingIds[0]}])`,
    )
    const single = await session.page('property-report.html')
    await waitForWordPreview(
      checks,
      single,
      'single-building export',
      [target.titles[0]],
      90_000,
    )
    await unblockExport(checks, single, 'single-building export')
    await assertToolbarUsable(checks, single, 'freshly rendered single-building report')
    await checkExport(checks, single, 'single-building export')
  }
}

void (async () => {
  try {
    await runScenario(
      'verify-word-export',
      {
        rendererPort: 9363,
        mainPort: 9364,
        userDataDir,
        env: {
          CONDITION_ASSESSMENT_AUTO_IMPORT: samplePath,
          CONDITION_ASSESSMENT_AUTO_IMPORT_MODE: 'new',
          CONDITION_ASSESSMENT_AUTO_DOCX: docxPath,
        },
      },
      scenario,
    )
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true })
  }
})()
