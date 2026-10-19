# Property report (`src/property-report.js`, `pages/property-report.html`)

The report screen is a **Word-derived review surface**. Opening it asks the
main process to build the authoritative `.docx` once, then the renderer lays
out those exact bytes with `docx-preview`. **Save Word Report…** writes the
same cached bytes; saving does not query the report again or rebuild it.

The preview is therefore much closer to the deliverable than the retired
hand-built HTML report, but it is not Microsoft Word. `docx-preview` interprets
OOXML in Chromium and cannot reproduce Word's layout engine or evaluate a single
Word field. The live table-of-contents field carries a cached, title-only outline
so the browser can show real section entries instead of a blank contents page;
it deliberately carries no guessed page numbers. Word remains authoritative for
final page breaks and refreshed contents-page numbers. The screen splits and
numbers its own pages so that scrolling one is like turning one, but those splits
are measured in Chromium and land near Word's rather than on them. The note above
the pages states that limitation instead of implying pixel identity. See
[word-export](word-export.md).

There is no PDF export.

## Entry

`openPropertyReport(projectId, buildingIds)` loads
`property-report.html#<projectId>:<id1>,<id2>,...`; `buildingIds` may be one id
or a list. `getActiveBuildingIds` preserves hash order and removes duplicates.
A property-row action opens one building. **Generate project report** opens the
building picker and then one consolidated document for the selected project;
see [home-page](home-page.md).

On load, `requestPreparation()` calls
`preparePropertyReport(projectId, buildingIds)`. The page does not assemble
report content or call `getPropertyReportData` itself.

## Authoritative artifact lifecycle

`property-report:prepare` owns the complete preparation transaction:

1. Begin a new sender-scoped `previewId`, immediately invalidating the prior
   artifact and any unused save-path authorization.
2. Collect one `getPropertyReportData` snapshot for every requested building,
   in request order, dropping unavailable buildings.
3. Reject the attempt while a caption or executive-summary AI job can still
   change any included building.
4. Fingerprint the snapshot, build the DOCX with
   `buildProjectReportDocxBuffer`, then collect and fingerprint the data again.
   A change during asynchronous ZIP packing rejects that obsolete build.
5. Commit an immutable buffer only if its `previewId` is still the newest
   preparation for that window. Return a byte copy plus compact
   project/building/validation data for the screen-only review panel.

Both sides enforce latest-wins ownership. Main's `begin` / `commit` token stops
an older build replacing a newer artifact; the renderer's monotonically
increasing revision stops a late IPC or layout result replacing a newer view.
`renderPreparedPreview` builds into detached body/style containers and swaps
them into the document only after `docx.renderAsync` succeeds. A transient
snapshot change gets one automatic rebuild; other failures show a named error
and **Try again** action.

One prepared artifact is retained per report window. It is revoked by a newer
preparation, top-level navigation, renderer destruction, or window close.
In-document Word bookmark navigation is deliberately not a revocation event,
so following a TOC link does not make its own report stale.

Preparation holds the app-wide report busy lock and shows the current phase on
the page. A large project can still block the main process while the Word
builder and ZIP packer work; the important difference is that this work happens
before review, not after the user chooses a filename.

## Preview rendering

`pages/property-report.html` loads the browser distributions of `jszip` and
`docx-preview` from production `node_modules`. The renderer normalizes IPC's
possible Buffer/typed-array representations, then calls `docx.renderAsync` with
section page breaking, headers, footers, footnotes, endnotes, and experimental
tab-stop measurement enabled. Comments, tracked changes, and alt-chunks are
not rendered.

The generated pages are marked with
`document.body.dataset.reportPreviewSource = 'docx'`. `reportReady` is set only
after the viewer has resolved, its delayed tab-stop pass has elapsed, and image
decodes have settled (bounded at three seconds). Blob URLs created by the
viewer are revoked when a preview is replaced or the page unloads.

The toolbar badge and explanatory note make the evidence boundary explicit:
the saved bytes are identical to the bytes supplied to the viewer, but the
screen's pagination is an approximation. No browser-print layout is maintained
or supported. The cached contents outline is part of those DOCX bytes, not a
renderer-only substitute, and it is what the screen shows: one report lists its
own Heading 1-3, while a multi-building binder lists the portfolio's sections
and then one line per property, because every building repeats the same section
titles and none of them says which building it belongs to. See
[word-export](word-export.md). The figures/tables index follows the outline
without an unconditional page break, so it uses any space the outline leaves and
then paginates normally.

