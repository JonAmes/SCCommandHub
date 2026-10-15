/**
 * SQLite schema for the Star Citizen item database and loadout calculator.
 * Idempotent: safe to run on every startup.
 */
export const SC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sc_ships (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    class_name     TEXT,
    manufacturer   TEXT,
    mass           REAL,
    cargo_capacity REAL,
    hardpoints     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hardpoints))
  );

  CREATE INDEX IF NOT EXISTS idx_sc_ships_name ON sc_ships (name);

  CREATE TABLE IF NOT EXISTS sc_components (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    type     TEXT,
    sub_type TEXT,
    size     INTEGER,
    grade    TEXT,
    class    TEXT,
    stats    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats))
  );

  CREATE INDEX IF NOT EXISTS idx_sc_components_type_size ON sc_components (type, size);

  CREATE TABLE IF NOT EXISTS sc_loadouts (
    loadout_id   TEXT PRIMARY KEY,
    ship_id      TEXT NOT NULL REFERENCES sc_ships (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    loadout_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(loadout_data)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sc_loadouts_ship ON sc_loadouts (ship_id);
`

/**
 * Create the SC tables on a better-sqlite3 database handle.
 * @param {import('better-sqlite3').Database} db
 */
export function initSCSchema(db) {
  db.pragma('foreign_keys = ON')
  db.exec(SC_SCHEMA_SQL)
  return db
}
