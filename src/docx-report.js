// Word (.docx) export of the consolidated property report — the only report
// file the app produces. Main builds it from one getPropertyReportData snapshot,
// caches the bytes, sends those bytes to the on-screen DOCX renderer, and saves
// that same artifact. Content can therefore never drift between review/save.
//
// Fixed prose, section order and the legal notices come from
// src/lib/report-content.js. Layout is a properly structured Word document —
// real heading styles, a live
// table of contents, roman-numeral front matter and arabic body pages — rather
// than a fixed-height page copy. See docs/property-report.md and
// docs/word-export.md.

const fs = require('node:fs')
const { nativeImage } = require('electron')
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Tab,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  TableLayoutType,
  WidthType,
  VerticalAlign,
  HeightRule,
  BorderStyle,
  ShadingType,
  TabStopType,
  Header,
  Footer,
  ImageRun,
  PageBreak,
  TableOfContents,
  NumberFormat,
  LevelFormat,
  LineRuleType,
  BookmarkStart,
  BookmarkEnd,
  ImportedXmlComponent,
  StyleLevel,
} = require('docx')

const {
  capitalLevel1Rows,
  componentSummaryRows,
  componentSummaryTotal,
  displayActionYear,
  displayBuildingId,
  displayCrvRows,
  displayVintage,
  facilityScorecard,
  orderedAssetGroups,
  termDisplayLabel,
} = require('./lib/property-report-rules')
const { aggregateProjectPlan } = require('./lib/project-rollup')
const { displayUnitMeasure } = require('./shared')
const {
  SUMMARY_SECTIONS,
  LABELS,
  COMPONENT_SUMMARY_COLUMNS,
  SCORECARD_TILES,
  SCORECARD_PRIORITY_COLUMNS,
  CONDITION_SNAPSHOT_COLUMNS,
  FACILITY_FIELDS,
  ASSET_FIELDS,
  NOT_PROVIDED,
  NOT_ASSESSED_NOTE,
  executiveSummaryIntroBlocks,
  capitalNeedsCommentaryBlocks,
  componentSummaryBlocks,
  facilityScorecardBlocks,
  capitalNeedsDefinitionBlocks,
  visualObservationBlocks,
  reserveScheduleIntroBlocks,
  crvIntroBlocks,
  crvClosingBlocks,
  fciBlocks,
  dataQualityBlocks,
  conditionAssessmentIntroBlocks,
  disclaimerBlocks,
  limitationsBlocks,
  conclusionsIntroBlocks,
  conclusionsClosingBlocks,
  portfolioOverviewBlocks,
  portfolioCapitalBlocks,
  portfolioForecastBlocks,
} = require('./lib/report-content')
const { sanitizeAnnotations } = require('./lib/annotations')

// ---------------------------------------------------------------------------
// Design tokens.
//
// The steel-slate palette, type scale and table treatment are canonical here;
// the report page renders this OOXML rather than maintaining a second layout.
// Word cannot
// do gradients, pseudo-element glyphs or `border-collapse`, so those become
// solid fills and paragraph borders; everything else maps across directly.
// ---------------------------------------------------------------------------

const INK = '152033' // --report-ink
const ACCENT = '1D5F9C' // --report-accent
const ACCENT_SOFT = 'E8F1F8' // --report-accent-soft
const SURFACE = 'F0F3F7' // --report-surface
const BORDER = 'B7C2CF' // --report-border
const BORDER_STRONG = '5C6B7E' // --report-border-strong
const MUTED = '5A6575' // --report-muted
const LEGAL_INK = '2A3340' // .legal-paragraph colour
const ZEBRA = 'FAFBFC' // .report-table even-row fill
const PAPER = 'FFFFFF'

// Word takes a single family rather than a stack: whatever is named here has
// to exist on the reader's machine or Word silently substitutes. Calibri is the
// document face rather than Segoe UI because Segoe UI is a Windows *interface*
// font — absent from Office for Mac, so half the readership was already seeing
// a substitute — while Calibri ships with every Office install on both
// platforms. It also has an open metric-compatible clone (Carlito), which is
// what lets the preview show the same line breaks as Word; see
// styles/property-report.css.
const BODY_FONT = 'Calibri'

// Half-points. Body copy is 11pt, tables 9pt, small print 9pt, page chrome 8pt,
// and the FCI scoring grid 8pt. Body prose is a point larger than the old Segoe
// UI setting because Calibri sets noticeably smaller at the same nominal size;
// 11pt is the size Word itself uses for Calibri body text. Only the document
// default moves — every table cell names TABLE_SIZE explicitly, so the fixed
// column grids are unaffected.
const BODY_SIZE = 22
const TABLE_SIZE = 18
const LEGAL_SIZE = 18
const CHROME_SIZE = 16
const MICRO_SIZE = 16

// Eighths of a point: the stylesheet's 3px accent rules and 1px hairlines.
const RULE_ACCENT = 18
const RULE_HAIRLINE = 4
const RULE_INK = 12

// Points. The gap `w:space` puts between a paragraph border and its text —
// Word and LibreOffice both draw the rule that far outside the text.
//
// One value per axis rather than a number chosen per heading or callout,
// because the review screen has to reapply these itself: docx-preview
// translates w:pBdr into a CSS border and drops w:space entirely, rendering
// every accent bar and rule flush against the words. Two values let the
// preview restore them generically, by axis, with nothing to track per
// construct and nothing to update when the report grows another bordered
// block. `restoreBorderSpacing` in src/property-report.js is the other half,
// and test/property-report.test.js fails if the two disagree.
const BORDER_SPACE_X = 8 // left/right — the accent bars
const BORDER_SPACE_Y = 6 // top/bottom — the horizontal rules

// Twips. US Letter paper with one-inch document margins. These values are
// attached to every section rather than relying on Word's locale-dependent
// defaults (A4 is the default on many client machines).
const LETTER_WIDTH_TWIPS = 12240
const LETTER_HEIGHT_TWIPS = 15840
const PAGE_MARGIN_TWIPS = 1440
const HEADER_FOOTER_MARGIN_TWIPS = 720

// Letter paper less the 1in margins every section sets.
const CONTENT_WIDTH = 9360

// Source photos can be many megapixels even though the widest report image is
// 6.5in. Bounding the encoded raster keeps a photo-heavy binder tractable while
// retaining roughly 246 dpi at full page width.
const REPORT_IMAGE_MAX_EDGE = 1600
const REPORT_IMAGE_JPEG_QUALITY = 88

// The cover's photo band. The stylesheet gives `.cover-hero` 3.85in, but Word
// stacks the cover as flowing content rather than a flex column, so the band is
// sized to what is actually left on the page — measured against the rendered
// cover, not assumed.
const HERO_BAND_TWIPS = 3200
const HERO_MAX_HEIGHT_PX = 265

/**
 * Character styles carried by the cached results of the footer's page fields.
 * See `cachedField` for why the numbers are styled rather than formatted inline.
 */
const PAGE_NUMBER_STYLE = 'CarPageNumber'
const PAGE_TOTAL_STYLE = 'CarPageTotal'

/**
 * Paragraph styles that exist so a binder's contents field can pick out the
 * few headings that belong in it.
 *
 * Every building repeats the same three dozen section titles, so a contents
 * built over Heading 1-3 lists that same list once per property — 2,485
 * entries across 54 pages for a 75-property binder, with nothing in it naming
 * the building any given block belongs to. A binder's contents is therefore
 * the portfolio's own sections and then one line per property, and these
 * styles are how the field says which is which: `TOC \t` selects by style
 * *name*, and the portfolio's headings need names the buildings' headings do
 * not share. See `tableOfContents`.
 *
 * Each stands in for the heading style it is based on and adds nothing of its
 * own, so tagging a heading changes what indexes it and nothing about how it
 * looks. `PROPERTY_ENTRY_STYLE` marks the property name already printed on a
 * building's cover rather than adding a heading of its own, which is why a
 * binder gains a usable contents page without gaining a line of visible text.
 */
const PORTFOLIO_HEADING_STYLES = Object.freeze({
  1: { id: 'CarPortfolioHeading1', name: 'Car Portfolio Heading 1' },
  2: { id: 'CarPortfolioHeading2', name: 'Car Portfolio Heading 2' },
  3: { id: 'CarPortfolioHeading3', name: 'Car Portfolio Heading 3' },
})
const PROPERTY_ENTRY_STYLE = Object.freeze({
  id: 'CarPropertyEntry',
  name: 'Car Property Entry',
})

/**
 * For each style a heading can be set in, the variant of it that also starts a
 * new page. Keyed by the id of the style it stands in for.
 *
 * The break lives in a style rather than on the paragraph because that is the
 * only form the preview can see. `docx-preview` parses a direct
 * `w:pageBreakBefore` and then never asks a paragraph for it: its page splitter
 * consults `findStyle(elem.styleName).paragraphProps.pageBreakBefore` and
 * nothing else, and its CSS builder discards the direct property instead of
 * translating it to `break-before`. Word honours both forms identically, so a
 * directly-set break printed correctly and was invisible on screen — the review
 * ran the heading on from the previous page while the export started a new one.
 *
 * A paragraph takes exactly one `w:pStyle`, so a heading that is both tagged for
 * a binder's contents and starts a page cannot wear its tag and a shared break
 * style at once. Every base style therefore gets its own variant, and the
 * variants of the contents tags are selected by BINDER_CONTENTS_STYLES too, so
 * starting a page never drops a heading out of the contents.
 */
const PAGE_BREAK_STYLES = Object.freeze(
  Object.fromEntries(
    [
      // A heading level's value is its built-in Word style id, which is what
      // lets `heading()` look a variant up by level or by tag with one lookup.
      { id: HeadingLevel.HEADING_1, name: 'Heading 1' },
      { id: HeadingLevel.HEADING_2, name: 'Heading 2' },
      { id: HeadingLevel.HEADING_3, name: 'Heading 3' },
      ...Object.values(PORTFOLIO_HEADING_STYLES),
    ].map((base) => [
      base.id,
      { id: `${base.id}Break`, name: `${base.name} Break`, basedOn: base.id },
    ]),
  ),
)

/** The `\t` argument: which styles a binder's contents lists, and at what depth. */
const BINDER_CONTENTS_STYLES = [
  ...Object.entries(PORTFOLIO_HEADING_STYLES).flatMap(([level, style]) => [
    new StyleLevel(style.name, Number(level)),
    // The same heading when it starts a page: a different style, same entry.
    new StyleLevel(PAGE_BREAK_STYLES[style.id].name, Number(level)),
  ]),
  new StyleLevel(PROPERTY_ENTRY_STYLE.name, 1),
]

/**
 * Word's own style table. Defining the defaults here rather than on every
 * paragraph is what stops the document from rendering in whatever font the
 * reader's Word happens to default to, and it is what the table of contents
 * and heading navigation key off.
 */
