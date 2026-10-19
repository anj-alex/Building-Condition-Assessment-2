/**
 * Page splitting and page numbering for the Word preview.
 *
 * `docx-preview` does no layout-based pagination. It starts a new page only
 * where the document carries an explicit break of its own — `w:pageBreakBefore`
 * on a paragraph's *style*, `<w:br w:type="page"/>`, or a section break — and it
 * sizes every page with `min-height` rather than `height`, so a run of content
 * with no break in it becomes one section as tall as its content needs. The
 * same property set directly on a paragraph is not a break here: the viewer's
 * splitter asks the style and nothing else, so a direct one prints in Word and
 * is invisible on screen. On the largest report that put roughly seventy pages
 * of component detail into a single scrolling block: eight sections for a
 * document Word flows across 121 pages. The scroll bar bore no relation to the
 * delivered file.
 *
 * This measures what the viewer produced and cuts each section at the page's own
 * content height, moving whole blocks onto fresh pages that carry copies of the
 * running header and footer.
 *
 * It is an approximation and stays one. The browser breaks lines where Word does
 * not, so a page here holds a slightly different set of blocks than Word picks,
 * and the count lands near the delivered document's rather than on it. What it
 * fixes is the order of magnitude, and that a page on screen is a page.
 *
 * Once the pages are real, they can be numbered: the viewer draws no field at
 * all, so every footer would otherwise read "Page  of ". See the page-numbers
 * section below.
 *
 * Geometry arrives through an injected `measure` so the split can be tested
 * without a layout engine — jsdom reports every offset as zero, which this
 * treats as "nothing overflows" and leaves the DOM untouched.
 */

/** Sub-pixel overshoot to forgive before starting a new page. */
const OVERSHOOT_SLACK_PX = 1

/** CSS absolute lengths, in pixels, against the spec's 96px inch. */
const PX_PER_UNIT = Object.freeze({
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  Q: 96 / 101.6,
})

/**
 * A CSS length in pixels, or NaN if it is not an absolute one.
 *
 * The viewer writes the page box in whatever unit the document used, and for a
 * Word file that is points — a Letter page arrives as `792pt`. Element geometry
 * is only ever reported in pixels, so reading `792` as pixels made a page 648px
 * of content instead of 864 and cut every page a quarter short.
 */
function lengthToPx(value) {
  const match = /^\s*(-?\d*\.?\d+)\s*([a-zA-Z]*)\s*$/.exec(String(value ?? ''))
  if (!match) return Number.NaN
  const [, amount, unit] = match
  // A bare number is only ever `0` in valid inline CSS, but treating it as
  // pixels keeps that case from failing the whole page box.
  const scale = unit === '' ? 1 : (PX_PER_UNIT[unit] ?? PX_PER_UNIT[unit.toLowerCase()])
  return scale === undefined ? Number.NaN : Number(amount) * scale
}

/**
 * Geometry from a real layout engine. Offsets share the section as origin.
 *
 * `marginTop` comes along because a block that starts a page still renders its
 * own space above itself — the article is a flex item, so nothing collapses that
 * margin away — and a page that ignored it ran over the page box by that much.
 */
const domMeasure = (el) => {
  const view = el.ownerDocument?.defaultView
  const marginTop = view ? Number.parseFloat(view.getComputedStyle(el).marginTop) : 0
  return {
    top: el.offsetTop,
    height: el.offsetHeight,
    marginTop: Number.isFinite(marginTop) ? marginTop : 0,
  }
}

/** Where a block's page begins: its own top margin belongs to it. */
const marginBoxTop = (box) => box.top - (box.marginTop ?? 0)

/**
 * Group blocks into pages by where they overflow.
 *
 * Positions are used rather than a running sum of heights because the gap
 * between two blocks is their collapsed margin, which no height includes. A
 * page is measured from the top of its first block's margin, which that block
 * still renders once it heads a page of its own.
 *
 * A block taller than a whole page cannot be helped by splitting; it takes a
 * page of its own and overflows it, which is what `min-height` already does.
 *
 * @param {Array<{top: number, height: number}>} boxes blocks in flow order
 * @param {number} budget usable content height of one page
 * @returns {Array<[number, number]>} inclusive index ranges, one per page
 */
