# Editing model: autosave + undo/redo

**Intended behaviour for all workspace editing in this app:** changes persist automatically (autosave), and the user can reverse or re-apply them with undo/redo. There are no “Save” buttons on data-entry forms. An explicit in-app navigation, panel rebuild, or normal operating-system window close first flushes every pending renderer draft. A failed write leaves the current editor mounted, dirty and retryable; the navigation or close does not proceed silently.

## Autosave

| Surface | Where | Notes |
|---------|--------|--------|
| Assets | Home asset form | Debounced ~400ms; flush on leave; blocked until the latest Uniformat cascade settles |
| Building / property | Building info | Create on first save when new; hash updated; photos enable after create |
| Project | Project setup | Create on first save when new |
| Firm | Firm setup | Text fields autosave; logo choose/remove persist immediately |
| Executive summary | Executive summary | AI-generated text is marked dirty and autosaved |
| Image captions | Gallery | Per-caption autosave; its registered flusher stays armed through debounce and IPC, and flushes before gallery close/rebuild, caption regeneration, and home `pagehide` |
| Photo annotations | Gallery | Persist on place/remove; failed writes stay retryable and block teardown/close |

Status lines show **Saving…** / **Saved** / **Save failed**.

Shared helper: `createFormAutosave` in `src/shared.js` (building, project, firm, executive summary). Asset forms keep a dedicated controller in `src/renderer-asset-form.js`. All of them, plus the coordinated gallery caption/annotation drafts, register one flush function with the renderer-draft registry in `src/shared.js`; callers do not need to know which editor is currently dirty.

### Flush before leave

Back buttons on form pages call `flushAndLeave` (or equivalent): cancel the debounce timer, write until the form reaches a clean revision, then navigate. Home tab changes, asset-list rebuilds and gallery close/navigation cross the same flush seam before changing state or removing DOM. A write that rejects keeps its dirty revision and visible status so the next action can retry it. Edits made while a forced write is in flight are included in another write before teardown completes.

### Window close handshake

A `BrowserWindow` close is initially canceled in the main process. Main sends an
`app:close-requested` message with a monotonically increasing request id;
`shared.js` awaits the same app-wide draft registry used by navigation and then
invokes `app:close-response`. Main accepts an acknowledgement only from the
window and request id that own the close attempt. It destroys the window only
after `{ ok: true }`, so a debounce timer or in-flight save cannot be overtaken
by shutdown. The registry uses an all-settled barrier: one failed editor is
reported only after sibling writes have finished. Every renderer page loads
`shared.js` after the named IPC surface.

The wait is bounded at 10 seconds. A rejected flush reports `{ ok: false }`
immediately; a missing response reaches the timeout. Either case opens an
**Changes are not saved yet** dialog with **Keep Window Open** as the safe
default and **Close Without Saving** as the explicit forced path. Keeping the
window clears the attempt so the user can fix the problem and retry. Duplicate
close clicks do not create competing requests.

`pagehide` still requests a best-effort force-flush, but the browser cannot make
an asynchronous `pagehide` handler part of the close guarantee. Renderer/main
crashes, `app.exit`, `BrowserWindow.destroy`, an operating-system process kill,
and **Close Without Saving** are forced termination paths and remain outside
the guarantee.

## Undo / redo

- **Shortcuts:** `Ctrl/Cmd+Z` undo; `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redo (`src/shared.js`). While focus is in a text field, the browser’s native text undo takes precedence for typing; app history still applies when focus is elsewhere.
- **Renderer drafts first:** before calling main-process history, app history awaits every registered renderer flush. A pending checkbox/select edit therefore becomes the newest database history entry and is the edit that Undo reverses. If any flush fails, Undo/Redo is not sent and an error toast explains why.
- **Stacks:** in-memory main-process only (`src/undo-history.js`), max 50 each. Session lifetime — not persisted across restarts.
- **Coalescing:** consecutive field updates to the **same** entity within ~4s (`UPDATE_COALESCE_MS`) share one undo step (earliest `before` kept). After undo/redo, an entry that already has an `after` snapshot is never coalesced into.
- **Branching:** any new recorded mutation clears the redo stack.
- **Field-update types:** `asset-update`, `building-update`, `project-update`, `executive-summary-update`, `firm-update`. Undo captures current row as `after`, restores `before`; redo restores `after`.
- **Delete types** (soft-delete / snapshot restore): asset, asset photo, building photo, building, project, executive summary clear. Same as before; see [home-page](home-page.md) for UI feedback (toasts vs dialog).
- **Project recovery:** Settings records a `project-recovery` history step when it restores a deleted project. Undo hides the same snapshot again; redo restores it again. The durable snapshot itself remains in the database while the project is deleted, so this recovery is also available after restarting.

Creates (new project/building/asset rows) are not themselves undo steps; they clear redo. Deleting those entities is undoable.

Stacks clear on full data import and when the DB file is replaced (`db:ensureCurrent` with `changed: true`).

## Out of scope (not form autosave)

- Settings backup/export (“Save backup…”); this replaces the whole workspace
  through its own durable transaction, not the form undo stack. See
  [app-data-backups](app-data-backups.md).
- Property report Word export
- One-shot dialogs (confirm delete, file pickers)

## Implementation map

| Concern | Module |
|---------|--------|
| Form autosave controller | `src/shared.js` → `createFormAutosave` |
| Cross-editor flush seam | `src/shared.js` → `registerRendererDraftFlusher`, `flushPendingRendererDrafts` |
| Graceful window close | `src/main/window-close.js` + `app:close-requested` / `app:close-response` |
| Gallery caption + annotation flush | `src/renderer-photos.js` → `flushPendingGalleryDraftSaves` |
| App history hotkeys + toasts | `src/shared.js` |
| Undo/redo stacks + coalesce | `src/undo-history.js` |
| Snapshots / equality | `src/db.js` (`*FieldsSnapshot`, `*PayloadEqualsSnapshot`) |
| IPC record + apply | `src/main.js` (`db:update*`, `history:undo`, `history:redo`) |
| Page reload after history | each page’s `app-undo` / `app-redo` listener |
