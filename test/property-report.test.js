const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { setUserDataPath } = require('./helpers/electron-stub')
const db = require('../src/db')
const { loadPage } = require('./helpers/renderer-page')

function preparedReport({
  previewId = 'preview-1',
  bytes = [0x50, 0x4b, 3, 4],
  title = 'Riverbend Tower',
  client = 'Acme Property Co',
  findings = [],
} = {}) {
  const errorCount = findings.filter((finding) => finding.severity === 'error').length
  const warningCount = findings.filter((finding) => finding.severity !== 'error').length
  return {
    ok: true,
    previewId,
    docxBytes: bytes,
    requestedCount: 1,
    reviewReports: [
      {
        project: { client },
        building: { id: 7, property_name: title },
        validation: { findings, errorCount, warningCount },
      },
    ],
  }
}

function loadReportPage(t, { electronAPI = {}, renderAsync } = {}) {
  const renders = []
  const page = loadPage('property-report.html', {
    hash: '3:7',
    electronAPI,
    beforeScript({ scriptPath, window }) {
      if (path.basename(scriptPath) !== 'property-report.js') return
      const browserSetTimeout = window.setTimeout.bind(window)
      // The production delay lets docx-preview's measured tab-stop pass finish.
      // Keep that ordering in tests without adding 550 ms to every assertion.
      window.setTimeout = (callback, delay, ...args) =>
        browserSetTimeout(callback, delay === 550 ? 0 : delay, ...args)
      window.docx = {
        renderAsync: async (bytes, body, styles, options) => {
          renders.push({ bytes: Array.from(bytes), options })
          if (renderAsync) return renderAsync(bytes, body, styles, options, window)
          const style = window.document.createElement('style')
          style.textContent = '.car-word-preview { color: black; }'
          styles.appendChild(style)
          const wrapper = window.document.createElement('div')
          wrapper.className = 'car-word-preview-wrapper'
          const sheet = window.document.createElement('section')
          sheet.className = 'car-word-preview'
          sheet.textContent = 'Rendered from the prepared DOCX'
          wrapper.appendChild(sheet)
          body.appendChild(wrapper)
        },
      }
    },
  })
  t.after(() => page.dom.window.close())
  return { ...page, renders }
}

async function until(check, message, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

test('the preview renderer receives the exact prepared DOCX bytes', async (t) => {
  const response = preparedReport({ bytes: [80, 75, 9, 8, 7] })
  const { document, calls, renders } = loadReportPage(t, {
    electronAPI: { preparePropertyReport: () => response },
  })

  await until(() => document.body.dataset.reportReady === 'true', 'preview never became ready')

  assert.deepEqual(renders[0].bytes, response.docxBytes)
  assert.equal(renders[0].options.className, 'car-word-preview')
  assert.equal(renders[0].options.breakPages, true)
  assert.equal(renders[0].options.renderHeaders, true)
  assert.equal(renders[0].options.renderFooters, true)
  assert.equal(renders[0].options.experimental, true)
  assert.equal(document.body.dataset.reportPreviewSource, 'docx')
  assert.match(document.getElementById('report-root').textContent, /prepared DOCX/)
  assert.equal(document.getElementById('preview-source').hidden, false)
  assert.match(document.getElementById('preview-note').textContent, /exact DOCX bytes/)
  assert.equal(document.getElementById('export-word').disabled, false)
  assert.equal(
    calls.some((call) => call.method === 'getPropertyReportData'),
    false,
    'the page must not assemble a second renderer-side snapshot',
  )
})

test('saving sends only the prepared artifact id, path capability, and review override', async (t) => {
  const { document, calls } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => preparedReport({ previewId: 'reviewed-preview' }),
      chooseReportExportPath: () => ({ canceled: false, exportId: 'save-once' }),
      exportPropertyReport: () => ({
        canceled: false,
        docxPath: '/private/chosen/report.docx',
      }),
    },
  })
  await until(() => document.body.dataset.reportReady === 'true', 'preview never became ready')

  document.getElementById('export-word').click()
  await until(
    () => document.getElementById('export-modal-done').hidden === false,
    'save result never appeared',
  )

  const chose = calls.find((call) => call.method === 'chooseReportExportPath')
  assert.match(chose.args[0], /riverbend-tower-condition-assessment\.docx/)
  const saved = calls.find((call) => call.method === 'exportPropertyReport')
  assert.equal(saved.args[0], 'reviewed-preview')
  assert.equal(saved.args[1], 'save-once')
  assert.equal(saved.args[2].allowValidationErrors, false)
  assert.equal(saved.args.includes('/private/chosen/report.docx'), false)
  assert.equal(document.getElementById('export-status').textContent, 'Word report saved.')
  assert.match(document.getElementById('export-modal-files').textContent, /report\.docx/)
})

