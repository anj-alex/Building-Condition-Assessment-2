# Building info (`src/building-info.js`, `pages/building-info.html`)

Create/edit form for a building (property) under a project. Buildings are the unit that assets, executive summaries, property photos, and reports attach to.

## Entry

- **New building**: `openBuildingInfo(projectId)` loads `building-info.html#<projectId>`. `activeProjectId` is set, `activeBuildingId` is null until the first autosave creates the row.
- **Edit building**: `editBuildingInfo(projectId, buildingId)` loads `building-info.html#<projectId>:<buildingId>`. Both ids are parsed from the hash by `getActiveIds` (split on `:`).

## Form fields

Client (read-only display, fetched from the project), `property_name`, `address` (textarea), `city`, `province`, `province_short`, `postal_code`, `gross_floor_area_m2` (positive number), `property_vintage` (whole year ≥1800 and no later than assessment), `date_of_assessment` (real non-future date), `num_floors` (positive whole number), cost location factor (select from `listLocationFactors` plus a positive custom numeric `location_factor`, default `1.0`), optional positive `current_replacement_value` CRV override, and a property photos section. Autosave keeps partial drafts; these semantic ranges are enforced at the pre-export report boundary rather than making an unfinished form impossible to save. Field rows use a two-column grid (`field-row`); see [styles](styles.md). Location factor and CRV feed capital planning — see [capital-planning](capital-planning.md).

## Autosave + history

See [editing-model](editing-model.md). Uses `createFormAutosave`:

- `input` debounced (~400ms); `change` / Enter-submit save immediately
- Blocked until location factors load and (edit mode) the building is hydrated
- **New property:** first save calls `createBuilding`, sets `activeBuildingId`, updates `location.hash`, enables photos, shows Delete
- **Back** flushes pending dirty state before navigating home; `pagehide` also force-flushes. Home restores a building selection only when the opener stored one via `setHomeReturnBuildingId` (e.g. **Add new property** from the asset view). Edit / Add from the property list clear that key, so Back returns to the property list.
- Field updates record coalesced `building-update` undo steps; Delete / photo delete remain undoable

## Property photos

Photos require a building id, so **Add photos** stays disabled until the first autosave creates the row (or when opening an existing building). Empty preview copy: “Start editing to create this property, then add photos.”

Clicking “Add photos” calls `importPropertyImages(activeBuildingId)`, which opens a multi-select image dialog in the main process, copies each file into `building-images/`, inserts `building_image` rows with incrementing `sort_order`, and returns the refreshed list.

## Bootstrap

`loadProjectClient` fills the read-only client display. `loadBuilding` (edit mode only) populates fields and mounts Delete. `loadBuildingImages` renders the photo grid. Location factors load first; then building hydrate; then autosave is enabled.
