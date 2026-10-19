const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const XLSX = require('xlsx')
const { setUserDataPath } = require('./helpers/electron-stub')
const db = require('../src/db')
const { parseBcaWorkbook, FIELD_COLUMNS } = require('../src/lib/bca-workbook')
const {
  resolvePricingId,
  mapRowToAssetFields,
  conditionLabelForScore,
  previewImport,
  applyImport,
} = require('../src/import-bca')
const { loadCapitalPlanningRules } = require('../src/lib/capital-planning')

const samplePath = path.join(
  __dirname,
  '..',
  'samples',
  'Asset-List_ASHC-Lodge-South-BCA_Worksheet_draft_v1.xlsx',
)
const rules = loadCapitalPlanningRules()

// Parse once — the sample is 4 MB and has 18 sheets; only two are needed.
const parsed = parseBcaWorkbook(XLSX.readFile(samplePath, { sheets: ['Worksheet', 'Legend'] }))

function freshDb(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cara-import-'))
  db.closeDatabase()
  setUserDataPath(userData)
  const database = db.openDatabase()
  t.after(() => {
    db.closeDatabase()
    fs.rmSync(userData, { recursive: true, force: true })
  })
  return database
}

/** A sheet from an address -> value map, in the shape SheetJS hands the parser. */
function sheetOf(cells, ref) {
  const sheet = { '!ref': ref }
  for (const [address, value] of Object.entries(cells)) {
    sheet[address] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: String(value) }
  }
  return sheet
}

// The Legend's site block used to be read only as far as row 60. A workbook
// listing more than 57 properties therefore lost the location factor of every
// site past that — the buildings were created at 1.0 while the workbook priced
// them at their own — and the reference tables that sit below the sites (rows 42
// down in the 26-property sample) were read as sites in their own right.
test('the legend is read past row 60, and its reference tables are not sites', () => {
  const headers = Object.fromEntries(
    FIELD_COLUMNS.map((field) => [`${field.letter}3`, field.header]),
  )
  const workbook = {
    SheetNames: ['Worksheet', 'Legend'],
    Sheets: {
      Worksheet: sheetOf(
        {
          ...headers,
          C4: '12', D4: 'Alberta Rose Lodge', F4: 'A', G4: 'A10', H4: 'A1010', J4: 'Foundation',
          C5: '58', D5: 'Cory Crescent (worksheet)', F5: 'A', G5: 'A10', H5: 'A1010', J5: 'Foundation',
        },
        'A1:AK5',
      ),
      Legend: sheetOf(
        {
          B2: 2026,
          A3: 'Site #', B3: 'Building', F3: 'Location Factor',
          A4: '12', B4: 'Alberta Rose Lodge', F4: 1.065,
          // Past the old cap: the 75-property workbook lists its last eighteen
          // sites from row 61 down.
          A65: '58', B65: '14 Cory Crescent', F65: 1.109,
          // The reference tables below the sites. No asset row carries these as
          // a site id, so they must never become buildings.
          A80: 'Critical', B80: 'Immediate failure / serious deficiency',
        },
        'A1:H80',
      ),
    },
  }

  const parsed = parseBcaWorkbook(workbook)
  assert.equal(parsed.baseYear, 2026)
  assert.deepEqual(
    parsed.buildings,
    [
      { siteId: '12', name: 'Alberta Rose Lodge', locationFactor: 1.065 },
      { siteId: '58', name: '14 Cory Crescent', locationFactor: 1.109 },
    ],
    'the site below row 60 kept the legend name and factor, and no label became a site',
  )
})

test('conditionLabelForScore maps 1–6 to stored labels', () => {
  assert.equal(conditionLabelForScore(1, rules), 'Very good')
  assert.equal(conditionLabelForScore(3, rules), 'Fair')
  assert.equal(conditionLabelForScore(6, rules), 'Critical')
  assert.equal(conditionLabelForScore(null, rules), null)
})