test('validation errors block saving until the user explicitly overrides them', async (t) => {
  const { document, calls } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () =>
        preparedReport({
          findings: [{ severity: 'error', message: 'Address is missing.' }],
        }),
      chooseReportExportPath: () => ({ canceled: false, exportId: 'save-once' }),
      exportPropertyReport: () => ({ docxPath: '/out/report.docx' }),
    },
  })
  await until(() => document.body.dataset.reportReady === 'true', 'preview never became ready')

  assert.equal(document.getElementById('export-word').disabled, true)
  assert.match(document.getElementById('report-review').textContent, /Address is missing/)
  document.getElementById('report-review-override').click()
  assert.equal(document.getElementById('export-word').disabled, false)

  document.getElementById('export-word').click()
  await until(
    () => calls.some((call) => call.method === 'exportPropertyReport'),
    'override was not sent to main',
  )
  assert.equal(
    calls.find((call) => call.method === 'exportPropertyReport').args[2]
      .allowValidationErrors,
    true,
  )
})

test('a DOCX render failure is visible, retryable, and never enables saving', async (t) => {
  const { document } = loadReportPage(t, {
    electronAPI: { preparePropertyReport: () => preparedReport() },
    renderAsync: async () => {
      throw new Error('Malformed Word package')
    },
  })

  await until(
    () => /could not be displayed/.test(document.getElementById('report-root').textContent),
    'render failure was not shown',
  )
  assert.match(document.getElementById('report-root').textContent, /Malformed Word package/)
  assert.equal(document.querySelector('.report-preview-action').textContent, 'Try again')
  assert.equal(document.getElementById('export-word').disabled, true)
  assert.equal(document.body.dataset.reportReady, undefined)
})

test('an empty DOCX render is rejected instead of enabling a blank preview', async (t) => {
  const { document } = loadReportPage(t, {
    electronAPI: { preparePropertyReport: () => preparedReport() },
    renderAsync: async () => {},
  })

  await until(
    () => /could not be displayed/.test(document.getElementById('report-root').textContent),
    'empty render failure was not shown',
  )
  assert.match(document.getElementById('report-root').textContent, /did not produce any pages/)
  assert.equal(document.getElementById('export-word').disabled, true)
  assert.equal(document.body.dataset.reportReady, undefined)
})

test('AI activity marks the preview stale and a terminal event prepares it again', async (t) => {
  let captionUpdate
  let prepareCount = 0
  const { document, calls } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => {
        prepareCount += 1
        return preparedReport({ previewId: `preview-${prepareCount}` })
      },
      onCaptionUpdated: (callback) => {
        captionUpdate = callback
      },
    },
  })
  await until(() => document.body.dataset.reportReady === 'true', 'initial preview never became ready')

  captionUpdate({ state: 'generating', buildingId: 7, imageId: 90 })
  assert.equal(document.body.dataset.reportReady, undefined)
  assert.equal(document.getElementById('export-word').disabled, true)
  assert.match(document.getElementById('preview-note').textContent, /Saving is paused/)

  captionUpdate({ state: 'finished', buildingId: 7, imageId: 90, ok: true })
  await until(() => prepareCount === 2 && document.body.dataset.reportReady === 'true', 'updated preview never became ready')
  assert.equal(
    calls.filter((call) => call.method === 'preparePropertyReport').length,
    2,
  )
})

