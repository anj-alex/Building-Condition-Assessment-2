const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  parseCsv,
  getRequiredCsvColumn,
  cleanCsvValue,
  csvInteger,
  parseLocationFactorRows,
  parseUniformatPricingRows,
  readUniformatPricingRows,
  readLocationFactorRows,
} = require('../src/lib/csv-utils')

const HEADER =
  'Uni-Format Pricing ID,Level 1,Level 1 Description,Level 2,Level 2 Description,Level 3,Level 3 Description,Level 4,Level 4 Description,Material,Mean Service Life (yrs),Practical Life (yrs),Unit Price,Unit of Measure'

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-utils-test-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function writeCsv(dir, name, content) {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

// --- parseCsv ---

test('parseCsv keeps quoted field with commas and newlines as one field', () => {
  const rows = parseCsv('a,"b, c\nd",e\n1,2,3')
  assert.deepEqual(rows, [
    ['a', 'b, c\nd', 'e'],
    ['1', '2', '3'],
  ])
})

test('parseCsv unescapes doubled quotes', () => {
  const rows = parseCsv('"a ""b"" c",x')
  assert.deepEqual(rows, [['a "b" c', 'x']])
})

test('parseCsv splits \\r\\n, \\n, and bare \\r identically', () => {
  const expected = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  assert.deepEqual(parseCsv('a,b\r\nc,d'), expected)
  assert.deepEqual(parseCsv('a,b\nc,d'), expected)
  assert.deepEqual(parseCsv('a,b\rc,d'), expected)
})

test('parseCsv emits final line without trailing newline; trailing newline adds no empty row', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
  assert.deepEqual(parseCsv('a,b\nc,d\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
})

test('parseCsv line ending in a comma yields trailing empty-string field', () => {
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']])
  assert.deepEqual(parseCsv('a,b,\nc,'), [
    ['a', 'b', ''],
    ['c', ''],
  ])
})

// --- cleanCsvValue / csvInteger ---

test('cleanCsvValue trims whitespace; empty-like values become null', () => {
  assert.equal(cleanCsvValue('  hello  '), 'hello')
  assert.equal(cleanCsvValue(''), null)
  assert.equal(cleanCsvValue('   '), null)
  assert.equal(cleanCsvValue(null), null)
  assert.equal(cleanCsvValue(undefined), null)
  // unit_price is run through cleanCsvValue — trailing spaces are trimmed.
  assert.equal(cleanCsvValue('$73.11 '), '$73.11')
})

test('csvInteger parses integers and rejects non-integers', () => {
  assert.equal(csvInteger('25'), 25)
  assert.equal(csvInteger(' 25 '), 25)
  assert.equal(csvInteger('25.5'), null)
  assert.equal(csvInteger(''), null)
  assert.equal(csvInteger(null), null)
  assert.equal(csvInteger(undefined), null)
  assert.equal(csvInteger('abc'), null)
})

// --- getRequiredCsvColumn ---

test('getRequiredCsvColumn throws naming the missing column', () => {
  assert.throws(
    () => getRequiredCsvColumn(['A', 'B'], 'Missing Col'),
    /Missing Col/,
  )
  assert.equal(getRequiredCsvColumn(['A', 'B'], 'B'), 1)
})

// --- readUniformatPricingRows ---

test('readUniformatPricingRows finds header after a blank row', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(
    dir,
    'pricing.csv',
    [
      '',
      HEADER,
      '100001,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Concrete,100,100,$10.00,LF',
    ].join('\n'),
  )

  const rows = readUniformatPricingRows(filePath)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pricing_id, '100001')
  assert.equal(rows[0].source_row, 3)
})

test('readUniformatPricingRows throws when no header row', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(dir, 'no-header.csv', 'foo,bar\n1,2\n')

  assert.throws(
    () => readUniformatPricingRows(filePath),
    /does not contain a Uni-Format Pricing ID header row/,
  )
})

test('readUniformatPricingRows throws naming a missing required column', (t) => {
  const dir = makeTempDir(t)
  // Header lacks Unit Price.
  const badHeader =
    'Uni-Format Pricing ID,Level 1,Level 1 Description,Level 2,Level 2 Description,Level 3,Level 3 Description,Level 4,Level 4 Description,Material,Mean Service Life (yrs),Practical Life (yrs),Unit of Measure'
  const filePath = writeCsv(
    dir,
    'missing-col.csv',
    ['', badHeader, '1,A,Sub,A10,F,A1010,S,A1010,S,Mat,10,10,LF'].join('\n'),
  )

  assert.throws(
    () => readUniformatPricingRows(filePath),
    /missing required column: Unit Price/,
  )
})

test('readUniformatPricingRows skips rows with empty Uni-Format Pricing ID', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(
    dir,
    'skip-empty-id.csv',
    [
      '',
      HEADER,
      ',A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Concrete,100,100,$10.00,LF',
      '100002,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Masonry,50,50,$20.00,LF',
    ].join('\n'),
  )

  const rows = readUniformatPricingRows(filePath)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pricing_id, '100002')
})

