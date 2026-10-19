# Home page (`src/renderer*.js`, `pages/index.html`)

The index page is the app's hub: it lists projects, lists properties under a selected project, and hosts the asset editor for a selected building. All DOM is built imperatively — the HTML provides only the structural scaffolding (`#projects-section`, `#property-list-wrap`, `#building-detail-section`, etc.).

The page loads three scripts, in this order, which is also the dependency order:

| File | Owns |
|---|---|
| `src/renderer-asset-form.js` | The asset editor: field schema and dropdown option lists, the Uniformat cascade, generated Description / Recommendation panels, and the autosaving per-asset form with its controller registry |
| `src/renderer-photos.js` | Photos: the asset photo strip, annotated thumbnails, and the full-screen gallery with its caption panel and box/arrow editor |
| `src/renderer.js` | Everything else, as the page controller: `homeState`, project and property lists, the building detail header and tabs, the asset list, undo/redo handling, and `bootstrap` |

They share one global scope, so the split is by concern rather than by visibility, and the load order matters in exactly one way: a top-level `const` may only read bindings from a script that has already run (which is why `src/renderer-photos.js`, not `renderer.js`, unpacks `window.photoAnnotations`). `test/page-scripts.test.js` fails on both a collision and a forward read.

## State (`homeState`)

A single module-level object holds everything:

- `projects`, `buildings`, `uniformatLevel1Groups` — cached lists from the API.
- `assets`, `assetImages` (Map by asset id), `buildingImages` (Map by building id).
- `selectedProjectId`, `selectedBuildingId` — current selection (numbers or null).
- `activeBuildingTab` — the currently selected Uniformat level-1 group name (e.g. `"A Substructure"`). Drives which assets are shown.
- `openAssetIds` — Set of asset ids whose form is expanded.
- `assetsLoading`, `assetLoadToken` — loading flag and a token to cancel stale loads.
- `galleryAssetId`, `galleryImageIndex` — lightbox state for the asset image gallery.

## Bootstrap and sync

`bootstrap()` reads the project id from `location.hash` (e.g. `#1001`) and calls `syncHome(requestedProjectId)`. `syncHome` fetches projects + level-1 groups in parallel, resolves the requested selection against the real project list, fetches buildings + building images for the selected project, resolves the building selection, resets `activeBuildingTab` to the first level-1 group if the current tab is no longer valid, then renders and loads assets.

**`syncHome` is concurrency-safe in two separate ways**, because it reads the whole home graph over IPC *before* it assigns any of it, and three things start one: selecting a project, finishing an Excel import, and `refreshHomeIfDatabaseChanged` (fired on window focus / visibility change). A 4,000-row import makes every window here wide — one `listBuildingImages` call per building, 27 of them for the sample workbook — and the symptom of getting either wrong is the same: the project deselects itself and the property list goes blank immediately after a successful import.

- **Last writer must not be the slowest writer.** Each call takes a `homeSyncToken` and abandons its result if a newer `syncHome` has started since. Without it a slow sync lands second and overwrites a newer one's selection.
- **"Keep the current selection" means the last one *requested*, not the last one *rendered*.** `syncHome`'s default arguments come from `homeSyncRequest`, not `homeState`. A sync that is still fetching has not written to `homeState` yet, so a background refresh that defaulted from `homeState` mid-flight picked up the *pre-selection* value — and, being the newest sync, the token guard then made it win. `selectProject` toggles against `homeSyncRequest` for the same reason: clicking twice quickly must deselect, not re-select a sync still in flight.

`test/renderer-home.test.js` covers both orderings, and each test was checked to fail with only its own fix removed.

`selectProject` toggles selection (clicking the selected project deselects it). `selectBuilding` toggles building selection, resets the tab and open assets, and loads assets for the new building.

## Rendering pipeline

`renderHome()` → `renderProjectList` + `renderPropertiesSection` + `renderBuildingDetail`.

### Project list (`renderProjectList`)

Renders a natural list of native toggle buttons (`aria-pressed` reflects the current selection). Each row shows the client name (or `Project #<id>` as fallback) and separate inline edit/delete buttons. Selecting a project calls `selectProject`; after the async list refresh, focus returns to the replacement project button instead of falling back to the document body.

### Property list (`renderPropertyList`)