test('AI completing behind the save dialog rebuilds before any save', async (t) => {
  let captionUpdate
  let resolveChoice
  let prepareCount = 0
  const { document, calls } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => {
        prepareCount += 1
        return preparedReport({ previewId: `preview-${prepareCount}` })
      },
      chooseReportExportPath: () =>
        new Promise((resolve) => {
          resolveChoice = resolve
        }),
      exportPropertyReport: () => ({ docxPath: '/out/must-not-save.docx' }),
      onCaptionUpdated: (callback) => {
        captionUpdate = callback
      },
    },
  })
  await until(() => document.body.dataset.reportReady === 'true', 'initial preview never became ready')

  document.getElementById('export-word').click()
  await until(() => typeof resolveChoice === 'function', 'save dialog did not open')
  captionUpdate({ state: 'generating', buildingId: 7, imageId: 90 })
  captionUpdate({ state: 'finished', buildingId: 7, imageId: 90, ok: true })
  resolveChoice({ canceled: false, exportId: 'now-stale' })

  await until(
    () => prepareCount === 2 && document.body.dataset.reportReady === 'true',
    'preview was not rebuilt after the dialog closed',
  )
  assert.equal(
    calls.some((call) => call.method === 'exportPropertyReport'),
    false,
  )
})

test('a late render cannot publish after a newer preparation was requested', async (t) => {
  let captionUpdate
  let resolveFirstRender
  let prepareCount = 0
  const { document } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => {
        prepareCount += 1
        return preparedReport({
          previewId: `preview-${prepareCount}`,
          bytes: [prepareCount],
        })
      },
      onCaptionUpdated: (callback) => {
        captionUpdate = callback
      },
    },
    renderAsync: async (bytes, body, _styles, _options, window) => {
      if (bytes[0] === 1) {
        await new Promise((resolve) => {
          resolveFirstRender = resolve
        })
      }
      const wrapper = window.document.createElement('div')
      wrapper.className = 'car-word-preview-wrapper'
      const sheet = window.document.createElement('section')
      sheet.className = 'car-word-preview'
      sheet.textContent = `Rendered artifact ${bytes[0]}`
      wrapper.appendChild(sheet)
      body.appendChild(wrapper)
    },
  })

  await until(() => typeof resolveFirstRender === 'function', 'first render did not start')
  captionUpdate({ state: 'finished', buildingId: 7, imageId: 90, ok: true })
  resolveFirstRender()
  await until(
    () => /Rendered artifact 2/.test(document.getElementById('report-root').textContent),
    'newest artifact was not rendered',
  )
  assert.doesNotMatch(document.getElementById('report-root').textContent, /artifact 1/)
})

test('AI starting during DOCX layout supersedes that render until AI finishes', async (t) => {
  let captionUpdate
  let resolveFirstRender
  let prepareCount = 0
  const { document } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => {
        prepareCount += 1
        return preparedReport({
          previewId: `preview-${prepareCount}`,
          bytes: [prepareCount],
        })
      },
      onCaptionUpdated: (callback) => {
        captionUpdate = callback
      },
    },
    renderAsync: async (bytes, body, _styles, _options, window) => {
      if (bytes[0] === 1) {
        await new Promise((resolve) => {
          resolveFirstRender = resolve
        })
      }
      const wrapper = window.document.createElement('div')
      wrapper.className = 'car-word-preview-wrapper'
      const sheet = window.document.createElement('section')
      sheet.className = 'car-word-preview'
      sheet.textContent = `Rendered artifact ${bytes[0]}`
      wrapper.appendChild(sheet)
      body.appendChild(wrapper)
    },
  })

  await until(() => typeof resolveFirstRender === 'function', 'first render did not start')
  captionUpdate({ state: 'generating', buildingId: 7, imageId: 90 })
  resolveFirstRender()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(document.body.dataset.reportReady, undefined)
  assert.equal(document.getElementById('export-word').disabled, true)
  assert.match(document.getElementById('preview-note').textContent, /Saving is paused/)

  captionUpdate({ state: 'finished', buildingId: 7, imageId: 90, ok: true })
  await until(
    () => prepareCount === 2 && document.body.dataset.reportReady === 'true',
    'post-AI preview never became ready',
  )
  assert.match(document.getElementById('report-root').textContent, /artifact 2/)
})

