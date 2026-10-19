const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const JSZip = require('jszip')
const {
  setNativeImageFactory,
  setUserDataPath,
} = require('./helpers/electron-stub')
const db = require('../src/db')
const {
  annotateBitmap,
  buildProjectReportDocxBuffer,
  currency,
} = require('../src/docx-report')
const {
  LABELS,
  COMPONENT_SUMMARY_COLUMNS,
  ASSET_FIELDS,
  SCORECARD_TILES,
  SCORECARD_PRIORITY_COLUMNS,
  CONDITION_SNAPSHOT_COLUMNS,
} = require('../src/lib/report-content')

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)
const TINY_WEBP = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAgA0JaQAA3AA/vuUAAA=',
  'base64',
)

function decodedImage(width = 2400, height = 1200) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => decodedImage(size.width, size.height),
    toBitmap: () => Buffer.alloc(width * height * 4, 255),
    toJPEG: () => TINY_JPEG,
    toPNG: () => fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png')),
  }
}

function useDecodedImages(t) {
  setNativeImageFactory(() => decodedImage())
  t.after(() => setNativeImageFactory(null))
}

function seedBuilding(database, projectId, name) {
  const buildingId = Number(
    database
      .prepare('INSERT INTO building (project_id, property_name) VALUES (?, ?)')
      .run(projectId, name).lastInsertRowid,
  )
  db.updateBuilding(buildingId, {
    property_name: name,
    address: '1200 West Georgia',
    city: 'Vancouver',
    province_short: 'BC',
    postal_code: 'V6E 2Y3',
    gross_floor_area_m2: 4200,
    property_vintage: 1998,
    date_of_assessment: '2026-05-01',
    num_floors: 12,
    location_factor: 1,
    current_replacement_value: 5000000,
  })
  const assetId = db.createAsset(buildingId, 'A').id
  database
    .prepare(
      `UPDATE asset SET asset_name = ?, condition_rating = 'Fair',
         description = 'Poured concrete with minor spalling.',
         recommendation = 'Monitor and patch.', action = 'Repair', priority = 'Medium',
         quantity = 200, action_year = 2028 WHERE id = ?`,
    )
    .run(`${name} foundation`, assetId)
  return buildingId
}

function withDb(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-docx-'))
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

/**
 * The document body after the table of contents.
 *
 * Every Heading 1 is also a line in the TOC's cached outline, so a bare
 * `indexOf` on a section title finds that copy first and orders sections by
 * where they appear in the contents list rather than in the report.
 */
function afterTableOfContents(xml) {
  const end = xml.indexOf('</w:sdt>', xml.indexOf('TOC \\h \\o'))
  return end === -1 ? xml : xml.slice(end + '</w:sdt>'.length)
}

/** Every `<w:p>` in the given markup; paragraphs do not nest, so this is exact. */
function paragraphs(xml) {
  return xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []
}

function tableOfContentsXml(xml) {
  const controls = xml.match(/<w:sdt>[\s\S]*?<\/w:sdt>/g) ?? []
  // One report selects its headings by outline level, a binder by style name.
  const contents = controls.find((control) => control.includes('TOC \\h'))
  assert.ok(contents, 'the document has no live table of contents field')
  return contents
}

test('currency helper', () => {
  assert.equal(currency(0), '-')
  assert.equal(currency(1500), '$1,500')
  assert.equal(currency(null), '-')
})

test('raster fallbacks burn photo annotations into their pixels', () => {
  const width = 20
  const height = 20
  const source = Buffer.alloc(width * height * 4, 255)
  const bitmap = annotateBitmap(source, width, height, [
    { kind: 'box', x: 0.2, y: 0.2, w: 0.5, h: 0.5, color: '#ff2d2d' },
  ])
  const offset = (4 * width + 4) * 4
  assert.deepEqual([...bitmap.subarray(offset, offset + 4)], [45, 45, 255, 255])
  assert.notDeepEqual(bitmap, source)
})

test('generates a valid .docx with the report content', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const buffer = await buildProjectReportDocxBuffer({ reports: [data] })
  assert.ok(Buffer.isBuffer(buffer))
  // ZIP magic — a .docx is a zip.
  assert.equal(buffer[0], 0x50)
  assert.equal(buffer[1], 0x4b)

  const xml = await documentXml(buffer)
  assert.match(xml, /Acme Property Co/)
  assert.match(xml, /Riverbend Tower/)
  assert.match(xml, /Riverbend Tower foundation/)
  assert.match(xml, new RegExp(LABELS.capitalRenewalSummary))
  assert.match(xml, new RegExp(LABELS.facilityConditionIndex))
  assert.match(xml, /Assessment date: /)
  // The cover carries no draft/status marking — the delivered file is the report.
  assert.doesNotMatch(xml, /Report status|Draft for Review/)
})