For each building: title, address line, a 2×2 thumbnail preview (up to four photos; `+N` fills the fourth cell when there are more), and a vertical stack of icon actions — edit (pencil), **Exec Summary**, **Generate report**, and **Delete**. The name/address/thumbnail surface is one native toggle button and the four actions are sibling buttons, so there are no nested controls and every operation is keyboard reachable. Selecting a property opens its assets and moves focus to the active building-section tab; deselecting returns focus to the property button.

The Properties panel header holds **Import from Excel**, **Generate project report**, and **Add new property**. It is disabled until a project with at least one building is selected, and opens `openProjectReportPicker` — a modal (`.home-modal`) with a checkbox per building, all checked, plus Select all / Clear all. Tab and Shift+Tab stay inside the picker. Escape (captured, so it closes the picker before page-level handlers see the key) and a backdrop click cancel, then focus returns to **Generate project report**. The Generate button counts the selection and is disabled at zero. Generating calls `openPropertyReport(projectId, ids)` with the checked ids **in list order**, producing one report document that contains every selected building. See [property-report](property-report.md).

**Import from Excel** (`runExcelImport`) is enabled as soon as a project is selected — it needs a project to import into, not existing properties. It calls `importBcaWorkbook(projectId)`; the main process drives the whole flow with native dialogs (file choice, a preview, the New/Update decision, and the commit). On success the property list is refreshed via `syncHome` and a toast summarizes what was created or updated. A failed import is toasted too: the handler reports it in a native dialog on the UI path, but that dialog is invisible to anything driving the app, and leaving the screen unchanged made a failed import indistinguishable from one that did nothing — so `runExcelImport` also surfaces a `canceled` result that carries an `error`. See [excel-import](excel-import.md).

### Building detail (`renderBuildingDetail`)

Shown when a building is selected. Hides the sidebar (via `.has-building-selection` class on `home-main`). Renders:

1. **Header** — Back button, project title, and a `<details>` property picker menu to switch between buildings without returning to the list.
2. **Tabs** — one per Uniformat level-1 group (`getBuildingSectionTabs`), sourced from `homeState.uniformatLevel1Groups`. Clicking a tab sets `activeBuildingTab` and reloads assets. Left/Right Arrow wraps between tabs, Home/End jumps to the first/last tab, and focus is restored to the newly rendered active tab after its asset load.
3. **Asset list** (`renderAssetList`) — toolbar with heading + "Add asset" + "Open all" / "Close all", then a list of asset rows. Each row shows the asset name, a summary line (`level_2_group_element | Condition: … | Action: …`), and up to three image thumbnails. Clicking a row toggles its form open/closed.

### Asset form (`createAssetForm`)

A 20-column CSS grid form. Fields (from `assetFields`):

- `asset_name` (primary, span 12)
- `vintage`, `service_life` (compact, span 4 each)
- `condition_rating`, `priority`, `action`, `conservation_lens`, `unit_measure` (fifth, span 4 each)
- `quantity`, `unit_cost_override`, `life_adjustment_years`, `allowance_interval_years`, `action_year` (Action Year Override), `opinion_of_probable_cost` (OPC Override) — numeric capital-planning inputs
- `include_as_not_assessed` (checkbox, wide) — opt a blank/incomplete asset into the report as a "Not Assessed" page; blank assets are otherwise excluded (see [property-report](property-report.md))
- An **Asset calculation preview** calls `previewAssetPlan` (shared engine via IPC) for catalogue/adjusted cost, OPC, condition grade, age, remaining life, replacement year, effective action year/source, recurrence/source, derived term (`Not scheduled` when `No Action` suppresses the asset), and building FCI for 0–2 / 0–5 / 0–10 / 0–25 years
- Generated **Observations & Description** and **Recommendations** sections (preview + final textareas)

There is no per-asset term control: **term is always derived** from the
scheduled action year and shown read-only in the calculation preview. Dropdown
option lists live in `src/renderer-asset-form.js` (`CONDITION_RATINGS`,
`PRIORITY_VALUES`, `ACTION_TYPES`, `CONSERVATION_LENS_VALUES`,
`UNIT_MEASURE_VALUES`). There is no per-asset FCI control. Formulas are
documented in [capital-planning](capital-planning.md).

When the asset has no vintage, the field displays the building's
`property_vintage` as an editable fallback, but that value is not persisted or
reported as an assessor-entered component vintage unless the user changes the
field. New assets do persist the first pricing row's mean service life
(practical-life fallback).