test('an AI wait retries on a terminal fallback event without a building id', async (t) => {
  let captionUpdate
  let prepareCount = 0
  const { document } = loadReportPage(t, {
    electronAPI: {
      preparePropertyReport: () => {
        prepareCount += 1
        if (prepareCount === 1) {
          return {
            ok: false,
            code: 'AI_ACTIVE',
            waitingForAi: true,
            error: 'AI is still updating an included property.',
          }
        }
        return preparedReport({ previewId: 'after-ai' })
      },
      onCaptionUpdated: (callback) => {
        captionUpdate = callback
      },
    },
  })

  await until(
    () => /Waiting for AI updates/.test(document.getElementById('report-root').textContent),
    'AI wait state never appeared',
  )
  captionUpdate({ state: 'finished', kind: 'asset', imageId: 90, ok: true })

  await until(
    () => prepareCount === 2 && document.body.dataset.reportReady === 'true',
    'fallback terminal event did not retry preparation',
  )
})

function buildReportFixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-property-report-'))
  db.closeDatabase()
  setUserDataPath(userData)
  const database = db.openDatabase()
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(userData, { recursive: true, force: true })
  })

  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = Number(
    database
      .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
      .run(projectId, 'Riverbend Tower').lastInsertRowid,
  )
  db.updateBuilding(buildingId, {
    property_name: 'Riverbend Tower',
    address: '1200 West Georgia',
    gross_floor_area_m2: 4200,
    property_vintage: 1998,
    date_of_assessment: '2026-05-01',
    num_floors: 12,
    location_factor: 1.063,
    current_replacement_value: 18500000,
  })
  const assetId = db.createAsset(buildingId, 'A').id
  database
    .prepare(
      `UPDATE asset
       SET asset_name = 'Foundation walls', condition_rating = 'Fair',
           description = 'Poured concrete foundation.', action = 'Repair', quantity = 250
       WHERE id = ?`,
    )
    .run(assetId)
  return { database, projectId, buildingId, assetId }
}

test('new assets do not fabricate a vintage inherited from the building', (t) => {
  const { database, buildingId } = buildReportFixture(t)
  const assetId = db.createAsset(buildingId, 'B').id
  const row = database
    .prepare('SELECT vintage, service_life FROM asset WHERE id = ?')
    .get(assetId)
  assert.equal(row.vintage, null)
  assert.ok(row.service_life > 0)
})

test('blank assets stay out of report data unless explicitly marked Not Assessed', (t) => {
  const { database, projectId, buildingId } = buildReportFixture(t)
  const blankId = db.createAsset(buildingId, 'B').id
  assert.equal(db.getPropertyReportData(projectId, buildingId).assets.length, 1)

  database
    .prepare('UPDATE asset SET include_as_not_assessed = 1 WHERE id = ?')
    .run(blankId)
  const report = db.getPropertyReportData(projectId, buildingId)
  assert.equal(report.assets.length, 2)
  assert.equal(report.assets.find((asset) => asset.id === blankId).assessed, false)
})

test('each asset carries only its own report photos', (t) => {
  const { database, projectId, buildingId, assetId } = buildReportFixture(t)
  const roofId = db.createAsset(buildingId, 'B').id
  database
    .prepare("UPDATE asset SET asset_name = 'Built-up roof', condition_rating = 'Poor' WHERE id = ?")
    .run(roofId)
  db.createAssetImage({ asset_id: assetId, file_path: '/img/foundation.jpg' })
  db.createAssetImage({ asset_id: roofId, file_path: '/img/roof.jpg' })

  const byId = new Map(
    db.getPropertyReportData(projectId, buildingId).assets.map((asset) => [
      asset.id,
      asset,
    ]),
  )
  assert.deepEqual(byId.get(assetId).images.map((image) => image.file_path), [
    '/img/foundation.jpg',
  ])
  assert.deepEqual(byId.get(roofId).images.map((image) => image.file_path), [
    '/img/roof.jpg',
  ])
})