test('readUniformatPricingRows rejects a header-only catalogue', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(dir, 'header-only.csv', `${HEADER}\n`)
  assert.throws(
    () => readUniformatPricingRows(filePath),
    /contains no pricing records/,
  )
})

test('readUniformatPricingRows rejects duplicate pricing ids', (t) => {
  const dir = makeTempDir(t)
  const row =
    '100001,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Concrete,100,100,$10.00,LF'
  const filePath = writeCsv(
    dir,
    'duplicates.csv',
    [HEADER, row, row.replace('Concrete', 'Masonry')].join('\n'),
  )
  assert.throws(
    () => readUniformatPricingRows(filePath),
    /duplicate Uni-Format Pricing ID "100001" on rows 2 and 3/,
  )
})

test('readUniformatPricingRows throws with correct source_row for missing level field', (t) => {
  const dir = makeTempDir(t)
  // Blank first row (index 0), header at index 1 → first data row is source_row 3.
  // Second data row is source_row 4 and is missing level_2_description.
  const filePath = writeCsv(
    dir,
    'bad-row.csv',
    [
      '',
      HEADER,
      '100001,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Concrete,100,100,$10.00,LF',
      '100002,A,Substructure,A10,,A1010,Std,A1010,Std,Masonry,50,50,$20.00,LF',
    ].join('\n'),
  )

  assert.throws(
    () => readUniformatPricingRows(filePath),
    /uniformat_pricing\.csv row 4 is missing level_2_description/,
  )
})

test('readUniformatPricingRows parses service-life columns; blanks become null', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(
    dir,
    'life.csv',
    [
      '',
      HEADER,
      '100001,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Concrete,25,,$10.00,LF',
      '100002,A,Substructure,A10,Foundations,A1010,Std,A1010,Std,Masonry,,40,$20.00 ,LF',
    ].join('\n'),
  )

  const rows = readUniformatPricingRows(filePath)
  assert.equal(rows[0].mean_service_life, 25)
  assert.equal(rows[0].practical_life, null)
  assert.equal(rows[0].unit_price, '$10.00')
  assert.equal(rows[1].mean_service_life, null)
  assert.equal(rows[1].practical_life, 40)
  // cleanCsvValue trims unit_price (including trailing spaces from the catalogue).
  assert.equal(rows[1].unit_price, '$20.00')
})

test('readUniformatPricingRows smoke: real uniformat_pricing.csv', () => {
  const realPath = path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')
  const rows = readUniformatPricingRows(realPath)
  assert.ok(rows.length > 1000, `expected >1000 rows, got ${rows.length}`)

  const ids = new Set(rows.map((r) => r.pricing_id))
  assert.equal(ids.size, rows.length, 'all pricing_ids must be unique')
})

test('parseUniformatPricingRows reads text and agrees with the path reader', () => {
  // Both entry points must agree so a path reader and an in-memory parse
  // cannot drift.
  const realPath = path.join(__dirname, '..', 'data', 'uniformat_pricing.csv')
  assert.deepEqual(
    parseUniformatPricingRows(fs.readFileSync(realPath, 'utf8')),
    readUniformatPricingRows(realPath),
  )
})

// --- readLocationFactorRows ---

test('readLocationFactorRows throws when province/city header is missing', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(dir, 'no-header.csv', 'foo,bar\n1,2\n')
  assert.throws(
    () => readLocationFactorRows(filePath),
    /does not contain a province\/city header row/,
  )
})

test('readLocationFactorRows throws naming a missing required column', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(
    dir,
    'missing-factor.csv',
    [
      'province,city,material_index,installation_index,total_index',
      'Ontario,Toronto,100,100,100',
    ].join('\n'),
  )
  assert.throws(
    () => readLocationFactorRows(filePath),
    /missing required column: factor/,
  )
})

test('readLocationFactorRows throws on invalid factor values', (t) => {
  const dir = makeTempDir(t)
  const filePath = writeCsv(
    dir,
    'bad-factor.csv',
    [
      'province,city,material_index,installation_index,total_index,factor',
      'Ontario,Toronto,100,100,100,not-a-number',
    ].join('\n'),
  )
  assert.throws(
    () => readLocationFactorRows(filePath),
    /row 2 has invalid factor/,
  )
})

test('parseLocationFactorRows reads text and agrees with the path reader', () => {
  // db.js's listLocationFactors goes through the text entry point, so the
  // two readers must not drift apart.
  const realPath = path.join(__dirname, '..', 'data', 'location_factors.csv')
  assert.deepEqual(
    parseLocationFactorRows(fs.readFileSync(realPath, 'utf8')),
    readLocationFactorRows(realPath),
  )
})
