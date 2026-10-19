# Word (.docx) export (`src/docx-report.js`)

**The Word document is the deliverable and the source of the preview.**
`src/docx-report.js` builds the whole consolidated report with the pure-JS
[`docx`](https://www.npmjs.com/package/docx) library in the main process.
Opening the report screen builds that DOCX once; the screen renders a copy of
its bytes and **Save Word Report…** writes the cached original without another
build. See [property-report](property-report.md).

There is no PDF export. The client dropped it in favour of an editable
deliverable, so what used to be a companion format is now the only output.

## One document, one content model

The prose that does not come from the database — the executive-summary section
intros, the capital-needs commentary and definitions, the CRV and FCI
explanations, the visual-observation note, the disclaimers, the limitations and
the conclusions — lives in `src/lib/report-content.js` and nowhere else, along
with **every heading, table caption, column head and field label** the report
prints (`LABELS`, `FACILITY_FIELDS`, `ASSET_FIELDS`). Only the DOCX builder
assembles those blocks into the report. The screen no longer has a parallel
HTML document assembly that can drift from it.

The wording is the client's, supplied as a rewritten report-text template. See
[report-wording](report-wording.md) for what it asked for, what was already
true, and where the implementation deviates.

The module exports blocks, not strings:

```js
{ type: 'heading', level: 1 | 2 | 3, text, legal?: true }
{ type: 'paragraph', text, legal?: true }
{ type: 'bullets', items: [text] }
{ type: 'callout', text }
```

`blockChildren` turns those into Word `Paragraph`s; `legal` means 9pt and a
`callout` means 9pt italic. Adding or rewording a section remains one edit in
`report-content.js`.

Everything else comes from one `getPropertyReportData(projectId, buildingId)`
snapshot per included building and the shared calculation engine
([capital-planning](capital-planning.md)), so OPC totals, CRV, FCI, action
years, planning terms, annual forecasts, narratives, and photo selections are
fixed before the build begins. Capital/CRV/FCI tables use the canonical
`capitalLevel1Rows`, `displayCrvRows`, and `termDisplayLabel` helpers in
`src/lib/property-report-rules.js`.

The preview's guarantee is **artifact identity, not pixel identity**: the byte
sequence supplied to `docx-preview` is the byte sequence later written to
disk. Chromium and Microsoft Word still use different layout engines. The
viewer evaluates no Word field at all — it parses `TOC`, `PAGE` and the rest and
then renders every field run as nothing — and its CSS page-breaking model can
wrap tables, fonts, and paragraphs differently. The DOCX therefore stores a
title-only cached result inside its still-live, dirty TOC field. The viewer can
render that real outline instead of a blank contents page, while Word replaces
it with authoritative page numbers on open. The footer's page numbers are cached
the same way, and the preview overwrites them with pages it counted itself; see
[property-report](property-report.md#page-numbers).

Different layout engines is the licence; silently dropping what the file says
is not. `docx-preview` translates `w:pBdr` into a CSS border but discards the
`w:space` that holds the rule off the text, so every accent bar and heading
rule rendered jammed against its words while Word and LibreOffice both drew the
gap. `restoreBorderSpacing` in `src/property-report.js` reapplies it after the
render, and pulls a left rule's margin back by the same amount — CSS grows the
text inward from a border pinned to the margin, where Word leaves the text
alone and draws the rule outside it, so without the pull-back the preview would
lose 8pt of measure and stop breaking lines where Word breaks them. The
document keeps to one border gap per axis (`BORDER_SPACE_X` / `BORDER_SPACE_Y`
in `src/docx-report.js`) so this stays generic — no per-heading or per-callout
number to track, and nothing to update when the report grows another bordered
block. `test/property-report.test.js` fails if the two sides drift apart.
Microsoft Word remains authoritative for final pagination and all live-field
results. This limitation is visible in the report UI.

Every Word section explicitly declares US Letter (8.5in × 11in) with one-inch
margins. This cannot be left to Word's defaults: installations in A4 locales
otherwise reflow the same document onto different pages.

## Appearance

The document does not rely on a reader's Word defaults. Design constants at the
top of `src/docx-report.js` define the steel-slate palette, type, rules, cell
padding, fixed column widths, zebra fills, legal text, callouts, cover tables,
headers, and footers. `DOCUMENT_STYLES.default.document` supplies real
`docDefaults`; heading styles carry their own colours and borders; data tables
use explicit widths and margins.

### Type and lists

The document face is **Calibri**. It is not Segoe UI, which is a Windows
interface font: Office for Mac does not install it, so those readers were
already reading a Word-chosen substitute. Calibri ships with every Office
install on both platforms, and it has an open metric-compatible clone
(**Carlito**, SIL OFL, in `assets/fonts/`) which the preview page binds as
`@font-face` — `local()` first, so a machine with the real font uses it. Without
that binding `docx-preview` emits a bare `font-family: Calibri` with no
fallback, and Chromium drops the entire preview to its default serif. Because
Carlito is metric-compatible, the preview breaks lines where Word breaks them.
Body prose is 11pt rather than 10pt, since Calibri sets smaller than Segoe UI at
the same nominal size; only `docDefaults` moved, so the fixed column grids are
untouched.

Bulleted lists use their own numbering definition rather than the library's
`bullet:` shorthand, which emits ● (U+25CF BLACK CIRCLE) at a half-inch indent —
a heavy dot marooned from its text. The report's levels use •/◦/▪ in the heading
accent on a 0.3in indent with a 0.15in hang. The glyphs are ordinary Unicode
rather than Word's convention of U+F0B7 in Symbol: private-use code points only
resolve for readers who have those exact fonts, and they render as tofu in the
preview. Indent and inter-item spacing are also repeated as direct paragraph
formatting, because the library stamps every numbered paragraph with
`ListParagraph`, a latent Word built-in this document never defines — Word
supplies its own, carrying both a half-inch indent and `contextualSpacing`, the
latter silently discarding the gap between items. The last item in each list
takes a wider gap so the prose that resumes underneath does not read as another
entry that lost its bullet.

The cover band is a solid table-cell fill, because Word does not support a
gradient there. The hero image is contain-fitted and bounded by
`HERO_MAX_HEIGHT_PX`; this keeps tall images from pushing the cover footer onto
a second page. A binder's project cover carries the client, property count, and
assessment-date range but no hero, while each facility cover retains its own
identity and address. Every table is followed by `tableGap()` because adjacent
Word tables otherwise merge and have no independent bottom margin.

`test/docx-report.test.js` pins the parts of this that no content assertion can
see: a populated `docDefaults`, the heading colours and rules, cell margins,
header shading, zebra fill, a fixed layout with unequal column widths, and that
no tab is emitted outside a run. That last one is the failure mode worth
knowing about — `<w:tab/>` as a direct child of `<w:p>` is silently dropped, so
the header's two halves run together and nothing in the XML text looks wrong.

## Structure

Each building contributes **three Word sections**, which is what gives it real
report pagination:

1. **Cover** — no page number, no running header or footer. Firm (title),
   "Building Condition Assessment", Prepared for (client, then each facility with
   its `Property ID:` line and
   address), Prepared by (firm), assessment date, confidentiality line. The
   cover carries no draft/status marking; `test/docx-report.test.js` asserts
   none is reintroduced.
2. **Front matter** — lower-case roman numerals restarting at i. Table of
   contents, list of figures, list of tables, the Facility Scorecard, then the
   Executive Summary: the nine narrative sections (accessibility, designated
   substance survey, architectural/structural, plumbing, mechanical, electrical,
   fire and life safety, site, code compliance), capital-needs commentary and
   definitions, the reserve grid, the Component Summary, CRV and FCI.
3. **Body** — decimal page numbers restarting at 1. Facility description
   (including Property ID and Figure 2-N photos), the per-asset condition
   assessment grouped by Uniformat Level 1, then conclusions, limitations and
   disclaimers.

A multi-building report opens with a project cover and a Project Capital Summary
(Portfolio Capital Requirements by Building System, the expenditure forecast,
and Portfolio Replacement Value and Facility Condition Index) from
`aggregateProjectPlan`, then repeats the three sections above per building.

### Facility Scorecard

A one-page management view, printed between the figures/tables index and the
Executive Summary it summarises. It answers the four questions an owner is asked
at a budget meeting — what the facility is worth, what condition it is in, what
it needs soon, and how many components drive that need — without paging through
the report behind it. Built by the client's Hastings County proposal collateral,
kept in `samples/ANJ_Hastings_RFQ_26-811_KPI_Dashboard_Mockups.zip`.

It carries an identity banner (facility, address, overall IFMA condition grade),
four headline tiles, the near-term priority grid, and the condition snapshot.

`facilityScorecard` in `src/lib/property-report-rules.js` computes all of it, and
computes nothing new: every figure is read from the same `capitalPlan` the
capital renewal, CRV and FCI tables print, so the card cannot disagree with the
pages behind it. Two consequences worth keeping:

- **The near-term window is summed from the plan's own year totals**, not by
  naming terms, so retuning the term bands cannot silently change what "0–5
  years" means here. The need, the component count and the priority rows all read
  that one window, so the three always reconcile.
- **Priority rows carry only the occurrences scheduled inside the window**, not a
  component's whole life-cycle cost. That keeps the rows a share of the tile above
  them rather than a second, larger number for the same thing.

Two things keep the card to one page, and both were sized against rendered
output rather than assumed: the priority grid is capped at five rows (the
snapshot is always three), and its first column carries the bare Level 2 code
rather than the spelled-out classification. Spelling it out wrapped that column
to three lines a row, which pushed the condition snapshot onto a page of its own
in the 24-asset Riverbend fixture. `test/facility-scorecard.test.js` pins both.

**The break after it is `w:pageBreakBefore` on the Executive Summary heading, not
a `pageBreak()` paragraph.** This is the one place in the document where that
distinction is load-bearing. A standalone break is a paragraph of its own: when
the content before it ends flush with the page bottom — which a full scorecard
does — the break lands on the *next* page and pushes the heading one further,
leaving a page holding nothing but that empty paragraph. Measured on the dev
database, that was a blank page vii in an 84-asset report. `pageBreakBefore` is a
property of the heading itself and cannot do it. Any fixed-size block followed by
a new chapter should be separated the same way; `test/docx-report.test.js` fails
if a break paragraph is reintroduced here.

**That break is carried by a paragraph style, not set on the paragraph.** Word
honours both forms identically; `docx-preview` honours only the style. It parses
a direct `w:pageBreakBefore` and then never asks a paragraph for it — the page
splitter consults `findStyle(styleName).paragraphProps.pageBreakBefore` and
nothing else, and the CSS builder discards the direct property instead of
translating it to `break-before`. A directly-set break therefore printed
correctly and was invisible in the review that is supposed to *be* the export:
on screen the summary heading ran on from the scorecard, while the delivered
file started a new page. `PAGE_BREAK_STYLES` defines, for every style a heading
can be set in, the variant of it that also starts a page — `Heading1Break` is
`basedOn` `Heading1` and adds only `pageBreakBefore` — and `heading()` swaps the
variant in whenever a break is asked for.

Every base style gets its own variant rather than all of them sharing one,
because a paragraph takes exactly one `w:pStyle`: a heading tagged for a binder's
contents cannot wear its tag and a shared break style at once. For the same
reason `BINDER_CONTENTS_STYLES` selects the variants alongside the tags, so a
tagged heading that starts a page does not quietly drop out of the contents.
`test/docx-report.test.js` pins all three — the summary heading's break comes
from its style and not from the paragraph, every base style has an inheriting
variant, and the binder field selects both names at each level.

**The Component Summary is per building, never per portfolio.** It is one row
per component, so a project summary carrying it would open a 27-property binder
with several thousand rows before the first cover. Each building's own executive
summary carries its own.

Its total is the sum of the allowances it lists, which is deliberately *not* the
Capital Renewal Summary's total — that table counts every scheduled recurrence
of a component inside the horizon, this one costs each component once, at the
figure its own asset page prints. The two totals must not be presented as the
same measure if either calculation changes.

Seven columns is the widest grid in the report and the one place the default
`dataTable` proportions do not work: it declares its own `weights` in inches of
the 6.5in content width and drops to `TIGHT_CELL_MARGINS`, because the standard
0.07in side padding is the difference between `Condition` as a column head and
`Conditio` / `n`. Those numbers were measured against a rendered page, not
assumed — the same failure mode `Immediat e Term` had.

**One table of contents per document.** A Word TOC field indexes the whole
document, so a per-building TOC in a multi-building report would list every
building under every heading. `buildingSections` takes an `includeToc` flag:
multi-building documents carry a single project-level TOC, single-building
documents carry their own. Each Heading 1-3 paragraph records its title and
level while the document is assembled; after all sections are in final order,
`materializeTableOfContents` fills the deferred slot with the outline read off
those actual paragraphs. There is no second hand-maintained section list to
drift, and the visually styled **Report Contents** title is deliberately not a
Heading 1, so the field does not index itself.

**A binder indexes properties, not headings.** One report's outline is its own
Heading 1-3 (`TOC \h \o "1-3"`). A binder's cannot be: every building repeats the
same three dozen section titles, and nothing inside a building names it, so a
75-property binder produced 2,485 entries across 54 pages that listed
`Facility Scorecard` seventy-five times and identified none of them. Capping the
depth does not help — 602 of those entries are level 1 on their own.

A binder therefore selects **named styles** instead: `TOC \h \t "…"` over
`PORTFOLIO_HEADING_STYLES` and `PROPERTY_ENTRY_STYLE`, which lists the
portfolio's own sections and then one line per property — 85 entries across
three pages. Each of those styles is `basedOn` the style it stands in for and
adds nothing, so tagging a paragraph changes what indexes it and nothing about
how it renders; verified against both LibreOffice and `docx-preview`, which
resolve `w:basedOn` down to the run. The property line is the one a building's
cover already prints in its *prepared for* box, so a binder gains a usable
contents page without gaining a line of visible text. `stylesWithLevels` and the
cached entries have to agree — Word's refresh replaces the cache with whatever
the instruction selects.

The cached result omits page numbers because only Word knows its final
pagination. The field stays dirty, and
`Document({ features: { updateFields: true } })` makes Word replace that cache
on open. There is no forced page break between the contents field and the
figures/tables index: a short outline lets the index use the remaining page;
longer outlines paginate naturally.

**Nothing is stranded under a forced break.** Word breaks a paragraph run or a
table wherever the page runs out, which is normally harmless — the tail lands on
the next page and the following content fills the rest of it. It is not harmless
where a forced page break comes next, because then nothing can do that filling
and the tail sits alone under most of a page of white. The document has two such
places, and both are bound against a break:

- the **figures/tables index**, which the executive summary follows on a forced
  break. Every entry but the last carries `keepNext`, so the index moves whole;
  the headings already carry it from `DOCUMENT_STYLES`. Before this, an 84-asset
  report put one bullet — *Major System Capital Summary* — alone on a page.
- the **final asset's detail grid**, which the conclusions follow on a forced
  break. `keyValueTable(pairs, { keepTogether })` applies the OOXML idiom for an
  unbreakable table: keep-with-next on every row but the last. `assetChildren`
  asks for it only on the asset `conditionAssessmentChildren` renders last —
  render order, which is the tail of the last group, not the tail of the input
  array.

`keepTogether` is deliberately off everywhere else. A grid that may not split has
to move whole, and paying that gap at every split added about 5% to the page
count of the dev database's reports — 192 pages to 201 — while removing no
whitespace, only relocating it. Applied to just the two stranding points it costs
nothing: the same reports paginate to the same length.

What remains is inherent. A section's last page holds whatever content ends it —
in practice the FCI Condition Classification heading and its five-row grid, about
two inches under a page of white — and the executive summary has to end a section
because the body restarts page numbering at 1. That is a short page, not a blank
one, and closing it would mean reordering the client's report.

Running header (firm/client) and "Page X of Y" footer (with the assessment date)
on every numbered page. Both are declared empty on the cover sections: a section
that names no header or footer inherits the one before it, so each building cover
in a binder was otherwise printing the previous building's running header and a
footer numbered against a section it is not part of.

`X` is `PAGE`. `Y` counts to the section, not to the whole binder, because front
matter and each facility body restart their numbering — but it is a `PAGEREF` to
a bookmark on the section's last page rather than `SECTIONPAGES`. The two mean
the same thing while numbering restarts, and `SECTIONPAGES` is the one readers
disagree about: LibreOffice cannot evaluate it and leaves it blank, printing a
dangling "of " under every page of the delivered file. A `\* roman` or
`\* arabic` switch pins the total to the numerals its band prints, which
`PAGEREF` otherwise takes from the page it points at and readers again disagree
about.

Each field caches a result — an em dash — between its `separate` and `end`, which
`docx` does not write on its own. Word and LibreOffice both replace it; a reader
that evaluates nothing shows the dash instead of a gap, and the preview
overwrites it with a real number. The bookmarks carry ids allocated here, because
`docx` gives every `Bookmark` it builds `w:id="1"`, and two of those in one part
collide.

An `assessed === false` asset (opted in via `include_as_not_assessed`) renders as
a "Not Assessed" note with no prefilled findings.

`prepareReportImage` owns every image conversion. Electron `nativeImage`
decodes all formats the import dialogs accept (including WebP and GIF), bounds
the encoded raster to a 1600px edge, converts photos to JPEG and
transparency-sensitive logos to PNG, and preserves the decoded aspect ratio in
the Word transformation. An unreadable or missing file is skipped rather than
failing the export. Every asset photo explicitly selected with
`include_in_report` is honored; the document does not impose a second hidden
photo limit.

Photo annotations are carried into modern Word as an SVG `ImageRun`: the
normalized raster is embedded in the SVG with sanitized boxes and arrows from
`bounding_boxes`. `docx-preview` and older Office engines select the OOXML
raster fallback rather than that SVG, so `annotatedRasterFallback` burns the
same shapes into a JPEG/PNG fallback with Electron `nativeImage`. Markup is
therefore visible in both the Word-derived preview and older consumers. This
also keeps both shape types together instead of relying on native Word shapes,
whose current `docx` implementation cannot express arrowheads.

## Entry points

- `property-report:prepare` (`preparePropertyReport`) — collects one report
  snapshot, rejects relevant AI activity, fingerprints and builds it, rechecks
  the snapshot after ZIP packing, and commits immutable bytes under a
  sender-scoped `previewId`. It returns a byte copy for `docx-preview` and the
  compact validation data produced from that same snapshot.
- `property-report:chooseExportPath` (`chooseReportExportPath`) — one save
  dialog for the `.docx`. Cancelling cancels the export. On success main keeps
  the selected path and returns only an opaque, sender-bound, one-use
  `exportId`. Honours `CONDITION_ASSESSMENT_AUTO_DOCX`.
- `property-report:export` (`exportPropertyReport`) — consumes that `exportId`,
  resolves the sender's matching `previewId`, verifies AI, fingerprint, and
  validation state, and atomically writes the cached buffer. It accepts neither
  report ids nor a path from the renderer and never rebuilds the document.
- `report:setExportBusy` (`setReportExportBusy`) — holds the app-wide busy lock
  (`setBusyTask`, shared with bulk AI generation) across preparation or save.

### Preparation and save state

Building the document blocks the main process for ~60s on a large project, so
the window would otherwise just sit there looking hung — which is exactly what
was reported from the field on 1.6.0, when the Word file was also written
silently beside a PDF and nothing on screen ever named it. The renderer now
shows a dedicated preparation state and names build/layout phases while holding
the busy lock. A document that cannot be built or displayed is an explicit
retryable error, never a silent no-op.

The save modal covers only the durable write and names the written file. Main
re-collects the report immediately before saving and compares its SHA-256
fingerprint to the prepared artifact. A relevant AI job or changed snapshot
returns a stale result and causes a rebuild; it never substitutes new bytes
after review. Sender-scoped latest-wins tokens also prevent an earlier
asynchronous preparation from replacing a newer one.

`src/main/atomic-file.js` writes the completed buffer to a unique `.pending`
file beside the chosen destination, fsyncs it, then renames it into place (and
fsyncs the directory where supported). The final path is never opened for a
partial write. If writing, flushing, or renaming fails, the pending file is
removed and any previous report at the destination remains unchanged. Packing
happened during preparation, before the destination was selected; the atomic
writer owns only the completed bytes.

`buildProjectReportDocxBuffer({ project, firm, reports })` returns the `.docx`
as a `Buffer` (a ZIP). `test/docx-report.test.js` unzips it with `jszip` and
asserts the document XML carries the expected content for single- and
multi-building projects. `test/atomic-file.test.js` separately proves the
fsync-before-rename order and preservation of an existing destination when the
rename fails. `scripts/verify-word-export.js` clicks the real button and
requires the file at the path the dialog authorized.

That scenario imports the 4,091-row sample workbook into one dev-seed project
and prepares/saves the whole 27-property result, not only the three-building
dev seed. Assessment completeness excludes the workbook's master-library
placeholders while the remaining hundreds of assessed components still
exercise the large-document path. The scenario verifies that the preview is
DOCX-derived and that the file reaches the main-authorized path; Word itself,
not the viewer's generated `<section>` count, owns final pagination. It also
hit-tests the toolbar before clicking because a hidden-state CSS regression can
cover a working button; see [ui-driver](ui-driver.md).

## Dependency

`docx`, `docx-preview` 0.4.0, and `jszip` are JavaScript dependencies and bundle
without another native module. The report page loads the browser distributions
of the latter two from packaged `node_modules`; `scripts/smoke-packaged-app.js`
asserts those exact files are present in the asar.

`docx-preview` creates style elements, inline declarations, blob-backed images,
and potentially embedded fonts. `property-report.html` therefore retains
`script-src 'self'` while adding report-page-only `style-src 'unsafe-inline'`,
`font-src file: blob: data:`, and the existing local/blob/data image sources.
`file:` is spelled out for the same reason `img-src` already spells it out: the
bundled Carlito faces load from `assets/fonts/` over `file:`. No remote viewer
or document upload is involved.
