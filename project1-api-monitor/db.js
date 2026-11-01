/**
 * Database layer (SQLite via Node built-in node:sqlite).
 * Tables: endpoints, checks, alerts, incidents
 */
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+ (no install/compile needed)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'monitor.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS endpoints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 30,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  status      INTEGER NOT NULL,
  ms          INTEGER NOT NULL,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_ep_ts ON checks(endpoint_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL,   -- DOWN | RECOVERED | SLOW | TEST
  message     TEXT    NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,            -- NULL while the outage is ongoing
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_ep ON incidents(endpoint_id, started_at);
`);

module.exports = db;