function pageGroups(boxes, budget) {
  if (boxes.length === 0) return []
  const groups = []
  let start = 0
  let origin = marginBoxTop(boxes[0])
  for (let i = 0; i < boxes.length; i += 1) {
    const bottom = boxes[i].top + boxes[i].height - origin
    if (bottom > budget + OVERSHOOT_SLACK_PX && i > start) {
      groups.push([start, i - 1])
      start = i
      origin = marginBoxTop(boxes[i])
    }
  }
  groups.push([start, boxes.length - 1])
  return groups
}

/**
 * Group table rows into pages.
 *
 * Heights sum here rather than reading positions: every continuation table
 * starts a fresh flow, and a repeated header row costs its height again.
 *
 * @param {number[]} heights row heights in order
 * @param {number} budget usable content height of one page
 * @param {number} headHeight repeated header height, 0 when there is none
 * @returns {Array<[number, number]>} inclusive index ranges, one per table
 */
function rowGroups(heights, budget, headHeight) {
  if (heights.length === 0) return []
  const groups = []
  let start = 0
  let used = headHeight
  for (let i = 0; i < heights.length; i += 1) {
    if (used + heights[i] > budget + OVERSHOOT_SLACK_PX && i > start) {
      groups.push([start, i - 1])
      start = i
      used = headHeight
    }
    used += heights[i]
  }
  groups.push([start, heights.length - 1])
  return groups
}

/**
 * Where a table keeps its body rows.
 *
 * The viewer builds tables through the DOM rather than by parsing HTML, so no
 * `<tbody>` is implied for it: rows usually sit directly under `<table>`. Both
 * shapes have to work, or a 105-row table stays whole on a five-page "page".
 */
function bodyRowParent(table) {
  return table.tBodies?.[0] ?? table
}

/** The rows a split may move — every row the repeated header does not own. */
function splittableRows(table) {
  const head = table.tHead
  return Array.from(bodyRowParent(table).rows ?? []).filter(
    (row) => !head || !head.contains(row),
  )
}

/**
 * Split one table taller than a page into consecutive tables.
 *
 * The continuation tables are clones with their body rows emptied, so each keeps
 * the original's `colgroup` and styling — column widths hold across the split —
 * and any header row repeats the way Word repeats `w:tblHeader`.
 */
function splitTable(table, budget, measure) {
  const rows = splittableRows(table)
  if (rows.length < 2) return

  const heights = rows.map((row) => measure(row).height)
  const headHeight = table.tHead ? measure(table.tHead).height : 0
  const groups = rowGroups(heights, budget, headHeight)
  if (groups.length < 2) return

  const template = table.cloneNode(true)
  for (const row of splittableRows(template)) row.remove()

  let anchor = table
  for (let group = 1; group < groups.length; group += 1) {
    const next = template.cloneNode(true)
    const nextParent = bodyRowParent(next)
    const [from, to] = groups[group]
    for (let i = from; i <= to; i += 1) nextParent.appendChild(rows[i])
    anchor.after(next)
    anchor = next
  }
}

/** Does this block put anything on the page? */
function drawsContent(block) {
  if (block.textContent.trim() !== '') return true
  return Boolean(block.querySelector?.('img, svg, table'))
}

/**
 * Fold away any page this split is about to invent that would draw nothing.
 *
 * Several of a page's blocks put nothing on paper. A Word page break is a
 * paragraph of its own and the viewer ends a page with it rather than starting
 * the next one with it, so a page's last block is routinely that empty
 * paragraph; so is the hairline paragraph carrying a section's end bookmark.
 * When the content above fills the page exactly, one of those is what overflows,
 * and cutting there hands it a page of its own — blank, but carrying the running
 * header, the footer and a page number, and pushing every page after it along.
 *
 * A page of nothing but those blocks is therefore given back to the page before
 * it, which is where they already sit whenever that page has room for them. The
 * page they end may then run a little over the box, with nothing drawn in the
 * extra space; before, the same overflow cost a whole page.
 *
 * **Only a page this module invents may be folded.** The first group is the page
 * the viewer itself produced from a break in the document, and a blank one there
 * is a blank page Word will print too — showing it is the preview's job, hiding
 * it would turn a defect in the document into one nobody can see.
 *
 * @param {Array<[number, number]>} groups index ranges from `pageGroups`
 * @param {Element[]} blocks the blocks those ranges index
 * @returns {Array<[number, number]>} the ranges that draw something
 */