### Page splitting

`docx-preview` does no layout-based pagination of its own. It starts a new page
only where the document carries an explicit break — `w:pageBreakBefore` on a
paragraph's *style*, a `<w:br w:type="page"/>`, or a section break — and sizes
each page with `min-height`, so a run of content with no break of its own
becomes one section as tall as its content needs. That property set directly on
a paragraph is not a break here: the viewer's splitter asks the style and
nothing else, so a directly-set break prints in Word and shows up nowhere on
screen. The largest report has nine such break points, and rendered as eight
sections for a document Word flows across 121 pages: one of them was 73,423px,
about seventy pages in a single scrolling block.

`src/lib/preview-pagination.js` cuts those sections at the page's own content
height once the borders, tab stops and images have settled, moving whole blocks
onto fresh pages that carry copies of the running header and footer. A table
too tall for the remaining page is split by rows into clones that keep its
`colgroup`, so column widths hold across the break.

Two details are load-bearing and were each a bug first:

- **The page box is written in the document's unit, not pixels.** A Letter page
  arrives as `min-height: 792pt` while every element offset is reported in
  pixels. Reading `792` as pixels left 648px of content instead of 864 and cut
  every page a quarter short.
- **The viewer builds tables through the DOM,** where no `<tbody>` is implied,
  so rows normally sit directly under `<table>`. Reaching only through
  `tBodies[0]` left a 105-row summary whole on a five-page page.
- **A page break is a paragraph, and the viewer ends a page with it** rather
  than starting the next one with it, so a page's last block is often one that
  draws nothing — and so is the hairline paragraph carrying a section's end
  bookmark. When the content above them filled the page exactly, one of those was
  what overflowed, and cutting there gave it a page of its own: blank, but
  carrying the running header, the footer and a page number, and pushing every
  page after it along. `foldBlankPages` gives any page the split would invent
  that draws nothing back to the page before it, which is where those blocks
  already sit whenever that page has room. The page they end may therefore run a
  little over the box; nothing is drawn in the extra space.

  The fold applies only to the pages this module invents. A page `docx-preview`
  itself produced from a break in the document corresponds to a page Word prints,
  so a blank one there is a blank page in the deliverable and stays on screen:
  the preview's job is to show that, not to hide it. No such page occurs today —
  neither the largest binder nor a single report renders a blank section before
  pagination — which is why every blank page seen so far has been one the split
  invented.

It stays an approximation. Measured against the same files converted by
LibreOffice, whole documents land within about 4–12% of the delivered page count
and a single numbering section within about 15%, and no page runs more than ~4%
over the page box. Word still decides the real breaks. Two known differences: a
paragraph is atomic here, where Word will flow one across a page boundary; and a
continuation table does not repeat its header row, because `docx-preview` parses
`w:tblHeader` into `row.isHeader` and then never renders a `<thead>` from it —
`splitTable` repeats a `tHead` whenever one is present, so this corrects itself
if the viewer ever gains that support.

### Page numbers

`docx-preview` renders every field run as nothing (`renderRun` returns `null` for
one), so both halves of the footer's "Page X of Y" would be blank. What it does
render is the cached result the builder writes inside each field, which carries a
character style and therefore arrives as a class the split can find.

Which number to write comes from a bookmark in each footer naming its **numbering
band** — one Word section's run of consecutive numbered pages, plus how that band
counts: `_CarPageBand_<key>_<decimal|lowerRoman>`. Word restarts numbering at
every section, so a page's number is its place in its own band, and the band's
total is its length. A page with no band is a cover: it is numbered by nobody and
closes the band before it, which is what stops one building's body from running
into the next building's in a binder.

The numbers are the preview's own count, so they carry the same tolerance as the
splits above and will not always match the delivered file. They are also written
after the viewer has frozen its tab stops — it measures what follows a right tab
once and stores the gap as a word spacing — so a footer that grew is realigned by
taking the growth back out of that gap. Without it the whole right-hand group
drifts past the margin the rest of the page lines up against.

Geometry reaches the module through an injected `measure` so the split is
testable without a layout engine. jsdom reports every offset as zero, which
reads as "nothing overflows" and leaves the DOM untouched — that is why the
renderer's other suites are unaffected by it.