test('the live contents field carries a visible outline and does not strand the following index', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const xml = await zip.file('word/document.xml').async('string')
  const settings = await zip.file('word/settings.xml').async('string')
  const contents = tableOfContentsXml(xml)
  const visibleOutline = contents.replace(/<[^>]+>/g, '')

  assert.match(contents, /w:fldCharType="begin" w:dirty="true"/)
  assert.match(contents, /w:fldCharType="separate"/)
  assert.match(contents, /w:fldCharType="end"/)
  assert.match(contents, /TOC \\h \\o &quot;1-3&quot;/)
  assert.match(settings, /<w:updateFields\/>/)
  let outlineCursor = -1
  for (const title of [
    LABELS.figuresAndTables,
    LABELS.executiveSummary,
    LABELS.facilityProfile,
    LABELS.conditionAssessmentFindings,
    'Riverbend Tower foundation',
  ]) {
    const titleAt = visibleOutline.indexOf(title, outlineCursor + 1)
    assert.ok(titleAt > outlineCursor, `the cached outline is missing or misorders "${title}"`)
    outlineCursor = titleAt
  }

  // The cache is deliberately title-only. Word owns the real page numbers and
  // replaces this dirty field result when the document opens.
  assert.doesNotMatch(contents, /<w:tab\/>/)
  assert.doesNotMatch(contents, /<w:t[^>]*>Report Contents<\/w:t>/)
  for (const indent of [0, 240, 480]) {
    assert.ok(contents.includes(`w:left="${indent}"`), `TOC level indent ${indent} is missing`)
  }

  // A short outline should share the remaining page with the figures/tables
  // index instead of an unconditional break leaving a mostly blank page.
  const afterContents = xml.indexOf('</w:sdt>', xml.indexOf('TOC \\h \\o')) + '</w:sdt>'.length
  const followingIndex = xml.indexOf(LABELS.figuresAndTables, afterContents)
  assert.ok(followingIndex > afterContents, 'the figures and tables index does not follow the TOC')
  assert.doesNotMatch(xml.slice(afterContents, followingIndex), /<w:br w:type="page"\/>/)
})

// Both checks below are for the same failure: a page whose whole content is a
// short tail that overflowed onto it, under a forced break nothing can fill.
// Measured against the dev database, the index stranded a single bullet on a
// page of its own in an 84-asset report.
test('the figures and tables index cannot be broken across a page', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const xml = await documentXml(await buildProjectReportDocxBuffer({ reports: [data] }))
  const afterContents = xml.indexOf('</w:sdt>', xml.indexOf('TOC \\h \\o')) + '</w:sdt>'.length
  const indexStart = xml.indexOf(LABELS.figuresAndTables, afterContents)
  const indexXml = xml.slice(indexStart, xml.indexOf(LABELS.executiveSummary, indexStart))
  const entries = paragraphs(indexXml).filter((paragraph) => paragraph.includes('<w:numPr>'))

  assert.ok(entries.length >= 8, `the index listed only ${entries.length} entries`)
  const breakable = entries.filter((paragraph) => !paragraph.includes('<w:keepNext/>'))
  assert.equal(breakable.length, 1, 'every index entry but the last must keep with the next')
  assert.ok(
    breakable[0].includes(LABELS.majorSystemCapitalSummary),
    'the entry free to be followed by a break is not the final one',
  )
})