test('mapRowToAssetFields keeps ref cost as override and recalculates the rest', () => {
  const fields = mapRowToAssetFields(
    {
      assetName: 'Foundation',
      vintage: 1980,
      normalLife: 100,
      conditionScore: 3,
      actionType: 'Replace',
      unit: 'Sq. Ft.',
      quantity: 200,
      referenceCost: 25,
      allowanceYear: null,
      opc: 5000,
      importKey: '1-1',
    },
    rules,
  )
  assert.equal(fields.unit_cost_override, 25)
  assert.equal(fields.condition_rating, 'Fair')
  assert.equal(fields.unit_measure, 'Sq. Ft.')
  assert.equal(fields.action_year, null) // derived, not frozen
  assert.equal(fields.opinion_of_probable_cost, null) // recomputed from qty × cost
  assert.equal(fields.import_key, '1-1')
})

test('resolvePricingId matches catalogue by level 3 code', (t) => {
  const database = freshDb(t)
  const id = resolvePricingId(database, { level1: 'A', level2: 'A10', level3: 'A1010' })
  assert.ok(id, 'A1010 resolves to a catalogue pricing id')
  const row = database.prepare('SELECT level_3_code FROM uniformat_pricing WHERE pricing_id = ?').get(id)
  assert.equal(row.level_3_code, 'A1010')
})

test('preview does not count an unresolved-only site as a new building', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Unresolved preview' }).id
  const unresolvedParsed = {
    baseYear: 2025,
    rows: [
      {
        siteId: 'new-unresolved-site',
        assetName: 'Unknown component',
        level1: 'NOT-IN-CATALOGUE',
        importKey: 'unresolved-row',
      },
    ],
    buildings: [
      {
        siteId: 'new-unresolved-site',
        name: 'Unresolved Site',
        locationFactor: 1,
      },
    ],
    errors: [],
    warnings: [],
    missingColumns: [],
  }

  const preview = previewImport({ database, parsed: unresolvedParsed, projectId })
  assert.equal(preview.totals.buildings, 1, 'the skipped workbook site remains visible')
  assert.equal(preview.totals.newBuildings, 0)
  assert.equal(preview.totals.newAssets, 0)
  assert.equal(preview.totals.unresolved, 1)

  const applied = applyImport({
    database,
    parsed: unresolvedParsed,
    projectId,
    mode: 'update',
  })
  assert.equal(applied.summary.createdBuildings, preview.totals.newBuildings)
  assert.equal(applied.summary.createdAssets, preview.totals.newAssets)
  assert.equal(applied.summary.unresolved, preview.totals.unresolved)
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM building WHERE project_id = ?')
      .get(projectId).count,
    0,
  )
})

test('imports the sample workbook and re-imports without duplicating', (t) => {
  const database = freshDb(t)
  // uses the shared `parsed` from module scope
  assert.ok(parsed.rows.length > 3000, 'the sample has thousands of asset rows')
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.missingColumns.length, 0)

  const projectId = db.createProject({ client: 'Bethany Care Society' }).id

  const preview = previewImport({ database, parsed, projectId })
  assert.ok(preview.totals.buildings > 1)
  assert.ok(preview.totals.newAssets > 3000)
  assert.equal(preview.totals.updateAssets, 0, 'nothing exists yet')

  const first = applyImport({ database, parsed, projectId, mode: 'new' })
  assert.ok(first.summary.createdBuildings > 1)
  assert.ok(first.summary.createdAssets > 3000)
  const assetCount = database
    .prepare('SELECT COUNT(*) AS n FROM asset e JOIN building b ON b.id = e.building_id WHERE b.project_id = ?')
    .get(projectId).n
  assert.equal(assetCount, first.summary.createdAssets)

  // Re-import the same file in update mode: rows match by import key, so no
  // duplicates are created.
  const second = applyImport({ database, parsed, projectId, mode: 'update' })
  assert.equal(second.summary.createdAssets, 0, 're-import creates no new assets')
  assert.ok(second.summary.updatedAssets > 3000, 're-import updates existing assets')
  const assetCountAfter = database
    .prepare('SELECT COUNT(*) AS n FROM asset e JOIN building b ON b.id = e.building_id WHERE b.project_id = ?')
    .get(projectId).n
  assert.equal(assetCountAfter, assetCount, 'asset count is unchanged on re-import')

  // 'new' mode after import adds nothing (all keys already present).
  const third = applyImport({ database, parsed, projectId, mode: 'new' })
  assert.equal(third.summary.createdAssets, 0)
})