const DOCUMENT_STYLES = {
  default: {
    document: {
      run: { font: BODY_FONT, size: BODY_SIZE, color: INK },
      // line-height 1.42 at Word's 240-twip single line.
      paragraph: { spacing: { line: 341, after: 140 } },
    },
    title: {
      run: { font: BODY_FONT, size: 52, bold: true, color: INK },
      paragraph: { spacing: { before: 0, after: 80 } },
    },
    heading1: {
      run: { font: BODY_FONT, size: 32, bold: true, color: INK },
      paragraph: {
        spacing: { before: 320, after: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: RULE_ACCENT, color: ACCENT, space: BORDER_SPACE_Y } },
        keepNext: true,
        keepLines: true,
      },
    },
    // An accent bar in the margin keeps second-level sections easy to scan.
    heading2: {
      run: { font: BODY_FONT, size: 24, bold: true, color: INK },
      paragraph: {
        spacing: { before: 280, after: 120 },
        border: { left: { style: BorderStyle.SINGLE, size: RULE_ACCENT, color: ACCENT, space: BORDER_SPACE_X } },
        indent: { left: 110 },
        keepNext: true,
        keepLines: true,
      },
    },
    heading3: {
      run: { font: BODY_FONT, size: 21, bold: true, color: ACCENT },
      paragraph: { spacing: { before: 220, after: 90 }, keepNext: true, keepLines: true },
    },
  },
  // The footer's two numbers are the cached results of Word fields. Styling them
  // here rather than on the run is what lets the preview find them: docx-preview
  // turns `w:rStyle` into a class name and drops the field runs themselves.
  characterStyles: [
    {
      id: PAGE_NUMBER_STYLE,
      name: 'Car Page Number',
      run: { font: BODY_FONT, size: 15, bold: true, color: INK },
    },
    {
      id: PAGE_TOTAL_STYLE,
      name: 'Car Page Total',
      run: { font: BODY_FONT, size: 15, bold: true, color: INK },
    },
  ],
  // Contents selectors, not formatting. Each inherits everything from the style
  // it stands in for so a tagged paragraph is indistinguishable from an
  // untagged one; see PORTFOLIO_HEADING_STYLES.
  paragraphStyles: [
    ...Object.entries(PORTFOLIO_HEADING_STYLES).map(([level, style]) => ({
      id: style.id,
      name: style.name,
      basedOn: `Heading${level}`,
      next: 'Normal',
    })),
    { id: PROPERTY_ENTRY_STYLE.id, name: PROPERTY_ENTRY_STYLE.name, basedOn: 'Normal' },
    // Each inherits the style it stands in for and adds only the page break, so
    // a heading that starts a page is otherwise identical; see PAGE_BREAK_STYLES.
    ...Object.values(PAGE_BREAK_STYLES).map((style) => ({
      id: style.id,
      name: style.name,
      basedOn: style.basedOn,
      next: 'Normal',
      paragraph: { pageBreakBefore: true },
    })),
  ],
}

// ---------------------------------------------------------------------------
// Formatting for the authoritative Word artifact.
// ---------------------------------------------------------------------------

function currency(value) {
  const amount = Number(String(value ?? '').replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(amount) || amount === 0) return '-'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function buildingTitle(building) {
  return text(building?.property_name, 'Facility')
}

function buildingAddress(building) {
  return [
    building?.address,
    [building?.city, building?.province_short || building?.province].filter(Boolean).join(', '),
    building?.postal_code,
  ]
    .map((part) => text(part))
    .filter(Boolean)
    .join(', ')
}

/**
 * The values the shared prose is written around. One per building, because the
 * firm and client are per-report and the year comes off that building's plan.
 */
function reportContext(report) {
  const { building, project, firm, capitalPlan, executiveSummary } = report
  const startYear =
    capitalPlan?.startYear
    ?? (() => {
      const date = new Date(`${building?.date_of_assessment ?? ''}T00:00:00`)
      return Number.isNaN(date.getTime()) ? new Date().getFullYear() : date.getFullYear()
    })()
  return {
    firm: text(firm?.name, 'the Consultant'),
    client: text(project?.client, 'the Client'),
    property: buildingTitle(building),
    address: buildingAddress(building) || NOT_PROVIDED,
    visitDate: formatDate(building?.date_of_assessment) || 'the assessment date',
    assessmentType: LABELS.assessmentType,
    assessmentTypePlural: LABELS.assessmentTypePlural,
    startYear,
    endYear: capitalPlan?.endYear ?? startYear + 25,
    immediateConcerns: text(executiveSummary?.immediate_concerns),
  }
}

// ---------------------------------------------------------------------------
// Small docx builders.
// ---------------------------------------------------------------------------

function para(content, options = {}) {
  return new Paragraph({
    children: [
      new TextRun({
        text: String(content ?? ''),
        bold: options.bold,
        italics: options.italics,
        size: options.size,
        color: options.color,
        font: options.font,
        allCaps: options.allCaps,
        characterSpacing: options.characterSpacing,
      }),
    ],
    spacing: options.spacing,
    alignment: options.alignment,
    heading: options.heading,
    style: options.style,
    border: options.border,
    shading: options.shading,
    indent: options.indent,
    keepNext: options.keepNext,
  })
}

const REPORT_HEADING_METADATA = new WeakMap()
const TABLE_OF_CONTENTS_SLOT = Symbol('table-of-contents-slot')
const TOC_LEVEL_BY_HEADING = {
  [HeadingLevel.HEADING_1]: 1,
  [HeadingLevel.HEADING_2]: 2,
  [HeadingLevel.HEADING_3]: 3,
}

/**
 * `pageBreakBefore` starts the heading on a fresh page.
 *
 * This is not the same as emitting `pageBreak()` in front of it. A standalone
 * break is a paragraph of its own, so when the preceding content happens to end
 * flush with the page bottom the break lands on the *next* page and pushes the
 * heading one further, leaving a page holding nothing but that empty paragraph.
 * `w:pageBreakBefore` is a property of the heading itself and cannot do that, so
 * it is what any block whose length is not fixed should be followed by.
 *
 * The property is carried by a style rather than set on the paragraph, which is
 * the only form the on-screen review can see; see PAGE_BREAK_STYLES.
 */
function heading(content, level = HeadingLevel.HEADING_1, { pageBreakBefore = false, styleId } = {}) {
  // Spacing, colour and rules all come from DOCUMENT_STYLES, so a heading here
  // is only ever text plus its level. A `styleId` swaps in a style that inherits
  // that level's appearance and differs only in name, so a binder's contents can
  // select it; see PORTFOLIO_HEADING_STYLES.
  const title = String(content ?? '')
  // One lookup covers both cases: a heading wears its contents tag if it has
  // one, and otherwise its level, whose value is the built-in Word style id.
  const breakStyleId = pageBreakBefore ? PAGE_BREAK_STYLES[styleId ?? level]?.id : undefined
  const appliedStyleId = breakStyleId ?? styleId
  const paragraph = appliedStyleId
    ? new Paragraph({
        text: title,
        style: appliedStyleId,
        // Only when no variant exists to carry it — a heading level with no
        // style of its own must still break in Word, even unseen by the review.
        pageBreakBefore: pageBreakBefore && !breakStyleId,
      })
    : new Paragraph({ text: title, heading: level, pageBreakBefore })
  const tocLevel = TOC_LEVEL_BY_HEADING[level]
  if (tocLevel && title.trim()) {
    REPORT_HEADING_METADATA.set(paragraph, { title, level: tocLevel })
  }
  return paragraph
}

/** Heading appearance without a Heading style, so the TOC never lists itself. */
function tableOfContentsHeading() {
  const style = DOCUMENT_STYLES.default.heading1
  return new Paragraph({
    ...style.paragraph,
    children: [new TextRun({ text: LABELS.tableOfContents, ...style.run })],
  })
}

/**
 * The report's bullet levels.
 *
 * The library's `bullet: { level }` shorthand emits Word's stock hybrid list:
 * ● (U+25CF BLACK CIRCLE) at a half-inch indent. That glyph is a full-size
 * filled circle rather than a bullet, so at 11pt it prints as a heavy dot
 * floating well off the text it belongs to. These levels use the actual bullet
 * characters on a tighter hanging indent, tinted with the accent the headings
 * and rules already use.
 *
 * The glyphs are ordinary Unicode rather than Word's convention of U+F0B7 in
 * Symbol and U+F0A7 in Wingdings: those are private-use code points that only
 * resolve when the reader has those exact fonts, and they render as tofu in the
 * docx-preview pass the review screen depends on.
 */
const BULLET_REFERENCE = 'report-bullets'
const BULLET_LEVELS = [
  { text: '\u2022', left: 432 }, // •
  { text: '\u25E6', left: 864 }, // ◦
  { text: '\u25AA', left: 1296 }, // ▪
].map(({ text, left }, level) => ({
  level,
  format: LevelFormat.BULLET,
  text,
  alignment: AlignmentType.LEFT,
  style: {
    run: { color: ACCENT, font: BODY_FONT },
    paragraph: { indent: { left, hanging: 216 } },
  },
}))

/**
 * The indent and the inter-item gap are repeated as direct paragraph formatting
 * because the library stamps every numbered paragraph with `ListParagraph`, a
 * latent Word built-in this document never defines. Word therefore supplies its
 * own, which carries both a half-inch indent and contextualSpacing — the latter
 * silently discarding the gap between items. Direct formatting outranks both.
 */
function bulletPara(content, { last = false, keepNext = false } = {}) {
  return new Paragraph({
    children: [new TextRun({ text: String(content ?? '') })],
    numbering: { reference: BULLET_REFERENCE, level: 0 },
    indent: { left: BULLET_LEVELS[0].style.paragraph.indent.left, hanging: 216 },
    contextualSpacing: false,
    keepNext,
    keepLines: true,
    // Items sit closer to each other than to their surroundings, so the list
    // reads as one block. Without the wider gap on the last item the prose
    // that resumes underneath looks like another entry that lost its bullet.
    spacing: { after: last ? 180 : 60 },
  })
}

const HEADING_FOR_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
}

/** `.legal-paragraph` — 9pt justified small print, set a shade off black. */
const LEGAL_PARAGRAPH = {
  size: LEGAL_SIZE,
  color: LEGAL_INK,
  alignment: AlignmentType.JUSTIFIED,
  spacing: { after: 110, line: 313 },
}

/** `.legal-block--inline` — the tinted, accent-ruled aside. */
const CALLOUT_PARAGRAPH = {
  size: LEGAL_SIZE,
  color: LEGAL_INK,
  italics: true,
  alignment: AlignmentType.JUSTIFIED,
  spacing: { before: 160, after: 160, line: 313 },
  shading: { type: ShadingType.CLEAR, fill: SURFACE, color: 'auto' },
  border: { left: { style: BorderStyle.SINGLE, size: RULE_ACCENT, color: BORDER_STRONG, space: BORDER_SPACE_X } },
  indent: { left: 140, right: 140 },
}

/** `.fci-formula` — the centred, rule-bounded serif expression. */
const FORMULA_PARAGRAPH = {
  font: 'Georgia',
  size: 22,
  alignment: AlignmentType.CENTER,
  spacing: { before: 180, after: 180 },
  indent: { left: 720, right: 720 },
  border: {
    top: { style: BorderStyle.SINGLE, size: RULE_HAIRLINE, color: BORDER, space: BORDER_SPACE_Y },
    bottom: { style: BorderStyle.SINGLE, size: RULE_HAIRLINE, color: BORDER, space: BORDER_SPACE_Y },
  },
}

/**
 * Render shared report-content blocks as Word paragraphs.
 *
 * `headingStyles` maps an outline level to a paragraph style, which is how the
 * portfolio front matter gets headings a binder's contents can select without
 * catching the identical headings inside all 75 buildings.
 */