function foldBlankPages(groups, blocks) {
  const kept = []
  for (const [from, to] of groups) {
    if (kept.length > 0 && !blocks.slice(from, to + 1).some(drawsContent)) {
      kept[kept.length - 1][1] = to
    } else {
      kept.push([from, to])
    }
  }
  return kept
}

/** Break up any table that no page could hold, before blocks are grouped. */
function splitOversizedTables(article, budget, measure) {
  for (const child of Array.from(article.children)) {
    if (child.tagName !== 'TABLE') continue
    if (measure(child).height <= budget) continue
    splitTable(child, budget, measure)
  }
}

/**
 * Split one rendered page at the page height.
 *
 * @returns {number} pages added
 */
function paginateSection(section, measure) {
  // The viewer writes the page box inline, so these are its own numbers rather
  // than this module's guess at Letter — converted to the pixels that element
  // geometry is measured in.
  const pageHeight = lengthToPx(section.style.minHeight)
  const padTop = lengthToPx(section.style.paddingTop)
  const padBottom = lengthToPx(section.style.paddingBottom)
  if (![pageHeight, padTop, padBottom].every(Number.isFinite)) return 0

  // The running header and footer sit in the page margins on negative margins of
  // their own, so they cost the content box nothing and are not subtracted here.
  const budget = pageHeight - padTop - padBottom
  if (!(budget > 0)) return 0

  const articles = Array.from(section.children).filter((el) => el.tagName === 'ARTICLE')
  // One article is the shape the builder produces. A page carrying several came
  // from continuous section breaks, where a split would have to decide which
  // section's properties the new page takes; leaving it whole is the honest
  // answer until the builder emits one.
  if (articles.length !== 1) return 0
  const article = articles[0]

  splitOversizedTables(article, budget, measure)

  const blocks = Array.from(article.children)
  if (blocks.length < 2) return 0

  const groups = foldBlankPages(
    pageGroups(blocks.map((el) => measure(el)), budget),
    blocks,
  )
  if (groups.length < 2) return 0

  const header = section.querySelector(':scope > header')
  const footer = section.querySelector(':scope > footer')
  let anchor = section
  for (let group = 1; group < groups.length; group += 1) {
    const page = section.cloneNode(false)
    if (header) page.appendChild(header.cloneNode(true))
    const nextArticle = article.cloneNode(false)
    const [from, to] = groups[group]
    for (let i = from; i <= to; i += 1) nextArticle.appendChild(blocks[i])
    page.appendChild(nextArticle)
    if (footer) page.appendChild(footer.cloneNode(true))
    anchor.after(page)
    anchor = page
  }
  return groups.length - 1
}

// ---------------------------------------------------------------------------
// Page numbers.
//
// `docx-preview` parses Word fields and then renders every field run as
// nothing, so `PAGE` and the footer's total both come out blank on their own.
// What it does render is the cached result the builder writes between the
// field's `separate` and `end` — a placeholder carrying a character style, which
// arrives here as a class. Numbering is therefore a matter of finding those two
// spans and writing the page this module just finished counting into them.
//
// Which number to write comes from a bookmark the builder puts in each footer,
// naming the run of pages that share one numbering scheme and how that scheme
// counts. Word restarts at every section, so a page's number is its position
// within its own band rather than within the document.
// ---------------------------------------------------------------------------

/** Bookmark naming a footer's numbering band: `_CarPageBand_<key>_<format>`. */
const PAGE_BAND_PREFIX = '_CarPageBand_'

/** Classes docx-preview derives from the two page-field character styles. */
const PAGE_NUMBER_CLASS = 'car-word-preview_carpagenumber'
const PAGE_TOTAL_CLASS = 'car-word-preview_carpagetotal'

/** The viewer's own class for a rendered tab. */
const TAB_STOP_CLASS = 'car-word-preview-tab-stop'

const PT_PER_PX = 72 / 96

const ROMAN_PLACES = Object.freeze([
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
])

function lowerRoman(value) {
  let left = value
  let out = ''
  for (const [amount, numeral] of ROMAN_PLACES) {
    while (left >= amount) {
      out += numeral
      left -= amount
    }
  }
  return out
}