test('an imported building produces a report with engine-recalculated values', (t) => {
  const database = freshDb(t)
  // uses the shared `parsed` from module scope
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })

  // Pines Lodge (site 22) is a building the assessor actually walked: all 89 of
  // its rows carry a condition, a quantity and a recommendation, so all 89 reach
  // the report. Assessment year 2025, LF 1.02.
  const building = database
    .prepare("SELECT id FROM building WHERE project_id = ? AND site_id = '22'")
    .get(projectId)
  const data = db.getPropertyReportData(projectId, building.id)
  assert.ok(data, 'imported building yields report data')
  assert.ok(data.assets.length > 50, 'the building has many assessed assets')

  // Its foundation is vintage 1976 with a 100-year life → action year 2076, and
  // the $25 reference cost adjusts to $26, matching the workbook's derived
  // columns.
  const foundation = data.assets.find((asset) => /foundation and footings/i.test(asset.asset_name ?? ''))
  assert.ok(foundation, 'foundation asset imported')
  assert.equal(foundation.capital.actionYear, 2076)
  assert.equal(foundation.capital.adjustedUnitCost, 26)
})

// The client's headline complaint: a 201-page PDF that was almost all
// master-library placeholder pages. Playfair Lodge is the shape that produced
// it — 185 imported rows of which the assessor filled in exactly three.
test('an un-inspected building contributes only its assessed rows to the report', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })

  const building = database
    .prepare("SELECT id FROM building WHERE project_id = ? AND site_id = '1'")
    .get(projectId)
  const stored = database
    .prepare('SELECT COUNT(*) AS n FROM asset WHERE building_id = ?')
    .get(building.id).n
  assert.ok(stored > 150, 'the whole master library is still imported and editable')

  const data = db.getPropertyReportData(projectId, building.id)
  assert.ok(
    data.assets.length < 10,
    `only assessed rows reach the report (got ${data.assets.length} of ${stored})`,
  )
  // Every page that survives is one somebody recorded something about. For this
  // building that is an action type on two rows and a hand-entered 12-year life
  // adjustment on a third — no other signal would have caught that last one.
  for (const asset of data.assets) {
    assert.ok(
      asset.condition_rating ||
        asset.action ||
        asset.recommendation ||
        asset.quantity > 0 ||
        Number(asset.life_adjustment_years) !== 0,
      `"${asset.asset_name}" reached the report with no property-specific data`,
    )
  }
})

// The workbook writes 0 in Vintage on rows nobody filled in. Carried through it
// makes the component 2,025 years old and back-dates its whole lifecycle.
test('a zero vintage is imported as no vintage, not as year zero', () => {
  const zeroVintage = mapRowToAssetFields({ assetName: 'X', vintage: 0, normalLife: 30 }, rules, 2025)
  assert.equal(zeroVintage.vintage, null)
  const realVintage = mapRowToAssetFields({ assetName: 'X', vintage: 1994, normalLife: 30 }, rules, 2025)
  assert.equal(realVintage.vintage, 1994)
  // A year after the assessment is not a construction year either.
  const future = mapRowToAssetFields({ assetName: 'X', vintage: 2099, normalLife: 30 }, rules, 2025)
  assert.equal(future.vintage, null)
})

test('placeholder cells are imported as empty, not as findings', () => {
  const fields = mapRowToAssetFields(
    { assetName: 'X', description: '-', recommendation: '   ', actionType: 'N/A' },
    rules,
  )
  assert.equal(fields.description, null)
  assert.equal(fields.recommendation, null)
  assert.equal(fields.action, null)
})

// The duplication mechanism the client hit: 912 of the sample's 4,091 rows carry
// no Sheet ID, and their import key used to be derived from the row number. Any
// edit that moved a row re-keyed it, so the next import inserted a second copy
// of it instead of updating it.
test('re-importing a workbook whose rows have moved creates no duplicates', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })
  const before = database.prepare('SELECT COUNT(*) AS n FROM asset').get().n

  const withoutSheetIds = parsed.rows.filter((row) => !row.sheetId).length
  assert.ok(withoutSheetIds > 500, 'the sample really does exercise the keyless path')

  // Same workbook, every row shifted down as if lines had been inserted above.
  const shifted = { ...parsed, rows: parsed.rows.map((row) => ({ ...row, row: row.row + 7 })) }
  const again = applyImport({ database, parsed: shifted, projectId, mode: 'update' })

  assert.equal(again.summary.createdAssets, 0, 'a moved row is matched, not re-inserted')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM asset').get().n, before)
})

