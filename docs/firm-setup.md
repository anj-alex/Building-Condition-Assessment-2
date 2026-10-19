# Firm setup (`src/firm-setup.js`, `pages/firm-setup.html`)

Edits the single `firm` row used across generated reports (cover page, headers, "prepared by" block). There is no concept of multiple firms — `db.getFirm` returns the first row by id or a hardcoded default (`Northstar Building Consultants`), and `updateFirm` upserts keyed on `current.id ?? 1`.

## Form fields

`name`, `short_name` (used as logo fallback text), `address_line_1`, `address_line_2`, and a logo picker. Text fields autosave; the logo is managed with explicit choose/remove actions that also persist immediately.

## Autosave + history

No Save/Cancel buttons. Uses `createFormAutosave` (see [editing-model](editing-model.md)). **Back** flushes pending text edits. Logo choose/remove flush text first, then update the firm row. All firm mutations (text and logo) record coalesced `firm-update` undo steps with a full firm field snapshot (including logo paths). Removed logos keep the file on disk so undo can restore `logo_path`.

## Logo import flow

The "Choose logo" button:

1. Flushes any pending text autosave via `updateFirm`.
2. Calls `importFirmLogo()`, which opens a single-file image dialog (`jpg/jpeg/png/webp`), copies the file into `firm-assets/` under `userData`, and upserts `logo_path` + `logo_original_name`.
3. Re-fills the form from the returned firm object, including the logo preview (`renderLogoPreview`).

`renderLogoPreview` shows an `<img>` when `logo_path` is set, otherwise “No logo selected.”
