-- Frozen snapshot of data/schema.sql at commit 43337a9 ("Add capital planning
-- engine..."), an unreleased dev shape that carries no user_version but already
-- has the v2 asset columns. Databases in this shape exist on machines that ran
-- a dev build between 1.0.2 and 2, and migrating one must not blank those
-- columns out. Do not edit.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    client                  TEXT,
    hidden                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS firm (
    id                      INTEGER PRIMARY KEY,
    name                    TEXT NOT NULL,
    short_name              TEXT,
    address_line_1          TEXT,
    address_line_2          TEXT,
    logo_path               TEXT,
    logo_original_name      TEXT
);

CREATE TABLE IF NOT EXISTS building (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id              INTEGER NOT NULL REFERENCES project(id),
    property_name           TEXT,
    address                 TEXT,
    city                    TEXT,
    province                TEXT,
    province_short          TEXT,
    postal_code             TEXT,
    gross_floor_area_m2     REAL,
    property_vintage        INTEGER,
    date_of_assessment      TEXT,
    num_floors              INTEGER,
    location_factor_province TEXT,
    location_factor_city     TEXT,
    location_factor          REAL NOT NULL DEFAULT 1,
    current_replacement_value REAL,
    hidden                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS executive_summary (
    building_id                 INTEGER NOT NULL REFERENCES building(id),
    accessibility               TEXT,
    architectural_structural    TEXT,
    plumbing                    TEXT,
    mechanical                  TEXT,
    electrical                  TEXT,
    fire_life_safety            TEXT,
    site                        TEXT,
    code_compliance             TEXT,
    capital_needs               TEXT,
    hidden                      INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executive_summary_building_id ON executive_summary(building_id);

CREATE TABLE IF NOT EXISTS asset (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id                 INTEGER NOT NULL REFERENCES building(id),
    uniformat_pricing_id        TEXT REFERENCES uniformat_pricing(pricing_id),
    asset_name                  TEXT,
    vintage                     INTEGER,
    service_life                INTEGER,
    description                 TEXT,
    recommendation              TEXT,
    condition_rating            TEXT,
    fci                         TEXT,
    priority                    TEXT,
    action                      TEXT,
    term                        TEXT,
    conservation_lens           TEXT,
    unit_measure                TEXT,
    quantity                    REAL,
    unit_cost_override          REAL,
    life_adjustment_years       INTEGER NOT NULL DEFAULT 0,
    allowance_interval_years    INTEGER,
    action_year                 INTEGER,
    opinion_of_probable_cost    REAL,
    hidden                      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uniformat_pricing (
    pricing_id                  TEXT PRIMARY KEY,
    level_1_code                TEXT NOT NULL,
    level_1_description         TEXT NOT NULL,
    level_2_code                TEXT NOT NULL,
    level_2_description         TEXT NOT NULL,
    level_3_code                TEXT NOT NULL,
    level_3_description         TEXT NOT NULL,
    level_4_code                TEXT NOT NULL,
    level_4_description         TEXT NOT NULL,
    material                    TEXT,
    mean_service_life           INTEGER,
    practical_life              INTEGER,
    unit_price                  TEXT,
    unit_of_measure             TEXT
);

CREATE TABLE IF NOT EXISTS asset_image (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    original_name   TEXT,
    caption         TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    hidden          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS building_image (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     INTEGER NOT NULL REFERENCES building(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    original_name   TEXT,
    caption         TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    hidden          INTEGER NOT NULL DEFAULT 0
);
