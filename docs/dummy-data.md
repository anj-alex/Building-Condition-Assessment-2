# Dummy data (`data/dummy_data.sql`)

Sample rows for development and demonstration. Sources:

1. **`./load-local-db.sh`** — always loads this file into a standalone scratch DB (see [local-db-loader](local-db-loader.md)).
2. **Dev app (`npm start`)** — on first open of an empty DB (no project rows, including soft-deleted), `src/db.js` seeds this file when `!app.isPackaged`.

**Packaged releases never load this file.** It is omitted from the asar, and `initializeDatabase` defaults `seedDummyData` to `false` when `app.isPackaged` is true. Callers may still pass `seedDummyData: true|false` explicitly (tests do).

## Firm

Replaces the firm row with id 1: `Amu Ahmad Inspection Inc.`, short name `NBC`, address in Richmond Hill, ON. No logo path.

## Projects

Two projects (using `INSERT OR IGNORE` to avoid clobbering existing rows):

- `1001` — Riverbend Property Group
- `1002` — Maple Ridge School District

## Buildings

Three buildings across the two projects:

- `1001` (project 1001) — Riverbend Office Tower, 1200 West Georgia Street, Vancouver, BC. 18 floors, built 1988, assessed 2026-03-12, 18,450.5 m².
- `1002` (project 1001) — Cedar Plaza Retail Centre, 4550 Kingsway, Burnaby, BC. 2 floors, built 2003, assessed 2026-03-19.
- `1003` (project 1002) — Maple Ridge Secondary School, 21911 122 Avenue, Maple Ridge, BC. 3 floors, built 1976, assessed 2026-04-04.

## Executive summary

A full twelve-field executive summary for building `1001` (Riverbend Office Tower). The text describes accessibility, designated substances, architectural/structural, plumbing, mechanical, electrical, fire/life safety, site, code compliance, immediate concerns, facility overview, and capital needs. Buildings 1002 and 1003 have no executive summary rows.

## Assets

~25 assets for building 1001 spanning every Uniformat level-1 group (A Substructure through G Site Work), plus one asset each for buildings 1002 (Exterior Wall Assembly) and 1003 (Interior Floor Finishes).

Each row includes:

- `uniformat_pricing_id` via `SELECT MIN(pricing_id) FROM uniformat_pricing WHERE level_2_code = '...'`
- vintage, service life, description, recommendation
- constrained UI fields aligned with home-page dropdowns: `condition_rating`, `priority` (`High` / `Medium` / `Low`), `action` (from `ACTION_TYPES`), `conservation_lens`, `unit_measure` (term is always derived, not stored)
- `action_year` (integer calendar year, or null when not applicable) and `opinion_of_probable_cost` (a plain number, or null to let the engine derive it from quantity × catalogue unit price)

Horizon language such as “End of Life” is stored on `term`, not `priority`. Legacy free-text actions like “Further Review” / “Allowance” are mapped to `Investigate` / `No Action` with `unit_measure = 'Allowance'` where appropriate.

**Level-2 codes are picked to match each asset's name, then for catalogue breadth.** The code is what the report tables and the AI executive-summary sections group by (see [executive-summary](executive-summary.md)), so a switchgear asset pointed at a `D20 Plumbing` row shows up under Plumbing everywhere — which is what the building-services codes used to do. Every level-1 group A–G and every level-2 code D10–D50 now resolves at least one asset for building 1001.

Three assets are still filed for breadth rather than strict accuracy, all *within* the right level-1 group so no section is affected: `Acoustic Ceiling Clouds & ACT` on `C20 Stairs`, `Landscaping, Irrigation & Site Furnishings` on `G40 Site Electrical Utilities`, and `Loading Dock Levelers & Bumpers` on `E20 Furnishings` — each is the only asset exercising that level-2 code.

All asset inserts use `INSERT OR IGNORE` so re-running the script is safe. Rebuild with `./load-local-db.sh` after changing this file.
