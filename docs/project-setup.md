# Project setup (`src/project-setup.js`, `pages/project-setup.html`)

Minimal create/edit form for a project. A project currently stores only a `client` name.

## Entry

- **New project**: `openProjectSetup()` loads `project-setup.html` with no hash. `activeProjectId` is null until the first autosave creates the row.
- **Edit project**: `openProjectSetup(projectId)` loads the page with `#<projectId>`. `activeProjectId` is parsed from the hash.

## Form

Hidden “Project number” field (readonly) and a `client` text input. Edit mode fills the client field, sets the title to “Edit project”, and mounts Delete.

## Autosave + history

No Save/Cancel buttons. Uses `createFormAutosave` (see [editing-model](editing-model.md)):

- Debounced input (~400ms); immediate save on change/Enter
- **New project:** first save calls `createProject`, sets `activeProjectId` and `location.hash`
- **Back** flushes pending edits before `goHome`
- Field updates record coalesced `project-update` undo steps; Delete remains undoable as `project-delete`. The deletion also persists its visibility snapshot, so **Settings → Recover deleted projects** can restore it after a restart without bringing back child rows that were deleted before the project.