Four cascading `<select>` dropdowns for the Uniformat hierarchy (level 2 → 3 → 4 → material) are inserted after the `service_life` field and hydrated by `hydrateUniformatSelectors`. Changing a parent resets/reloads its children. Each cascade has a generation token: a late response for an older parent is ignored, and an asset flush awaits the newest generation before it snapshots the form. Level 4 deliberately resets to blank after a parent change, so leaving is blocked with “Choose a material to save” until the assessor completes the hierarchy; the old material is never silently written under the new parent. A hydration/request failure is shown in the asset status line with **Retry pricing choices**; retry starts a fresh generation, and a success re-enables autosave and flushes edits made while pricing was unavailable. Material options carry catalogue unit and mean/practical life metadata. Pricing changes refresh `service_life` (mean, then practical) and `unit_measure` only until the assessor touches that field; programmatic prefills do not masquerade as user edits in `dirtyFields`.

Unit mappings cover the catalogue vocabulary (`Set`, `Per Floor`, `Per Point`, `Per Hose`, `Per Toilet`) and assessor-specific item units (`Per Tread`, `Per Rung`, `Per Starter`) in addition to EA / square feet / linear feet / allowance / lump sum.

There is no Save button. The form autosaves through `updateAsset`; input/change activity is debounced by about 400 ms and Enter-submit requests an immediate save. Before a tab change, list rebuild, photo-list rebuild or other home transition, the page controller flushes every registered renderer draft and disposes the asset controllers only after all writes succeed. A rejected write keeps the old tab/form mounted with its dirty fields so it can be retried. After a successful save, `homeState.assets` and the collapsed row header are updated in place (no full list reload, so focus is preserved). A live status line shows Saving… / Saved / Save failed. Saves are skipped while Material (`uniformat_pricing_id`) is empty during ordinary editing; a forced leave is blocked so the row cannot disappear from JOIN-based asset lists. App-wide pattern: [editing-model](editing-model.md).

### Undo / Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y)

See [editing-model](editing-model.md) for the full stack (all field-update types + deletes). On the home page: restoring a deleted asset shows a blocking info dialog; other results use a toast. Listeners reload affected lists without jumping scroll (window + asset list). Asset history events carry `buildingId` and `level1Group` so the correct property and Uniformat tab are selected.

### Asset images (`createAssetImageSection`)

An "Add image" button triggers `importAssetImages(assetId)` (native file dialog in the main process). Images render as a grid; each image itself is a named button that opens the lightbox (`openImageGallery`), independent of its sibling include/delete controls. Each thumbnail has a top-left include toggle (`include_in_report`): green outline when the photo will appear in the exported report, red with a diagonal strike when excluded. The first six photos on an asset default to included; later imports default to excluded. A failed include/exclude write leaves the prior state in place and reports the failure in a toast instead of creating an unhandled renderer rejection. The top-right control soft-deletes the photo.

### Image gallery (`openImageGallery` / `renderImageGalleryNow`)

A full-screen modal overlay with prev/next navigation and a close button. Opening moves focus to Close, Tab/Shift+Tab stay inside the modal, Escape closes it, and Left/Right Arrow navigate photos unless focus is in a text editor. Closing restores focus to the thumbnail that opened it. Clicking the overlay backdrop also closes it; navigation wraps around modulo image count.

Gallery transitions first await `flushPendingGalleryDraftSaves`, which settles both caption and annotation drafts, then `renderImageGalleryNow` rebuilds the overlay and its window/document listeners. A rejected write therefore leaves the existing editor and combined error status on screen instead of removing it; normal window close crosses the same registry seam. The renderer assembles the gallery from `createGalleryStage` (photo + nav + annotation overlay), `createGalleryCaptionPanel` (side panel) and `createGalleryAnnotationEditor` (the two toolbars, drag-to-draw, session undo). It keeps only the wiring that spans them: the shared status line, palette dismissal, the resize handler, and re-measuring once the image has layout.