/** A page number in its band's own numerals, matching what Word will print. */
function formatPageNumber(value, format) {
  if (!(value > 0)) return ''
  return format === 'lowerRoman' ? lowerRoman(value) : String(value)
}

/** The numbering band a rendered page belongs to, or null for an unnumbered one. */
function pageBand(section) {
  const marker = section.querySelector(`:scope > footer [id^="${PAGE_BAND_PREFIX}"]`)
  if (!marker) return null
  const name = marker.id.slice(PAGE_BAND_PREFIX.length)
  const split = name.lastIndexOf('_')
  if (split < 1) return null
  return { key: name.slice(0, split), format: name.slice(split + 1) }
}

/**
 * Take a footer's growth back out of its right tab stop.
 *
 * The viewer measures what follows a right tab once and freezes the gap as a
 * word spacing in points. Writing a real page number over the placeholder makes
 * that content wider, which would push the whole right-hand group past the
 * margin the rest of the page lines up against.
 */
function realignTabStops(footer) {
  const doc = footer.ownerDocument
  if (typeof doc?.createRange !== 'function') return
  for (const tab of footer.querySelectorAll(`.${TAB_STOP_CLASS}`)) {
    const paragraph = tab.closest('p')
    if (!paragraph) continue
    const spacing = Number.parseFloat(tab.style.wordSpacing)
    if (!Number.isFinite(spacing)) continue
    const range = doc.createRange()
    range.setStartAfter(tab)
    range.setEndAfter(paragraph)
    const overflow = range.getBoundingClientRect().right - paragraph.getBoundingClientRect().right
    if (!Number.isFinite(overflow) || overflow === 0) continue
    tab.style.wordSpacing = `${(spacing - overflow * PT_PER_PX).toFixed(2)}pt`
  }
}

/** Write one page's numbers over the placeholders its footer carries. */
function stampFooter(section, number, total) {
  const footer = section.querySelector(':scope > footer')
  if (!footer) return false
  let stamped = false
  for (const [className, value] of [
    [PAGE_NUMBER_CLASS, number],
    [PAGE_TOTAL_CLASS, total],
  ]) {
    for (const span of Array.from(footer.querySelectorAll(`.${className}`))) {
      span.textContent = value
      stamped = true
    }
  }
  if (stamped) realignTabStops(footer)
  return stamped
}

/**
 * Number every page the viewer produced, band by band.
 *
 * A page with no band — the cover — is numbered by nobody and closes whatever
 * band preceded it, so two buildings' bodies never run into one another.
 *
 * @param {Element} scope container holding the viewer's output
 * @returns {number} pages numbered
 */
function numberPages(scope) {
  if (!scope?.querySelectorAll) return 0
  const bands = []
  let current = null
  for (const section of scope.querySelectorAll('section.car-word-preview')) {
    const band = pageBand(section)
    if (!band) {
      current = null
      continue
    }
    if (current?.key !== band.key) {
      current = { ...band, pages: [] }
      bands.push(current)
    }
    current.pages.push(section)
  }

  let numbered = 0
  for (const { format, pages } of bands) {
    const total = formatPageNumber(pages.length, format)
    pages.forEach((page, index) => {
      if (stampFooter(page, formatPageNumber(index + 1, format), total)) numbered += 1
    })
  }
  return numbered
}

/**
 * Split every rendered page in `scope` that holds more than a page of content,
 * then number what is left.
 *
 * @param {Element} scope container holding the viewer's output
 * @param {{measure?: (el: Element) => {top: number, height: number}}} [options]
 * @returns {number} pages added
 */
function paginatePreview(scope, { measure = domMeasure } = {}) {
  if (!scope?.querySelectorAll) return 0
  let added = 0
  // Snapshot first: the loop inserts sections that must not be revisited.
  for (const section of Array.from(scope.querySelectorAll('section.car-word-preview'))) {
    added += paginateSection(section, measure)
  }
  // Second pass: a page cannot know its number until every split has happened.
  numberPages(scope)
  return added
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    paginatePreview,
    numberPages,
    pageGroups,
    rowGroups,
    lengthToPx,
    lowerRoman,
    OVERSHOOT_SLACK_PX,
  }
}
