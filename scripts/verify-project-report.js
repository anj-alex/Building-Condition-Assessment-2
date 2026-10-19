/**
 * Verify the project-wide report end to end in the running app.
 *
 * Covers what unit tests structurally cannot: that the picker renders every
 * building of the selected project, and that generating produces ONE
 * Word-derived review document containing the selected building identities and
 * consolidated project summary.
 *
 * The Word file itself is the subject of verify-word-export.js; this scenario
 * owns the picker and the on-screen document it produces.
 *
 *   node scripts/verify-project-report.js
 *   node scripts/verify-project-report.js --user-data-dir=/tmp/ui   # debug real data
 *
 * Output (screenshots) lands in out/ui-driver/, which is gitignored.
 *
 * Runs in a throwaway userData profile by default — like the other two
 * scenarios — so it never migrates or opens the developer's real dev database
 * and never trips the single-instance lock when the dev app is already open.
 * Pass --user-data-dir= to point it at a real profile for debugging.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { repoRoot, runScenario, sleep } = require('./ui-driver')

const outDir = path.join(repoRoot, 'out', 'ui-driver')
const explicitUserDataDir =
  process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.split('=')[1] ?? null
// A throwaway profile is the default; only an explicit flag reuses real data.
const userDataDir =
  explicitUserDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cara-project-report-ui-'))

/** The generate button inside the picker, as an expression usable from `eval`. */
const generateBtn = `document.querySelector('#project-report-picker .home-modal-footer .home-action-btn--primary')`
const pickerRows = `[...document.querySelectorAll('#project-report-picker .home-modal-row')]`

/**
 * Wait for the report page to finish building and rendering its Word artifact.
 *
 * The export button cannot be the signal any more: the pre-export review
 * legitimately leaves it disabled on a complete render when mandatory facility
 * information is missing. `reportReady` is the page's own explicit marker.
 */
async function waitForReport(report, checks) {
  await report.until(
    `document.body.dataset.reportReady === 'true' &&
      document.body.dataset.reportPreviewSource === 'docx' &&
      document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview').length > 0`,
    'Word-derived report render',
    90_000,
  )
  checks.check(
    'the ready report identifies the DOCX as its preview source',
    {
      ready: await report.eval(`document.body.getAttribute('data-report-ready')`),
      source: await report.eval(`document.body.getAttribute('data-report-preview-source')`),
    },
    { ready: 'true', source: 'docx' },
  )
  checks.check(
    'docx-preview produced one document wrapper with rendered pages',
    {
      wrappers: await report.eval(`document.querySelectorAll('.car-word-preview-wrapper').length`),
      hasPages: await report.eval(
        `document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview').length > 0`,
      ),
    },
    { wrappers: 1, hasPages: true },
  )
  // The pre-export review blocks export while mandatory facility information is
  // missing; the dev seed is complete, so it must not be blocked here.
  checks.check(
    'a complete report is not blocked by the pre-export review',
    await report.eval(`document.getElementById('export-word').disabled`),
    false,
  )
}

