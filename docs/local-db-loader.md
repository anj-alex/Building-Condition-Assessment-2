# Local DB loader (`load-local-db.sh`, `scripts/write-uniformat-pricing-sql.js`)

A dev-only shell script that rebuilds a standalone SQLite database from the repo's schema, pricing CSV, and dummy data. This is **not** used by the running Electron app (which manages its own `app.db` under `userData`) — it exists to produce a inspectable database for manual testing or debugging outside the app.

## `load-local-db.sh`

```bash
./load-local-db.sh
```

Behavior:

1. Resolves the DB path from `$DB_PATH` or falls back to `${XDG_CONFIG_HOME:-$HOME/.config}/condition-assesment-report-generator/app.db` — the same path the Electron app uses on Linux.
2. Checks for `sqlite3` in `PATH` and verifies `data/schema.sql`, `data/dummy_data.sql`, and `data/uniformat_pricing.csv` exist.
3. `mkdir -p` the parent directory, `rm -f` the existing DB.
4. Pipes `data/schema.sql` into `sqlite3` to create tables.
5. Pipes the output of `scripts/write-uniformat-pricing-sql.js` (see below) into `sqlite3` to seed the pricing catalogue.
6. Pipes `data/dummy_data.sql` into `sqlite3` to insert sample rows.
7. Prints a confirmation message.

`set -euo pipefail` ensures the script aborts on any failure.

## `scripts/write-uniformat-pricing-sql.js`

A standalone Node script (no Electron dependencies) that reads `uniformat_pricing.csv` and writes SQL statements to stdout. This is the CLI counterpart of `src/db.js`'s `seedUniformatPricing` — both import the shared CSV parsing helpers from `src/lib/csv-utils.js`.

Usage (invoked by `load-local-db.sh`):

```bash
node scripts/write-uniformat-pricing-sql.js data/uniformat_pricing.csv | sqlite3 app.db
```

Output is a single transaction:

1. `BEGIN;`
2. Creates a temp table `current_uniformat_pricing_ids` and inserts every CSV pricing_id.
3. For each row: an `INSERT ... ON CONFLICT(pricing_id) DO UPDATE SET ...` upsert.
4. `DELETE FROM uniformat_pricing WHERE ... AND NOT EXISTS (asset reference)` — same orphan-protection as the in-app seeder.
5. Drops the temp table.
6. `COMMIT;`

`sqlValue` formats values for SQL: `NULL` for null, raw number for numbers, single-quoted with doubled quotes for strings. The CSV path can be passed as `argv[2]` and defaults to `../data/uniformat_pricing.csv` relative to the script.

## Relationship to the in-app seeder

Both code paths produce the same `uniformat_pricing` contents from the same CSV. The in-app `seedUniformatPricing` (in `src/db.js`) runs on every app launch and uses prepared statements; the CLI script emits raw SQL for piping into the `sqlite3` CLI. Both import the shared CSV parsing utilities from `src/lib/csv-utils.js` — the CLI script cannot import `src/db.js` directly because `db.js` depends on Electron's `app` module for the DB path.