## Report data and assessed assets

The main-process snapshot contains `{ project, firm, building,
buildingImages, executiveSummary, capitalPlan, assets[] }`. Each asset includes
its own `images[]`, an `assessed` flag, and a capital snapshot from the shared
calculation engine.

**Photos are strictly per asset.** `images[]` comes from
`listAssetImages(asset.id)`, and `asset_image.asset_id` is a foreign key to
`asset(id)`. Stored files include the asset id and a UUID, so files cannot
collide across assets.

**Master-library rows are excluded; the report is the assessed subset.**
`getPropertyReportData` keeps assets that pass `isAssetAssessed`
(`src/lib/asset-completeness.js`), plus rows deliberately included with
`include_as_not_assessed`.

The distinction is *seeded library row vs assessed component*. Imported and
new buildings can contain the full Uniformat library before a site visit.
Template values such as Uniformat class, reference price, service life, and an
imported asset name are not evidence of assessment. Findings, a meaningful
quantity/cost/action year, a non-zero life adjustment, or a photo are evidence;
placeholder strings and zero quantities are not. A name entered for an asset
created in the app does count, while a workbook-supplied name (`import_key` is
set) does not.

This filter prevents thousands of untouched workbook rows from becoming asset
pages and capital events. Only assessed assets feed `calculateCapitalPlan`.
An explicitly included blank row becomes a **Not Assessed** identity page and
does not contribute prefilled findings or cost. See
[capital-planning](capital-planning.md).

## Pre-export review

The compact preparation response carries the `validation` result produced from
the same snapshot as the DOCX. The screen-only `#report-review` panel aggregates
findings across included buildings. It checks:

- required client/facility fields and valid area, storey count, year, date, and
  location factor;
- missing or unsuitable CRV/FCI inputs;
- duplicate component records;
- contradictory condition and action/priority values;
- overdue lifecycle dates and building-borrowed component vintage;
- costed actions without a computable cost, and unschedulable assets.

Errors disable **Save Word Report…**; warnings do not. **Export anyway** is the
only renderer path past errors and the override resets on every preparation.
Main stores the snapshot's error count with the artifact and also requires
`allowValidationErrors: true`, so bypassing the screen cannot silently save a
blocked artifact.

## AI updates and staleness

A relevant in-progress caption or summary job prevents preparation. If a job
starts after a preview is visible, the page marks it stale, clears
`reportReady`, pauses saving, and keeps the old pages visible as explicitly
stale evidence. A terminal event queues a new preparation. Events arriving
while the native save dialog or save modal owns the screen rebuild immediately
after that operation instead.

Main repeats the relevant-AI and snapshot-fingerprint checks immediately before
saving. Any data change after review returns `STALE_PREVIEW`; it never writes a
newly rebuilt or unreviewed report behind the user's back.

## Saving

The filename suggestion is based on the building title for one property, or the
project client for a multi-building report. `chooseReportExportPath` opens the
native `.docx` save dialog and returns only a sender-bound, one-use `exportId`;
the renderer never receives or submits an arbitrary filesystem path.

`exportPropertyReport(previewId, exportId, { allowValidationErrors })` resolves
the exact cached artifact, verifies AI/fingerprint/validation state, consumes
the path authorization, and passes the artifact buffer directly to
`writeFileAtomically`. The adjacent pending file is flushed before it replaces
the destination, so a failed write preserves an existing report. The artifact
itself remains available for another save; only the selected destination token
is one-use.

The save modal covers only the durable write and names the completed path. It
does not hide a second document build. See [word-export](word-export.md) and
[electron-main-process](electron-main-process.md#report-preview-and-save).

## Screen-only shell and security policy

`styles/property-report.css` styles the sticky toolbar, validation panel,
status/error cards, Word-preview canvas, and save modal. Document formatting and
page dimensions come from the OOXML interpreted by `docx-preview`, not from a
second report stylesheet. The page still carries its own
`[hidden] { display: none !important }` rule because it does not load the global
stylesheet.

The page keeps `script-src 'self'`; the viewer bundles load from packaged local
files. It alone permits inline styles and blob/data fonts because
`docx-preview` materializes DOCX styles and embedded fonts at runtime. Images
permit local, blob, and data sources. See [styles](styles.md).
