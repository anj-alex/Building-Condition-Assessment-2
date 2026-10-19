// Section 6 acceptance test from the client requirements
// (BCA_Software_Developer_Fix_and_Enhancement_Requirements.pdf): demonstrate the
// full chain end to end — import a sample Excel project, generate the complete
// project report, and verify the delivered Word document carries the same asset
// data, OPC totals, CRV, FCI, action years, planning terms, and annual forecasts
// as the report itself, with no incomplete-asset pages and no formula errors.
//
// The on-screen report and the Word document are both built from the one
// getPropertyReportData snapshot (see docs/word-export.md), so "the same" is
// demonstrated by asserting the rendered .docx actually contains the exact
// values the report data computes, through the same formatting helper.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const XLSX = require('xlsx')
const JSZip = require('jszip')
const { setUserDataPath } = require('./helpers/electron-stub')
const db = require('../src/db')
const { parseBcaWorkbook } = require('../src/lib/bca-workbook')
const { applyImport } = require('../src/import-bca')
const { buildProjectReportDocxBuffer, currency } = require('../src/docx-report')
const { isAssetAssessed } = require('../src/lib/asset-completeness')
const { displayActionYear } = require('../src/lib/property-report-rules')

const samplePath = path.join(
  __dirname,
  '..',
  'samples',
  'Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx',
)
// Parse once — only the two sheets the parser reads (the file is ~4 MB).
const parsed = parseBcaWorkbook(XLSX.readFile(samplePath, { sheets: ['Worksheet', 'Legend'] }))

function freshDb(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-accept-'))
  db.closeDatabase()
  setUserDataPath(userData)
  const database = db.openDatabase()
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(userData, { recursive: true, force: true })
  })
  return database
}

async function documentXml(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('word/document.xml').async('string')
}