test('only the final asset grid — the one a forced break follows — is kept whole', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  // A second asset, so "kept whole" is visibly the exception and not the rule.
  const second = db.createAsset(buildingId, 'B').id
  database
    .prepare(
      `UPDATE asset SET asset_name = 'Riverbend Tower roofing', condition_rating = 'Poor',
         action = 'Replace', priority = 'High', quantity = 900, action_year = 2030 WHERE id = ?`,
    )
    .run(second)
  const data = db.getPropertyReportData(projectId, buildingId)

  const xml = await documentXml(await buildProjectReportDocxBuffer({ reports: [data] }))
  const grids = (xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []).filter(
    (table) => table.includes(ASSET_FIELDS.opinionOfProbableCost) && table.includes(ASSET_FIELDS.level1),
  )
  assert.equal(grids.length, 2, 'expected one detail grid per assessed asset')

  const kept = grids.map((table) => (table.match(/<w:keepNext\/>/g) ?? []).length)
  assert.equal(kept[0], 0, 'a grid the next asset follows must stay free to split')
  // Every row but the last, both cells of each: the OOXML idiom for an
  // unbreakable table. Keeping every grid this way costs pages for no gain.
  const rows = (grids[1].match(/<w:tr>/g) ?? []).length
  assert.equal(kept[1], (rows - 1) * 2, 'the final grid is not bound against a page break')
})

test('the facility scorecard opens the summary section with its four headline figures', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const xml = afterTableOfContents(
    await documentXml(await buildProjectReportDocxBuffer({ reports: [data] })),
  )
  const flat = xml.replace(/<[^>]+>/g, '')

  const scorecardAt = flat.indexOf(LABELS.facilityScorecard)
  assert.ok(scorecardAt > 0, 'the scorecard is missing from the document')
  assert.ok(
    scorecardAt > flat.indexOf(LABELS.figuresAndTables),
    'the scorecard must follow the front matter',
  )
  assert.ok(
    scorecardAt < flat.indexOf(LABELS.executiveSummary, scorecardAt),
    'the scorecard is a management view of the summary, so it precedes it',
  )

  for (const label of [
    ...Object.values(SCORECARD_TILES),
    ...Object.values(SCORECARD_PRIORITY_COLUMNS),
    ...Object.values(CONDITION_SNAPSHOT_COLUMNS),
    LABELS.overallCondition,
    LABELS.scorecardPriorities,
    LABELS.conditionSnapshot,
  ]) {
    assert.ok(flat.includes(label), `the scorecard is missing "${label}"`)
  }

  // The scorecard summarises the plan rather than restating it: the figures it
  // prints have to be the ones the tables further down the report print.
  assert.ok(
    flat.includes(currency(data.capitalPlan.crv.value)),
    'the replacement value tile does not match the capital plan',
  )
})

// The scorecard is a full page of fixed content followed by a new chapter. A
// standalone break paragraph in that position lands on the *next* page whenever
// the card happens to fill its own, leaving a page holding nothing but that
// empty paragraph — measured as a blank page vii in an 84-asset report.
test('the summary starts its own page without a break paragraph after the scorecard', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const xml = afterTableOfContents(await zip.file('word/document.xml').async('string'))
  const scorecardAt = xml.indexOf(LABELS.facilityScorecard)
  const summaryAt = xml.indexOf(LABELS.executiveSummary, scorecardAt)
  const between = xml.slice(scorecardAt, summaryAt)

  assert.doesNotMatch(
    between,
    /<w:br w:type="page"\/>/,
    'a standalone page break between the scorecard and the summary can strand an empty page',
  )
  const summaryHeading = paragraphs(xml.slice(summaryAt - 400, summaryAt + 400)).find((paragraph) =>
    paragraph.includes(LABELS.executiveSummary),
  )
  assert.ok(summaryHeading, 'the executive summary heading was not found')

  // The heading carries the break, but through its style rather than on itself.
  // docx-preview reads `w:pageBreakBefore` only from a paragraph's style — its
  // splitter asks `findStyle(styleName).paragraphProps` and its CSS builder
  // discards the direct property — so a directly-set break printed in Word and
  // was invisible in the review that is supposed to be the export.
  const summaryStyle = (summaryHeading.match(/w:pStyle w:val="([^"]+)"/) ?? [])[1]
  assert.ok(summaryStyle, 'the summary heading must be set in a named style to carry its break')
  assert.doesNotMatch(
    summaryHeading,
    /<w:pageBreakBefore\/>/,
    'a break set on the paragraph is one the preview cannot see',
  )
  const styles = await zip.file('word/styles.xml').async('string')
  const summaryStyleXml = styles.split(`w:styleId="${summaryStyle}"`)[1]?.split('</w:style>')[0] ?? ''
  assert.match(
    summaryStyleXml,
    /<w:pageBreakBefore\/>/,
    'the style the summary heading uses must be the one that starts the page',
  )
})