function blockChildren(blocks, { headingStyles } = {}) {
  const children = []
  for (const block of blocks ?? []) {
    if (!block) continue
    if (block.type === 'heading') {
      // A legal heading is the stylesheet's small accent lead-in, not a
      // rule-underlined section head.
      if (block.legal) {
        children.push(
          para(block.text, {
            bold: true,
            color: ACCENT,
            size: 22,
            spacing: { before: 200, after: 70 },
            keepNext: true,
          }),
        )
      } else {
        children.push(
          heading(block.text, HEADING_FOR_LEVEL[block.level] ?? HeadingLevel.HEADING_1, {
            pageBreakBefore: Boolean(block.pageBreakBefore),
            styleId: headingStyles?.[block.level ?? 1]?.id,
          }),
        )
      }
    } else if (block.type === 'bullets') {
      const items = block.items ?? []
      items.forEach((item, index) =>
        children.push(bulletPara(item, { last: index === items.length - 1 })),
      )
    } else if (block.type === 'formula') {
      children.push(para(block.text, { bold: true, ...FORMULA_PARAGRAPH }))
    } else if (block.type === 'callout') {
      children.push(para(block.text, CALLOUT_PARAGRAPH))
    } else if (block.type === 'paragraph') {
      children.push(para(block.text, block.legal ? LEGAL_PARAGRAPH : {}))
    }
  }
  return children
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] })
}

// ---------------------------------------------------------------------------
// Tables.
//
// `.report-table` is a hairline grid with an ink header band, tinted label
// cells behind a 3px accent rule, zebra body rows and real cell padding. Word
// has no stylesheet to inherit from, so each of those is set per cell.
// ---------------------------------------------------------------------------

const hairline = { style: BorderStyle.SINGLE, size: RULE_HAIRLINE, color: BORDER }

const TABLE_BORDERS = {
  top: hairline,
  bottom: hairline,
  left: hairline,
  right: hairline,
  insideHorizontal: hairline,
  insideVertical: hairline,
}

const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
}

// `.report-table th, td { padding: 0.05in 0.07in }` in twips. Without this Word
// jams the text against the gridlines.
const CELL_MARGINS = { marginUnitType: WidthType.DXA, top: 72, bottom: 72, left: 101, right: 101 }
// The Component Summary is seven columns wide; the body padding above costs it
// half an inch of text width, which is the difference between "Condition" as a
// heading and "Conditio / n".
const TIGHT_CELL_MARGINS = { marginUnitType: WidthType.DXA, top: 54, bottom: 54, left: 72, right: 72 }

/**
 * Word gives a table no margin of its own, and — worse — silently merges two
 * tables that touch into one. Every grid therefore gets a short spacer after
 * it, standing in for `.report-table { margin-bottom: 0.16in }`.
 */
function tableGap() {
  return new Paragraph({
    children: [new TextRun({ text: '', size: 8 })],
    spacing: { before: 0, after: 100 },
  })
}

/** Split the text column across the grid on the given weights, in twips. */
function columnWidths(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => Math.round((CONTENT_WIDTH * weight) / total))
}

function cell(content, options = {}) {
  const {
    bold = false,
    italics = false,
    align,
    fill,
    color,
    size = TABLE_SIZE,
    borders,
    width,
    children,
    keepNext = false,
    verticalAlign = VerticalAlign.TOP,
  } = options
  return new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    verticalAlign,
    width,
    borders,
    children: children ?? [
      new Paragraph({
        spacing: { after: 0, line: 276 },
        alignment: align,
        keepNext,
        children: [new TextRun({ text: String(content ?? ''), bold, italics, size, color })],
      }),
    ],
  })
}

function styledTable(rows, widths, { borders = TABLE_BORDERS, margins = CELL_MARGINS } = {}) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    // Fixed layout is what makes columnWidths stick; autofit would let Word
    // re-balance them and undo the narrow money columns.
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    margins,
    borders,
    rows,
  })
}

/**
 * A headed data grid. The first column carries names and stays left-aligned and
 * wide; the rest carry numbers and are narrow and right-aligned, which is the
 * split `.label-cell { width: 30% }` makes on screen.
 */
function dataTable(headers, rows, options = {}) {
  const {
    equalColumns = false,
    size = TABLE_SIZE,
    bodyAlign = AlignmentType.RIGHT,
    emphasizeLastRow = false,
    // A grid whose columns are neither one name plus numbers nor all equal —
    // the Component Summary mixes wide text, narrow words and money — states
    // its own proportions and alignments instead.
    weights: explicitWeights = null,
    aligns = null,
    margins = CELL_MARGINS,
  } = options
  const nameWeight = headers.length <= 3 ? 3 : headers.length <= 5 ? 2.5 : 2
  const weights =
    explicitWeights
    ?? (equalColumns
      ? headers.map(() => 1)
      : headers.map((_, index) => (index === 0 ? nameWeight : 1)))
  const alignFor = (index) =>
    aligns ? aligns[index] : equalColumns || index > 0 ? bodyAlign : undefined
  const widths = columnWidths(weights)
  const widthFor = (index) => ({ size: widths[index], type: WidthType.DXA })

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((header, index) =>
      cell(header, {
        bold: true,
        fill: INK,
        color: PAPER,
        align: AlignmentType.CENTER,
        size,
        width: widthFor(index),
      }),
    ),
  })

  const bodyRows = rows.map((row, rowIndex) => {
    const isTotal = emphasizeLastRow && rowIndex === rows.length - 1
    return new TableRow({
      cantSplit: true,
      children: row.map((value, index) =>
        cell(value, {
          bold: isTotal,
          align: alignFor(index),
          fill: isTotal ? ACCENT_SOFT : rowIndex % 2 === 1 ? ZEBRA : undefined,
          size,
          width: widthFor(index),
          borders: isTotal ? { top: { style: BorderStyle.SINGLE, size: RULE_INK, color: INK } } : undefined,
        }),
      ),
    })
  })

  return styledTable([headerRow, ...bodyRows], widths, { margins })
}

/**
 * A label/value grid with a tinted, accented label column.
 *
 * `keepTogether` stops the grid breaking across a page. OOXML has no flag for
 * that; the idiom is keep-with-next on every row but the last, which is what
 * the `keepNext` below does. It is off by default on purpose — a grid that may
 * not split has to move whole, and paying that gap at every split would add
 * about 5% to a long report's page count for no gain, because an ordinary
 * split leaves its tail on a page the next asset goes on to fill. It earns its
 * keep only where nothing follows to do that filling; see assetChildren.
 */
function keyValueTable(pairs, { keepTogether = false } = {}) {
  const widths = columnWidths([30, 70])
  const rows = pairs.map(([key, value], index) => {
    const keepNext = keepTogether && index < pairs.length - 1
    return new TableRow({
      cantSplit: true,
      children: [
        cell(key, {
          bold: true,
          fill: ACCENT_SOFT,
          keepNext,
          width: { size: widths[0], type: WidthType.DXA },
          borders: { left: { style: BorderStyle.SINGLE, size: RULE_ACCENT, color: ACCENT } },
        }),
        cell(text(value, NOT_PROVIDED), {
          fill: index % 2 === 1 ? ZEBRA : undefined,
          keepNext,
          width: { size: widths[1], type: WidthType.DXA },
        }),
      ],
    })
  })
  return styledTable(rows, widths)
}

// ---------------------------------------------------------------------------
// Pure row builders (unit-tested); the preview renders their packed OOXML.
// ---------------------------------------------------------------------------

/**
 * The scorecard's headline number, set large over its caption.
 *
 * Half-points, so 32 is 16pt — the largest type in the document body. The
 * scorecard is read across a table at a budget meeting rather than at desk
 * distance, which is the whole reason it exists as a separate page.
 */
const TILE_NUMBER_SIZE = 32
const TILE_LABEL_SIZE = 15

/**
 * The identity band: who this facility is, and the one-word verdict on it.
 *
 * Two solid fills rather than the usual hairline grid, because this is the
 * masthead of the page and has to read as a banner instead of as the first row
 * of a table.
 */
function scorecardIdentityBand(ctx, scorecard) {
  const widths = columnWidths([62, 38])
  const bandCell = (fill, lines, width) =>
    cell(null, {
      fill,
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      children: lines.map(
        ({ content, bold = false, size = TABLE_SIZE, align }) =>
          new Paragraph({
            spacing: { after: 0, line: 276 },
            alignment: align,
            children: [new TextRun({ text: String(content ?? ''), bold, size, color: PAPER })],
          }),
      ),
    })

  return styledTable(
    [
      new TableRow({
        cantSplit: true,
        children: [
          bandCell(
            INK,
            [
              { content: ctx.property, bold: true, size: BODY_SIZE },
              { content: ctx.address, size: TABLE_SIZE },
            ],
            widths[0],
          ),
          bandCell(
            ACCENT,
            [
              { content: LABELS.overallCondition, size: TILE_LABEL_SIZE, align: AlignmentType.CENTER },
              {
                content: text(scorecard.grade, NOT_PROVIDED).toUpperCase(),
                bold: true,
                size: BODY_SIZE,
                align: AlignmentType.CENTER,
              },
            ],
            widths[1],
          ),
        ],
      }),
    ],
    widths,
    { borders: NO_BORDERS },
  )
}

/** The four headline figures, each set large over its caption. */
function scorecardTiles(scorecard) {
  const fci = scorecard.fci
  const tiles = [
    [SCORECARD_TILES.crv, scorecard.crv == null ? NOT_PROVIDED : currency(scorecard.crv)],
    [
      SCORECARD_TILES.fci,
      fci?.percent == null ? NOT_PROVIDED : `${fci.percent.toFixed(1)}%`,
    ],
    [SCORECARD_TILES.nearTermNeed, currency(scorecard.nearTermNeed)],
    [SCORECARD_TILES.nearTermCount, String(scorecard.nearTermCount)],
  ]
  const widths = columnWidths(tiles.map(() => 1))
  return styledTable(
    [
      new TableRow({
        cantSplit: true,
        children: tiles.map(([label, value], index) =>
          cell(null, {
            fill: ACCENT_SOFT,
            width: { size: widths[index], type: WidthType.DXA },
            children: [
              new Paragraph({
                spacing: { after: 20, line: 276 },
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: value, bold: true, size: TILE_NUMBER_SIZE, color: INK }),
                ],
              }),
              new Paragraph({
                spacing: { after: 0, line: 240 },
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: label, size: TILE_LABEL_SIZE, color: MUTED }),
                ],
              }),
            ],
          }),
        ),
      }),
    ],
    widths,
  )
}

/**
 * The components driving the next five years of spend, dearest first.
 *
 * The allowance column carries only the occurrences scheduled inside that
 * window, so these rows are a share of the need in the tile above rather than a
 * second, larger number for the same thing.
 */
function scorecardPrioritiesTable(scorecard) {
  const rows = scorecard.priorities.map((row) => [
    text(row.element, NOT_PROVIDED),
    text(row.name, NOT_PROVIDED),
    text(row.condition, NOT_PROVIDED),
    text(row.horizon, NOT_PROVIDED),
    currency(row.cost),
  ])
  return dataTable(
    [
      SCORECARD_PRIORITY_COLUMNS.element,
      SCORECARD_PRIORITY_COLUMNS.name,
      SCORECARD_PRIORITY_COLUMNS.condition,
      SCORECARD_PRIORITY_COLUMNS.horizon,
      SCORECARD_PRIORITY_COLUMNS.cost,
    ],
    rows,
    {
      // The code column is narrow by design; the width it gives up goes to the
      // component name, which is the column that wraps and costs page height.
      weights: [1.35, 4.05, 1.4, 1.7, 1.5],
      aligns: [
        undefined,
        undefined,
        AlignmentType.CENTER,
        AlignmentType.CENTER,
        AlignmentType.RIGHT,
      ],
    },
  )
}