/** Select a project without toggling it off — clicking the selected row deselects. */
async function selectProject(home, projectId, expectedBuildingCount) {
  const selector = `[data-project-id="${projectId}"]`
  if ((await home.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed')`)) !== 'true') {
    await home.click(selector)
  }
  // The row click starts `void selectProject(...)`; the mouse event can finish
  // while the old property list is still on screen and a replacement render is
  // in flight. Do not hit-test an action in that transient DOM: it can move
  // under the pointer between the driver's geometry read and mouse press.
  await home.until(
    `(() => {
      const project = document.querySelector(${JSON.stringify(selector)})
      return project?.getAttribute('aria-pressed') === 'true' &&
        document.querySelectorAll('#property-list-wrap .home-property-row').length === ${Number(expectedBuildingCount)}
    })()`,
    'project selection and property list settled',
  )
}

async function scenario(session, checks) {
  fs.rmSync(outDir, { recursive: true, force: true })
  const home = await session.page('index.html')
  await home.until(`document.querySelectorAll('[data-project-id]').length`, 'project list')
  checks.note('userData', await session.userDataPath())

  // Find a project with more than one building instead of hardcoding dummy ids,
  // so the scenario still runs against a hand-edited dev database.
  const target = await home.eval(`(async () => {
    for (const project of await window.electronAPI.listProjects()) {
      const buildings = await window.electronAPI.listBuildings(project.id)
      if (buildings.length > 1) {
        return {
          id: project.id,
          buildings: buildings.map((b) => ({
            id: b.id,
            title: getBuildingTitle(b),
            reportId: String(b.site_id ?? '').trim() || '#' + b.id,
          })),
        }
      }
    }
    return null
  })()`)
  if (!target) {
    throw new Error('no project with two or more buildings in the dev database (run ./load-local-db.sh)')
  }
  checks.note('project', `${target.id} — ${target.buildings.map((b) => b.title).join(', ')}`)
  const titles = target.buildings.map((b) => b.title)

  checks.check(
    'header button disabled with no project selected',
    await home.eval(`document.getElementById('generate-project-report').disabled`),
    true,
  )

  await selectProject(home, target.id, titles.length)
  await home.until(
    `document.querySelectorAll('#property-list-wrap .home-property-row').length === ${titles.length}`,
    'property rows',
  )
  checks.check(
    'header button enabled once a project with buildings is selected',
    await home.eval(`document.getElementById('generate-project-report').disabled`),
    false,
  )
  await home.screenshot(path.join(outDir, '01-properties.png'))

  await home.click('#generate-project-report')
  await home.until(`!!document.getElementById('project-report-picker')`, 'picker')
  checks.check(
    'picker lists every building of the project, all checked',
    await home.eval(
      `${pickerRows}.map((r) => [r.querySelector('strong').textContent, r.querySelector('input').checked])`,
    ),
    titles.map((title) => [title, true]),
  )
  checks.check(
    'generate label counts the selection',
    await home.eval(`${generateBtn}.textContent`),
    `Generate report (${titles.length} properties)`,
  )
  await home.screenshot(path.join(outDir, '02-picker.png'))

  // Unchecking, clearing and re-selecting all drive the label and disabled state.
  await home.eval(`(() => {
    const input = ${pickerRows}[${titles.length - 1}].querySelector('input')
    input.checked = false
    input.dispatchEvent(new Event('change'))
  })()`)
  checks.check(
    'label follows the count after unchecking one',
    await home.eval(`${generateBtn}.textContent`),
    titles.length === 2
      ? 'Generate report (1 property)'
      : `Generate report (${titles.length - 1} properties)`,
  )
  await home.click('#project-report-picker .home-modal-toolbar .home-modal-link-btn:nth-child(2)')
  checks.check('clear all disables generate', await home.eval(`${generateBtn}.disabled`), true)
  await home.click('#project-report-picker .home-modal-toolbar .home-modal-link-btn:nth-child(1)')
  checks.check(
    'select all restores every building',
    await home.eval(`${generateBtn}.textContent`),
    `Generate report (${titles.length} properties)`,
  )

  // Escape is handled on keydown, so it needs a real key event.
  await home.key('Escape', 27)
  await sleep(300)
  checks.check(
    'escape closes the picker',
    await home.eval(`!!document.getElementById('project-report-picker')`),
    false,
  )

  await home.click('#generate-project-report')
  await home.until(`!!document.getElementById('project-report-picker')`, 'picker reopened')
  await home.click('#project-report-picker .home-modal-footer .home-action-btn--primary')

  const report = await session.page('property-report.html')
  checks.check(
    'report hash carries every selected building id',
    report.url.split('#')[1],
    `${target.id}:${target.buildings.map((b) => b.id).join(',')}`,
  )
  await waitForReport(report, checks)

  const expectedIdentities = target.buildings.flatMap((building) => [
    building.title,
    `Property ID: ${building.reportId}`,
  ])
  checks.check(
    'the rendered Word document contains every selected property identity',
    await report.eval(`(() => {
      const text = document.querySelector('.car-word-preview-wrapper')?.textContent ?? ''
      return ${JSON.stringify(expectedIdentities)}.filter((identity) => !text.includes(identity))
    })()`),
    [],
  )
  checks.check(
    'the rendered Word document contains the consolidated portfolio summary',
    await report.eval(
      `document.querySelector('.car-word-preview-wrapper')?.textContent.includes('Portfolio Capital Overview')`,
    ),
    true,
  )
  // A binder's contents lists the portfolio's own sections and then one line per
  // property. It deliberately does not list the buildings' headings: those are
  // the same three dozen titles once per property, naming none of them.
  checks.check(
    'the rendered contents page lists every property and no per-building heading',
    await report.eval(`(() => {
      const wrapper = document.querySelector('.car-word-preview-wrapper')
      const page = [...document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview')]
        .find((section) => section.textContent.includes('Report Contents'))
      const contents = page?.textContent ?? ''
      return {
        found: Boolean(page),
        hasPortfolioEntry: contents.includes('Portfolio Capital Overview'),
        missingProperties: ${JSON.stringify(titles)}.filter((title) => !contents.includes(title)),
        listsBuildingSections: contents.includes('Executive Summary'),
        executiveSummaryHeadings: [...(wrapper?.querySelectorAll('p') ?? [])]
          .filter((paragraph) => paragraph.textContent.trim() === 'Executive Summary').length,
      }
    })()`),
    {
      found: true,
      hasPortfolioEntry: true,
      missingProperties: [],
      listsBuildingSections: false,
      executiveSummaryHeadings: titles.length,
    },
  )
  checks.check(
    'status reports the property count and rendered preview pages',
    await report.eval(
      `new RegExp('^${titles.length} properties · [1-9][0-9]* preview pages? ready\\.$')
        .test(document.getElementById('export-status').textContent)`,
    ),
    true,
  )

  await report.screenshot(path.join(outDir, '03-report-cover.png'))
  await report.eval(`(() => {
    const title = ${JSON.stringify(titles[1])}
    const reportId = ${JSON.stringify(`Property ID: ${target.buildings[1].reportId}`)}
    const page = [...document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview')]
      .find((section) => section.textContent.includes(title) && section.textContent.includes(reportId))
    page?.scrollIntoView()
  })()`)
  await sleep(500)
  await report.screenshot(path.join(outDir, '04-second-cover.png'))

  await report.eval(`(() => {
    const page = [...document.querySelectorAll('.car-word-preview-wrapper > section.car-word-preview')]
      .find((section) => section.textContent.includes('Report Contents'))
    page?.scrollIntoView()
  })()`)
  await sleep(500)
  await report.screenshot(path.join(outDir, '05-report-contents.png'))
}

void (async () => {
  try {
    await runScenario(
      'verify-project-report',
      { rendererPort: 9333, mainPort: 9334, userDataDir },
      scenario,
    )
  } finally {
    // Only remove a profile we created; leave an explicitly-passed one alone.
    if (!explicitUserDataDir) {
      fs.rmSync(userDataDir, { force: true, recursive: true })
    }
  }
})()