// A break variant exists for every style a heading can wear, because a
// paragraph takes exactly one w:pStyle: a heading that is both tagged for a
// binder's contents and starts a page cannot wear its tag and a shared break
// style at once.
test('every heading style has a break variant that inherits it and is still indexed', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const styles = await zip.file('word/styles.xml').async('string')
  const definition = (id) => styles.split(`w:styleId="${id}"`)[1]?.split('</w:style>')[0] ?? ''

  for (const base of [
    'Heading1', 'Heading2', 'Heading3',
    'CarPortfolioHeading1', 'CarPortfolioHeading2', 'CarPortfolioHeading3',
  ]) {
    const variant = definition(`${base}Break`)
    assert.ok(variant, `no break variant is defined for ${base}`)
    assert.match(variant, new RegExp(`w:basedOn w:val="${base}"`),
      `${base}Break must inherit ${base} so starting a page changes nothing else`)
    assert.match(variant, /<w:pageBreakBefore\/>/, `${base}Break must start a new page`)
  }

  // A binder's contents selects styles by name, so the variants of the contents
  // tags have to be selected too — otherwise a tagged heading that starts a page
  // would quietly stop appearing in the contents.
  const second = seedBuilding(database, projectId, 'Lakeshore Annex')
  const binder = await JSZip.loadAsync(
    await buildProjectReportDocxBuffer({
      reports: [data, db.getPropertyReportData(projectId, second)],
    }),
  )
  const field = tableOfContentsXml(await binder.file('word/document.xml').async('string'))
    .replace(/<[^>]+>/g, '')
  for (const level of [1, 2, 3]) {
    assert.ok(
      field.includes(`Car Portfolio Heading ${level},${level}`),
      `the binder contents does not select Car Portfolio Heading ${level}`,
    )
    assert.ok(
      field.includes(`Car Portfolio Heading ${level} Break,${level}`),
      `the binder contents does not select the break variant at level ${level}`,
    )
  }
})

// The manual check that caught the Word file printing an untitled Table E-1
// while the preview captioned it. Every section the client's template renamed
// has to actually reach the delivered document, not just the review screen.
test('the delivered document carries the reworded sections', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const xml = await documentXml(await buildProjectReportDocxBuffer({ reports: [data] }))
  const text = xml.replace(/<[^>]+>/g, '')

  for (const phrase of [
    LABELS.assessmentType,
    LABELS.confidentiality,
    LABELS.tableOfContents,
    LABELS.figuresAndTables,
    LABELS.capitalRenewalSummary,
    LABELS.crvImplementationTable,
    LABELS.crvAllowanceCategory,
    LABELS.fciClassification,
    LABELS.facilityProfile,
    LABELS.facilityInformation,
    LABELS.conditionAssessmentFindings,
    LABELS.totalPlannedCapitalRenewal,
    'Report Use and Reliance',
    'Assessment Conclusions and Capital Priorities',
    'Appendix – Scope Limitations and Basis of Assessment',
    'Basis of Cost Allowances',
    'FCI = (Immediate + Year 1 + Year 2 Capital Requirements) / Current Replacement Value',
  ]) {
    assert.ok(text.includes(phrase), `the document is missing "${phrase}"`)
  }

  // Wording the client asked us to stop printing.
  for (const phrase of ['Property Condition Assessment', 'Lifecycle Replacement Total', 'Level 1 Major Group']) {
    assert.ok(!text.includes(phrase), `the document still prints "${phrase}"`)
  }
})

