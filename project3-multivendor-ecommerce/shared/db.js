/**
 * Each microservice owns its own SQLite database file (database-per-service pattern).
 * Uses Node's built-in node:sqlite (Node 22.13+), so nothing needs compiling.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function open(name) {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, `${name}.db`));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

/** Runs fn inside a transaction; rolls back if it throws. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

module.exports = { open, tx };