/** How the assessed components sit across the condition scale. */
function conditionSnapshotTable(scorecard) {
  const rows = scorecard.conditionBands.map((band) => [
    band.label,
    String(band.count),
    band.percent == null ? NOT_PROVIDED : `${band.percent.toFixed(0)}%`,
  ])
  return dataTable(
    [
      CONDITION_SNAPSHOT_COLUMNS.band,
      CONDITION_SNAPSHOT_COLUMNS.count,
      CONDITION_SNAPSHOT_COLUMNS.share,
    ],
    rows,
    { bodyAlign: AlignmentType.CENTER },
  )
}

/**
 * The Facility Scorecard page.
 *
 * It sits between two forced page breaks, so it opens a page of its own and
 * nothing follows it that could fill a spill — the arrangement that strands a
 * tail under white space (see assetChildren). It is sized to stay well inside
 * one page: a banner, four tiles and two short grids, with the priority grid
 * capped at five rows.
 */
function facilityScorecardChildren(report, ctx) {
  const scorecard = facilityScorecard(report)
  const children = [...blockChildren(facilityScorecardBlocks())]
  children.push(scorecardIdentityBand(ctx, scorecard), tableGap())
  children.push(scorecardTiles(scorecard), tableGap())

  children.push(tableCaption(LABELS.scorecardPriorities))
  if (scorecard.priorities.length === 0) {
    children.push(para(LABELS.scorecardNoPriorities, { italics: true }))
  } else {
    children.push(scorecardPrioritiesTable(scorecard), tableGap())
  }

  children.push(tableCaption(LABELS.conditionSnapshot))
  // No trailing tableGap: a spacer exists to hold the next block off a grid, and
  // a forced page break follows this one. Emitting it anyway costs a paragraph
  // that a full scorecard pushes onto the next page, where the break then leaves
  // it alone — a blank page between the scorecard and the executive summary.
  children.push(conditionSnapshotTable(scorecard))
  return children
}

function capitalNeedsTable(plan) {
  const terms = plan?.terms ?? []
  const groups = capitalLevel1Rows(plan?.groups ?? [])
  const headers = [LABELS.buildingSystem, ...terms.map((term) => termDisplayLabel(term))]
  const rows = groups.map((group) => [
    group.name,
    ...terms.map((term) => currency(group.byTerm[term.id] ?? 0)),
  ])
  rows.push([LABELS.totalPlannedCapitalRenewal, ...terms.map((term) => currency(term.total))])
  return dataTable(headers, rows, { emphasizeLastRow: true })
}

/**
 * The component-level roll-up: one row per included asset, in the order the
 * findings section prints them.
 *
 * The Budget Allowance column is the asset page's own opinion of probable cost,
 * so a row cannot disagree with the page it indexes. That makes its total lower
 * than the capital renewal table's, which counts every scheduled recurrence of
 * a component inside the horizon rather than one occurrence — the prose above
 * the table says so, and the total row is labelled for what it actually adds up.
 *
 * Seven columns on a portrait page, so it is set at the same 8pt the FCI grid
 * uses and declares its own proportions — the default one-wide-name-plus-equal-
 * numbers split would leave the money column too narrow to hold a figure while
 * Condition idled at the same width.
 */
function componentSummaryTable(report) {
  const rows = componentSummaryRows(report?.assets ?? [])
  const headers = [
    COMPONENT_SUMMARY_COLUMNS.name,
    COMPONENT_SUMMARY_COLUMNS.system,
    COMPONENT_SUMMARY_COLUMNS.condition,
    COMPONENT_SUMMARY_COLUMNS.priority,
    COMPONENT_SUMMARY_COLUMNS.action,
    COMPONENT_SUMMARY_COLUMNS.year,
    COMPONENT_SUMMARY_COLUMNS.cost,
  ]
  const body = rows.map((row) => [
    text(row.name, NOT_PROVIDED),
    text(row.system, NOT_PROVIDED),
    text(row.condition, NOT_PROVIDED),
    text(row.priority, NOT_PROVIDED),
    text(row.action, NOT_PROVIDED),
    text(row.year, NOT_PROVIDED),
    currency(row.cost),
  ])
  body.push([
    LABELS.componentSummaryTotal,
    '',
    '',
    '',
    '',
    '',
    currency(componentSummaryTotal(rows)),
  ])
  return dataTable(headers, body, {
    size: MICRO_SIZE,
    emphasizeLastRow: true,
    margins: TIGHT_CELL_MARGINS,
    // Inches of the 6.5in content width, measured against a rendered page: each
    // heading has to sit on its own line unbroken, and "2029 (overdue)" has to
    // fit the Action Year column.
    weights: [1.73, 1, 0.72, 0.65, 0.9, 0.7, 0.8],
    aligns: [
      undefined,
      undefined,
      AlignmentType.CENTER,
      AlignmentType.CENTER,
      AlignmentType.CENTER,
      AlignmentType.CENTER,
      AlignmentType.RIGHT,
    ],
  })
}

function crvTable(plan) {
  const rows = displayCrvRows(plan?.crv).map((row) => [
    text(row.label, NOT_PROVIDED),
    text(row.code, NOT_PROVIDED),
    currency(row.crv),
  ])
  rows.push(['Current Replacement Value (Total)', '', currency(plan?.crv?.value)])
  return dataTable(['Level 2 Description', 'Level 2', 'Replacement Value'], rows, {
    emphasizeLastRow: true,
  })
}

/**
 * The project-delivery allowances that convert component construction values
 * into a replacement-value estimate — Table E-1 in the document.
 */
function crvAllowancesTable(plan) {
  const factors = [
    ...(plan?.crv?.factors ?? []),
    { name: 'Other (Client Internal Factors)', percent: 14 },
  ]
  return dataTable(
    [LABELS.crvAllowanceCategory, LABELS.crvPlanningAllowance],
    factors.map((factor) => [factor.name, `${factor.percent}%`]),
  )
}

function fciTable(plan) {
  const windows = plan?.fci ?? []
  const headers = ['Building', ...windows.map((row, index) => (index === 0 ? 'FCI (current)' : `FCI ${row.label}`))]
  const scoreRow = ['Score', ...windows.map((row) => (row.percent == null ? '—' : `${row.percent.toFixed(1)}%`))]
  const gradeRow = ['Grade', ...windows.map((row) => text(row.grade || row.unavailableReason, NOT_PROVIDED))]
  // `.fci-scoring-table` is the one grid the stylesheet sets smaller and centres.
  return dataTable(headers, [scoreRow, gradeRow], {
    size: MICRO_SIZE,
    bodyAlign: AlignmentType.CENTER,
  })
}

/**
 * Year-by-year capital reserve spend, one table per term. Years run across in
 * chunks so a 25-year horizon stays readable on a portrait page.
 */
function yearCostChildren(plan, { yearsPerRow = 5, headingStyles } = {}) {
  const byYear = new Map((plan?.years ?? []).map((row) => [row.year, row.total]))
  const children = []
  for (const term of plan?.terms ?? []) {
    children.push(
      heading(termDisplayLabel(term), HeadingLevel.HEADING_3, {
        styleId: headingStyles?.[3]?.id,
      }),
    )
    const years = []
    for (let year = term.yearFrom; year <= term.yearTo; year += 1) years.push(year)
    for (let index = 0; index < years.length; index += yearsPerRow) {
      const chunk = years.slice(index, index + yearsPerRow)
      children.push(
        dataTable(
          chunk.map((year) => String(year)),
          [chunk.map((year) => currency(byYear.get(year) ?? 0))],
          { equalColumns: true, bodyAlign: AlignmentType.CENTER },
        ),
        tableGap(),
      )
    }
  }
  return children
}

/**
 * Assets grouped by UNIFORMAT Level 1 major group: groups alphabetically, then
 * Level 2 code, then asset name.
 */
function majorGroups(assets) {
  return orderedAssetGroups(assets ?? [])
}

function includedAssetImages(asset) {
  return (asset?.images ?? []).filter((image) => Number(image.include_in_report) === 1)
}

// ---------------------------------------------------------------------------
// Images.
// ---------------------------------------------------------------------------