// The client asked for a component-level roll-up beside the capital summary.
// It is the one table whose numbers have to agree with the asset pages rather
// than with the plan, so both ends are pinned here.
test('the executive summary carries the component roll-up', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const xml = await documentXml(await buildProjectReportDocxBuffer({ reports: [data] }))
  const body = xml.replace(/<[^>]+>/g, '')

  assert.match(body, new RegExp(LABELS.componentSummary))
  assert.match(body, new RegExp(LABELS.componentSummaryTotal))
  for (const column of Object.values(COMPONENT_SUMMARY_COLUMNS)) {
    assert.ok(body.includes(column), `the roll-up is missing the "${column}" column`)
  }

  // The seeded asset's own row, with the allowance its asset page prints.
  const [seeded] = data.assets
  assert.ok(body.includes('Riverbend Tower foundation'))
  assert.ok(body.includes(currency(seeded.capital.opinionOfProbableCost)))

  // It reads before the schedule that follows it and after the capital table.
  const at = (needle) => body.indexOf(needle)
  assert.ok(at(LABELS.capitalRenewalSummary) < at(LABELS.componentSummary))
  assert.ok(at(LABELS.componentSummary) < at('Capital Expenditure Schedule'))

  // The header repeats when the grid runs over a page, and no row splits across
  // one — a summary is useless if a component's costs land on the next page.
  const grids = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []
  const rollup = grids.find((table) => table.includes(LABELS.componentSummaryTotal))
  assert.ok(rollup, 'the roll-up did not reach the document as a table')
  assert.match(rollup, /<w:tblHeader\/>/)
  assert.equal(
    (rollup.match(/<w:cantSplit\/>/g) ?? []).length,
    (rollup.match(/<w:tr>/g) ?? []).length,
  )
})

// Appearance is invisible to every other test here: the document XML can carry
// every right word and still open as a default-Word document with hairline
// tables, no cell padding and no font of its own. These assertions pin the
// formatting that makes it read like the report page.
test('the delivered document carries the report styling', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const buffer = await buildProjectReportDocxBuffer({ reports: [data] })
  const zip = await JSZip.loadAsync(buffer)
  const styles = await zip.file('word/styles.xml').async('string')
  const xml = await zip.file('word/document.xml').async('string')
  // header1 is the cover's, which is deliberately empty so it inherits nothing.
  const headerParts = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^word\/header\d+\.xml$/.test(name))
      .map((name) => zip.file(name).async('string')),
  )
  const header = headerParts.find((part) => part.includes('<w:p>'))
  assert.ok(header, 'a running header reaches the file')

  // An empty docDefaults leaves the body font to whatever the reader's Word
  // defaults to, so the same file looks different on two machines.
  assert.match(styles, /<w:rPrDefault><w:rPr>/)
  // Calibri rather than Segoe UI: a Windows interface font is not installed
  // with Office for Mac, so those readers were always seeing a substitute.
  assert.match(styles, /<w:rFonts w:ascii="Calibri"/)
  assert.match(styles, /<w:sz w:val="22"\/>/)
  // The three heading levels the report actually uses carry its ink and accent
  // rather than Word's stock blue. (4-6 are untouched; nothing emits them.)
  const styleBlock = (id) =>
    styles.match(new RegExp(`<w:style [^>]*w:styleId="${id}">[\\s\\S]*?</w:style>`))?.[0] ?? ''
  assert.match(styleBlock('Heading1'), /<w:color w:val="152033"\/>/)
  assert.match(styleBlock('Heading1'), /<w:bottom w:val="single" w:color="1D5F9C"/)
  assert.match(styleBlock('Heading2'), /<w:left w:val="single" w:color="1D5F9C"/)
  assert.match(styleBlock('Heading3'), /<w:color w:val="1D5F9C"\/>/)
  for (const level of ['Heading1', 'Heading2', 'Heading3']) {
    assert.doesNotMatch(styleBlock(level), /2E74B5/, `${level} is still Word's stock blue`)
  }

  // Padding, header shading, zebra rows and the label-cell tint.
  assert.match(xml, /<w:tblCellMar>/)
  assert.ok(xml.includes('w:fill="152033"'), 'table header rows are not shaded')
  assert.ok(xml.includes('w:fill="E8F1F8"'), 'label cells are not tinted')
  assert.ok(xml.includes('w:fill="FAFBFC"'), 'body rows are not striped')

  // Fixed layout with real column widths — otherwise Word re-balances every
  // column to the same width and the name column wraps while money columns idle.
  assert.match(xml, /<w:tblLayout w:type="fixed"\/>/)
  // Checked over every grid rather than whichever table lands first: the cover
  // band is a single full-width cell and the meta boxes beside it are an
  // equal pair, so table order says nothing about the data tables downstream.
  const grids = [...xml.matchAll(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/g)].map((match) =>
    [...match[0].matchAll(/w:w="(\d+)"/g)].map((width) => Number(width[1])),
  )
  assert.ok(grids.length > 0, 'no table declares a column grid')
  assert.ok(
    grids.every((widths) => widths.length > 0 && widths.every((width) => width > 0)),
    'a table declares a grid without real column widths',
  )
  assert.ok(
    grids.some((widths) => new Set(widths).size > 1),
    'every table gave all of its columns the same width',
  )

  // A tab is a run element. Emitted as a bare child of w:p it is silently
  // dropped, which runs the header's two halves together — invisible in the
  // XML text and only obvious once the document is rendered.
  for (const [name, part] of [['document', xml], ['header', header]]) {
    assert.doesNotMatch(part, /<\/w:r><w:tab\/>/, `the ${name} emits a tab outside a run`)
  }
  assert.match(header, /<w:tabs><w:tab w:val="right"/)
})