// A database imported by an OLDER build holds row-number keys (`<siteId>-r<row>`)
// that the content-derived scheme can never produce. Without adoption, the first
// re-import after this change would insert a second copy of every one of them —
// which is exactly the duplication the change exists to prevent.
test('assets keyed by an older build are adopted, not duplicated', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })
  const before = database.prepare('SELECT COUNT(*) AS n FROM asset').get().n

  // Rewrite one building's keys to the legacy row-number form, the way a
  // database imported before this change actually looks.
  const building = database
    .prepare("SELECT id, site_id FROM building WHERE project_id = ? AND site_id = '22'")
    .get(projectId)
  const legacy = database
    .prepare('SELECT id FROM asset WHERE building_id = ? ORDER BY id')
    .all(building.id)
  const rekey = database.prepare('UPDATE asset SET import_key = ? WHERE id = ?')
  for (const [index, asset] of legacy.entries()) {
    rekey.run(`${building.site_id}-r${index + 4}`, asset.id)
  }
  assert.ok(legacy.length > 50, 'the fixture rewrote a meaningful number of rows')

  const preview = previewImport({ database, parsed, projectId })
  assert.equal(
    preview.totals.newAssets,
    0,
    'legacy matches are described as existing rows, not new inserts',
  )
  assert.equal(preview.totals.updateAssets, parsed.rows.length)

  const addOnly = applyImport({ database, parsed, projectId, mode: 'new' })
  assert.equal(addOnly.summary.createdAssets, 0)
  assert.equal(addOnly.summary.rekeyedAssets, 0, 'Add new only performs no hidden rekey')
  assert.match(
    database.prepare('SELECT import_key FROM asset WHERE id = ?').get(legacy[0].id).import_key,
    /^22-r/,
    'the legacy key remains untouched in Add new only mode',
  )

  const again = applyImport({ database, parsed, projectId, mode: 'update' })

  assert.equal(again.summary.createdAssets, 0, 'no legacy row is re-inserted')
  assert.equal(again.summary.rekeyedAssets, legacy.length, 'every legacy row is adopted')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM asset').get().n, before)
  // The adopted rows now carry stable keys, so a third import is a plain update.
  const third = applyImport({ database, parsed, projectId, mode: 'update' })
  assert.equal(third.summary.createdAssets, 0)
  assert.equal(third.summary.rekeyedAssets, 0, 'adoption happens once, not every time')
})

test('adoption never collapses two genuine copies of the same component', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })

  // Playfair lists "Built Up Roof Assemblies" twice — two real components that
  // must stay two assets even though they share a name and a pricing row.
  const building = database
    .prepare("SELECT id, site_id FROM building WHERE project_id = ? AND site_id = '1'")
    .get(projectId)
  const twins = database
    .prepare(
      `SELECT id FROM asset
        WHERE building_id = ? AND asset_name = 'Built Up Roof Assemblies'
        ORDER BY id`,
    )
    .all(building.id)
  assert.equal(twins.length, 2, 'the sample really does list this component twice')
  const rekey = database.prepare('UPDATE asset SET import_key = ? WHERE id = ?')
  for (const [index, asset] of twins.entries()) {
    rekey.run(`${building.site_id}-r${900 + index}`, asset.id)
  }

  const again = applyImport({ database, parsed, projectId, mode: 'update' })
  assert.equal(again.summary.createdAssets, 0)
  const after = database
    .prepare(
      `SELECT COUNT(*) AS n FROM asset
        WHERE building_id = ? AND asset_name = 'Built Up Roof Assemblies'`,
    )
    .get(building.id).n
  assert.equal(after, 2, 'both copies survive with distinct keys')
})

test('the database refuses a second asset with the same import key', (t) => {
  const database = freshDb(t)
  const projectId = db.createProject({ client: 'Bethany Care Society' }).id
  applyImport({ database, parsed, projectId, mode: 'new' })
  const row = database
    .prepare("SELECT building_id, import_key FROM asset WHERE import_key IS NOT NULL LIMIT 1")
    .get()
  assert.throws(
    () =>
      database
        .prepare('INSERT INTO asset (building_id, import_key) VALUES (?, ?)')
        .run(row.building_id, row.import_key),
    /UNIQUE/i,
  )
})