Beside the image (side panel): **filename** (`original_name`), index (`n of m`), resolution, an editable **Caption** textarea (`caption`, autosaved via `db:updateImageCaption` — debounced 450 ms and flushed immediately before gallery close/rebuild), and **Generate New Caption** (`ai:regenerateCaption` — requires the session AI key loaded at startup). The caption draft flusher remains registered through both the debounce and the outstanding IPC, so navigation/window close cannot overtake an ordinary autosave. Generate New Caption first forces the current manual draft through that same barrier; only after every older caption write has settled does it enqueue AI, preventing an old request from winning after the AI job's compare-and-set read. Caption and annotation updates mutate the same canonical image object in `homeState.assetImages`; neither can replace the object out from under the other editor, so a caption followed by an annotation remains visible on reopen. While an automatic or manually requested caption job is queued/running for that image, both the textarea and button are disabled and the status reads “Generating caption…”. Main-process status restores that busy state if the gallery opens mid-job; the terminal caption event re-enables both controls.

Below the caption controls are separate **Add box** / **Remove boxes** and **Add arrow** / **Remove arrows** controls plus a five-color palette for each shape type. Dragging on the visible photo stores image-relative fractions in `asset_image.bounding_boxes`: boxes use `{kind:'box',x,y,w,h,color}` and arrows use `{kind:'arrow',x1,y1,x2,y2,color}`. Immediate writes are serialized by annotation revision: an older response cannot claim a newer drawing as saved, and a forced gallery/window flush continues until the latest revision is durable. Failures remain registered for retry and block close/navigation rather than letting the visible shape disappear.

That shape contract lives in exactly one place, `src/lib/annotations.js`, because it spans the process boundary: the renderer draws annotations and `src/db.js` stores them. Both sides accept or reject a shape through the same `sanitizeAnnotation` (finite coordinates, fractions clamped to 0–1, boxes wider/taller than zero, arrows at least `MIN_ARROW_LENGTH` long, colour normalized to a 6-digit hex or `DEFAULT_ANNOTATION_COLOR`), so the gallery cannot draw a shape that the save would silently drop. `test/photo-annotations.test.js` asserts the draw path and the storage path keep accepting the same set. The module is loaded the same way as `property-report-rules.js` — an IIFE publishing `window.photoAnnotations` in the renderer, `module.exports` in the main process (see [property-report](property-report.md)).

The overlay is sized to the visible (letterboxed) picture — `positionGalleryBoxLayer` recomputes it on image load and window resize — so the fractions map 1:1 at every display size. Changes persist immediately via `db:updateImageBoundingBoxes` and reappear on property-report photos. Shapes placed during the current gallery session can be undone with `Ctrl/Cmd+Z` and redone with `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y`; caption text retains the browser's native text undo. The asset-pane thumbnails and collapsed asset-row previews draw the same colored annotations over contain-fitted previews and refresh live when annotations are saved.

## Asset loading (`loadActiveAssets`)

Uses a token (`assetLoadToken`) to race-proof concurrent loads: increments the token, clears current assets/images, renders the loading state, fetches assets for `(buildingId, activeBuildingTab)`, then fetches each asset's images in parallel via `Promise.all`. If the token has advanced by the time the responses return, the results are discarded. Finally renders the asset list and re-renders the gallery.

## Top actions and Settings

The home page top-right nav (`.home-top-actions`) has an **AI status** chip (left of Firm details: on / locked / off; opens Settings), **Firm details**, and a gear **Settings** button (`#open-settings` → `electronAPI.openSettings` → `settings:open`). When a building is selected, the nav is hidden with the rest of the hub chrome.

App version is **not** shown on the home canvas. It appears in the application **Help** menu (`Version x.y.z`) and in Settings **About** (expanded debug identity via `electronAPI.getAppInfo` / `app:getInfo`, plus copy-to-clipboard). See [electron-main-process](electron-main-process.md) and [database](database.md) versioning policy.

Appearance (Light / Dark / System), Uniformat pricing CSV, backup/restore, deleted-project recovery, and **About** live on the Settings page (`pages/settings.html`, `src/settings.js`). Backup/restore uses a portable, validated and crash-recoverable `.projectdata` workspace archive; see [app-data-backups](app-data-backups.md). The recovery card lists soft-deleted projects and returns a project with the properties, assets, and photos that were visible at deletion; items deleted separately beforehand remain deleted. Choosing a CSV copies it into the userData working path and updates display identity in `app-settings.json` (see [uniformat-pricing](uniformat-pricing.md)). Theme preference is applied by `src/theme.js` on every page (see [styles](styles.md)).

## `toFileUrl`

Converts an absolute file path to a `file://` URL for `<img src>`. Replaces backslashes (Windows), encodes URI components, and escapes `?` / `#` in the path. Used by both the home page and the property report.
