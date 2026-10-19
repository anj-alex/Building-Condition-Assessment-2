# App-data backups

Settings can export the complete local workspace to a `.projectdata` file and
replace the current workspace from one. The implementation is
`src/app-data-io.js`; the IPC dialogs and destructive-replacement confirmation
are in `src/main/ipc-handlers.js`.

This is different from a schema-migration `.bak`: a `.projectdata` archive is a
portable user backup containing the database, photos and selected settings,
while a migration backup is an untouched SQLite file kept beside `app.db`.

## Archive format

`.projectdata` is a gzip-compressed tar archive. Save format version 1 permits
only these entries:

```text
app.db                         required, regular file
manifest.json                  optional for legacy/hand-made v0 saves
app-settings.json              optional
uniformat-pricing.csv          optional
asset-images/<one filename>    optional, flat regular files only
building-images/<one filename> optional, flat regular files only
firm-assets/<one filename>     optional, flat regular files only
```

`manifest.json` records `format: "condition-assessment-app-data"`, the format
version and export timestamp. An archive declaring a newer version is rejected.
Export obtains `app.db` through better-sqlite3's backup operation, so it is a
transaction-consistent, self-contained SQLite copy rather than a live-file copy
separated from a journal/WAL sidecar. The completed archive is flushed to an
adjacent pending file and atomically renamed over the chosen destination, so a
failed export cannot truncate an older good backup at that path.
Regular files are opened read/write for the flush because Windows cannot flush
a read-only file handle. File-flush errors remain fatal; only directory flushes
that the host filesystem does not support are treated as best effort.

## Validation before replacement

Import extracts only into a temporary staging directory. It rejects absolute,
backslash, dot-segment, nested and unexpected entry paths; duplicate entries
(including case or Unicode-normalization aliases that would collide on another
supported filesystem);
links, devices and every other non-file/non-directory tar type. Directories are
limited to the three media roots above. The extracted tree is checked again with
`lstat` before any live path is touched.

Resource bounds are intentionally much larger than a normal assessment while
remaining finite:

- compressed archive: 20 GiB;
- 50,000 entries and 50 GiB total extracted bytes;
- `app.db`: 8 GiB;
- each media file: 512 MiB;
- settings/pricing file: 64 MiB; manifest: 1 MiB;
- archive path: 1,024 UTF-8 bytes;
- at least 512 MiB remains free beyond the declared install size.

The staged database must pass SQLite `quick_check` and `foreign_key_check`.
Every stored media reference is then rebased by its owning table:

| Database field | Required archive directory |
|---|---|
| `asset_image.file_path` | `asset-images/` |
| `building_image.file_path` | `building-images/` |
| `firm.logo_path` | `firm-assets/` |

The foreign machine/profile prefix is discarded, but the expected directory
must be the final parent and the basename must be a portable single filename.
The referenced staged path must exist as a regular non-symlink file. Thus a
normal Windows backup imports on Linux (and vice versa), while arbitrary local
paths, `..`, misleading `not-asset-images` segments and missing media reject the
whole archive before replacement.

Any imported `uniformatPricingCsvPath` is rewritten to the included local
`<userData>/uniformat-pricing.csv`; the original source name/path remain display
metadata only.

## Crash-safe replacement

After staging succeeds, import closes SQLite and records the exact pre-import
inventory in `<userData>/.import-journal.json`. It then moves the live managed
paths into `<userData>/.import-rollback` with same-volume atomic renames. A
rename failure aborts and rolls back the import; it never falls back to a
potentially partial copy. Import then installs the staged set, opens it through
the normal schema/integrity checks, and flushes installed files. The journal
phases are:

1. `snapshotting` — an interruption restores whichever originals have already
   moved and leaves originals not yet moved in place;
2. `installing` — an interruption removes partial imported paths and restores
   the complete prior inventory;
3. `committed` — installed files were flushed; an interruption only finishes
   deleting rollback metadata.

`src/main.js` calls `recoverInterruptedImport()` before the first database open.
That ordering is load-bearing: if a crash moved `app.db`, SQLite must not see an
absent path and create a fresh empty database over the recovery situation.

The rollback directory is deleted only after a completed commit or completed
rollback. A rollback directory without its journal is ambiguous and is never
silently deleted; startup stops and tells the operator to preserve it and
contact support.

`test/app-data-io.test.js` and `test/file-durability.test.js` cover cross-machine
rebasing, invalid paths, missing media, links/unexpected entries, resource
bounds, Windows-compatible file flushing, database-integrity failure, snapshot
and locked-file fault injection, and both restart-recovery outcomes.