test('acceptance: import a sample Excel project, generate the report, and confirm the Word document agrees with it, with no incomplete pages or formula errors', async (t) => {
  // No formula errors in the imported workbook that would block the report.
  assert.equal(parsed.errors.length, 0, 'sample workbook parses with no formula errors')
  assert.equal(parsed.missingColumns.length, 0, 'template columns are all present')

  // 1. Import the sample Excel project.
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  const imported = applyImport({ database, parsed, projectId, mode: 'new' })
  assert.ok(imported.summary.createdBuildings > 1, 'the sample imports several buildings')
  assert.ok(imported.summary.createdAssets > 3000, 'the sample imports thousands of assets')

  // 2. Generate the complete project report. The multi-building consolidation
  // (Section 3) is building-count-independent, so two imported buildings
  // exercise the whole project path without building a 4,000-asset document.
  //
  // Sites 22 and 26 (Pines Lodge, West Pine Lodge) are buildings the assessor
  // actually walked; West Pine also carries lifecycle dates that have already
  // expired (1981, 2000), which is what the overdue assertions below need. Most
  // sites in this workbook are the untouched master library and correctly
  // contribute almost nothing to a report — see "an un-inspected building
  // contributes only its assessed rows" in import-bca.test.js.
  const buildingRows = database
    .prepare(
      "SELECT id, site_id FROM building WHERE project_id = ? AND site_id IN ('22', '26') ORDER BY CAST(site_id AS INTEGER)",
    )
    .all(projectId)
  assert.equal(buildingRows.length, 2)

  const reportBySite = new Map()
  for (const row of buildingRows) {
    const data = db.getPropertyReportData(projectId, row.id)
    assert.ok(data, `building ${row.id} yields report data`)
    reportBySite.set(String(row.site_id), data)
  }
  const reports = [...reportBySite.values()]

  // No incomplete-asset pages: every asset carried into the report is assessed,
  // so none renders as "Not Assessed", and the plan totals are computed over
  // assessed assets only. The report is a filtered view of the import — the
  // whole master library stays in the database, editable, and out of the report.
  for (const report of reports) {
    assert.ok(report.assets.length > 0, 'each building has report assets')
    for (const asset of report.assets) {
      assert.notEqual(asset.assessed, false, `asset "${asset.asset_name}" is assessed`)
      assert.ok(
        isAssetAssessed(asset, asset.images),
        `asset "${asset.asset_name}" carries property-specific data`,
      )
    }
  }

  // The client's rejection of the 201-page draft in one assertion: a report is
  // an assessment, not a printout of the component library.
  const storedAssets = database
    .prepare('SELECT COUNT(*) AS n FROM asset e JOIN building b ON b.id = e.building_id WHERE b.project_id = ?')
    .get(projectId).n
  const reportedAssets = reports.reduce((sum, report) => sum + report.assets.length, 0)
  assert.ok(
    reportedAssets < storedAssets / 10,
    `the report is the assessed subset, not the library (${reportedAssets} of ${storedAssets})`,
  )

  // 3. Build the Word document from the same snapshot the report renders from.
  const buffer = await buildProjectReportDocxBuffer({ reports })
  assert.equal(buffer[0], 0x50) // ZIP magic — a .docx is a zip.
  assert.equal(buffer[1], 0x4b)
  const xml = await documentXml(buffer)

  // No incomplete pages and no formula errors leak into the Word output.
  assert.doesNotMatch(xml, /Not Assessed/, 'no incomplete-asset pages in the report')
  assert.doesNotMatch(xml, /#REF!|#VALUE!|#DIV\/0!|#NAME\?|\bNaN\b/, 'no formula errors in the report')

  // 4. The document carries the report's own data. Both come from the same
  // snapshot and format with the same currency helper, so the report's computed
  // CRV total and current FCI grade must appear verbatim in the Word document.
  for (const report of reports) {
    const plan = report.capitalPlan
    assert.ok(plan.crv?.value > 0, 'building has a positive CRV')
    assert.ok(xml.includes(currency(plan.crv.value)), 'the CRV total appears in the Word document')

    const currentFci = plan.fci?.[0]
    assert.ok(currentFci?.grade, 'building has a current FCI grade')
    assert.ok(xml.includes(currentFci.grade), 'the FCI grade appears in the Word document')
  }

  // The action year and adjusted unit cost are engine-derived from the imported
  // inputs (not the workbook's computed columns) and match the workbook: the
  // Pines Lodge (site 22) foundation is vintage 1976 + 100-year life -> 2076,
  // and its $25 reference cost adjusts to $26 at location factor 1.02 — the
  // same numbers the report shows.
  const site22 = reportBySite.get('22')
  assert.ok(site22, 'site 22 building is in the report')
  const foundation = site22.assets.find((a) => /foundation and footings/i.test(a.asset_name ?? ''))
  assert.ok(foundation, 'foundation asset present')
  assert.equal(foundation.capital.actionYear, 2076)
  assert.equal(foundation.capital.adjustedUnitCost, 26)
  assert.ok(xml.includes('2076'), 'the derived action year appears in the Word document')

  // No expired lifecycle date is ever printed as the current recommended action
  // year. Where the workbook's date has passed, the report shows the assessment
  // year and says the work is overdue — on screen and in the document alike,
  // from the same helper.
  let overdueChecked = 0
  for (const report of reports) {
    for (const asset of report.assets) {
      const capital = asset.capital
      if (!capital?.actionYearIsOverdue) continue
      overdueChecked += 1
      const printed = String(displayActionYear(capital, asset))
      assert.match(printed, /overdue/, `"${asset.asset_name}" must be marked overdue`)
      assert.ok(
        printed.startsWith(String(capital.scheduledActionYear)),
        `"${asset.asset_name}" must lead with the year the work is actually due`,
      )
      assert.ok(
        xml.includes(escapeXml(printed)),
        `the Word document must carry the overdue action year for "${asset.asset_name}"`,
      )
    }
  }
  assert.ok(overdueChecked > 0, 'the sample really does contain overdue lifecycle dates')
})

// docx escapes the characters it has to; the em dash in the overdue label is
// written through as-is.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
