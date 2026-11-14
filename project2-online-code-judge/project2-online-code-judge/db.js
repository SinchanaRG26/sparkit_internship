/** SQLite (built into Node 22+). One file, WAL mode, foreign keys on. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'judge.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS problems (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  difficulty    TEXT NOT NULL CHECK (difficulty IN ('Easy','Medium','Hard')),
  statement     TEXT NOT NULL,
  input_format  TEXT NOT NULL DEFAULT '',
  output_format TEXT NOT NULL DEFAULT '',
  time_limit_ms INTEGER NOT NULL DEFAULT 2000,
  memory_mb     INTEGER NOT NULL DEFAULT 256,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS testcases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  input      TEXT NOT NULL,
  expected   TEXT NOT NULL,
  is_sample  INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tc_problem ON testcases(problem_id, position);
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id   INTEGER REFERENCES problems(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'SUBMIT',      -- SUBMIT (judged) or RUN (custom input)
  language     TEXT NOT NULL,
  code         TEXT NOT NULL,
  custom_input TEXT,
  status       TEXT NOT NULL DEFAULT 'QUEUED',
  passed       INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  time_ms      INTEGER,
  memory_kb    INTEGER,
  result       TEXT,                                -- JSON: per-test details, compiler output
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status, id);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sub_problem ON submissions(problem_id, kind, status);
`);

/** Run fn inside one write transaction. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx, DATA_DIR };
