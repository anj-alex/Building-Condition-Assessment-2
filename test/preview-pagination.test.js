const assert = require('node:assert/strict')
const test = require('node:test')

const { JSDOM } = require('jsdom')

const {
  paginatePreview,
  numberPages,
  pageGroups,
  rowGroups,
  lengthToPx,
  lowerRoman,
} = require('../src/lib/preview-pagination')

// The viewer writes the page box in the document's own unit, which for a Word
// file is points; element geometry only ever comes back in pixels.
const PAGE_HEIGHT_PT = 792
const MARGIN_PT = 72
const PAGE_HEIGHT = 1056
const MARGIN = 96
/** What one Letter page leaves for content once its margins are taken. */
const BUDGET = PAGE_HEIGHT - MARGIN * 2

/** Geometry from `data-top` / `data-h`, standing in for a layout engine. */
const measure = (el) => ({
  top: Number(el.dataset.top ?? 0),
  height: Number(el.dataset.h ?? 0),
})

/**
 * A rendered page in the shape docx-preview produces: the page box written
 * inline on the section, the running header and footer as its own children, and
 * the flowed content in a single `<article>`.
 */
function page(blocks, { header = true, footer = true, articles = 1, band = null } = {}) {
  const dom = new JSDOM('<div class="car-word-preview-wrapper"></div>')
  const { document } = dom.window
  const wrapper = document.querySelector('.car-word-preview-wrapper')
  const section = document.createElement('section')
  section.className = 'car-word-preview'
  section.style.minHeight = `${PAGE_HEIGHT_PT}pt`
  section.style.paddingTop = `${MARGIN_PT}pt`
  section.style.paddingBottom = `${MARGIN_PT}pt`
  if (header) {
    const el = document.createElement('header')
    el.textContent = 'Amu Ahmad Inspection Inc.'
    section.appendChild(el)
  }
  for (let a = 0; a < articles; a += 1) {
    const article = document.createElement('article')
    for (const block of a === 0 ? blocks : []) {
      const el = document.createElement(block.tag ?? 'p')
      el.dataset.top = String(block.top)
      el.dataset.h = String(block.height)
      if (block.text) el.textContent = block.text
      article.appendChild(el)
    }
    section.appendChild(article)
  }
  if (footer) section.appendChild(runningFooter(document, band))
  wrapper.appendChild(section)
  return { document, wrapper }
}

/**
 * The footer docx-preview renders from the builder's page fields: a bookmark
 * naming the numbering band, then the two cached results — the only part of
 * either field the viewer draws — as spans carrying their character style.
 */
function runningFooter(document, band) {
  const el = document.createElement('footer')
  el.innerHTML =
    (band ? `<span id="_CarPageBand_${band}"></span>` : '') +
    '<span>January 1, 2025</span>' +
    '<span><span class="car-word-preview-tab-stop">&nbsp;</span>Page </span>' +
    '<span class="car-word-preview_carpagenumber">\u2014</span>' +
    '<span> of </span>' +
    '<span class="car-word-preview_carpagetotal">\u2014</span>'
  return el
}

/** Another rendered page in the same document, after the ones already there. */
function addPage(document, wrapper, { band = null } = {}) {
  const section = document.createElement('section')
  section.className = 'car-word-preview'
  section.appendChild(document.createElement('article'))
  section.appendChild(runningFooter(document, band))
  wrapper.appendChild(section)
  return section
}

/** What each page's footer ended up printing, or null where it has no footer. */
const printedNumbers = (wrapper) =>
  sections(wrapper).map((section) => {
    const footer = section.querySelector(':scope > footer')
    if (!footer) return null
    return [
      footer.querySelector('.car-word-preview_carpagenumber')?.textContent,
      footer.querySelector('.car-word-preview_carpagetotal')?.textContent,
    ].join('/')
  })

const sections = (wrapper) => [...wrapper.querySelectorAll('section.car-word-preview')]
const blockText = (section) =>
  [...section.querySelector('article').children].map((el) => el.textContent)

