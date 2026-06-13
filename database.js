const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'wa-manager.db');
let db = null;
let saveTimer = null;

function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 500);
}

async function init() {
  if (db) return;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wa_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      phone TEXT,
      status TEXT DEFAULT 'disconnected',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      author TEXT,
      body TEXT,
      timestamp INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_account_chat ON messages(account_id, chat_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp)`);

  debouncedSave();
}

// Mimic better-sqlite3's prepare().get/all/run() synchronous API
function prepare(sql) {
  if (!db) throw new Error('Database not initialised — await db.init() first');

  const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)/i.test(sql);

  return {
    get(...args) {
      const params = args.flat();
      const stmt = db.prepare(sql);
      if (params.length) stmt.bind(params);
      const ok = stmt.step();
      const row = ok ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },

    all(...args) {
      const params = args.flat();
      const stmt = db.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },

    run(...args) {
      const params = args.flat();
      db.run(sql, params.length ? params : undefined);
      const lastInsertRowid = db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]?.[0] ?? null;
      const changes = db.getRowsModified();
      if (isWrite) debouncedSave();
      return { lastInsertRowid, changes };
    },
  };
}

// Compatibility stub — sql.js doesn't need pragma
function pragma() {}

// For raw multi-statement DDL (not used after init, but kept for safety)
function exec(sql) {
  if (!db) throw new Error('Database not initialised');
  db.run(sql);
  debouncedSave();
}

module.exports = { init, prepare, pragma, exec };