// The library's `bullet: { level }` shorthand emits ● (U+25CF BLACK CIRCLE) at
// Word's stock half-inch indent, which prints as a heavy dot marooned from its
// text. The list the bullets actually belong to has to reach the file.
test('bulleted lists use the report bullet rather than the library default', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const numbering = await zip.file('word/numbering.xml').async('string')
  const xml = await zip.file('word/document.xml').async('string')

  // The list the document points at, not merely some list in the file: the
  // library always emits its own stock abstract numbering alongside ours.
  const numId = xml.match(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="(\d+)"\/>/)?.[1]
  assert.ok(numId, 'no bulleted paragraph references a numbering definition')
  const abstractId = numbering.match(
    new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="(\\d+)"`),
  )?.[1]
  assert.ok(abstractId, `numId ${numId} maps to no abstract numbering`)
  const abstract = numbering.match(
    new RegExp(`<w:abstractNum w:abstractNumId="${abstractId}"[\\s\\S]*?</w:abstractNum>`),
  )?.[0]
  assert.ok(abstract, `abstract numbering ${abstractId} is missing`)

  const level0 = abstract.match(/<w:lvl w:ilvl="0"[\s\S]*?<\/w:lvl>/)?.[0] ?? ''
  assert.match(level0, /<w:lvlText w:val="\u2022"\/>/, 'the bullet is not U+2022')
  assert.doesNotMatch(level0, /\u25CF/, 'the oversized U+25CF circle is back')
  assert.match(level0, /<w:color w:val="1D5F9C"\/>/, 'the marker is not the report accent')
  assert.match(level0, /<w:ind w:left="432" w:hanging="216"\/>/)

  // Word's latent ListParagraph style carries both a half-inch indent and
  // contextualSpacing, either of which would quietly override the list above.
  // Direct paragraph formatting is what makes the rendered result predictable.
  const item = xml.match(/<w:p><w:pPr><w:pStyle w:val="ListParagraph"\/>[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
  assert.match(item, /<w:ind w:left="432" w:hanging="216"\/>/)
  assert.match(item, /<w:contextualSpacing w:val="false"\/>/)
})

test('every section is US Letter with one-inch margins and section-local page totals', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const xml = await zip.file('word/document.xml').async('string')
  const sections = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) ?? []
  assert.equal(sections.length, 3)
  for (const section of sections) {
    assert.match(section, /<w:pgSz w:w="12240" w:h="15840"/)
    assert.match(
      section,
      /<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/,
    )
  }

  const footers = Object.keys(zip.files).filter((name) => /^word\/footer\d+\.xml$/.test(name))
  assert.equal(footers.length, 3, 'one footer per section, the cover included')

  // The cover declares an empty footer rather than none. A section that names no
  // footer inherits the one before it, which in a binder put the previous
  // building's page numbers under this building's cover.
  const parts = await Promise.all(footers.map((name) => zip.file(name).async('string')))
  const blank = parts.filter((part) => !part.includes('<w:p>'))
  assert.equal(blank.length, 1)

  const bands = new Set()
  for (const footer of parts.filter((part) => part.includes('<w:p>'))) {
    assert.match(footer, /<w:instrText[^>]*> PAGE <\/w:instrText>/)

    // The total counts to a bookmark on the section's last page rather than
    // asking for SECTIONPAGES, which LibreOffice cannot evaluate at all and
    // leaves blank — a dangling "of " under every page of the delivered file.
    // NUMPAGES would answer for the whole document, which is a different number
    // once numbering restarts.
    assert.doesNotMatch(footer, /SECTIONPAGES|NUMPAGES/)
    const total = footer.match(/> PAGEREF (_CarSectionEnd_\w+) \\h \\\* (roman|arabic) </)
    assert.ok(total, 'the total is a PAGEREF into the footer\'s own section')
    assert.match(xml, new RegExp(`<w:bookmarkStart w:name="${total[1]}"`))

    // Both numbers cache a result, or a reader that evaluates no field at all
    // draws nothing at either end of the "of".
    assert.equal(footer.match(/<w:rStyle w:val="CarPage(Number|Total)"\/><\/w:rPr><w:t[^>]*>—</g)?.length, 2)

    const band = footer.match(/<w:bookmarkStart w:name="(_CarPageBand_\w+)"/)
    assert.ok(band, 'the footer names the numbering band its pages belong to')
    bands.add(band[1])
  }
  // Front matter and body each number themselves, and say so differently.
  assert.deepEqual([...bands].sort(), [
    '_CarPageBand_B1Body_decimal',
    '_CarPageBand_B1Front_lowerRoman',
  ])

  // `docx` gives every Bookmark it builds `w:id="1"`, so ids have to be handed
  // out here. Two bookmarks sharing one leaves a PAGEREF pointing at whichever
  // Word decides it meant.
  const ids = []
  for (const part of [xml, ...parts]) {
    for (const [, id] of part.matchAll(/<w:bookmarkStart[^>]*w:id="(\d+)"/g)) ids.push(id)
  }
  assert.equal(ids.length, 4)
  assert.equal(new Set(ids).size, ids.length, `bookmark ids collide: ${ids}`)
})

test('normalizes accepted photos, carries annotations, honors all selected photos, and resets Figure 3 numbering', async (t) => {
  const database = withDb(t)
  useDecodedImages(t)
  const projectId = db.createProject({ client: 'Acme Property Co' }).id
  const buildingId = seedBuilding(database, projectId, 'Riverbend Tower')
  const data = db.getPropertyReportData(projectId, buildingId)
  const imagePaths = Array.from({ length: 7 }, (_, index) => {
    const filePath = path.join(os.tmpdir(), `cara-docx-${process.pid}-${index}.webp`)
    fs.writeFileSync(filePath, TINY_WEBP)
    t.after(() => fs.rmSync(filePath, { force: true }))
    return filePath
  })

  data.buildingImages = [
    {
      file_path: imagePaths[0],
      original_name: 'property.webp',
      caption: 'Property exterior',
      bounding_boxes: [],
    },
  ]
  data.assets[0].images = imagePaths.slice(1).map((filePath, index) => ({
    file_path: filePath,
    original_name: `asset-${index + 1}.webp`,
    caption: `Selected asset photo ${index + 1}`,
    include_in_report: 1,
    bounding_boxes:
      index === 0
        ? [
            { kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.25, color: '#ff2d2d' },
            { kind: 'arrow', x1: 0.2, y1: 0.8, x2: 0.75, y2: 0.35, color: '#00aa00' },
          ]
        : [],
  }))

  const zip = await JSZip.loadAsync(await buildProjectReportDocxBuffer({ reports: [data] }))
  const xml = await zip.file('word/document.xml').async('string')
  const body = xml.replace(/<[^>]+>/g, '')
  assert.match(body, /Figure 2-1: Property exterior/)
  assert.match(body, /Figure 3-1: Selected asset photo 1/)
  assert.doesNotMatch(body, /Figure 3-2: Selected asset photo 1/)
  for (let index = 1; index <= 6; index += 1) {
    assert.match(body, new RegExp(`Selected asset photo ${index}`))
  }

  const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'))
  const svgName = media.find((name) => name.endsWith('.svg'))
  assert.ok(svgName, 'the annotated WebP did not become an SVG image part')
  assert.ok(media.some((name) => /\.jpe?g$/.test(name)), 'the annotated raster fallback is missing')
  const svg = await zip.file(svgName).async('string')
  assert.match(svg, /data:image\/jpeg;base64,/)
  assert.match(svg, /<rect /)
  assert.match(svg, /<line /)
  assert.match(svg, /marker-end=/)
  assert.match(svg, /#ff2d2d/)
  assert.match(svg, /#00aa00/)
  assert.match(svg, /width="1600" height="800"/)
})

test('a multi-building export includes the project summary', async (t) => {
  const database = withDb(t)
  const projectId = db.createProject({ client: 'Multi Co' }).id
  const b1 = seedBuilding(database, projectId, 'Tower A')
  const b2 = seedBuilding(database, projectId, 'Tower B')
  const reports = [
    db.getPropertyReportData(projectId, b1),
    db.getPropertyReportData(projectId, b2),
  ]

  const buffer = await buildProjectReportDocxBuffer({ reports })
  const xml = await documentXml(buffer)
  assert.match(xml, new RegExp(LABELS.portfolioOverview))
  assert.match(xml, new RegExp(LABELS.portfolioCapitalRequirements))
  assert.match(xml, /Tower A/)
  assert.match(xml, /Tower B/)
  assert.match(xml, /2 facilities — consolidated project report/)

  const contents = tableOfContentsXml(xml)
  assert.equal((xml.match(/<w:instrText[^>]*>TOC /g) ?? []).length, 1)

  // Every building repeats the same section titles, so a binder that indexed
  // Heading 1-3 would list them once per property and name none of them. It
  // selects the portfolio's own headings and the property line on each cover.
  assert.match(
    contents,
    /TOC \\h \\t &quot;Car Portfolio Heading 1,1,Car Portfolio Heading 1 Break,1,Car Portfolio Heading 2,2,Car Portfolio Heading 2 Break,2,Car Portfolio Heading 3,3,Car Portfolio Heading 3 Break,3,Car Property Entry,1&quot;/,
  )
  assert.equal((xml.match(/w:pStyle w:val="CarPropertyEntry"/g) ?? []).length, 2)
  assert.ok(
    (xml.match(/w:pStyle w:val="CarPortfolioHeading[123]"/g) ?? []).length >= 3,
    'the portfolio front matter carries no contents-selector headings',
  )

  const visibleOutline = contents.replace(/<[^>]+>/g, '')
  let cursor = -1
  for (const title of [LABELS.portfolioOverview, 'Tower A', 'Tower B']) {
    const at = visibleOutline.indexOf(title, cursor + 1)
    assert.ok(at > cursor, `the project contents are missing or misorder "${title}"`)
    cursor = at
  }
  for (const title of [LABELS.facilityProfile, LABELS.figuresAndTables, 'Tower A foundation']) {
    assert.ok(
      !visibleOutline.includes(title),
      `the project contents list per-building "${title}" once for every property`,
    )
  }
})