// Element geometry only ever comes back in pixels, so the page box has to be
// converted before it can be compared with it. Reading Letter's `792pt` as 792
// pixels left 648px of content instead of 864 and cut every page a quarter
// short, which showed up as a run of near-empty pages.
test('the page box is converted from the unit the viewer wrote it in', () => {
  assert.equal(lengthToPx('792pt'), 1056)
  assert.equal(lengthToPx('72pt'), 96)
  assert.equal(lengthToPx('1056px'), 1056)
  assert.equal(lengthToPx('11in'), 1056)
  assert.equal(lengthToPx('2.54cm'), 96)
  assert.equal(lengthToPx('25.4mm'), 96)
  assert.equal(lengthToPx('6pc'), 96)
  assert.equal(lengthToPx('0'), 0)
  assert.equal(lengthToPx(' 792pt '), 1056)
})

test('a page box in a unit with no fixed pixel size is refused', () => {
  for (const value of ['100%', '10em', '5vh', 'auto', '', null, undefined, 'abc']) {
    assert.equal(Number.isNaN(lengthToPx(value)), true, `${value} is not an absolute length`)
  }
})

test('blocks that fit inside the page stay on one page', () => {
  const groups = pageGroups(
    [
      { top: 0, height: 400 },
      { top: 400, height: 400 },
    ],
    BUDGET,
  )
  assert.deepEqual(groups, [[0, 1]])
})

test('a block that would overflow the page starts the next one', () => {
  const groups = pageGroups(
    [
      { top: 0, height: 400 },
      { top: 400, height: 400 },
      { top: 800, height: 400 },
    ],
    BUDGET,
  )
  assert.deepEqual(groups, [
    [0, 1],
    [2, 2],
  ])
})

// Summing heights would put these two on one page at 800px of content. The gap
// between them is a collapsed margin that neither height includes, and on the
// page it is real space, so positions are what decide.
test('the space between blocks counts against the page, not just their heights', () => {
  const groups = pageGroups(
    [
      { top: 0, height: 400 },
      { top: 500, height: 400 },
    ],
    BUDGET,
  )
  assert.deepEqual(groups, [
    [0, 0],
    [1, 1],
  ])
})

test('each new page measures from its own first block', () => {
  const groups = pageGroups(
    [
      { top: 0, height: 800 },
      { top: 800, height: 800 },
      { top: 1600, height: 800 },
    ],
    BUDGET,
  )
  assert.deepEqual(groups, [
    [0, 0],
    [1, 1],
    [2, 2],
  ])
})

// Nothing can make it fit, and a page must always take at least one block or the
// walk would never advance.
test('a block taller than any page takes a page alone rather than looping', () => {
  const groups = pageGroups(
    [
      { top: 0, height: 5000 },
      { top: 5000, height: 100 },
    ],
    BUDGET,
  )
  assert.deepEqual(groups, [
    [0, 0],
    [1, 1],
  ])
})

test('no blocks produce no pages', () => {
  assert.deepEqual(pageGroups([], BUDGET), [])
})

// The article is a flex item, so a first child's top margin does not collapse
// out of it — the block renders that space at the top of its new page too, and
// a page that ignored it overshot the page box.
test('a block that starts a page is charged its own top margin', () => {
  const boxes = [
    { top: 0, height: 400 },
    { top: 400, height: 400, marginTop: 0 },
    // 800..1264 of flow, but on a fresh page it costs its 100px margin as well,
    // so only 764px of the 864 budget is left for anything after it.
    { top: 900, height: 464, marginTop: 100 },
    { top: 1364, height: 500 },
  ]
  assert.deepEqual(pageGroups(boxes, BUDGET), [
    [0, 1],
    [2, 2],
    [3, 3],
  ])
})

test('a measurement with no margin reported is treated as having none', () => {
  assert.deepEqual(
    pageGroups(
      [
        { top: 0, height: 800 },
        { top: 800, height: 64 },
      ],
      BUDGET,
    ),
    [[0, 1]],
  )
})

test('table rows fill a page and then continue on the next', () => {
  assert.deepEqual(rowGroups([200, 200, 200, 200, 200, 200], BUDGET, 0), [
    [0, 3],
    [4, 5],
  ])
})

// A continuation table repeats its header, so the header's height is charged to
// every page rather than only the first. Here that leaves 564px for rows instead
// of 864, which is two 200px rows a page rather than four.
test('a repeated header row costs its height on each continuation table', () => {
  assert.deepEqual(rowGroups([200, 200, 200, 200, 200, 200], BUDGET, 300), [
    [0, 1],
    [2, 3],
    [4, 5],
  ])
})

test('a row taller than the page takes a table of its own rather than looping', () => {
  assert.deepEqual(rowGroups([2000, 100], BUDGET, 0), [
    [0, 0],
    [1, 1],
  ])
})