function positiveDimension(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function fittedImageDimensions(sourceWidth, sourceHeight, maxWidth, maxHeight) {
  const widthLimit = positiveDimension(maxWidth) ?? sourceWidth
  const heightLimit = positiveDimension(maxHeight) ?? Number.POSITIVE_INFINITY
  const scale = Math.min(1, widthLimit / sourceWidth, heightLimit / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

function boundedRasterDimensions(sourceWidth, sourceHeight) {
  const scale = Math.min(1, REPORT_IMAGE_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

function annotationSvg({ data, type, width, height, annotations }) {
  const mime = type === 'png' ? 'image/png' : 'image/jpeg'
  const dataUrl = `data:${mime};base64,${data.toString('base64')}`
  const shortestEdge = Math.min(width, height)
  const strokeWidth = Math.max(3, shortestEdge * 0.006)
  const arrowHead = Math.max(strokeWidth * 3.5, shortestEdge * 0.025)
  const shapes = []
  const definitions = []

  for (const [index, shape] of annotations.entries()) {
    if (shape.kind === 'arrow') {
      const markerId = `report-arrow-${index}`
      definitions.push(
        `<marker id="${markerId}" markerWidth="${arrowHead}" markerHeight="${arrowHead}" ` +
          `refX="${arrowHead}" refY="${arrowHead / 2}" orient="auto" markerUnits="userSpaceOnUse" ` +
          `viewBox="0 0 ${arrowHead} ${arrowHead}">` +
          `<path d="M 0 0 L ${arrowHead} ${arrowHead / 2} L 0 ${arrowHead} z" fill="${shape.color}"/>` +
          '</marker>',
      )
      shapes.push(
        `<line x1="${shape.x1 * width}" y1="${shape.y1 * height}" ` +
          `x2="${shape.x2 * width}" y2="${shape.y2 * height}" ` +
          `stroke="${shape.color}" stroke-width="${strokeWidth}" stroke-linecap="round" ` +
          `marker-end="url(#${markerId})"/>`,
      )
      continue
    }
    shapes.push(
      `<rect x="${shape.x * width}" y="${shape.y * height}" ` +
        `width="${shape.w * width}" height="${shape.h * height}" fill="none" ` +
        `stroke="${shape.color}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`,
    )
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">` +
      (definitions.length ? `<defs>${definitions.join('')}</defs>` : '') +
      `<image href="${dataUrl}" x="0" y="0" width="${width}" height="${height}" ` +
      'preserveAspectRatio="none"/>' +
      shapes.join('') +
      '</svg>',
    'utf8',
  )
}

function annotationColorBytes(color) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    String(color ?? ''),
  )
  if (!match) return { red: 255, green: 45, blue: 45 }
  return {
    red: Number.parseInt(match[1], 16),
    green: Number.parseInt(match[2], 16),
    blue: Number.parseInt(match[3], 16),
  }
}

let nativeBitmapChannels = null

function bitmapChannels() {
  if (nativeBitmapChannels) return nativeBitmapChannels
  const fallback = { blue: 0, green: 1, red: 2, alpha: 3 }
  try {
    // Electron documents raw bitmap layout as platform-dependent. Decode one
    // known opaque pixel once so annotation colours stay correct everywhere.
    const probe = nativeImage.createFromBuffer(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4WKgKAAPeAYhB7GijAAAAAElFTkSuQmCC',
        'base64',
      ),
    )
    const pixel = probe?.toBitmap?.().subarray(0, 4)
    if (pixel?.length === 4) {
      const detected = {
        blue: pixel.indexOf(37),
        green: pixel.indexOf(113),
        red: pixel.indexOf(241),
        alpha: pixel.indexOf(255),
      }
      if (new Set(Object.values(detected)).size === 4 && Object.values(detected).every((index) => index >= 0)) {
        nativeBitmapChannels = detected
        return nativeBitmapChannels
      }
    }
  } catch {
    // Test adapters and older runtimes may not expose createFromBuffer.
  }
  nativeBitmapChannels = fallback
  return nativeBitmapChannels
}

function annotateBitmap(source, width, height, annotations) {
  const expectedBytes = width * height * 4
  if (!Buffer.isBuffer(source) || source.length < expectedBytes) return null
  const bitmap = Buffer.from(source.subarray(0, expectedBytes))
  const shortestEdge = Math.min(width, height)
  const strokeWidth = Math.max(3, shortestEdge * 0.006)
  const channels = bitmapChannels()

  const paintPixel = (x, y, color) => {
    const column = Math.round(x)
    const row = Math.round(y)
    if (column < 0 || column >= width || row < 0 || row >= height) return
    const offset = (row * width + column) * 4
    bitmap[offset + channels.blue] = color.blue
    bitmap[offset + channels.green] = color.green
    bitmap[offset + channels.red] = color.red
    bitmap[offset + channels.alpha] = 255
  }

  const paintDisc = (x, y, radius, color) => {
    const left = Math.floor(x - radius)
    const right = Math.ceil(x + radius)
    const top = Math.floor(y - radius)
    const bottom = Math.ceil(y + radius)
    const radiusSquared = radius * radius
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const dx = column - x
        const dy = row - y
        if (dx * dx + dy * dy <= radiusSquared) {
          paintPixel(column, row, color)
        }
      }
    }
  }

  const paintLine = (x1, y1, x2, y2, color) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))))
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps
      paintDisc(
        x1 + (x2 - x1) * ratio,
        y1 + (y2 - y1) * ratio,
        strokeWidth / 2,
        color,
      )
    }
  }

  const triangleSign = (point, first, second) =>
    (point.x - second.x) * (first.y - second.y) -
    (first.x - second.x) * (point.y - second.y)

  const fillTriangle = (first, second, third, color) => {
    const left = Math.floor(Math.min(first.x, second.x, third.x))
    const right = Math.ceil(Math.max(first.x, second.x, third.x))
    const top = Math.floor(Math.min(first.y, second.y, third.y))
    const bottom = Math.ceil(Math.max(first.y, second.y, third.y))
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const point = { x: column + 0.5, y: row + 0.5 }
        const d1 = triangleSign(point, first, second)
        const d2 = triangleSign(point, second, third)
        const d3 = triangleSign(point, third, first)
        const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
        const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
        if (!(hasNegative && hasPositive)) paintPixel(column, row, color)
      }
    }
  }

  for (const shape of annotations) {
    const color = annotationColorBytes(shape.color)
    if (shape.kind === 'arrow') {
      const x1 = shape.x1 * width
      const y1 = shape.y1 * height
      const x2 = shape.x2 * width
      const y2 = shape.y2 * height
      paintLine(x1, y1, x2, y2, color)
      const dx = x2 - x1
      const dy = y2 - y1
      const length = Math.hypot(dx, dy)
      if (length > 0) {
        const arrowHead = Math.max(strokeWidth * 3.5, shortestEdge * 0.025)
        const unitX = dx / length
        const unitY = dy / length
        const baseX = x2 - unitX * arrowHead
        const baseY = y2 - unitY * arrowHead
        const halfWidth = arrowHead / 2
        fillTriangle(
          { x: x2, y: y2 },
          { x: baseX - unitY * halfWidth, y: baseY + unitX * halfWidth },
          { x: baseX + unitY * halfWidth, y: baseY - unitX * halfWidth },
          color,
        )
      }
      continue
    }

    const left = shape.x * width
    const top = shape.y * height
    const right = (shape.x + shape.w) * width
    const bottom = (shape.y + shape.h) * height
    paintLine(left, top, right, top, color)
    paintLine(right, top, right, bottom, color)
    paintLine(right, bottom, left, bottom, color)
    paintLine(left, bottom, left, top, color)
  }
  return bitmap
}

function annotatedRasterFallback(decoded, type, width, height, annotations, fallback) {
  if (
    typeof decoded?.toBitmap !== 'function' ||
    typeof nativeImage.createFromBitmap !== 'function'
  ) {
    return fallback
  }
  const bitmap = annotateBitmap(decoded.toBitmap(), width, height, annotations)
  if (!bitmap) return fallback
  const annotated = nativeImage.createFromBitmap(bitmap, {
    width,
    height,
    scaleFactor: 1,
  })
  if (!annotated || annotated.isEmpty()) return fallback
  const data =
    type === 'png'
      ? annotated.toPNG()
      : annotated.toJPEG(REPORT_IMAGE_JPEG_QUALITY)
  return Buffer.isBuffer(data) && data.length > 0 ? data : fallback
}

/**
 * Prepare one report image behind a single interface. The implementation owns
 * format decoding, source-pixel bounds, aspect-ratio fitting, photo encoding,
 * and the annotated-SVG/fallback pair. Callers only choose display bounds and
 * whether transparency matters (logos); source extensions never reach docx.
 *
 * @param {string|object} source file path or report image record
 * @param {{maxWidth?:number,maxHeight?:number,preserveTransparency?:boolean}} [options]
 * @returns {ImageRun|null}
 */
function prepareReportImage(
  source,
  {
    maxWidth = 400,
    maxHeight = Number.POSITIVE_INFINITY,
    preserveTransparency = false,
  } = {},
) {
  try {
    const filePath = typeof source === 'string' ? source : source?.file_path
    if (!filePath || !fs.existsSync(filePath)) return null

    let decoded = nativeImage.createFromPath(filePath)
    if (!decoded || decoded.isEmpty()) return null
    const sourceSize = decoded.getSize()
    const sourceWidth = positiveDimension(sourceSize?.width)
    const sourceHeight = positiveDimension(sourceSize?.height)
    if (!sourceWidth || !sourceHeight) return null

    const rasterSize = boundedRasterDimensions(sourceWidth, sourceHeight)
    if (rasterSize.width !== sourceWidth || rasterSize.height !== sourceHeight) {
      decoded = decoded.resize({ ...rasterSize, quality: 'best' })
      if (!decoded || decoded.isEmpty()) return null
    }

    const type = preserveTransparency ? 'png' : 'jpg'
    const data = preserveTransparency
      ? decoded.toPNG()
      : decoded.toJPEG(REPORT_IMAGE_JPEG_QUALITY)
    if (!Buffer.isBuffer(data) || data.length === 0) return null

    const transformation = fittedImageDimensions(
      sourceWidth,
      sourceHeight,
      maxWidth,
      maxHeight,
    )
    const annotations = sanitizeAnnotations(
      typeof source === 'string' ? [] : source?.bounding_boxes,
    )
    if (annotations.length === 0) {
      return new ImageRun({ type, data, transformation })
    }

    const svg = annotationSvg({
      data,
      type,
      width: rasterSize.width,
      height: rasterSize.height,
      annotations,
    })
    const fallback = annotatedRasterFallback(
      decoded,
      type,
      rasterSize.width,
      rasterSize.height,
      annotations,
      data,
    )
    return new ImageRun({
      type: 'svg',
      data: svg,
      // docx-preview and older Office engines select AlternateContent's raster
      // fallback. Burn the same annotations into it so those views do not lose
      // assessor markup while modern Word keeps the vector SVG primary.
      fallback: { type, data: fallback },
      transformation,
    })
  } catch {
    // A bad image should omit that figure, never abort the whole deliverable.
    return null
  }
}

function imageParagraph(image) {
  const run = prepareReportImage(image)
  if (!run) return null
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 140, after: 60 },
    children: [run],
  })
}

/** The photo the cover leads with: a building photo, else the first asset photo. */
function firstReportImage(report) {
  const buildingImage = (report?.buildingImages ?? []).find((image) => image?.file_path)
  if (buildingImage) return buildingImage
  for (const asset of report?.assets ?? []) {
    const image = includedAssetImages(asset).find((candidate) => candidate?.file_path)
    if (image) return image
  }
  return null
}

/**
 * A photo with its numbered caption. `figureLabel` is the "Figure 3-4" style
 * label the Lists of Figures refers to, so the caption and the list agree.
 */
function figureChildren(image, figureLabel, altFallback) {
  const figure = imageParagraph(image)
  if (!figure) return []
  const caption = text(image?.caption || image?.original_name, altFallback)
  return [
    figure,
    para(`${figureLabel}: ${caption}`, {
      italics: true,
      size: LEGAL_SIZE,
      color: MUTED,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
  ]
}

// ---------------------------------------------------------------------------
// Section builders.
// ---------------------------------------------------------------------------

/**
 * The dark band across the top of the cover. The stylesheet paints a
 * ink-to-accent gradient; Word has no gradient fill for a table cell, so the
 * band is solid ink with the same uppercase kicker and status chip on it.
 */
function coverBand(kicker) {
  const widths = columnWidths([1])
  return styledTable(
    [
      new TableRow({
        cantSplit: true,
        children: [
          cell(kicker, {
            bold: true,
            fill: INK,
            color: PAPER,
            size: 17,
            width: { size: widths[0], type: WidthType.DXA },
          }),
        ],
      }),
    ],
    widths,
    {
      borders: NO_BORDERS,
      margins: { marginUnitType: WidthType.DXA, top: 200, bottom: 200, left: 180, right: 180 },
    },
  )
}

/** One `.cover-meta` box: tinted, behind a 3px accent rule, with a small caps head. */
function metaBox(title, lines, width) {
  return cell('', {
    fill: SURFACE,
    width,
    borders: {
      top: hairline,
      bottom: hairline,
      right: hairline,
      left: { style: BorderStyle.SINGLE, size: RULE_ACCENT, color: ACCENT },
    },
    children: [
      para(title, {
        bold: true,
        allCaps: true,
        color: ACCENT,
        size: 17,
        characterSpacing: 20,
        spacing: { after: 90 },
      }),
      ...lines.map((line, index) =>
        para(line.text ?? line, {
          bold: line.bold,
          style: line.style,
          size: 20,
          spacing: { after: index === lines.length - 1 ? 0 : 50, line: 276 },
        }),
      ),
    ],
  })
}

/**
 * `.cover-logo-row` — the client's name beside the firm's logo (its short name
 * when no logo is on file), each in a bordered white box.
 */
function coverLogoRow(project, firm) {
  const widths = columnWidths([1, 1])
  const boxBorders = { top: hairline, bottom: hairline, left: hairline, right: hairline }
  const logo = prepareReportImage(firm?.logo_path, {
    maxWidth: 260,
    maxHeight: 60,
    preserveTransparency: true,
  })
  const firmMark = logo
    ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [logo] })]
    : [
        para(text(firm?.short_name, text(firm?.name, 'Consultant')), {
          bold: true,
          size: 26,
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
        }),
      ]
  return styledTable(
    [
      new TableRow({
        cantSplit: true,
        children: [
          cell('', {
            fill: PAPER,
            borders: boxBorders,
            width: { size: widths[0], type: WidthType.DXA },
            children: [
              para(text(project?.client, 'Client'), {
                bold: true,
                size: 26,
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
              }),
            ],
          }),
          cell('', {
            fill: PAPER,
            borders: boxBorders,
            width: { size: widths[1], type: WidthType.DXA },
            children: firmMark,
          }),
        ],
      }),
    ],
    widths,
    {
      borders: NO_BORDERS,
      margins: { marginUnitType: WidthType.DXA, top: 170, bottom: 170, left: 160, right: 160 },
    },
  )
}