test('displayBuildingId prefers workbook Site ID and labels record-number fallback', () => {
  const { displayBuildingId } = require('../src/lib/property-report-rules')
  assert.equal(displayBuildingId({ id: 7, site_id: ' 1042 ' }), '1042')
  assert.equal(displayBuildingId({ id: 7, site_id: null }), '#7')
  assert.equal(displayBuildingId(null), null)
})

// docx-preview translates w:pBdr into a CSS border and silently drops the
// w:space that holds the rule off the text, so every accent bar and rule
// rendered jammed against its words while Word and LibreOffice both showed the
// gap. The preview restores it; these pin that it still does, and that it does
// it with the numbers the document actually carries.
test('the preview restores the border spacing docx-preview drops', async (t) => {
  const { document } = loadReportPage(t, {
    electronAPI: { preparePropertyReport: () => preparedReport() },
    renderAsync: async (_bytes, body, styles, _options, window) => {
      const style = window.document.createElement('style')
      style.textContent = '.car-word-preview { color: black; }'
      styles.appendChild(style)
      const wrapper = window.document.createElement('div')
      wrapper.className = 'car-word-preview-wrapper'
      const sheet = window.document.createElement('section')
      sheet.className = 'car-word-preview'
      // The two shapes the report emits: a heading whose accent bar comes from
      // a style, and a callout whose border is direct formatting.
      sheet.innerHTML =
        '<p id="bar" style="border-left: 2.25pt solid #1D5F9C; margin-left: 5.5pt;">Component Summary</p>' +
        '<p id="rule" style="border-bottom: 2.25pt solid #1D5F9C;">Facility Profile</p>' +
        '<p id="plain">Ordinary prose carries no rule.</p>' +
        '<table><tr><td id="cell" style="border-left: 1pt solid #000; padding-left: 4pt;">Cell</td></tr></table>'
      wrapper.appendChild(sheet)
      body.appendChild(wrapper)
    },
  })
  await until(() => document.body.dataset.reportReady === 'true', 'preview never became ready')

  const el = (id) => document.getElementById(id)
  assert.equal(el('bar').style.paddingLeft, '8pt', 'the accent bar gained no gap')
  assert.equal(el('rule').style.paddingBottom, '6pt', 'the heading rule gained no gap')
  assert.equal(el('plain').style.paddingLeft, '', 'an unbordered paragraph was padded')

  // Word draws a left rule outside the text rather than pushing the text in,
  // so the margin comes back by the same amount and the measure is unchanged.
  // The pull-back is written as calc() so it does not have to assume the unit
  // the engine reports a computed margin in. Engines are free to reduce that to
  // px on read-back — jsdom does — so assert the arithmetic, not the spelling.
  const compensated = el('bar').style.marginLeft
  const reduced = /^calc\(\s*(-?\d*\.?\d+)px\s*\)$/.exec(compensated)
  assert.ok(
    compensated === 'calc(5.5pt - 8pt)' ||
      (reduced && Math.abs(Number(reduced[1]) - (5.5 - 8) * (96 / 72)) < 0.01),
    `the accent bar was not pulled back by its own spacing: ${compensated}`,
  )

  // Cell padding is real — docx-preview does translate w:tblCellMar.
  assert.equal(el('cell').style.paddingLeft, '4pt', 'a table cell was re-padded')
})

test('the preview border spacing matches the numbers the document carries', () => {
  const { BORDER_SPACE_X, BORDER_SPACE_Y } = require('../src/docx-report')
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'property-report.js'), 'utf8')
  const declared = source.match(/const BORDER_SPACE_PT = (\{[^}]*\})/)?.[1]
  assert.ok(declared, 'the preview no longer declares BORDER_SPACE_PT')
  // eslint-disable-next-line no-new-func
  const preview = new Function(`return ${declared}`)()
  assert.deepEqual(preview, {
    top: BORDER_SPACE_Y,
    bottom: BORDER_SPACE_Y,
    left: BORDER_SPACE_X,
    right: BORDER_SPACE_X,
  })
})
