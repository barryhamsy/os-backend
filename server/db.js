const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Scale hardening for many concurrent users:
//  - WAL lets reads and writes proceed concurrently (default rollback journal
//    blocks readers during a write) — big win under load.
//  - busy_timeout makes a writer wait for a lock instead of throwing SQLITE_BUSY.
//  - synchronous=NORMAL is safe with WAL and much faster than FULL.
// NOTE: WAL creates database.db-wal and database.db-shm alongside the DB —
// keep those out of git (see .gitignore).
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA busy_timeout = 5000');
db.run('PRAGMA synchronous = NORMAL');

// Helper for promise-based queries
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  db.serialize(async () => {
    // 1. Users table (Admin & Resellers)
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'reseller')),
        credits REAL DEFAULT 0.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. CDKeys table
    db.run(`
      CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cdkey TEXT UNIQUE NOT NULL,
        appids TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        cost REAL DEFAULT 1.0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'used', 'disabled')),
        activated_by TEXT,
        activated_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);

    // Migration: store the game name alongside the AppID (ignored if column already exists)
    db.run(`ALTER TABLE keys ADD COLUMN game_name TEXT`, () => {});

    // Index the column computeEntitlements() filters on, so membership lookups
    // stay instant as the keys table grows into the thousands.
    db.run(`CREATE INDEX IF NOT EXISTS idx_keys_activated_by ON keys(activated_by)`);
    // 4. Activation Logs table
    db.run(`
      CREATE TABLE IF NOT EXISTS activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cdkey TEXT NOT NULL,
        steamid TEXT NOT NULL,
        appids TEXT NOT NULL,
        ip_address TEXT,
        activated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Fast lookups of a SteamID's activation history.
    db.run(`CREATE INDEX IF NOT EXISTS idx_activations_steamid ON activations(steamid)`);

    // 5. Member Unlocks table
    db.run(`
      CREATE TABLE IF NOT EXISTS member_unlocks (
        steamid TEXT NOT NULL,
        appid TEXT NOT NULL,
        added_at INTEGER,
        PRIMARY KEY (steamid, appid)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_member_unlocks_steamid ON member_unlocks(steamid)`);

    // 6. OneGamers OG Keys table
    db.run(`
      CREATE TABLE IF NOT EXISTS og_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cdkey TEXT UNIQUE NOT NULL,
        appid TEXT NOT NULL,
        game_name TEXT,
        created_by INTEGER NOT NULL,
        cost REAL DEFAULT 1.0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','used','disabled')),
        activated_by TEXT,
        activated_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_og_keys_created_by ON og_keys(created_by)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_og_keys_activated_by ON og_keys(activated_by)`);

    // 7. OneGamers OG Activations table
    db.run(`
      CREATE TABLE IF NOT EXISTS og_activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cdkey TEXT NOT NULL,
        steamid TEXT NOT NULL,
        appid TEXT NOT NULL,
        ip_address TEXT,
        activated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_og_acts_steamid ON og_activations(steamid)`);

    // Seed default admin if no users exist
    const row = await get("SELECT count(*) as count FROM users WHERE role = 'admin'");
    if (!row || row.count === 0) {
      const defaultPassword = 'admin123456';
      const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
      await run(`
        INSERT INTO users (username, password, role, credits)
        VALUES ('admin', ?, 'admin', 999999.0)
      `, [hashedPassword]);
      console.log('====================================================');
      console.log('Default Admin Account Created:');
      console.log('Username: admin');
      console.log(`Password: ${defaultPassword}`);
      console.log('====================================================');
    }
  });
}

initDb();

module.exports = {
  db,
  run,
  get,
  all
};