/**
 * `.cover-hero` — the facility photograph across the foot of the cover, or the
 * stylesheet's placeholder when the building has no photo on file.
 */
function coverHero(report) {
  const image = firstReportImage(report)
  // 6.5in of text column at 96dpi. The height cap is what the rest of the cover
  // leaves once the band, title, meta grid and logo row have taken their share.
  // The review screen's cover hero is the bare photograph; annotations belong
  // to the numbered body figure where their caption and full context appear.
  const run = prepareReportImage(image?.file_path, {
    maxWidth: 624,
    maxHeight: HERO_MAX_HEIGHT_PX,
  })
  const contents = run
    ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run] })]
    : [
        para(LABELS.facilityPhotograph, {
          allCaps: true,
          color: MUTED,
          size: 20,
          characterSpacing: 24,
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 0 },
        }),
      ]
  const widths = columnWidths([1])
  return styledTable(
    [
      new TableRow({
        cantSplit: true,
        // The band keeps its height whether or not a photo fills it, so a
        // facility with no photo on file still gets a cover that reaches the
        // footer rather than trailing off into white space.
        height: { value: HERO_BAND_TWIPS, rule: HeightRule.ATLEAST },
        children: [
          cell('', {
            fill: run ? PAPER : SURFACE,
            verticalAlign: VerticalAlign.CENTER,
            width: { size: widths[0], type: WidthType.DXA },
            children: contents,
          }),
        ],
      }),
    ],
    widths,
    { margins: { marginUnitType: WidthType.DXA, top: 120, bottom: 120, left: 120, right: 120 } },
  )
}

function coverChildren({ project, firm, reports }) {
  const preparedFor = [{ text: text(project?.client, 'Client'), bold: true }]
  if (reports.length > 1) {
    preparedFor.push({
      text: `${reports.length} facilities — consolidated project report`,
    })
  } else {
    const report = reports[0]
    const id = displayBuildingId(report?.building)
    // The one place a building's own cover names it. Styling it is what puts
    // the property in a binder's contents without printing a heading nobody
    // asked for; see PORTFOLIO_HEADING_STYLES.
    preparedFor.push({ text: buildingTitle(report?.building), style: PROPERTY_ENTRY_STYLE.id })
    if (id) preparedFor.push({ text: `${LABELS.propertyId}: ${id}` })
    preparedFor.push({ text: buildingAddress(report?.building) || NOT_PROVIDED })
  }

  const preparedBy = [{ text: text(firm?.name, 'Consultant'), bold: true }]
  if (text(firm?.address_line_1)) preparedBy.push({ text: firm.address_line_1 })
  if (text(firm?.address_line_2)) preparedBy.push({ text: firm.address_line_2 })

  const boxWidths = columnWidths([1, 1])
  const metaGrid = styledTable(
    [
      new TableRow({
        cantSplit: true,
        children: [
          metaBox(LABELS.preparedFor, preparedFor, { size: boxWidths[0], type: WidthType.DXA }),
          metaBox(LABELS.preparedBy, preparedBy, { size: boxWidths[1], type: WidthType.DXA }),
        ],
      }),
    ],
    boxWidths,
    {
      borders: NO_BORDERS,
      margins: { marginUnitType: WidthType.DXA, top: 150, bottom: 150, left: 190, right: 190 },
    },
  )

  const assessmentDates = [
    ...new Set(
      reports
        .map((report) => text(report?.building?.date_of_assessment))
        .filter(Boolean),
    ),
  ].sort()
  const assessmentDate =
    assessmentDates.length === 0
      ? NOT_PROVIDED
      : assessmentDates.length === 1
        ? formatDate(assessmentDates[0])
        : `${formatDate(assessmentDates[0])} – ${formatDate(assessmentDates.at(-1))}`

  return [
    coverBand(LABELS.assessmentType),
    para('', { spacing: { after: 200 } }),

    new Paragraph({
      text: text(firm?.name, LABELS.assessmentType),
      heading: HeadingLevel.TITLE,
    }),
    para(LABELS.assessmentType, {
      bold: true,
      color: ACCENT,
      size: 28,
      spacing: { after: 240 },
    }),
    metaGrid,
    tableGap(),
    coverLogoRow(project, firm),
    ...(reports.length === 1 ? [tableGap(), coverHero(reports[0])] : []),
    para('', { spacing: { after: 120 } }),
    // `.cover-footer` — the document-control line under a 2px ink rule.
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: RULE_INK, color: INK, space: BORDER_SPACE_Y } },
      spacing: { before: 160, after: 60 },
      children: [
        new TextRun({ text: `Assessment date: ${assessmentDate}`, bold: true, size: 20 }),
      ],
    }),
    para(LABELS.confidentiality, { italics: true, color: MUTED, size: LEGAL_SIZE }),
  ]
}

/**
 * A live Word TOC field with a title-only cached result.
 *
 * Browser viewers can display the cache; Word replaces it on open because the
 * field remains dirty and updateFields is set. Cached page numbers are omitted
 * because only Word knows its final pagination.
 *
 * One report indexes its own Heading 1-3. A binder cannot: those headings are
 * the same three dozen titles repeated once per property, which is 2,485
 * entries and 54 pages at 75 properties and identifies nothing. It selects
 * named styles instead, so its contents is the portfolio's sections and then
 * one line per property. `stylesWithLevels` and the cached entries have to
 * agree, or Word's refresh would replace the cache with a different list.
 */
function tableOfContents(outlineEntries, { stylesWithLevels } = {}) {
  return new TableOfContents(LABELS.tableOfContents, {
    hyperlink: true,
    ...(stylesWithLevels ? { stylesWithLevels } : { headingStyleRange: '1-3' }),
    contentChildren: outlineEntries.map(({ title, level }, index) =>
      new Paragraph({
        spacing: {
          // A top-level entry that closes off an indented run needs the gap to
          // read as a new group — without it a binder's 75 property lines run
          // straight on from the portfolio's subsections as one bold block.
          before: level === 1 && (outlineEntries[index - 1]?.level ?? 1) > 1 ? 140 : 0,
          after: level === 1 ? 70 : 35,
          line: 240,
        },
        indent: { left: (level - 1) * 240 },
        keepLines: true,
        children: [
          new TextRun({
            text: title,
            bold: level === 1,
            color: level === 3 ? MUTED : INK,
            size: level === 3 ? MICRO_SIZE : TABLE_SIZE,
          }),
        ],
      }),
    ),
  })
}

/**
 * Read the outline from the actual heading Paragraphs in document order. This
 * avoids a second hand-maintained report outline that could drift from the
 * document.
 */