test('a page holding one page of content is left alone', () => {
  const { wrapper } = page([
    { top: 0, height: 400, text: 'first' },
    { top: 400, height: 400, text: 'second' },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 0)
  assert.equal(sections(wrapper).length, 1)
})

// A Word page break is a paragraph of its own, and the viewer ends a page with
// it rather than starting the next one with it. When the content above fills the
// page exactly, that empty paragraph is what overflows — and cutting there gave
// it a page of its own: completely blank, but carrying the running header, the
// footer and a page number, and pushing the appendix behind it from 7 of 8 to
// 8 of 9.
test('a trailing block that draws nothing never gets a page of its own', () => {
  const { wrapper } = page([
    { top: 0, height: 500, text: 'first' },
    { top: 500, height: 360, text: 'second' },
    // The page break, flush against the bottom of a full page.
    { top: 860, height: 20 },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 0)

  const pages = sections(wrapper)
  assert.equal(pages.length, 1, 'the empty paragraph did not become a page')
  assert.deepEqual(pages.map(blockText), [['first', 'second', '']])
  assert.deepEqual(printedNumbers(wrapper), ['—/—'], 'no number was spent on a blank page')
})

test('a page still splits at its last block that draws something', () => {
  const { wrapper } = page([
    { top: 0, height: 500, text: 'first' },
    { top: 500, height: 500, text: 'second' },
    { top: 1000, height: 20 },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 1)

  const pages = sections(wrapper)
  assert.deepEqual(
    pages.map(blockText),
    [['first'], ['second', '']],
    'the trailing empty paragraph follows the block it belongs behind',
  )
})

// The same rule holds anywhere in the section, not just at its end: a run of
// blocks that draw nothing can be long enough to fill a page all on its own.
test('a page in the middle that would draw nothing is folded back too', () => {
  const { wrapper } = page([
    { top: 0, height: 500, text: 'first' },
    { top: 500, height: 400 },
    { top: 900, height: 400 },
    { top: 1300, height: 400, text: 'second' },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 1)

  const pages = sections(wrapper)
  assert.deepEqual(
    pages.map(blockText),
    [['first', '', ''], ['second']],
    'the empty run stayed behind the block it follows instead of taking a page',
  )
})

// The first group is the page docx-preview itself produced from a break in the
// document, so a blank one there is a blank page Word prints as well. Hiding it
// would turn a defect in the document into one nobody can see on screen.
test('a blank page the viewer itself produced is left alone', () => {
  const { wrapper } = page(
    [
      { top: 0, height: 500 },
      { top: 500, height: 500 },
    ],
    { band: 'Body_decimal' },
  )
  assert.equal(paginatePreview(wrapper, { measure }), 0)

  const pages = sections(wrapper)
  assert.equal(pages.length, 1, 'the viewer\'s own page was neither split nor removed')
  assert.deepEqual(printedNumbers(wrapper), ['1/1'], 'and it is still a numbered page')
})

test('an overlong page is cut into pages that each carry the header and footer', () => {
  const { wrapper } = page([
    { top: 0, height: 500, text: 'first' },
    { top: 500, height: 500, text: 'second' },
    { top: 1000, height: 500, text: 'third' },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 2)

  const pages = sections(wrapper)
  assert.equal(pages.length, 3)
  assert.deepEqual(
    pages.map(blockText),
    [['first'], ['second'], ['third']],
    'each block moved onto its own page in document order',
  )
  for (const [index, section] of pages.entries()) {
    assert.equal(
      section.querySelectorAll(':scope > header').length,
      1,
      `page ${index + 1} carries the running header`,
    )
    assert.equal(
      section.querySelectorAll(':scope > footer').length,
      1,
      `page ${index + 1} carries the running footer`,
    )
    assert.equal(section.style.minHeight, `${PAGE_HEIGHT_PT}pt`)
    assert.equal(section.style.paddingTop, `${MARGIN_PT}pt`)
    assert.equal(section.className, 'car-word-preview')
  }
})

test('pages are inserted in order after the page they came from', () => {
  const { wrapper, document } = page([
    { top: 0, height: 900, text: 'a' },
    { top: 900, height: 900, text: 'b' },
  ])
  const trailer = document.createElement('section')
  trailer.className = 'car-word-preview'
  trailer.dataset.marker = 'last'
  wrapper.appendChild(trailer)

  paginatePreview(wrapper, { measure })
  const order = sections(wrapper).map((s) =>
    s.dataset.marker === 'last' ? 'last' : blockText(s).join(''),
  )
  assert.deepEqual(order, ['a', 'b', 'last'])
})

// jsdom runs the renderer's unit suites and reports every offset as zero. That
// has to read as "nothing overflows", never as "every block is at the top and
// therefore needs its own page".
test('a document with no layout is left untouched', () => {
  const { wrapper } = page([
    { top: 0, height: 0, text: 'first' },
    { top: 0, height: 0, text: 'second' },
    { top: 0, height: 0, text: 'third' },
  ])
  assert.equal(paginatePreview(wrapper, { measure }), 0)
  assert.equal(sections(wrapper).length, 1)
})

test('a page missing its inline page box is left alone', () => {
  const { wrapper } = page([
    { top: 0, height: 900, text: 'first' },
    { top: 900, height: 900, text: 'second' },
  ])
  sections(wrapper)[0].style.minHeight = ''
  assert.equal(paginatePreview(wrapper, { measure }), 0)
  assert.equal(sections(wrapper).length, 1)
})

test('a page built from several section breaks is left whole', () => {
  const { wrapper } = page(
    [
      { top: 0, height: 900, text: 'first' },
      { top: 900, height: 900, text: 'second' },
    ],
    { articles: 2 },
  )
  assert.equal(paginatePreview(wrapper, { measure }), 0)
  assert.equal(sections(wrapper).length, 1)
})

test('a table too tall for a page is split by rows, keeping its columns and header', () => {
  const { wrapper, document } = page([{ tag: 'table', top: 0, height: 2000 }])
  const table = wrapper.querySelector('table')
  const colgroup = document.createElement('colgroup')
  const col = document.createElement('col')
  col.setAttribute('width', '220')
  colgroup.appendChild(col)
  table.appendChild(colgroup)
  const head = document.createElement('thead')
  head.dataset.h = '100'
  head.textContent = 'Component'
  table.appendChild(head)
  const body = document.createElement('tbody')
  for (let i = 0; i < 6; i += 1) {
    const row = document.createElement('tr')
    row.dataset.h = '200'
    row.textContent = `row ${i}`
    body.appendChild(row)
  }
  table.appendChild(body)

  paginatePreview(wrapper, { measure })

  const tables = [...wrapper.querySelectorAll('table')]
  assert.equal(tables.length, 2, 'six 200px rows under a 100px header need two tables')
  assert.deepEqual(
    tables.map((t) => [...t.tBodies[0].rows].map((r) => r.textContent)),
    [
      ['row 0', 'row 1', 'row 2'],
      ['row 3', 'row 4', 'row 5'],
    ],
    'rows moved once, in order, with none duplicated or dropped',
  )
  for (const t of tables) {
    assert.equal(t.querySelectorAll('colgroup col').length, 1, 'column widths survive')
    assert.equal(t.tHead?.textContent, 'Component', 'the header row repeats')
  }
})

// The viewer builds tables through the DOM, where no <tbody> is implied, so its
// rows normally sit directly under <table>. Reaching only through `tBodies[0]`
// left a 105-row summary whole on a five-page page.
test('a tall table whose rows have no tbody is still split', () => {
  const { wrapper, document } = page([{ tag: 'table', top: 0, height: 2000 }])
  const table = wrapper.querySelector('table')
  for (let i = 0; i < 6; i += 1) {
    const row = document.createElement('tr')
    row.dataset.h = '200'
    row.textContent = `row ${i}`
    table.appendChild(row)
  }
  assert.equal(table.tBodies.length, 0, 'the fixture reproduces the viewer’s shape')

  paginatePreview(wrapper, { measure })

  const tables = [...wrapper.querySelectorAll('table')]
  assert.equal(tables.length, 2)
  assert.deepEqual(
    tables.map((t) => [...t.rows].map((r) => r.textContent)),
    [
      ['row 0', 'row 1', 'row 2', 'row 3'],
      ['row 4', 'row 5'],
    ],
  )
})

test('a table that fits is not split', () => {
  const { wrapper, document } = page([{ tag: 'table', top: 0, height: 400 }])
  const table = wrapper.querySelector('table')
  const body = document.createElement('tbody')
  for (let i = 0; i < 2; i += 1) {
    const row = document.createElement('tr')
    row.dataset.h = '200'
    body.appendChild(row)
  }
  table.appendChild(body)

  paginatePreview(wrapper, { measure })
  assert.equal(wrapper.querySelectorAll('table').length, 1)
})

test('paginating a container with no pages is harmless', () => {
  const dom = new JSDOM('<div id="empty"></div>')
  assert.equal(paginatePreview(dom.window.document.getElementById('empty'), { measure }), 0)
  assert.equal(paginatePreview(null, { measure }), 0)
})

// ---------------------------------------------------------------------------
// Page numbers.
// ---------------------------------------------------------------------------

test('roman numerals are built the way Word writes front matter', () => {
  assert.deepEqual(
    [1, 4, 5, 9, 14, 20, 40, 90, 100, 400, 1000].map(lowerRoman),
    ['i', 'iv', 'v', 'ix', 'xiv', 'xx', 'xl', 'xc', 'c', 'cd', 'm'],
  )
})

test('a band is numbered in its own numerals, against its own total', () => {
  const { document, wrapper } = page([], { band: 'B1Front_lowerRoman' })
  addPage(document, wrapper, { band: 'B1Front_lowerRoman' })
  addPage(document, wrapper, { band: 'B1Front_lowerRoman' })

  assert.equal(numberPages(wrapper), 3)
  assert.deepEqual(printedNumbers(wrapper), ['i/iii', 'ii/iii', 'iii/iii'])
})

// Word restarts numbering at every section, so a page's number is its place in
// its own band — not in the document.
test('numbering restarts with each band and counts only that band', () => {
  const { document, wrapper } = page([], { band: 'B1Front_lowerRoman' })
  addPage(document, wrapper, { band: 'B1Front_lowerRoman' })
  addPage(document, wrapper, { band: 'B1Body_decimal' })
  addPage(document, wrapper, { band: 'B1Body_decimal' })
  addPage(document, wrapper, { band: 'B1Body_decimal' })

  numberPages(wrapper)
  assert.deepEqual(printedNumbers(wrapper), ['i/ii', 'ii/ii', '1/3', '2/3', '3/3'])
})

// A binder puts one building's body next to the next building's cover. Numbering
// that ran straight through would give the second building a first page of 40.
test('an unnumbered cover closes the band before it', () => {
  const { document, wrapper } = page([], { band: 'B1Body_decimal' })
  addPage(document, wrapper, { band: 'B1Body_decimal' })
  addPage(document, wrapper, { band: null })
  addPage(document, wrapper, { band: 'B2Body_decimal' })

  numberPages(wrapper)
  assert.deepEqual(printedNumbers(wrapper), ['1/2', '2/2', '—/—', '1/1'])
})

test('pages made by splitting are numbered along with the rest', () => {
  const { wrapper } = page(
    [
      { top: 0, height: 500, text: 'first' },
      { top: 500, height: 500, text: 'second' },
      { top: 1000, height: 500, text: 'third' },
    ],
    { band: 'B1Body_decimal' },
  )

  assert.equal(paginatePreview(wrapper, { measure }), 2)
  assert.deepEqual(printedNumbers(wrapper), ['1/3', '2/3', '3/3'])
})

test('a footer that names no band keeps its placeholders', () => {
  const { wrapper } = page([], { band: null })
  assert.equal(numberPages(wrapper), 0)
  assert.deepEqual(printedNumbers(wrapper), ['—/—'])
})

test('a page with no footer at all is numbered by nobody', () => {
  const { document, wrapper } = page([], { footer: false })
  addPage(document, wrapper, { band: 'B1Body_decimal' })

  assert.equal(numberPages(wrapper), 1)
  assert.deepEqual(printedNumbers(wrapper), [null, '1/1'])
})

// The name carries both halves and the key itself may hold no separator beyond
// the one before the format.
test('a malformed band marker is ignored rather than half-read', () => {
  const { wrapper } = page([], { band: 'decimal' })
  assert.equal(numberPages(wrapper), 0)
  assert.deepEqual(printedNumbers(wrapper), ['—/—'])
})

test('numbering a container with no pages is harmless', () => {
  const dom = new JSDOM('<div id="empty"></div>')
  assert.equal(numberPages(dom.window.document.getElementById('empty')), 0)
  assert.equal(numberPages(null), 0)
})