function outlineEntries(children) {
  const entries = []
  for (const child of children ?? []) {
    if (!child || typeof child !== 'object') continue
    const entry = REPORT_HEADING_METADATA.get(child)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Replace the deferred TOC slot with the contents the caller worked out. */
function materializeTableOfContents(sections, contents) {
  return sections.map((section) => ({
    ...section,
    children: (section.children ?? []).map((child) =>
      child === TABLE_OF_CONTENTS_SLOT ? contents() : child,
    ),
  }))
}

/**
 * Front matter: the legal notices, then (for a single-building report) the
 * table of contents, and the lists of figures and tables.
 */
function frontMatterChildren(ctx, { figures, tables, includeToc }) {
  const children = [...blockChildren(disclaimerBlocks(ctx)), pageBreak()]

  // A Word TOC field indexes the whole document, so a multi-building binder
  // gets one table of contents up front rather than an identical copy in every
  // building's front matter. See buildDocument.
  if (includeToc) {
    children.push(tableOfContentsHeading())
    children.push(TABLE_OF_CONTENTS_SLOT)
  }

  // The index is a short fixed block, and the executive summary after it starts
  // on a forced page break. A break *inside* the index therefore strands its
  // tail — as little as a single bullet — on a page nothing else can fill. Every
  // entry but the final one keeps with the next, so the block moves whole; the
  // three heading levels already carry keepNext from DOCUMENT_STYLES.
  children.push(heading(LABELS.figuresAndTables))
  children.push(heading(LABELS.figures, HeadingLevel.HEADING_2))
  if (figures.length === 0) {
    children.push(para(LABELS.noFigures, { italics: true, keepNext: true }))
  } else {
    figures.forEach((entry, index) =>
      children.push(bulletPara(entry, { last: index === figures.length - 1, keepNext: true })),
    )
  }
  children.push(heading(LABELS.tables, HeadingLevel.HEADING_2))
  tables.forEach((entry, index) =>
    children.push(
      bulletPara(entry, {
        last: index === tables.length - 1,
        keepNext: index < tables.length - 1,
      }),
    ),
  )
  return children
}

/** Executive Summary: the ASTM framing, the nine narratives, and the summary tables. */
function executiveSummaryChildren(report, ctx, { startOnNewPage = false } = {}) {
  const { capitalPlan, executiveSummary } = report
  const children = [
    ...blockChildren(executiveSummaryIntroBlocks(ctx, { pageBreakBefore: startOnNewPage })),
  ]

  for (const [title, key] of SUMMARY_SECTIONS) {
    const value = text(executiveSummary?.[key])
    if (!value) continue
    children.push(heading(title, HeadingLevel.HEADING_2), para(value))
  }

  children.push(heading(LABELS.capitalRenewalSummary, HeadingLevel.HEADING_2))
  const capitalNeeds = text(executiveSummary?.capital_needs)
  if (capitalNeeds) children.push(para(capitalNeeds))
  children.push(...blockChildren(capitalNeedsCommentaryBlocks()))
  children.push(capitalNeedsTable(capitalPlan), tableGap())
  children.push(...blockChildren(capitalNeedsDefinitionBlocks()))
  children.push(...blockChildren(visualObservationBlocks(ctx)))

  children.push(...blockChildren(componentSummaryBlocks()))
  children.push(componentSummaryTable(report), tableGap())

  children.push(
    heading(reserveScheduleHeading(ctx), HeadingLevel.HEADING_2),
    ...blockChildren(reserveScheduleIntroBlocks()),
    ...yearCostChildren(capitalPlan),
  )

  children.push(
    heading(crvHeading(ctx), HeadingLevel.HEADING_2),
    ...blockChildren(crvIntroBlocks(ctx)),
    tableCaption(CRV_ALLOWANCES_CAPTION),
    crvAllowancesTable(capitalPlan),
    tableGap(),
    ...blockChildren(crvClosingBlocks()),
    tableCaption(CRV_LEVEL2_CAPTION),
    crvTable(capitalPlan),
    tableGap(),
  )
  children.push(
    ...blockChildren(fciBlocks()),
    heading(LABELS.fciClassification, HeadingLevel.HEADING_3),
    fciTable(capitalPlan),
    tableGap(),
  )
  return children
}

/** `.report-table caption` — bold, left, and kept with the grid beneath it. */
function tableCaption(label) {
  return para(label, { bold: true, spacing: { before: 200, after: 60 }, keepNext: true })
}

/** Table captions, matching the entries the lists of tables point at. */
const CRV_ALLOWANCES_CAPTION = `Table E-1 — ${LABELS.crvImplementationTable}`
const CRV_LEVEL2_CAPTION = 'Table E-2 — Level 2 Current Replacement Value'

/** Headings that carry the capital plan's own year ranges. */
const crvHeading = (ctx) => `Estimated Current Replacement Value (CRV) – ${ctx.startYear}`
const reserveScheduleHeading = (ctx) =>
  `Capital Expenditure Schedule – ${ctx.startYear} to ${ctx.endYear}`

function createFigureRegistry() {
  return { entries: [], counts: { 2: 0, 3: 0 } }
}

function pendingFigureLabel(registry, chapter) {
  return `Figure ${chapter}-${registry.counts[chapter] + 1}`
}

function recordFigure(registry, chapter, label, caption) {
  registry.counts[chapter] += 1
  registry.entries.push(`${label}: ${caption}`)
}

/** Facility Description, including the property photos and their figure labels. */
function facilityDescriptionChildren(report, ctx, figures) {
  const { building, project, executiveSummary, buildingImages = [] } = report
  const children = [heading(LABELS.facilityProfile), heading(LABELS.facilityOverview, HeadingLevel.HEADING_2)]

  const overview = text(executiveSummary?.facility_overview)
  const address = buildingAddress(building)
  const fallback = [
    address
      ? `${ctx.property} is located at ${address}.`
      : `${ctx.property} has no site address recorded in the assessment data.`,
    `${ctx.property} is included in the ${ctx.client} ${LABELS.assessmentType} program. The facility information shown below reflects the project database and information available at the time of reporting. Where a field was not provided or could not be confirmed, it is identified accordingly rather than assumed.`,
    building?.gross_floor_area_m2 ? `The property has a gross floor area of ${building.gross_floor_area_m2} m2.` : '',
    building?.num_floors ? `The facility consists of ${building.num_floors} storeys.` : '',
    'Residential/unit count information was not available in the assessment data.',
  ]
    .filter(Boolean)
    .join(' ')
  children.push(para(overview || fallback))

  children.push(
    keyValueTable([
      [FACILITY_FIELDS.client, project?.client],
      [FACILITY_FIELDS.property, ctx.property],
      [FACILITY_FIELDS.propertyId, displayBuildingId(building)],
      [FACILITY_FIELDS.address, buildingAddress(building)],
      [FACILITY_FIELDS.grossFloorArea, building?.gross_floor_area_m2 ? `${building.gross_floor_area_m2} m2` : null],
      [FACILITY_FIELDS.storeys, building?.num_floors],
      [FACILITY_FIELDS.yearBuilt, building?.property_vintage],
      [FACILITY_FIELDS.assessmentDate, formatDate(building?.date_of_assessment)],
    ]),
    tableGap(),
    ...blockChildren(dataQualityBlocks()),
  )

  const photos = buildingImages.slice(0, 4)
  if (photos.length) {
    children.push(heading(LABELS.propertyPhotos, HeadingLevel.HEADING_2))
    photos.forEach((image) => {
      const label = pendingFigureLabel(figures, 2)
      const rendered = figureChildren(image, label, 'Property Photo')
      if (rendered.length === 0) return
      children.push(...rendered)
      recordFigure(
        figures,
        2,
        label,
        text(image.caption || image.original_name, 'Property Photo'),
      )
    })
  }
  return children
}

/** The bold lead-in over an asset's free text, coloured like a label cell. */
function fieldLabel(label) {
  return para(label, { bold: true, color: INK, spacing: { before: 140, after: 40 }, keepNext: true })
}

/**
 * `last` marks the final asset of the findings, the one a forced page break
 * follows. Its detail grid is the only one whose overflow cannot be absorbed:
 * every other grid that splits leaves its tail on a page the next asset fills,
 * whereas a tail stranded here sits alone under a page of white. So that one
 * grid is kept whole and the others are left free to break.
 */
function assetChildren(asset, figures, { last = false } = {}) {
  const children = [heading(text(asset.asset_name, `Asset #${asset.id}`), HeadingLevel.HEADING_3)]
  if (asset.assessed === false) {
    children.push(
      keyValueTable(
        [
          [ASSET_FIELDS.level1, asset.level_1_group],
          [ASSET_FIELDS.level2, asset.level_2_group_element],
        ],
        { keepTogether: last },
      ),
      tableGap(),
      para('Not Assessed', { bold: true, color: ACCENT, spacing: { before: 160, after: 60 } }),
      para(NOT_ASSESSED_NOTE, CALLOUT_PARAGRAPH),
    )
    return children
  }

  const capital = asset.capital ?? {}
  if (text(asset.description)) {
    children.push(fieldLabel(ASSET_FIELDS.description), para(asset.description))
  }
  if (text(asset.recommendation)) {
    children.push(fieldLabel(ASSET_FIELDS.recommendation), para(asset.recommendation))
  }

  for (const image of includedAssetImages(asset)) {
    const label = pendingFigureLabel(figures, 3)
    const fallback = asset.asset_name || 'Asset Photo'
    const rendered = figureChildren(image, label, fallback)
    if (rendered.length === 0) continue
    children.push(...rendered)
    recordFigure(figures, 3, label, text(image.caption || image.original_name, fallback))
  }

  children.push(
    keyValueTable(
      [
        [ASSET_FIELDS.level1, asset.level_1_group],
        [ASSET_FIELDS.level2, asset.level_2_group_element],
        [ASSET_FIELDS.conditionRating, asset.condition_rating],
        [ASSET_FIELDS.conditionGrade, capital.conditionGrade],
        [ASSET_FIELDS.priority, asset.priority],
        [ASSET_FIELDS.action, asset.action],
        [ASSET_FIELDS.term, capital.effectiveTerm],
        [ASSET_FIELDS.conservationLens, asset.conservation_lens],
        [ASSET_FIELDS.unitMeasure, displayUnitMeasure(asset)],
        [ASSET_FIELDS.quantity, capital.quantity ?? asset.quantity],
        [ASSET_FIELDS.adjustedUnitCost, capital.adjustedUnitCost == null ? NOT_PROVIDED : currency(capital.adjustedUnitCost)],
        [ASSET_FIELDS.vintage, displayVintage(asset)],
        [ASSET_FIELDS.serviceLife, asset.service_life],
        [ASSET_FIELDS.actionYear, displayActionYear(capital, asset)],
        [ASSET_FIELDS.opinionOfProbableCost, capital.opinionOfProbableCost == null ? NOT_PROVIDED : currency(capital.opinionOfProbableCost)],
      ],
      { keepTogether: last },
    ),
    tableGap(),
  )
  return children
}

function conditionAssessmentChildren(report, figures) {
  const children = [...blockChildren(conditionAssessmentIntroBlocks())]
  const assets = report.assets ?? []
  if (assets.length === 0) {
    children.push(para('No assessed assets for this facility.', { italics: true }))
    return children
  }
  // Render order, not input order: majorGroups regroups the assets, so the last
  // one printed is the tail of the last group. It is the asset the forced page
  // break to the conclusions follows — see assetChildren.
  const groups = [...majorGroups(assets)]
  const lastAsset = groups.at(-1)?.[1]?.at(-1)
  for (const [groupName, groupAssets] of groups) {
    children.push(heading(groupName, HeadingLevel.HEADING_2))
    for (const asset of groupAssets) {
      children.push(...assetChildren(asset, figures, { last: asset === lastAsset }))
    }
  }
  return children
}

function conclusionsChildren(report, ctx) {
  return [
    ...blockChildren(conclusionsIntroBlocks(ctx)),
    capitalNeedsTable(report.capitalPlan),
    tableGap(),
    ...blockChildren(conclusionsClosingBlocks()),
    ...blockChildren(visualObservationBlocks(ctx)),
  ]
}

function projectSummaryChildren(reports) {
  const plan = aggregateProjectPlan(reports.map((report) => report.capitalPlan))
  const perBuilding = dataTable(
    ['Facility', 'Current Replacement Value', 'Immediate Need', 'FCI (0–2 yr)'],
    reports.map((report) => {
      const bp = report.capitalPlan ?? {}
      const immediate = (bp.terms ?? []).find((term) => term.id === 'immediate')?.total ?? 0
      const fci = (bp.fci ?? []).find((window) => window.id === 'years_0_2')
      return [
        buildingTitle(report.building),
        currency(bp.crv?.value),
        currency(immediate),
        fci?.percent == null ? NOT_PROVIDED : `${fci.percent.toFixed(1)}% (${fci.grade ?? NOT_PROVIDED})`,
      ]
    }),
  )
  const projectName = `${text(reports[0]?.project?.client, 'the client')} ${LABELS.assessmentType} program`
  // These are the only headings a binder's contents lists besides the property
  // names, so they are the ones that carry the selector styles.
  const styles = { headingStyles: PORTFOLIO_HEADING_STYLES }
  return [
    ...blockChildren(portfolioOverviewBlocks({ projectName }), styles),
    perBuilding,
    tableGap(),
    ...blockChildren(portfolioCapitalBlocks(), styles),
    capitalNeedsTable(plan),
    tableGap(),
    ...blockChildren(portfolioForecastBlocks(), styles),
    ...yearCostChildren(plan, styles),
    heading(LABELS.portfolioCrvFci, HeadingLevel.HEADING_2, {
      styleId: PORTFOLIO_HEADING_STYLES[2].id,
    }),
    crvTable(plan),
    tableGap(),
    fciTable(plan),
    tableGap(),
  ]
}

// ---------------------------------------------------------------------------
// Document assembly.
// ---------------------------------------------------------------------------

/**
 * `.page-header` — the firm in accent on the left, the property in muted grey
 * on the right, under a 2px ink rule.
 */
function runningHeader(brand, property) {
  return {
    default: new Header({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
          border: { bottom: { style: BorderStyle.SINGLE, size: RULE_INK, color: INK, space: BORDER_SPACE_Y } },
          spacing: { after: 200 },
          children: [
            new TextRun({ text: brand, bold: true, color: ACCENT, size: CHROME_SIZE }),
            new TextRun({ children: [new Tab(), property ?? ''], color: MUTED, size: CHROME_SIZE }),
          ],
        }),
      ],
    }),
  }
}

// ---------------------------------------------------------------------------
// Footer page numbers.
//
// `docx` writes `PageNumber.CURRENT` as an empty field — begin, instruction,
// separate, end, with nothing cached between the last two — so a reader that
// does not evaluate the field is left with nothing to draw. Writing a cached
// result costs nothing in Word, which recomputes page fields as it paginates
// (and this document already asks it to update fields on open), and gives every
// other reader something: LibreOffice falls back to it, and the on-screen
// preview replaces it with the page it counted.
//
// The total is a `PAGEREF` to a bookmark on the last page of the numbering
// section rather than `SECTIONPAGES`. Numbering restarts at every section, so
// that last page's number *is* the section's page count — and unlike
// `SECTIONPAGES`, which LibreOffice cannot evaluate and leaves blank, printing a
// dangling "of " under every page, `PAGEREF` is understood everywhere.
// ---------------------------------------------------------------------------

/** Run properties for the field itself; the result carries a character style. */
const FIELD_RUN_PROPS =
  `<w:rPr><w:b/><w:bCs/><w:color w:val="${INK}"/><w:sz w:val="15"/><w:szCs w:val="15"/></w:rPr>`

/** Drawn only by a reader that evaluates no fields at all. */
const PAGE_FIELD_PLACEHOLDER = '\u2014'

/**
 * A numbering band: one Word section's worth of consecutive numbered pages.
 * The names lead with an underscore so Word hides them from the bookmark list,
 * the way it hides its own `_Toc` bookmarks.
 */
const sectionEndBookmark = (band) => `_CarSectionEnd_${band.key}`
const pageBandBookmark = (band) => `_CarPageBand_${band.key}_${band.format}`

/**
 * A named bookmark with an id of our own.
 *
 * `docx`'s own `Bookmark` builds a fresh id generator per instance, so every
 * bookmark it writes claims `w:id="1"` and two in one part silently collide —
 * which is exactly what two section-end bookmarks in `document.xml` would do.
 * Numbering from the band keeps them unique and the bytes stable between builds
 * of the same data, and starting well above 1 keeps a stock `Bookmark` added
 * later from landing on one of these.
 */
const BOOKMARK_ID_BASE = 100

function bookmark(name, id) {
  return [new BookmarkStart(name, id), new BookmarkEnd(id)]
}

/**
 * The numeral switch for a band's total.
 *
 * `PAGEREF` takes its numerals from the page it points at, and readers disagree
 * about what that means for a roman-numbered section — Word follows the
 * section, LibreOffice falls back to arabic. Pinning the switch makes the total
 * match the page number printed beside it whoever draws it.
 */
const bandNumeralSwitch = (band) => (band.format === 'lowerRoman' ? '\\* roman' : '\\* arabic')

/**
 * One element built from an OOXML fragment.
 *
 * `fromXmlString` parses into a nameless root component wrapping whatever the
 * fragment held, and serializing that wrapper emits a bogus `<undefined>`
 * element around the run. Only its child is wanted.
 */
function importedElement(xml) {
  const [element] = ImportedXmlComponent.fromXmlString(xml).root
  if (!element) throw new Error(`Could not import OOXML fragment: ${xml}`)
  return element
}

/** A complex field whose cached result the preview can find and overwrite. */
function cachedField(instruction, styleId) {
  return [
    importedElement(`<w:r>${FIELD_RUN_PROPS}<w:fldChar w:fldCharType="begin"/></w:r>`),
    importedElement(
      `<w:r>${FIELD_RUN_PROPS}` +
        `<w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>`,
    ),
    importedElement(`<w:r>${FIELD_RUN_PROPS}<w:fldChar w:fldCharType="separate"/></w:r>`),
    importedElement(
      `<w:r><w:rPr><w:rStyle w:val="${styleId}"/></w:rPr>` +
        `<w:t xml:space="preserve">${PAGE_FIELD_PLACEHOLDER}</w:t></w:r>`,
    ),
    importedElement(`<w:r>${FIELD_RUN_PROPS}<w:fldChar w:fldCharType="end"/></w:r>`),
  ]
}

/**
 * The hairline paragraph that closes a numbered section, carrying the bookmark
 * its footer counts to. An exact 1/20pt line keeps it from taking a line of its
 * own — let alone a page, which would make the total it defines wrong.
 */
function sectionEndAnchor(band) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 1, lineRule: LineRuleType.EXACT },
    children: bookmark(sectionEndBookmark(band), BOOKMARK_ID_BASE + band.ordinal * 2),
  })
}

/**
 * Blank running chrome for a cover page.
 *
 * A section that declares no header or footer inherits the one before it, so
 * every building cover in a binder was picking up the previous building's — a
 * running header naming the wrong property and, once the page fields resolved,
 * a footer reading "Page 10 of 9" against numbering it is not part of. Declaring
 * them empty is what actually leaves a cover bare.
 */
const blankHeader = () => ({ default: new Header({ children: [] }) })
const blankFooter = () => ({ default: new Footer({ children: [] }) })

/** `.page-footer` — the date on the left, a bold page count on the right. */
function pageFooter(assessmentDate, band) {
  return {
    default: new Footer({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
          border: { top: { style: BorderStyle.SINGLE, size: 8, color: BORDER_STRONG, space: BORDER_SPACE_Y } },
          spacing: { before: 200, after: 0 },
          children: [
            // Names the band these pages belong to and how it counts. Renders as
            // an empty marker the preview reads and nothing a reader can see.
            ...bookmark(pageBandBookmark(band), BOOKMARK_ID_BASE + band.ordinal * 2 + 1),
            new TextRun({ text: assessmentDate ?? '', color: MUTED, size: 15 }),
            new TextRun({ children: [new Tab(), 'Page '], color: MUTED, size: 15 }),
            ...cachedField('PAGE', PAGE_NUMBER_STYLE),
            new TextRun({ text: ' of ', color: MUTED, size: 15 }),
            ...cachedField(
              `PAGEREF ${sectionEndBookmark(band)} \\h ${bandNumeralSwitch(band)}`,
              PAGE_TOTAL_STYLE,
            ),
          ],
        }),
      ],
    }),
  }
}

function reportSectionProperties(pageNumbers = null) {
  return {
    page: {
      size: { width: LETTER_WIDTH_TWIPS, height: LETTER_HEIGHT_TWIPS },
      margin: {
        top: PAGE_MARGIN_TWIPS,
        right: PAGE_MARGIN_TWIPS,
        bottom: PAGE_MARGIN_TWIPS,
        left: PAGE_MARGIN_TWIPS,
        header: HEADER_FOOTER_MARGIN_TWIPS,
        footer: HEADER_FOOTER_MARGIN_TWIPS,
        gutter: 0,
      },
      ...(pageNumbers ? { pageNumbers } : {}),
    },
  }
}

/**
 * One building becomes three Word sections so the page numbering matches the
 * report convention: an unnumbered cover, roman-numeral front matter, then the
 * body restarting at 1.
 */
function buildingSections(report, { project, firm, includeToc, index }) {
  const frontBand = { key: `B${index + 1}Front`, format: 'lowerRoman', ordinal: index * 2 + 1 }
  const bodyBand = { key: `B${index + 1}Body`, format: 'decimal', ordinal: index * 2 + 2 }
  const ctx = reportContext(report)
  const runningBrand = ctx.firm !== 'the Consultant' ? ctx.firm : ctx.client
  const assessmentDate = formatDate(report.building?.date_of_assessment)

  // Figures and tables are collected while the body is built, then listed in
  // the front matter — so the body is assembled first even though it prints last.
  const figures = createFigureRegistry()
  const facility = facilityDescriptionChildren(report, ctx, figures)
  const assessment = conditionAssessmentChildren(report, figures)
  const tables = [
    LABELS.scorecardPriorities,
    LABELS.conditionSnapshot,
    LABELS.capitalRenewalSummary,
    LABELS.componentSummary,
    reserveScheduleHeading(ctx),
    CRV_ALLOWANCES_CAPTION,
    CRV_LEVEL2_CAPTION,
    LABELS.fciClassification,
    LABELS.facilityInformation,
    LABELS.majorSystemCapitalSummary,
  ]

  const bodyChildren = [
    ...facility,
    pageBreak(),
    ...assessment,
    pageBreak(),
    ...conclusionsChildren(report, ctx),
    pageBreak(),
    ...blockChildren(limitationsBlocks(ctx)),
  ]

  return [
    {
      properties: reportSectionProperties(),
      headers: blankHeader(),
      footers: blankFooter(),
      children: coverChildren({ project, firm, reports: [report] }),
    },
    {
      properties: reportSectionProperties({
        start: 1,
        formatType: NumberFormat.LOWER_ROMAN,
      }),
      headers: runningHeader(runningBrand, ctx.property),
      footers: pageFooter(assessmentDate, frontBand),
      children: [
        ...frontMatterChildren(ctx, { figures: figures.entries, tables, includeToc }),
        pageBreak(),
        ...facilityScorecardChildren(report, ctx),
        ...executiveSummaryChildren(report, ctx, { startOnNewPage: true }),
        sectionEndAnchor(frontBand),
      ],
    },
    {
      properties: reportSectionProperties({
        start: 1,
        formatType: NumberFormat.DECIMAL,
      }),
      headers: runningHeader(runningBrand, ctx.property),
      footers: pageFooter(assessmentDate, bodyBand),
      children: [...bodyChildren, sectionEndAnchor(bodyBand)],
    },
  ]
}

function buildDocument({ project, firm, reports }) {
  const sections = []
  const projectBand = { key: 'Project', format: 'lowerRoman', ordinal: 0 }
  const binder = reports.length > 1
  let contents = null

  if (binder) {
    const runningBrand = text(firm?.name) || text(project?.client, LABELS.assessmentType)
    const summaryChildren = projectSummaryChildren(reports)
    // A binder's contents is the portfolio's own sections and then one line per
    // property, which is the outline the reader can actually navigate — see
    // `tableOfContents`. The property lines are read off the reports rather than
    // off the covers that anchor them, because a cover carries its name inside
    // the "prepared for" box and the outline walk only sees top-level children.
    const entries = [
      ...outlineEntries(summaryChildren),
      ...reports.map((report) => ({ title: buildingTitle(report.building), level: 1 })),
    ]
    contents = () => tableOfContents(entries, { stylesWithLevels: BINDER_CONTENTS_STYLES })

    sections.push({
      properties: reportSectionProperties(),
      headers: blankHeader(),
      footers: blankFooter(),
      children: coverChildren({ project, firm, reports }),
    })
    sections.push({
      properties: reportSectionProperties({
        start: 1,
        formatType: NumberFormat.LOWER_ROMAN,
      }),
      headers: runningHeader(runningBrand, text(project?.client, LABELS.assessmentType)),
      footers: pageFooter(formatDate(reports[0]?.building?.date_of_assessment), projectBand),
      children: [
        ...summaryChildren,
        pageBreak(),
        tableOfContentsHeading(),
        TABLE_OF_CONTENTS_SLOT,
        sectionEndAnchor(projectBand),
      ],
    })
  }

  // The one table of contents lives in the project front matter when there is
  // one, and in the single building's own front matter otherwise.
  const includeToc = !binder
  reports.forEach((report, index) => {
    sections.push(...buildingSections(report, { project, firm, includeToc, index }))
  })

  // One report indexes every heading it has, so its outline can only be read
  // once all of its sections exist.
  if (!binder) {
    const entries = sections.flatMap((section) => outlineEntries(section.children))
    contents = () => tableOfContents(entries)
  }

  // Word fills the table of contents in on open rather than showing a stale
  // "right-click to update" placeholder.
  return new Document({
    features: { updateFields: true },
    styles: DOCUMENT_STYLES,
    numbering: { config: [{ reference: BULLET_REFERENCE, levels: BULLET_LEVELS }] },
    sections: materializeTableOfContents(sections, contents),
  })
}

/** Build the .docx as a Buffer from an array of getPropertyReportData payloads. */
async function buildProjectReportDocxBuffer({ project, firm, reports }) {
  const active = (reports ?? []).filter(Boolean)
  if (active.length === 0) throw new Error('No report data to export.')
  const resolvedProject = project ?? active[0].project
  const resolvedFirm = firm ?? active[0].firm
  return Packer.toBuffer(buildDocument({ project: resolvedProject, firm: resolvedFirm, reports: active }))
}

module.exports = {
  buildProjectReportDocxBuffer,
  buildDocument,
  BORDER_SPACE_X,
  BORDER_SPACE_Y,
  // exposed for unit tests
  currency,
  formatDate,
  reportContext,
  blockChildren,
  capitalNeedsTable,
  componentSummaryTable,
  crvTable,
  fciTable,
  yearCostChildren,
  majorGroups,
  annotateBitmap,
}
