require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ost-secret-jwt-key-change-in-production-2026';

// fetch() with a hard timeout. Node's fetch has NO default timeout, so a single
// slow/hung upstream (the CD-key server, GitHub, Steam, SGDB) can hang a request
// until the reverse proxy gives up with a 504. Wrapping every external call in a
// timeout makes it reject fast instead — callers already .catch() and fall back.
async function fetchT(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (err) {
    if (err.name === 'AbortError' || (err.message && err.message.includes('aborted'))) {
      throw new Error(`Request to ${url} timed out after ${ms}ms`);
    }
    throw err;
  }
  finally { clearTimeout(t); }
}

// ── Membership unlocks live in SQLite (source of truth) ──────────────────────
// Writing users/<sid>.json to GitHub on every click hit GitHub's contents-API
// conflict/secondary-rate limits under rapid unlocking (409 "write conflict").
// The DB is instant and conflict-free; GitHub is kept only as a debounced backup.
db.run(`CREATE TABLE IF NOT EXISTS member_unlocks (
  steamid TEXT NOT NULL,
  appid   TEXT NOT NULL,
  added_at INTEGER,
  PRIMARY KEY (steamid, appid)
)`).catch((e) => console.error('[member_unlocks] init failed:', e.message));

db.run(`CREATE TABLE IF NOT EXISTS user_memberships (
  steamid TEXT PRIMARY KEY,
  cd_key TEXT,
  key_type TEXT,
  activation_date TEXT,
  expiry_date TEXT,
  updated_at INTEGER
)`).catch((e) => console.error('[user_memberships] init failed:', e.message));

const _entitlementsVersionCache = new Map();
const _entitlementsCache = new Map();

function invalidateEntitlementsCache(sid) {
  if (!sid) return;
  const s = String(sid);
  _entitlementsVersionCache.delete(s);
  _entitlementsCache.delete(s);
}

async function dbGetUnlocks(sid) {
  const rows = await db.all('SELECT appid FROM member_unlocks WHERE steamid = ?', [String(sid)]);
  return rows.map((r) => String(r.appid));
}
async function dbAddUnlock(sid, appid) {
  invalidateEntitlementsCache(sid);
  await db.run('INSERT OR IGNORE INTO member_unlocks (steamid, appid, added_at) VALUES (?,?,?)',
    [String(sid), String(appid), Date.now()]);
}
async function dbAddUnlocks(sid, appids) {
  invalidateEntitlementsCache(sid);
  for (const a of appids) await dbAddUnlock(sid, a);
}
async function dbRemoveUnlock(sid, appid) {
  invalidateEntitlementsCache(sid);
  await db.run('DELETE FROM member_unlocks WHERE steamid = ? AND appid = ?', [String(sid), String(appid)]);
}

// Debounced, best-effort GitHub backup of a user's unlock list. Coalesces a
// burst of unlocks into ONE commit so we never hammer GitHub. Never on the hot path.
// Replace mirrorUserToGitHub with a stub
function mirrorUserToGitHub(sid) {
  // Disabled: Local SQLite is the sole source of truth
  return;
}

// Prevent GitHub Fallback Reads in ensureMigrated
const _migrated = new Set();
async function ensureMigrated(sid) {
  sid = String(sid);
  _migrated.add(sid);
  return true;
}

app.use(cors());
app.use(express.json());

// Serve the installer at the root URL for PowerShell only, so
//   irm onennabe.duckdns.org | iex
// returns the script, while browsers still get the dashboard.
app.get('/', (req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (/powershell/i.test(ua)) {
    const scriptPath = path.join(__dirname, 'public', 'install.ps1');
    if (fs.existsSync(scriptPath)) {
      res.type('text/plain');
      return res.send(fs.readFileSync(scriptPath, 'utf8'));
    }
  }
  // Browsers → the end-user dashboard.
  return res.redirect('/dashboard');
});

// Serve OneGamers gamekey installer script via:
//   irm onennabe.duckdns.org/gamekey | iex
app.get(['/gamekey', '/gamekey.ps1', '/onegamers-install.ps1'], (req, res) => {
  const scriptPath = path.join(__dirname, 'public', 'onegamers-install.ps1');
  if (fs.existsSync(scriptPath)) {
    res.type('text/plain');
    return res.send(fs.readFileSync(scriptPath, 'utf8'));
  }
  res.status(404).send('Installer script not found');
});

// Helper to locate the latest plugin .star build across installation and onegamers folders
function getLatestStarFile() {
  const candidates = [
    path.join(__dirname, '..', 'installation', 'millennium', 'plugins', 'com.onegamers.activation.star'),
    path.join(__dirname, 'onegamers', 'millennium', 'plugins', 'com.onegamers.activation.star'),
    path.join(__dirname, 'onegamers', 'millennium', 'plugins', 'com.onegamers.gamekey.star')
  ];

  let best = null;
  let maxMtime = 0;

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs > maxMtime) {
          maxMtime = stat.mtimeMs;
          best = { path: p, mtime: Math.floor(stat.mtimeMs), size: stat.size, filename: path.basename(p) };
        }
      } catch {}
    }
  }
  return best;
}

// Serve direct plugin star bundle downloads (scans installation & onegamers folders automatically)
app.get(['/com.onegamers.activation.star', '/com.onegamers.gamekey.star'], (req, res) => {
  const latest = getLatestStarFile();
  if (latest && fs.existsSync(latest.path)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.sendFile(latest.path);
  }
  res.status(404).send('Plugin star bundle not found');
});

// Plugin auto-update version check endpoint (scans installation & onegamers folders)
app.get('/api/plugin/version', (req, res) => {
  try {
    const latest = getLatestStarFile();
    if (!latest) {
      return res.json({ ok: false, message: 'Plugin bundle missing on server' });
    }

    return res.json({
      ok: true,
      mtime: latest.mtime,
      size: latest.size,
      filename: latest.filename,
      url: `https://onennabe.duckdns.org/${latest.filename}`,
      activation_url: 'https://onennabe.duckdns.org/com.onegamers.activation.star',
      gamekey_url: 'https://onennabe.duckdns.org/com.onegamers.gamekey.star'
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Serve /onegamers static folder (for com.onegamers.gamekey.star & assets)
const onegamersDir = path.join(__dirname, 'onegamers');
if (!fs.existsSync(onegamersDir)) fs.mkdirSync(onegamersDir, { recursive: true });

// Pure JS Zip builder helper for onegamers directory
function createZipFromFolder(folderPath) {
  const files = [];
  function scan(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === '.gitkeep' || item.name === 'onegamers.zip') continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) scan(full, rel);
      else files.push({ name: rel.replace(/\\/g, '/'), data: fs.readFileSync(full) });
    }
  }
  scan(folderPath);

  if (files.length === 0) {
    const pubStar = path.join(__dirname, 'public', 'com.onegamers.gamekey.star');
    if (fs.existsSync(pubStar)) {
      files.push({ name: 'millennium/plugins/com.onegamers.gamekey.star', data: fs.readFileSync(pubStar) });
    }
  }

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i];
      for (let j = 0; j < 8; j++) {
        let mask = -(byte & 1);
        crc = (crc >>> 1) ^ (0xEDB88320 & mask);
        byte >>>= 1;
      }
    }
    return (crc ^ -1) >>> 0;
  }

  const parts = []; const cdEntries = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = f.data;
    const crc = crc32(dataBuf);
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6); localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10); localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22); localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); nameBuf.copy(localHeader, 30);

    const entryOffset = offset;
    parts.push(localHeader, dataBuf);
    offset += localHeader.length + dataBuf.length;

    const cdHeader = Buffer.alloc(46 + nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0); cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6); cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(0, 10); cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14); cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(dataBuf.length, 20); cdHeader.writeUInt32LE(dataBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28); cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32); cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36); cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(entryOffset, 42); nameBuf.copy(cdHeader, 46);
    cdEntries.push(cdHeader);
  }

  const cdOffset = offset; let cdSize = 0;
  for (const cd of cdEntries) { parts.push(cd); cdSize += cd.length; }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

// ZIP download endpoint for OneGamers installation payload
app.get(['/onegamers.zip', '/api/onegamers/download'], (req, res) => {
  try {
    const zipBuf = createZipFromFolder(onegamersDir);
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="onegamers.zip"');
    res.send(zipBuf);
  } catch (e) {
    res.status(500).send('Error building payload ZIP: ' + e.message);
  }
});

// API endpoint listing all files inside os-backend/server/onegamers
app.get('/api/onegamers/files', (req, res) => {
  const filesList = [];
  function scanDir(dir, relPath = '') {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '.gitkeep' || item.name === 'onegamers.zip') continue;
      const rel = relPath ? `${relPath}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        scanDir(full, rel);
      } else {
        filesList.push({ path: rel.replace(/\\/g, '/'), size: fs.statSync(full).size });
      }
    }
  }
  scanDir(onegamersDir);

  if (filesList.length === 0) {
    const pubStar = path.join(__dirname, 'public', 'com.onegamers.gamekey.star');
    if (fs.existsSync(pubStar)) {
      filesList.push({ path: 'com.onegamers.gamekey.star', size: fs.statSync(pubStar).size });
    }
  }

  res.json({ files: filesList });
});

app.use('/onegamers', express.static(onegamersDir));
app.use('/onegamers', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Generate Alphanumeric CDKey format OST-XXXX-YYYY-ZZZZ
function generateCDKeyString() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randBlock = () => {
    let res = '';
    for (let i = 0; i < 4; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  };
  return `OST-${randBlock()}-${randBlock()}-${randBlock()}`;
}

// Helper: Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    try {
      // Reject tokens of accounts that have since been removed
      const exists = await db.get('SELECT id FROM users WHERE id = ?', [user.id]);
      if (!exists) return res.status(401).json({ error: 'Account no longer exists' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    req.user = user;
    next();
  });
}

// Helper: Admin Check
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ==========================================
// AUTH ROUTES
// ==========================================

// Login (Admin or Reseller)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const tokenPayload = { id: user.id, username: user.username, role: user.role };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        credits: user.credits
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current User Info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, username, role, credits, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

// Get Admin Overview Stats
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalResellersRow = await db.get("SELECT count(*) as count FROM users WHERE role = 'reseller'");
    const totalKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys) + 
        (SELECT COUNT(*) FROM keys)
      ) as count
    `);
    const activeKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys WHERE status = 'active') + 
        (SELECT COUNT(*) FROM keys WHERE status = 'active')
      ) as count
    `);
    const usedKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys WHERE status = 'used') + 
        (SELECT COUNT(*) FROM keys WHERE status = 'used')
      ) as count
    `);
    const totalActivationsRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_activations) + 
        (SELECT COUNT(*) FROM activations)
      ) as count
    `);
    const sumCreditsRow = await db.get("SELECT SUM(credits) as sum FROM users WHERE role = 'reseller'");

    const recentActivations = await db.all(`
      SELECT cdkey, steamid, appids, creator_name, activated_at FROM (
        SELECT a.cdkey, a.steamid, a.appids, a.activated_at, COALESCE(u.username, 'System') as creator_name
        FROM activations a
        LEFT JOIN keys k ON a.cdkey = k.cdkey
        LEFT JOIN users u ON k.created_by = u.id
        UNION ALL
        SELECT oa.cdkey, oa.steamid, oa.appid as appids, oa.activated_at, COALESCE(u.username, 'System') as creator_name
        FROM og_activations oa
        LEFT JOIN og_keys ok ON oa.cdkey = ok.cdkey
        LEFT JOIN users u ON ok.created_by = u.id
      )
      ORDER BY activated_at DESC LIMIT 10
    `);

    res.json({
      totalResellers: totalResellersRow ? totalResellersRow.count : 0,
      totalKeys: totalKeysRow ? totalKeysRow.count : 0,
      activeKeys: activeKeysRow ? activeKeysRow.count : 0,
      usedKeys: usedKeysRow ? usedKeysRow.count : 0,
      totalActivations: totalActivationsRow ? totalActivationsRow.count : 0,
      totalCreditsInCirculation: (sumCreditsRow && sumCreditsRow.sum) ? sumCreditsRow.sum : 0,
      recentActivations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List All Resellers
app.get('/api/admin/resellers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const resellers = await db.all(`
      SELECT u.id, u.username, u.role, u.credits, u.created_at,
             (SELECT count(*) FROM keys WHERE created_by = u.id) as keys_generated,
             (SELECT count(*) FROM keys WHERE created_by = u.id AND status = 'used') as keys_used
      FROM users u 
      WHERE u.role = 'reseller'
      ORDER BY u.created_at DESC
    `);
    res.json({ resellers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create New Reseller
app.post('/api/admin/resellers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, password, initial_credits } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const credits = parseFloat(initial_credits) || 0.0;

    const result = await db.run(`
      INSERT INTO users (username, password, role, credits)
      VALUES (?, ?, 'reseller', ?)
    `, [username, hashedPassword, credits]);

    if (credits > 0) {
      await db.run(`
        INSERT INTO topup_logs (reseller_id, admin_id, amount, note)
        VALUES (?, ?, ?, 'Initial credit on creation')
      `, [result.lastID, req.user.id, credits]);
    }

    res.json({
      message: 'Reseller created successfully',
      reseller: {
        id: result.lastID,
        username,
        role: 'reseller',
        credits
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Top Up Credit for Reseller
app.post('/api/admin/topup', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { reseller_id, amount, note } = req.body;

    const topupAmount = parseFloat(amount);
    if (isNaN(topupAmount) || topupAmount === 0) {
      return res.status(400).json({ error: 'Valid top-up amount is required' });
    }

    const reseller = await db.get("SELECT * FROM users WHERE id = ? AND role = 'reseller'", [reseller_id]);
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    await db.run('UPDATE users SET credits = credits + ? WHERE id = ?', [topupAmount, reseller_id]);
    await db.run(`
      INSERT INTO topup_logs (reseller_id, admin_id, amount, note)
      VALUES (?, ?, ?, ?)
    `, [reseller_id, req.user.id, topupAmount, note || 'Admin Top-Up']);

    const updatedReseller = await db.get('SELECT id, username, credits FROM users WHERE id = ?', [reseller_id]);

    res.json({
      message: `Successfully added ${topupAmount} credits to ${reseller.username}`,
      reseller: updatedReseller
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Remove Reseller
// The reseller account is deleted. Keys they generated are kept, so keys already
// sold to customers keep working; they show as "(removed #id)" in the dashboard.
app.delete('/api/admin/resellers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const reseller = await db.get("SELECT id, username FROM users WHERE id = ? AND role = 'reseller'", [req.params.id]);
    if (!reseller) {
      return res.status(404).json({ error: 'Reseller not found' });
    }

    await db.run("DELETE FROM users WHERE id = ? AND role = 'reseller'", [reseller.id]);

    res.json({ message: `Reseller '${reseller.username}' removed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin List All Generated Keys
app.get('/api/admin/keys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `
      SELECT k.*, COALESCE(u.username, '(removed #' || k.created_by || ')') as creator_name,
             u.role as creator_role
      FROM keys k
      LEFT JOIN users u ON k.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ' AND k.status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (k.cdkey LIKE ? OR k.appids LIKE ? OR k.game_name LIKE ? OR k.activated_by LIKE ? OR u.username LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY k.created_at DESC LIMIT 500';

    const keys = await db.all(query, params);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin View All Activations Tracking
app.get('/api/admin/activations', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT a.*, k.created_by, u.username as creator_name
      FROM activations a
      LEFT JOIN keys k ON a.cdkey = k.cdkey
      LEFT JOIN users u ON k.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ' AND (a.cdkey LIKE ? OR a.steamid LIKE ? OR a.appids LIKE ? OR u.username LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY a.activated_at DESC LIMIT 500';

    const activations = await db.all(query, params);
    res.json({ activations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'barryhamsy/onennebe';

// Private game-patch repo. Each branch is named after an appid and holds the
// patch .rar(s). The token needs read access to this repo; if the main
// GITHUB_TOKEN already has it, PATCH_GITHUB_TOKEN can be left unset.
const PATCH_REPO = process.env.PATCH_REPO || 'barryhamsy/patchfixbybybybybypassy';
const PATCH_GITHUB_TOKEN = process.env.PATCH_GITHUB_TOKEN || GITHUB_TOKEN;

// Replace commitKeyToGitHub with a stub
async function commitKeyToGitHub(cdkey, appids) {
  // Disabled: Keys stored in SQLite only
  return { success: true };
}

// Replace deleteKeyFromGitHub with a stub
async function deleteKeyFromGitHub(cdkey) {
  // Disabled: Key revocation handled in SQLite
  return { success: true };
}

// Per-path write lock: serialize writes to the SAME file so two rapid unlocks
// can't race on the file's SHA (which caused GitHub 409 conflicts → 502).
const _ghLocks = new Map(); // filePath -> tail promise
function withGhLock(key, fn) {
  const prev = _ghLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // run after the previous write settles
  _ghLocks.set(key, next.catch(() => {}));
  return next;
}

// One read-SHA + PUT attempt.
async function _ghPutOnce(url, headers, contentB64, message) {
  let sha = null;
  const checkRes = await fetchT(`${url}?ref=main`, { headers }, 12000);
  if (checkRes.ok) sha = (await checkRes.json()).sha;
  const body = { message, content: contentB64, branch: 'main' };
  if (sha) body.sha = sha;
  const putRes = await fetchT(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 15000);
  if (putRes.ok) return { ok: true };
  return { ok: false, status: putRes.status, reason: await putRes.text().catch(() => '') };
}

// Helper: PUT any file to the GitHub repo (main/<path>), creating or updating it.
// Serialized per path + retried on conflict / secondary-rate / timeout, so rapid
// concurrent unlocks to the same users/<sid>.json succeed instead of 502-ing.
async function putFileToGitHub(filePath, contentString, message) {
  if (!GITHUB_TOKEN) return { success: false, reason: 'No GITHUB_TOKEN configured' };

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'OST-Server/1.0',
    'Accept': 'application/vnd.github+json'
  };
  const contentB64 = Buffer.from(contentString).toString('base64');

  return withGhLock(filePath, async () => {
    let lastStatus = 0, lastReason = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await _ghPutOnce(url, headers, contentB64, message);
        if (r.ok) return { success: true };
        lastStatus = r.status; lastReason = r.reason || '';
        // 409 = SHA conflict (concurrent write), 422 = stale SHA, 403 = secondary
        // rate limit — all worth a re-fetch + retry. Anything else, stop.
        if (r.status === 409 || r.status === 422 || r.status === 403) {
          await new Promise((res) => setTimeout(res, 400 * attempt));
          continue;
        }
        break;
      } catch (err) {
        lastStatus = 0; lastReason = err.message || String(err);
        await new Promise((res) => setTimeout(res, 400 * attempt));
      }
    }
    console.error(`[putFileToGitHub] ${filePath} failed after retries HTTP ${lastStatus}: ${String(lastReason).slice(0, 300)}`);
    return { success: false, status: lastStatus, reason: lastReason };
  });
}

// Turn a failed putFileToGitHub result into a human-useful message (so a 502
// tells us WHY: expired token, rate limit, conflict, …) instead of a blank wall.
function ghErrMsg(base, result) {
  const r = result && result.reason ? String(result.reason) : '';
  let hint = '';
  if (/bad credentials|401/i.test(r)) hint = ' — GitHub token invalid or expired';
  else if (/rate limit|403/i.test(r)) hint = ' — GitHub rate limit / permission';
  else if ((result && result.status === 409) || /conflict|sha/i.test(r)) hint = ' — write conflict, try again';
  else if (/abort|timeout/i.test(r)) hint = ' — GitHub write timed out';
  return base + hint + (r ? ' [' + r.slice(0, 140) + ']' : '');
}

// Compute the AppIDs a SteamID is currently entitled to: the union of AppIDs
// across every key that SteamID has activated and that has NOT been revoked.
// This is the single source of truth for what the DLL should inject.
async function computeEntitlements(steamid) {
  const rows = await db.all(
    "SELECT appids FROM keys WHERE activated_by = ? AND status = 'used'",
    [steamid]
  );
  const set = new Set();
  for (const r of rows) {
    for (const a of String(r.appids).split(',')) {
      const id = a.trim();
      if (id) set.add(id);
    }
  }
  // Sort numerically for stable output
  return [...set].sort((a, b) => Number(a) - Number(b));
}

// Recompute a SteamID's entitlements and write users/<steamid>.json on GitHub.
// Called after an activation (adds appids) and after a revoke (removes appids
// no longer covered by any remaining key). Keeps the DLL's GitHub read path
// working; the live /api/entitlements endpoint below is the fast path.
async function syncUserEntitlements(steamid) {
  if (!steamid) return { success: false, reason: 'no steamid' };
  const appids = await computeEntitlements(steamid);
  const json = JSON.stringify({ appids: appids.map(Number) }, null, 2);
  const result = await putFileToGitHub(
    `users/${steamid}.json`,
    json,
    `Update entitlements for ${steamid} (${appids.length} appid(s))`
  );
  if (result.success) {
    console.log(`[Entitlements] Synced users/${steamid}.json (${appids.length} appid(s))`);
  } else {
    console.warn(`[Entitlements] Failed to sync users/${steamid}.json: ${result.reason}`);
  }
  return result;
}

// PUBLIC: Live entitlements for a SteamID, straight from the DB (no GitHub
// cache). The DLL polls this so a revoke takes effect within one poll cycle.
// Accepts either the 32-bit AccountID or the 64-bit SteamID64.
// Raw GitHub read of users/<sid>.json. Returns an array of appid strings, [] if
// the file genuinely doesn't exist (404), or null if the read FAILED (token /
// rate limit / network) — so callers can tell "empty" from "unknown".
async function readUsersJsonFromGitHub(sid64) {
  if (!GITHUB_TOKEN) return [];
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/users/${sid64}.json?ref=main`;
    const r = await fetchT(url, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'OST-Server/1.0',
        'Accept': 'application/vnd.github+json',
      },
    }, 12000);
    if (r.status === 404) return [];
    if (!r.ok) return null;
    const j = await r.json();
    const body = Buffer.from(j.content || '', 'base64').toString('utf8');
    let data = null;
    try { data = JSON.parse(body); } catch { /* fall back to digit scan */ }
    let arr = (data && Array.isArray(data.appids)) ? data.appids
            : (Array.isArray(data) ? data : (body.match(/\d{2,10}/g) || []));
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch { return null; }
}

// The membership unlocks for a SteamID — from the DB (source of truth), importing
// any pre-existing GitHub list once. Never throws; returns appid strings.
async function readUsersJsonAppids(sid64) {
  const sid = String(sid64);
  try {
    await ensureMigrated(sid);
    return await dbGetUnlocks(sid);
  } catch (e) {
    console.error(`[readUsersJsonAppids] ${sid}: ${e.message}`);
    return await dbGetUnlocks(sid).catch(() => []);
  }
}

const STEAM64_BASE = 76561197960265728n;
function toSteamId64(id) {
  try { const n = BigInt(id); return (n > STEAM64_BASE) ? String(n) : String(n + STEAM64_BASE); }
  catch { return String(id); }
}

app.get('/api/entitlements/:steamid', async (req, res) => {
  try {
    let id = String(req.params.steamid).trim();
    const cached = _entitlementsCache.get(id);
    if (cached && (Date.now() - cached.time < 2000)) {
      return res.json(cached.data);
    }

    const candidates = new Set([id]);
    try {
      const n = BigInt(id);
      if (n > STEAM64_BASE) candidates.add(String(n - STEAM64_BASE)); // 64 -> 32
      else candidates.add(String(n + STEAM64_BASE));                  // 32 -> 64
    } catch { /* non-numeric, ignore */ }

    const set = new Set();
    // Per-key activations (keys table).
    for (const c of candidates) {
      for (const a of await computeEntitlements(c)) set.add(String(a));
    }
    // Membership unlocks (users/<steamid64>.json).
    for (const a of await readUsersJsonAppids(toSteamId64(id))) set.add(String(a));

    const appids = [...set].sort((a, b) => Number(a) - Number(b));
    const outData = { steamid: id, appids: appids.map(Number) };
    _entitlementsCache.set(id, { data: outData, time: Date.now() });
    res.json(outData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global manifest epoch. Bump it (POST /api/manifest/bump) after pushing new
// .lua / manifest ids to GitHub to force every running DLL to re-check its
// injected games on the next 2s tick. In-memory is fine: a process restart just
// makes every client refresh once, which is safe (drop-safe, hash-gated).
let _manifestEpoch = 0;

// PUBLIC: tiny per-user version string the DLL polls every 2s. It is the cheap
// fast-path probe — no GitHub — and changes whenever the user's unlock set
// changes (a new key activation or a member_unlocks row) or the manifest epoch
// is bumped. When it changes, the DLL runs a full sync + manifest refresh.
// Mirrors the exact sources /api/entitlements unions (keys for both the 32- and
// 64-bit id, member_unlocks for the SteamID64).
app.get('/api/entitlements-version/:steamid', async (req, res) => {
  try {
    let id = String(req.params.steamid).trim();
    const cached = _entitlementsVersionCache.get(id);
    if (cached && (Date.now() - cached.time < 1500) && cached.epoch === _manifestEpoch) {
      res.set('Cache-Control', 'no-store');
      return res.json({ v: cached.v });
    }

    const candidates = new Set([id]);
    try {
      const n = BigInt(id);
      if (n > STEAM64_BASE) candidates.add(String(n - STEAM64_BASE)); // 64 -> 32
      else candidates.add(String(n + STEAM64_BASE));                  // 32 -> 64
    } catch { /* non-numeric, ignore */ }
    const cand = [...candidates];
    const placeholders = cand.map(() => '?').join(',');

    const krow = await db.get(
      `SELECT COUNT(*) AS n, COALESCE(MAX(activated_at), '') AS mx
         FROM keys WHERE activated_by IN (${placeholders}) AND status = 'used'`,
      cand
    ).catch(() => ({ n: 0, mx: '' }));

    const mrow = await db.get(
      "SELECT COUNT(*) AS n, COALESCE(MAX(added_at), 0) AS mx FROM member_unlocks WHERE steamid = ?",
      [String(toSteamId64(id))]
    ).catch(() => ({ n: 0, mx: 0 }));

    const v = `${krow.n}:${krow.mx}:${mrow.n}:${mrow.mx}:${_manifestEpoch}`;
    _entitlementsVersionCache.set(id, { v, time: Date.now(), epoch: _manifestEpoch });
    res.set('Cache-Control', 'no-store');
    res.json({ v });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bump the manifest epoch so every client re-checks injected .lua within ~2s.
// Optional shared-secret guard: set MANIFEST_BUMP_KEY in the env and pass ?key=.
app.post('/api/manifest/bump', (req, res) => {
  const need = process.env.MANIFEST_BUMP_KEY;
  if (need && String(req.query.key || '') !== need)
    return res.status(403).json({ error: 'forbidden' });
  _manifestEpoch = Date.now();
  res.json({ ok: true, epoch: _manifestEpoch });
});

// GitHub Webhook listener: Automatically bumps epoch when changes are pushed to GitHub repository
app.post('/api/github/webhook', (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.MANIFEST_BUMP_KEY;
  if (secret) {
    const sig = req.headers['x-hub-signature-256'];
    if (sig) {
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', secret);
      const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');
      if (sig !== digest) {
        return res.status(403).json({ error: 'invalid signature' });
      }
    }
  }
  _manifestEpoch = Date.now();
  console.log(`[GitHub Webhook] Pushed event received. Bumped _manifestEpoch to ${_manifestEpoch}`);
  res.json({ ok: true, epoch: _manifestEpoch, message: 'Manifest epoch bumped via GitHub webhook' });
});

const ONENNABE_DB_PATH = process.env.ONENNABE_DB_PATH || 'G:/steamunlockonennabe/onennabe.db';

function getOnennabeDbPath() {
  if (process.env.ONENNABE_DB_PATH && fs.existsSync(process.env.ONENNABE_DB_PATH)) {
    return process.env.ONENNABE_DB_PATH;
  }
  const os = require('os');
  const path = require('path');
  const candidates = [
    'G:/steamunlockonennabe/onennabe.db',
    '/home/barryhamsy/steamunlockonennabe/onennabe.db',
    '/home/steamunlockonennabe/onennabe.db',
    '/var/www/steamunlockonennabe/onennabe.db',
    '/opt/steamunlockonennabe/onennabe.db',
    path.join(__dirname, '../../steamunlockonennabe/onennabe.db'),
    path.join(__dirname, '../steamunlockonennabe/onennabe.db'),
    path.join(process.cwd(), '../steamunlockonennabe/onennabe.db'),
    path.join(process.cwd(), '../../steamunlockonennabe/onennabe.db'),
    path.join(os.homedir(), 'steamunlockonennabe/onennabe.db'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return process.env.ONENNABE_DB_PATH || 'G:/steamunlockonennabe/onennabe.db';
}

async function suLookupDbDirect(sid64) {
  const dbPath = getOnennabeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  return new Promise((resolve) => {
    const sqlite3 = require('sqlite3');
    const sdb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(null);
    });
    const sql = `
      SELECT k.cd_key, k.key_type, k.activation_date, k.expiry_date, s.activation_date AS link_activation_date
      FROM cdkey_steamids s
      JOIN cd_keys k ON s.cd_key = k.cd_key
      WHERE s.steamid = ?
    `;
    sdb.all(sql, [sid64], (err, rows) => {
      sdb.close();
      if (err || !Array.isArray(rows)) return resolve(null);
      resolve(rows);
    });
  });
}

async function suValidateDbDirect(cd, sid64) {
  const dbPath = getOnennabeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  const cdUpper = String(cd || '').trim().toUpperCase();
  if (!cdUpper || !sid64) return null;

  return new Promise((resolve) => {
    const sqlite3 = require('sqlite3');
    const sdb = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return resolve(null);
    });

    sdb.get('SELECT key_type, activation_date, expiry_date, used_count FROM cd_keys WHERE UPPER(cd_key) = ?', [cdUpper], (err, row) => {
      if (err || !row) {
        sdb.close();
        return resolve({ status: 'error', message: 'Invalid CD Key' });
      }

      const keyType = row.key_type || 'STANDARD';
      let actDate = row.activation_date || null;
      let expDate = row.expiry_date || null;
      let usedCount = row.used_count || 0;
      const today = suTodayStr();

      sdb.all('SELECT steamid FROM cdkey_steamids WHERE UPPER(cd_key) = ?', [cdUpper], (err2, steamRows) => {
        if (err2) { sdb.close(); return resolve(null); }
        const linkedSteamids = (steamRows || []).map((s) => s.steamid);
        const isLinked = linkedSteamids.includes(sid64);

        const kt = keyType.toUpperCase();
        if (kt === 'STANDARD' || kt === 'BASIC') {
          if (linkedSteamids.length > 0 && !isLinked) {
            sdb.close();
            return resolve({ status: 'error', message: 'This STANDARD CD Key is permanently linked to another Steam account.' });
          }
        } else if (kt === 'DUO') {
          if (linkedSteamids.length >= 2 && !isLinked) {
            sdb.close();
            return resolve({ status: 'error', message: 'This DUO CD Key is already linked to two Steam accounts.' });
          }
        } else if (kt === 'PREMIUM') {
          if (linkedSteamids.length >= 3 && !isLinked) {
            sdb.close();
            return resolve({ status: 'error', message: 'This PREMIUM CD Key is already linked to three Steam accounts.' });
          }
        } else if (kt === 'MONTHLY' || kt === '1DAY' || kt === '3MONTHS' || kt === '6MONTHS' || kt === '1YEAR' || kt === 'TRIAL') {
          if (linkedSteamids.length > 0 && !isLinked) {
            sdb.close();
            return resolve({ status: 'error', message: `This ${kt} CD Key is permanently linked to another Steam account.` });
          }

          if (!actDate) actDate = today;
          if (!expDate) {
            const now = new Date();
            let addDays = 30;
            if (kt === '1DAY') addDays = 1;
            else if (kt === '3MONTHS') addDays = 90;
            else if (kt === '6MONTHS') addDays = 180;
            else if (kt === '1YEAR') addDays = 365;
            const expTime = new Date(now.getTime() + addDays * 86400000);
            expDate = expTime.toISOString().slice(0, 10);
          }

          if (expDate && expDate < today) {
            sdb.close();
            return resolve({ status: 'error', message: `This ${kt} CD Key has expired. Please renew your subscription.` });
          }
        }

        sdb.serialize(() => {
          if (!isLinked) {
            sdb.run('INSERT OR IGNORE INTO cdkey_steamids (cd_key, steamid, activation_date) VALUES (?, ?, ?)', [cdUpper, sid64, today]);
            sdb.run('UPDATE cd_keys SET used_count = used_count + 1, activation_date = COALESCE(activation_date, ?), expiry_date = COALESCE(expiry_date, ?) WHERE UPPER(cd_key) = ?', [today, expDate, cdUpper]);
          } else {
            sdb.run('UPDATE cd_keys SET used_count = used_count + 1 WHERE UPPER(cd_key) = ?', [cdUpper]);
          }
          sdb.close(() => {
            resolve({
              status: 'success',
              message: 'CD Key validated successfully',
              key_type: keyType,
              activation_date: actDate || today,
              expiry_date: expDate,
              steamid: sid64,
              used_count: usedCount + 1
            });
          });
        });
      });
    });
  });
}

// Server-to-server: ask steamunlockonennabe whether a CD key is valid. It needs
// both the CD key and the SteamID; we send field-name aliases so it matches
// whichever the endpoint reads (cd_key/steamid — SteamID as 64-bit).
async function suValidate(cd, sid) {
  const sid64 = sid ? toSteamId64(String(sid)) : '';
  const cdUpper = String(cd || '').trim().toUpperCase();
  if (!cdUpper) return { status: 'error', message: 'CD key required' };

  // 1. Direct SQLite local database validation (1ms latency!)
  try {
    const directRes = await suValidateDbDirect(cdUpper, sid64);
    if (directRes) {
      if (directRes.status === 'success' && sid64) {
        const kt = directRes.key_type || 'STANDARD';
        const ad = directRes.activation_date || suTodayStr();
        const ed = directRes.expiry_date || null;
        await db.run(`
          INSERT OR REPLACE INTO user_memberships (steamid, cd_key, key_type, activation_date, expiry_date, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [sid64, cdUpper, kt, ad, ed, Date.now()]).catch((err) => console.error('[user_memberships] db save error:', err.message));
      }

      // Non-blocking background call to HTTP server if configured
      fetchT('http://127.0.0.1:5000/validate-onennabe-cdkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cd_key: cdUpper, cdkey: cdUpper,
          steamid: sid64, steamid64: sid64, steam_id: sid64, steamID: sid64,
        }),
      }, 3000).catch(() => {});

      return directRes;
    }
  } catch (e) {
    console.error('[suValidate] Direct DB validation error:', e.message);
  }

  // Fallback to HTTP API query if direct DB file not accessible
  let vr = null;
  try {
    vr = await fetchT('http://127.0.0.1:5000/validate-onennabe-cdkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cd_key: cdUpper, cdkey: cdUpper, steamid: sid64, steamid64: sid64 }),
    }, 5000);
  } catch (_) {
    try {
      vr = await fetchT(SU_VALIDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cd_key: cdUpper, cdkey: cdUpper, steamid: sid64, steamid64: sid64 }),
      }, 10000);
    } catch (_) {}
  }

  const res = vr ? await vr.json().catch(() => null) : null;
  keyListCache.fetchedAt = 0;

  if (res && (res.status === 'success' || res.activated || res.success || (res.message && String(res.message).toLowerCase().includes('validated')) || (res.message && String(res.message).toLowerCase().includes('success')))) {
    if (sid64) {
      const kt = res.key_type || res.type || 'STANDARD';
      const ad = res.activation_date || suTodayStr();
      const ed = res.expiry_date || res.expires || null;
      await db.run(`
        INSERT OR REPLACE INTO user_memberships (steamid, cd_key, key_type, activation_date, expiry_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sid64, cdUpper, kt, ad, ed, Date.now()]).catch((err) => console.error('[user_memberships] db save error:', err.message));
    }
    return res;
  }

  if (res) return res;

  return { status: 'error', message: 'Could not connect to activation server. Please check the CD Key and try again.' };
}

async function getKeyListFromDbFile() {
  const dbPath = getOnennabeDbPath();
  if (!fs.existsSync(dbPath)) return null;
  return new Promise((resolve) => {
    const sqlite3 = require('sqlite3');
    const sdb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(null);
    });
    const sql = `
      SELECT k.cd_key, k.key_type, k.activation_date, k.expiry_date, s.steamid
      FROM cd_keys k
      JOIN cdkey_steamids s ON k.cd_key = s.cd_key
    `;
    sdb.all(sql, [], (err, rows) => {
      sdb.close();
      if (err || !Array.isArray(rows)) return resolve(null);
      // Group by cd_key into format expected by suLookup ({ cd_key, key_type, expiry_date, steamids: [{ steamid, activation_date }] })
      const keyMap = new Map();
      for (const r of rows) {
        if (!keyMap.has(r.cd_key)) {
          keyMap.set(r.cd_key, {
            cd_key: r.cd_key,
            key_type: r.key_type,
            activation_date: r.activation_date,
            expiry_date: r.expiry_date,
            steamids: []
          });
        }
        keyMap.get(r.cd_key).steamids.push({ steamid: r.steamid, activation_date: r.activation_date });
      }
      resolve([...keyMap.values()]);
    });
  });
}

async function getKeyList(forceFresh = false) {
  // Try reading local SQLite file directly first (0ms latency!)
  try {
    const dbKeys = await getKeyListFromDbFile();
    if (dbKeys) {
      keyListCache.data = dbKeys;
      keyListCache.fetchedAt = Date.now();
      return dbKeys;
    }
  } catch (e) {
    console.error('[getKeyList] Error reading onennabe.db file directly:', e.message);
  }

  // Fallback to HTTP API query if file not accessible
  if (forceFresh) keyListCache.fetchedAt = 0;
  const fresh = !forceFresh && keyListCache.data && (Date.now() - keyListCache.fetchedAt < KEYLIST_CACHE_MS);
  if (fresh) return keyListCache.data;
  if (keyListCache.pending) return keyListCache.pending;
  keyListCache.pending = (async () => {
    try {
      if (typeof SU_VIEW_URL === 'undefined' || !SU_VIEW_URL) {
        throw new Error('SU_VIEW_URL is not configured');
      }
      const vr = await fetchT(SU_VIEW_URL, { headers: { 'Cache-Control': 'no-cache, no-store' } }, 15000);
      const data = await vr.json().catch(() => null);
      const keys = (data && Array.isArray(data.keys)) ? data.keys : null;
      if (!keys) throw new Error('bad key-list payload');
      keyListCache.data = keys;
      keyListCache.fetchedAt = Date.now();
      return keys;
    } catch (err) {
      // Set backoff timestamp so failed requests aren't re-attempted on every request tick
      keyListCache.fetchedAt = Date.now();
      if (keyListCache.data) return keyListCache.data;
      return [];
    } finally {
      keyListCache.pending = null;
    }
  })();
  return keyListCache.pending;
}

function suTodayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Key-type selection priority for 1-click / auto activation.
// PREMIUM > STANDARD > MONTHLY > 1DAY. Higher number wins. Unknown types rank
// lowest (0). Normalized so "1 DAY", "1-day", "one day" all match.
function suKeyTypeRank(kt) {
  const t = String(kt || '').toUpperCase().replace(/[\s_\-]+/g, '');
  if (t === 'PREMIUM') return 4;
  if (t === 'STANDARD') return 3;
  if (t === 'MONTHLY') return 2;
  if (t === '1DAY' || t === 'ONEDAY' || t === 'DAY') return 1;
  return 0;
}

// Comparator for picking the best key: highest key-type priority first, then
// the furthest-out expiry (empty expiry = lifetime = treated as furthest out).
// Use with Array.sort(...) — best key ends up first.
function suKeyCompare(a, b) {
  const byType = suKeyTypeRank(b.key_type) - suKeyTypeRank(a.key_type);
  if (byType !== 0) return byType;
  const ax = a.expiry_date ? String(a.expiry_date) : '9999-12-31';
  const bx = b.expiry_date ? String(b.expiry_date) : '9999-12-31';
  if (ax === bx) return 0;
  return ax < bx ? 1 : -1;
}

// GET /api/su/lookup?steamid=...
// One-click activation for existing users: finds a key this SteamID has already
// activated and returns ONLY that user's own key (never anyone else's).
app.get('/api/su/lookup', async (req, res) => {
  const sidIn = String(req.query.steamid || '').trim();
  if (!sidIn) return res.status(400).json({ found: false, error: 'steamid required' });
  const sid64 = toSteamId64(sidIn);
  try {
    const mem = await suLookup(sid64);
    return res.json(mem);
  } catch (e) {
    return res.status(502).json({ found: false, error: 'Could not reach the key server' });
  }
});

// ── Game patches (private repo, branch = appid) ───────────────────────────────
// The plugin can't reach the private patch repo (token lives server-side), so
// os-backend authenticates and hands the branch ZIP to the client, which then
// extracts the .rar into the game folder with the bundled UnRAR.exe.

// HEAD/GET /api/patch/:appid/exists → { exists: bool } — does a patch branch exist?
app.get('/api/patch/:appid/exists', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  if (!appid) return res.status(400).json({ exists: false, error: 'appid required' });
  if (!PATCH_GITHUB_TOKEN) return res.status(500).json({ exists: false, error: 'patch token not configured' });
  try {
    const url = `https://api.github.com/repos/${PATCH_REPO}/branches/${appid}`;
    const gh = await fetch(url, {
      headers: { Authorization: `Bearer ${PATCH_GITHUB_TOKEN}`, 'User-Agent': 'OpenSteamTool', Accept: 'application/vnd.github+json' },
    });
    return res.json({ exists: gh.status === 200, appid });
  } catch (e) {
    return res.status(502).json({ exists: false, error: 'github unreachable' });
  }
});

// GET /api/patch/:appid  → streams the branch ZIP (private repo, authenticated).
app.get('/api/patch/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  if (!appid) return res.status(400).json({ error: 'appid required' });
  if (!PATCH_GITHUB_TOKEN) return res.status(500).json({ error: 'patch token not configured' });
  try {
    // api.github.com/zipball redirects to a signed codeload URL; fetch follows it.
    const url = `https://api.github.com/repos/${PATCH_REPO}/zipball/${appid}`;
    const gh = await fetch(url, {
      headers: { Authorization: `Bearer ${PATCH_GITHUB_TOKEN}`, 'User-Agent': 'OpenSteamTool', Accept: 'application/vnd.github+json' },
    });
    if (gh.status === 404) return res.status(404).json({ error: 'no patch for this appid' });
    if (!gh.ok) return res.status(502).json({ error: `github ${gh.status}` });
    const buf = Buffer.from(await gh.arrayBuffer());
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="patch_${appid}.zip"`);
    res.setHeader('Content-Length', String(buf.length));
    console.log(`[Patch] Served branch ${appid} (${buf.length} bytes)`);
    return res.end(buf);
  } catch (e) {
    return res.status(502).json({ error: 'patch download failed' });
  }
});

// GET /api/patch-info/:appid → the onennabe catalog flags for one appid, so the
// plugin can decide whether to show the patch button (online/bypass/hypervisor).
app.get('/api/patch-info/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  if (!appid) return res.status(400).json({ error: 'appid required' });
  try {
    await getGameCatalog();
    const g = gamesCache.byId && gamesCache.byId.get(appid);
    let online = g ? !!g.online_supported : false;
    let bypass = g ? !!g.bypass_supported : false;
    let hyper  = g ? !!g.hypervisor_bypass : false;
    let isPatchable = online || bypass || hyper;

    // Fallback: check if GitHub branch exists if catalog flags are false or appid not found in catalog
    if (!isPatchable && PATCH_GITHUB_TOKEN) {
      try {
        const ghUrl = `https://api.github.com/repos/${PATCH_REPO}/branches/${appid}`;
        const ghRes = await fetchT(ghUrl, {
          headers: { Authorization: `Bearer ${PATCH_GITHUB_TOKEN}`, 'User-Agent': 'OpenSteamTool', Accept: 'application/vnd.github+json' }
        }, 5000);
        if (ghRes.ok) {
          isPatchable = true;
          bypass = true;
        }
      } catch (_) {}
    }

    return res.json({
      appid,
      found: !!g || isPatchable,
      name: (g && g.name) || '',
      online_supported: online,
      bypass_supported: bypass,
      hypervisor_bypass: hyper,
      patchable: isPatchable,
    });
  } catch (e) {
    return res.status(502).json({ error: 'catalog unreachable' });
  }
});

// GET /api/su/validate?cd_key=...&steamid=...  → passes the result through.
app.get('/api/su/validate', async (req, res) => {
  const cd = String(req.query.cd_key || '').trim();
  const sid = String(req.query.steamid || '').trim();
  if (!cd) return res.status(400).json({ status: 'error', message: 'cd_key required' });
  try {
    const vd = await suValidate(cd, sid);
    if (!vd) return res.status(502).json({ status: 'error', message: 'Validation server error' });
    return res.json(vd);
  } catch (e) {
    return res.status(502).json({ status: 'error', message: 'Could not reach validation server' });
  }
});

// Shared unlock handler (GET query or POST body).
async function suUnlock(params, res) {
  try {
    const cd = String(params.cd_key || '').trim();
    let sid = String(params.steamid || '').trim();
    const appId = String(params.appid || '').replace(/\D/g, '');
    if (!cd || !sid || !appId) {
      return res.status(400).json({ success: false, error: 'cd_key, steamid and appid are required' });
    }
    sid = toSteamId64(sid); // membership entitlements are keyed by SteamID64

    // 1. Validate the membership.
    let vd = null;
    try { vd = await suValidate(cd, sid); }
    catch (e) { return res.status(502).json({ success: false, error: 'Could not validate membership' }); }
    if (!vd || vd.status !== 'success') {
      return res.status(403).json({ success: false, error: (vd && vd.message) || 'Membership not active' });
    }

    // 2. Record the unlock in the DB (source of truth); mirror to GitHub in the
    // background. Instant and conflict-free even under rapid unlocking.
    const migrated = await ensureMigrated(sid);
    await dbAddUnlock(sid, appId);
    const appids = (await dbGetUnlocks(sid)).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (migrated) mirrorUserToGitHub(sid);

    console.log(`[SU Unlock] ${sid} += ${appId} (${appids.length} total)`);
    res.json({ success: true, appids });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/su/unlock', (req, res) => suUnlock(req.query, res));
app.post('/api/su/unlock', (req, res) => suUnlock(req.body, res));

// Membership-authorized unlock — no CD key needed. Authorizes by whether the
// SteamID has an active key (suLookup). Used by the plugin so it doesn't have to
// read the CD key out of the encrypted SUINABE.dat marker.
async function suMemberUnlock(params, res) {
  try {
    const sid = toSteamId64(String(params.steamid || '').trim());
    const appId = String(params.appid || '').replace(/\D/g, '');
    if (!sid || !appId) return res.status(400).json({ success: false, error: 'steamid and appid are required' });
    const mem = await suLookup(sid);
    if (!mem.found) return res.status(403).json({ success: false, error: mem.expired ? 'Membership expired' : 'No active membership' });
    const migrated = await ensureMigrated(sid);
    await dbAddUnlock(sid, appId);
    const appids = (await dbGetUnlocks(sid)).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (migrated) mirrorUserToGitHub(sid);
    console.log(`[Member Unlock] ${sid} += ${appId} (${appids.length} total)`);
    res.json({ success: true, appids });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}
app.get('/api/su/member-unlock', (req, res) => suMemberUnlock(req.query, res));
app.post('/api/su/member-unlock', (req, res) => suMemberUnlock(req.body, res));

// Revoke CDKey: removes the key (active or activated), deletes it from GitHub,
// and refunds its cost to the reseller who generated it.
// Admins can revoke any key; resellers can only revoke keys they generated.
app.post('/api/keys/:cdkey/revoke', authenticateToken, async (req, res) => {
  try {
    const cdkey = String(req.params.cdkey).trim().toUpperCase();
    const keyRecord = await db.get('SELECT * FROM keys WHERE cdkey = ?', [cdkey]);
    if (!keyRecord || (req.user.role !== 'admin' && keyRecord.created_by !== req.user.id)) {
      return res.status(404).json({ error: 'CDKey not found' });
    }

    // Delete first; only the request that actually removed the row issues the refund,
    // so double-clicks can never refund twice.
    const del = await db.run('DELETE FROM keys WHERE id = ?', [keyRecord.id]);
    if (del.changes !== 1) {
      return res.status(409).json({ error: 'CDKey was already revoked' });
    }

    let refunded = 0;
    let refundedTo = null;
    const creator = await db.get('SELECT id, username, role FROM users WHERE id = ?', [keyRecord.created_by]);
    if (creator && creator.role === 'reseller' && keyRecord.cost > 0) {
      refunded = keyRecord.cost;
      refundedTo = creator.username;
      await db.run('UPDATE users SET credits = credits + ? WHERE id = ?', [refunded, creator.id]);
      await db.run(`
        INSERT INTO topup_logs (reseller_id, admin_id, amount, note)
        VALUES (?, ?, ?, ?)
      `, [creator.id, req.user.id, refunded,
          `Refund: revoked ${keyRecord.status === 'used' ? 'activated' : 'unused'} key ${cdkey}`]);
    }

    keyListCache.fetchedAt = 0;
    await db.run('DELETE FROM user_memberships WHERE cd_key = ?', [cdkey]).catch(() => {});

    // If this key had been activated, recompute that SteamID's entitlements so
    // the revoked AppID(s) drop out of users/<steamid>.json — unless another of
    // the customer's still-valid keys also grants them.
    let entitlements = null;
    if (keyRecord.activated_by) {
      await db.run('DELETE FROM user_memberships WHERE steamid = ?', [toSteamId64(keyRecord.activated_by)]).catch(() => {});
      entitlements = await syncUserEntitlements(keyRecord.activated_by);
    }

    let message = `Revoked ${cdkey}`;
    if (refundedTo) message += ` and refunded ${refunded} credits to ${refundedTo}`;
    else if (!creator) message += ' (creator account removed, no refund)';
    if (!github.success) message += '. Warning: could not remove it from GitHub';
    if (entitlements && !entitlements.success) message += '. Warning: could not update the customer entitlement file';

    res.json({ message, refunded, refunded_to: refundedTo, github, entitlements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GAME CATALOG (ONENNABE API PROXY)
// ==========================================

const GAMES_API_URL = process.env.GAMES_API_URL || 'https://steamunlockonennabe.duckdns.org/api/onennabe';
const GAMES_CACHE_MS = 60 * 60 * 1000; // 1 hour TTL for game catalog cache
let gamesCache = { data: null, byId: null, genres: [], fetchedAt: 0, pending: null };
const _yesFlag = (v) => {
  if (!v) return false;
  if (v === true || v === 1) return true;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1';
};

// Primary-genre mapping (the catalog's numeric primary_genre → display name).
const GENRE_MAP = {
  0: 'Unknown Genre', 1: 'Action', 2: 'Strategy', 3: 'RPG', 4: 'Casual', 5: 'Strategy',
  28: 'Simulation', 18: 'Sports', 9: 'Racing', 10: 'MMO', 11: 'FPS', 12: 'Puzzle',
  23: 'Indie', 25: 'Adventure', 29: 'Massively Multiplayer', 33: 'Indie', 34: 'Indie',
  37: 'Free To Play', 50: 'Indie', 51: 'Animation & Modeling', 52: 'Music',
  53: 'Software & Tools', 54: 'Education', 55: 'Software & Tools', 57: 'Software & Tools',
  58: 'Software & Tools', 59: 'Software & Tools', 70: 'Early Access', 71: 'Sexual Content',
  72: 'Sexual Content', 73: 'Adventure', 74: 'Gore', 60: 'Software & Tools',
};
function genreName(id) { return GENRE_MAP[Number(id)] || 'Other'; }

// Pre-compiled regex (compiled once at module level instead of 150,000+ times per catalog refresh)
const ADULT_KEYWORD_RE = /\bpornocrates\b|\bpornstar\b|\bsuccubus\b|\bsexdivers\b|\bsextet\b|\bsexy\b|\bpleasure\b|\bhentai\b|\bsex2\b|\bsex\b|\bsexual\b|\becchi\b|\bnsfw\b|\beroge\b|\bxxx\b|\br18\b|18\+|\bnude\b|\bnudity\b|\buncensored\b/;

// Adult detector — content_descriptors (preferred), primary_genre fallback, then
// name-keyword heuristics for mislabeled titles.
function isAdultGame(game) {
  try {
    const cds = (game && game.content_descriptors && game.content_descriptors.length) ? game.content_descriptors : [];
    for (let i = 0; i < cds.length; i++) { const c = String(cds[i]); if (c === '3' || c === '4') return true; }
    const pg = Number(game && game.primary_genre);
    if (pg === 71 || pg === 72) return true;
    const name = String((game && game.name) || '').toLowerCase();
    if (ADULT_KEYWORD_RE.test(name)) return true;
    return false;
  } catch (e) { return false; }
}
// Fast parse "10.88 GB" / "512 MB" → float GB without regex allocation
function parseSizeGB(s) {
  if (!s) return 0;
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  if (typeof s === 'string') {
    if (s.includes('MB') || s.includes('mb')) return num / 1024;
    if (s.includes('TB') || s.includes('tb')) return num * 1024;
  }
  return num;
}
// Size bucket key for filtering.
function sizeBucket(gb) {
  if (gb <= 0) return 'unknown';
  if (gb < 5) return 'lt5';
  if (gb < 20) return '5to20';
  if (gb < 50) return '20to50';
  return 'gt50';
}

const CATALOG_CACHE_FILE = path.join(__dirname, 'catalog_cache.json');

// High-efficiency catalog builder: single pass, no intermediate array allocations
function _buildCatalog(list) {
  const len = list ? list.length : 0;
  const data = [];
  const genreSet = new Map();

  for (let i = 0; i < len; i++) {
    const g = list[i];
    if (!g || !g.appid || !g.name || g.requires_membership === true) continue;

    const gid = g.primary_genre ? String(g.primary_genre).trim() : '';
    const gName = GENRE_MAP[gid] || 'Other';
    const gb = parseSizeGB(g.size_gb);

    data.push({
      appid: String(g.appid),
      name: String(g.name),
      genre: gid,
      genreName: gName,
      size_gb: g.size_gb || '',
      sizeGB: gb,
      sizeBucket: gb <= 0 ? 'unknown' : (gb < 5 ? 'lt5' : (gb < 20 ? '5to20' : (gb < 50 ? '20to50' : 'gt50'))),
      adult: isAdultGame(g),
      online_supported: _yesFlag(g.online_supported),
      bypass_supported: _yesFlag(g.bypass_supported),
      hypervisor_bypass: _yesFlag(g.hypervisor_bypass),
    });

    if (gid && !genreSet.has(gid)) {
      genreSet.set(gid, gName);
    }
  }

  const genres = [];
  for (const [id, name] of genreSet.entries()) {
    genres.push({ id, name });
  }
  genres.sort((a, b) => a.name.localeCompare(b.name));

  return { data, genres };
}

function _applyCatalog(data, genres, fetchedAt) {
  gamesCache.data = data;
  const byId = new Map();
  const len = data ? data.length : 0;
  for (let i = 0; i < len; i++) {
    const g = data[i];
    byId.set(g.appid, g);
  }
  gamesCache.byId = byId;
  gamesCache.genres = genres || [];
  gamesCache.fetchedAt = fetchedAt || Date.now();
}

// Seed from disk on boot, so a cold start (or an upstream outage) serves the grid
// instantly instead of blocking or 502-ing. Marked stale so a refresh still runs.
(function loadCatalogFromDisk() {
  try {
    if (fs.existsSync(CATALOG_CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8'));
      if (saved && Array.isArray(saved.data) && saved.data.length) {
        _applyCatalog(saved.data, saved.genres || [], saved.fetchedAt || Date.now());
        console.log(`[Game Catalog] Seeded ${saved.data.length} games from disk cache`);
      }
    }
  } catch (e) { console.error('[Game Catalog] disk load failed:', e.message); }
})();

// The upstream fetch. Concurrent callers share one in-flight request.
function refreshCatalog() {
  if (gamesCache.pending) return gamesCache.pending;
  gamesCache.pending = (async () => {
    try {
      const r = await fetchT(GAMES_API_URL, { headers: { 'User-Agent': 'OST-Server/1.0' } }, 20000);
      if (!r.ok) throw new Error(`Game catalog returned HTTP ${r.status}`);
      const json = await r.json();
      const list = Array.isArray(json) ? json : (json.games || json.data || []);
      const { data, genres } = _buildCatalog(list);
      if (!data.length) throw new Error('upstream returned an empty catalog');
      _applyCatalog(data, genres, Date.now());
      fs.writeFile(CATALOG_CACHE_FILE, JSON.stringify({ data, genres, fetchedAt: gamesCache.fetchedAt }), () => {});
      return gamesCache.data;
    } finally {
      gamesCache.pending = null;
    }
  })();
  return gamesCache.pending;
}

// Non-blocking getter with stale-while-revalidate:
//   • fresh cache           → return immediately
//   • stale cache with data → return stale NOW, refresh in the background
//   • no data at all        → wait for one fetch (rare — disk seeds it)
// A request NEVER waits on the upstream once we have any data, so the grid loads
// instantly and an upstream hiccup can't 502 the list.
async function getGameCatalog() {
  const fresh = gamesCache.data && (Date.now() - gamesCache.fetchedAt < GAMES_CACHE_MS);
  if (fresh) return gamesCache.data;

  if (gamesCache.data) {
    refreshCatalog().catch(err =>
      console.error(`[Game Catalog] background refresh failed, keeping cached list: ${err.message}`));
    return gamesCache.data;
  }

  try {
    return await refreshCatalog();
  } catch (err) {
    console.error(`[Game Catalog] initial load failed: ${err.message}`);
    return gamesCache.data || [];   // empty rather than throwing → no 502
  }
}

// Keep the cache warm so no user request ever waits on the upstream.
// Only fetch if missing or older than cache TTL.
setInterval(() => { refreshCatalog().catch(() => {}); }, GAMES_CACHE_MS);
setTimeout(() => {
  if (!gamesCache.data || (Date.now() - gamesCache.fetchedAt > GAMES_CACHE_MS)) {
    refreshCatalog().catch(() => {});
  }
}, 30000);

// Search games by name or AppID (with full catalog pagination & filters)
app.get('/api/games', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.search || req.query.q || '').trim().toLowerCase();
    const genre = String(req.query.genre || '').trim();       // genre id, '' = any
    const size = String(req.query.size || '').trim();         // bucket key, '' = any
    const showAdult = String(req.query.adult || '1') !== '0'; // show 18+ unless explicitly hidden
    const fOnline = String(req.query.online || '') === '1';
    const fBypass = String(req.query.bypass || '') === '1';
    const fHyper  = String(req.query.hypervisor || '') === '1';

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || req.query.pageSize, 10) || 24, 1), 200);

    const games = await getGameCatalog();

    let pool = showAdult ? games : games.filter((g) => !g.adult);
    let matches = pool;

    if (q) {
      matches = /^\d+$/.test(q)
        ? matches.filter((g) => g.appid.includes(q))
        : matches.filter((g) => g.name.toLowerCase().includes(q));
    }
    if (genre) matches = matches.filter((g) => g.genre === genre);
    if (size) matches = matches.filter((g) => g.sizeBucket === size);
    if (fOnline) matches = matches.filter((g) => g.online_supported);
    if (fBypass) matches = matches.filter((g) => g.bypass_supported);
    if (fHyper)  matches = matches.filter((g) => g.hypervisor_bypass);

    const total = matches.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const curPage = Math.min(Math.max(page, 1), pages);
    const slice = matches.slice((curPage - 1) * limit, curPage * limit);

    res.json({
      total, page: curPage, pages, limit, catalogTotal: games.length,
      genres: gamesCache.genres || [],
      games: slice.map((g) => ({
        appid: g.appid,
        name: g.name,
        genre: g.genre,
        genreName: g.genreName,
        size_gb: g.size_gb,
        sizeGB: g.sizeGB,
        sizeBucket: g.sizeBucket,
        adult: g.adult,
        online_supported: g.online_supported,
        bypass_supported: g.bypass_supported,
        hypervisor_bypass: g.hypervisor_bypass,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: `Could not load game list: ${err.message}` });
  }
});


// Reseller / Admin Generate Keys
app.post('/api/keys/generate', authenticateToken, async (req, res) => {
  try {
    let { appids, quantity, game_name } = req.body;
    game_name = game_name ? String(game_name).trim().slice(0, 200) : null;

    if (!appids) {
      return res.status(400).json({ error: 'AppID(s) are required' });
    }

    if (Array.isArray(appids)) {
      appids = appids.map(a => String(a).trim()).filter(Boolean).join(',');
    } else {
      appids = String(appids).split(',').map(a => a.trim()).filter(Boolean).join(',');
    }

    if (!appids) {
      return res.status(400).json({ error: 'Valid AppID(s) required' });
    }

    const numKeys = parseInt(quantity) || 1;
    if (numKeys < 1 || numKeys > 100) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    }

    // Fixed price: every key costs exactly 1 credit. The cost is set server-side
    // so a reseller can't lower it (a client-supplied cost is ignored).
    const CREDIT_PER_KEY = 1.0;
    const keyCost = CREDIT_PER_KEY;
    const totalCost = numKeys * keyCost;

    const isReseller = req.user.role === 'reseller';
    if (isReseller) {
      const user = await db.get('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      if (user.credits < totalCost) {
        return res.status(400).json({
          error: `Insufficient credit balance! Required: ${totalCost} credits, Available: ${user.credits} credits.`
        });
      }
      await db.run('UPDATE users SET credits = credits - ? WHERE id = ?', [totalCost, req.user.id]);
    }

    const generatedKeys = [];

    for (let i = 0; i < numKeys; i++) {
      let keyStr = generateCDKeyString();
      while (await db.get('SELECT id FROM keys WHERE cdkey = ?', [keyStr])) {
        keyStr = generateCDKeyString();
      }

      await db.run(`
        INSERT INTO keys (cdkey, appids, game_name, created_by, cost, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `, [keyStr, appids, game_name, req.user.id, keyCost]);

      // Automatically commit key file to GitHub repository keys/<cdkey>.txt
      commitKeyToGitHub(keyStr, appids);

      generatedKeys.push({
        cdkey: keyStr,
        appids,
        game_name,
        cost: keyCost
      });
    }

    const updatedUser = await db.get('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      message: `Successfully generated ${numKeys} CDKey(s) and synced to GitHub`,
      total_cost: totalCost,
      remaining_credits: updatedUser.credits,
      keys: generatedKeys
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Current User's Generated Keys
app.get('/api/keys/my-keys', authenticateToken, async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = 'SELECT * FROM keys WHERE created_by = ?';
    const params = [req.user.id];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (cdkey LIKE ? OR appids LIKE ? OR game_name LIKE ? OR activated_by LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }

    query += ' ORDER BY created_at DESC LIMIT 500';

    const keys = await db.all(query, params);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Reseller Stats
app.get('/api/reseller/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await db.get('SELECT credits FROM users WHERE id = ?', [userId]);
    const totalKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys WHERE created_by = ?) + 
        (SELECT COUNT(*) FROM keys WHERE created_by = ?)
      ) as count
    `, [userId, userId]);
    const activeKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys WHERE status = 'active' AND created_by = ?) + 
        (SELECT COUNT(*) FROM keys WHERE status = 'active' AND created_by = ?)
      ) as count
    `, [userId, userId]);
    const usedKeysRow = await db.get(`
      SELECT (
        (SELECT COUNT(*) FROM og_keys WHERE status = 'used' AND created_by = ?) + 
        (SELECT COUNT(*) FROM keys WHERE status = 'used' AND created_by = ?)
      ) as count
    `, [userId, userId]);

    const recentActivations = await db.all(`
      SELECT cdkey, steamid, appids, creator_name, activated_at FROM (
        SELECT a.cdkey, a.steamid, a.appids, a.activated_at, COALESCE(u.username, 'System') as creator_name
        FROM activations a
        INNER JOIN keys k ON a.cdkey = k.cdkey
        INNER JOIN users u ON k.created_by = u.id
        WHERE k.created_by = ?
        UNION ALL
        SELECT oa.cdkey, oa.steamid, oa.appid as appids, oa.activated_at, COALESCE(u.username, 'System') as creator_name
        FROM og_activations oa
        INNER JOIN og_keys ok ON oa.cdkey = ok.cdkey
        INNER JOIN users u ON ok.created_by = u.id
        WHERE ok.created_by = ?
      )
      ORDER BY activated_at DESC LIMIT 10
    `, [userId, userId]);

    res.json({
      credits: user ? user.credits : 0,
      totalKeys: totalKeysRow ? totalKeysRow.count : 0,
      activeKeys: activeKeysRow ? activeKeysRow.count : 0,
      usedKeys: usedKeysRow ? usedKeysRow.count : 0,
      recentActivations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PUBLIC CDKEY ACTIVATION ENDPOINT
// ==========================================

async function handleKeyActivation(cdkeyInput, steamidInput, reqIp) {
  if (!cdkeyInput || !steamidInput) {
    return { status: 400, data: { success: false, error: 'cdkey and steamid parameters are required' } };
  }

  const cleanKey = String(cdkeyInput).trim().toUpperCase();
  const cleanSteamID = String(steamidInput).trim();

  const keyRecord = await db.get('SELECT * FROM keys WHERE cdkey = ?', [cleanKey]);

  if (!keyRecord) {
    return { status: 404, data: { success: false, error: 'CDKey not found or invalid' } };
  }

  if (keyRecord.status === 'used') {
    return {
      status: 400,
      data: {
        success: false,
        error: 'CDKey has already been activated',
        activated_by: keyRecord.activated_by,
        activated_at: keyRecord.activated_at
      }
    };
  }

  if (keyRecord.status === 'disabled') {
    return { status: 400, data: { success: false, error: 'CDKey is disabled' } };
  }

  // Cross-check: if this account already owns every appid this key grants, do NOT
  // consume the key — the game is already unlocked for them (via an earlier key
  // or their membership). The key stays 'active' so it isn't wasted.
  const keyAppids = String(keyRecord.appids || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (keyAppids.length) {
    const owned = new Set();
    for (const a of await computeEntitlements(cleanSteamID)) owned.add(String(a));
    try {
      for (const a of await readUsersJsonAppids(toSteamId64(cleanSteamID))) owned.add(String(a));
    } catch (_) { /* membership lookup best-effort */ }
    if (keyAppids.every((a) => owned.has(String(a)))) {
      return {
        status: 409,
        data: {
          success: false,
          already_owned: true,
          error: 'This account already owns this game — the key was not used.',
          appids: keyAppids.map(Number),
        },
      };
    }
  }

  await db.run(`
    UPDATE keys
    SET status = 'used', activated_by = ?, activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [cleanSteamID, keyRecord.id]);

  await db.run(`
    INSERT INTO activations (cdkey, steamid, appids, ip_address)
    VALUES (?, ?, ?, ?)
  `, [cleanKey, cleanSteamID, keyRecord.appids, reqIp || '127.0.0.1']);

  // Recompute this SteamID's full entitlement set (this key plus any earlier
  // keys the same account activated) and push it to users/<steamid>.json.
  await syncUserEntitlements(cleanSteamID);

  // Return the SteamID's entire entitlement set, so the DLL injects everything
  // the account owns, not only this one key.
  const entitled = await computeEntitlements(cleanSteamID);

  return {
    status: 200,
    data: {
      success: true,
      message: 'CDKey activated successfully!',
      cdkey: cleanKey,
      steamid: cleanSteamID,
      appids: entitled.map(Number)
    }
  };
}

// POST /api/activate
app.post('/api/activate', async (req, res) => {
  const { cdkey, key, steamid } = req.body;
  const targetKey = cdkey || key;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const result = await handleKeyActivation(targetKey, steamid, ip);
  res.status(result.status).json(result.data);
});

// GET /api/activate
app.get('/api/activate', async (req, res) => {
  const { cdkey, key, steamid } = req.query;
  const targetKey = cdkey || key;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const result = await handleKeyActivation(targetKey, steamid, ip);
  res.status(result.status).json(result.data);
});

// ==========================================
// END-USER DASHBOARD (Steam OpenID login + remote game unlocking)
// ==========================================

const SITE_URL = (process.env.SITE_URL || 'https://onennabe.duckdns.org').replace(/\/+$/, '');

// ── Session cookie (signed JWT, httpOnly) ─────────────────────────────────────
function setSteamSession(res, steamid64) {
  const token = jwt.sign({ sid: steamid64, kind: 'steam' }, JWT_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie', `dash=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}
function clearSteamSession(res) {
  res.setHeader('Set-Cookie', 'dash=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}
function getSteamSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)dash=([^;]+)/);
  if (!m) return null;
  try {
    const d = jwt.verify(decodeURIComponent(m[1]), JWT_SECRET);
    return (d && d.kind === 'steam') ? String(d.sid) : null;
  } catch { return null; }
}
function requireSteam(req, res, next) {
  const sid = getSteamSession(req);
  if (!sid) return res.status(401).json({ error: 'Not signed in' });
  req.steamid = sid;
  next();
}

// ── Steam OpenID 2.0 ──────────────────────────────────────────────────────────
app.get('/auth/steam', (req, res) => {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': SITE_URL + '/auth/steam/return',
    'openid.realm': SITE_URL,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect('https://steamcommunity.com/openid/login?' + params.toString());
});

app.get('/auth/steam/return', async (req, res) => {
  try {
    // Re-post all params to Steam with mode=check_authentication to verify.
    const verify = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) verify.append(k, String(v));
    verify.set('openid.mode', 'check_authentication');
    const r = await fetchT('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verify.toString(),
    }, 10000);
    const text = await r.text();
    if (!/is_valid\s*:\s*true/i.test(text)) return res.status(401).send('Steam verification failed. <a href="/dashboard">Back</a>');
    const claimed = String(req.query['openid.claimed_id'] || '');
    const m = claimed.match(/\/id\/(\d{17})$/);
    if (!m) return res.status(400).send('Could not read SteamID. <a href="/dashboard">Back</a>');
    setSteamSession(res, m[1]);
    res.redirect('/dashboard');
  } catch (e) {
    res.status(500).send('Auth error. <a href="/dashboard">Back</a>');
  }
});

app.get('/auth/logout', (req, res) => { clearSteamSession(res); res.redirect('/dashboard'); });

// ── Membership lookup helper (shared) ─────────────────────────────────────────
async function suLookup(sid64) {
  if (!sid64) return { found: false };
  const today = suTodayStr();

  // 1. Instant direct read from local onennabe.db ground truth (1ms)
  try {
    const rows = await suLookupDbDirect(sid64);
    if (rows !== null) {
      const matches = rows.map((r) => {
        const exp = String(r.expiry_date || '');
        return {
          cd_key: r.cd_key,
          key_type: r.key_type || 'STANDARD',
          activation_date: String(r.link_activation_date || r.activation_date || ''),
          expiry_date: exp,
          expired: exp ? (exp < today) : false
        };
      });

      const active = matches.filter((m) => !m.expired).sort(suKeyCompare);
      if (active.length) {
        const best = active[0];
        await db.run(`
          INSERT OR REPLACE INTO user_memberships (steamid, cd_key, key_type, activation_date, expiry_date, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [sid64, best.cd_key, best.key_type, best.activation_date, best.expiry_date, Date.now()]).catch(() => {});
        return { found: true, ...best };
      }

      // If no active matches found for this SteamID in onennabe.db (e.g. revoked key),
      // purge any stale user_memberships row IMMEDIATELY so non-activated state is shown!
      await db.run('DELETE FROM user_memberships WHERE steamid = ?', [sid64]).catch(() => {});

      if (matches.length) {
        const m = matches.slice().sort(suKeyCompare)[0];
        return { found: false, expired: true, ...m };
      }

      return { found: false };
    }
  } catch (e) {
    console.error('[suLookup] Direct DB lookup error:', e.message);
  }

  // 2. Fallback to local DB cache check if onennabe.db file read fails
  try {
    const local = await db.get('SELECT * FROM user_memberships WHERE steamid = ?', [sid64]);
    if (local && local.cd_key) {
      const exp = String(local.expiry_date || '');
      const isExpired = exp ? (exp < today) : false;
      if (!isExpired) {
        return {
          found: true,
          cd_key: local.cd_key,
          key_type: local.key_type || 'STANDARD',
          activation_date: local.activation_date || '',
          expiry_date: exp,
          expired: false
        };
      }
    }
  } catch (e) {}

  // 3. Fallback to remote API if everything else fails
  try {
    const keys = await getKeyList();
    const matches = [];
    for (const k of (keys || [])) {
      const ids = Array.isArray(k.steamids) ? k.steamids : [];
      const mine = ids.find((s) => String(s && (s.steamid || s)).trim() === sid64);
      if (!mine) continue;
      const exp = String(k.expiry_date || '');
      matches.push({
        cd_key: k.cd_key,
        expiry_date: exp,
        key_type: k.key_type || '',
        activation_date: String((mine && mine.activation_date) || k.activation_date || ''),
        expired: exp ? (exp < today) : false,
      });
    }

    const active = matches.filter((m) => !m.expired).sort(suKeyCompare);
    if (active.length) {
      const best = active[0];
      await db.run(`
        INSERT OR REPLACE INTO user_memberships (steamid, cd_key, key_type, activation_date, expiry_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sid64, best.cd_key, best.key_type, best.activation_date, best.expiry_date, Date.now()]).catch(() => {});
      return { found: true, ...best };
    }
    if (matches.length) {
      const m = matches.slice().sort(suKeyCompare)[0];
      return { found: false, expired: true, ...m };
    }
  } catch (e) {}

  return { found: false };
}

// ── Steam Profile Cache ───────────────────────────────────────────────────────
const _steamProfileCache = new Map();
async function fetchSteamProfile(sid) {
  if (_steamProfileCache.has(sid)) return _steamProfileCache.get(sid);
  try {
    const r = await fetchT(`https://steamcommunity.com/profiles/${sid}?xml=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, 4000);
    const text = await r.text();
    const nameMatch = text.match(/<steamID>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/steamID>/s);
    const avatarMatch = text.match(/<avatarMedium>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/avatarMedium>/s);
    const persona = (nameMatch && nameMatch[1]) ? nameMatch[1].trim() : '';
    const avatar = (avatarMatch && avatarMatch[1]) ? avatarMatch[1].trim() : '';
    const out = { personaName: persona || sid, avatar: avatar || '' };
    if (persona) _steamProfileCache.set(sid, out);
    return out;
  } catch (e) {
    return { personaName: sid, avatar: '' };
  }
}

// ── Dashboard API (session-authenticated) ─────────────────────────────────────
// Who am I + membership + my unlocked games + persona name & avatar.
app.get('/dash/api/me', requireSteam, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const sid = toSteamId64(req.steamid);
    const [mem, appids, profile] = await Promise.all([
      suLookup(sid).catch(() => ({ found: false })),
      readUsersJsonAppids(sid).catch(() => []),
      fetchSteamProfile(sid).catch(() => ({ personaName: sid, avatar: '' })),
    ]);
    res.json({
      steamid: sid,
      personaName: profile.personaName,
      avatar: profile.avatar,
      membership: mem,
      appids: appids.map(Number),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activate a CD key against the signed-in SteamID (binds membership).
app.post('/dash/api/activate', requireSteam, async (req, res) => {
  try {
    const sid = toSteamId64(req.steamid);
    const cd = String((req.body && req.body.cd_key) || '').trim();
    if (!cd) return res.status(400).json({ status: 'error', message: 'CD key required' });
    const vd = await suValidate(cd, sid);
    if (!vd) return res.status(502).json({ status: 'error', message: 'Validation server error' });
    return res.json(vd);
  } catch (e) { res.status(502).json({ status: 'error', message: 'Could not reach validation server' }); }
});

// Canonical Steam Store Genres (Single Source of Truth)
const STEAM_CANONICAL_GENRES = [
  "Action", "Adventure", "Casual", "Early Access", "Free to Play",
  "Indie", "Massively Multiplayer", "Racing", "RPG", "Simulation",
  "Sports", "Strategy", "Utilities"
];

// Search + paginate the onennabe catalog (name / appid). Returns cover art plus
// the total match count and page metadata for the grid.
app.get('/dash/api/games', requireSteam, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const genre = String(req.query.genre || '').trim();       // genre name/id, '' = any
    const size = String(req.query.size || '').trim();         // bucket key, '' = any
    const scope = String(req.query.scope || 'all').trim();    // 'all' | 'unlocked'
    const showAdult = String(req.query.adult || '') === '1';  // parental control off?
    // Tag filters — each '1' requires the game to carry that flag (AND together).
    const fOnline = String(req.query.online || '') === '1';
    const fBypass = String(req.query.bypass || '') === '1';
    const fHyper  = String(req.query.hypervisor || '') === '1';
    const rawGames = await getGameCatalog();

    // Enrich catalog games with real Steam info from cache if available
    const games = rawGames.map(g => {
      const cached = _infoCache.get(g.appid);
      const steamGenres = (cached && Array.isArray(cached.genres) && cached.genres.length)
        ? cached.genres
        : (g.genres || (g.genreName ? [g.genreName] : []));
      const genreName = steamGenres.length ? steamGenres.slice(0, 3).join(', ') : (g.genreName || '');
      return {
        ...g,
        genres: steamGenres,
        genreName: genreName,
        developers: cached ? (cached.developers || '') : '',
        releaseDate: cached ? (cached.releaseDate || '') : '',
      };
    });

    // Parental control: hide 18+ titles unless explicitly allowed.
    let pool = showAdult ? games : games.filter((g) => !g.adult);

    // "My games" scope: restrict to the signed-in account's unlocked appids.
    if (scope === 'unlocked') {
      const sid = toSteamId64(req.steamid);
      const owned = new Set((await readUsersJsonAppids(sid)).map(String));
      pool = pool.filter((g) => owned.has(g.appid));
    }

    let matches = pool;
    if (q) {
      matches = /^\d+$/.test(q)
        ? matches.filter((g) => g.appid.includes(q))
        : matches.filter((g) => g.name.toLowerCase().includes(q));
    }
    if (genre) {
      matches = matches.filter((g) => {
        if (Array.isArray(g.genres) && g.genres.some(s => s.toLowerCase() === genre.toLowerCase())) return true;
        if (g.genreName && g.genreName.toLowerCase().includes(genre.toLowerCase())) return true;
        if (g.genre && String(g.genre).toLowerCase() === genre.toLowerCase()) return true;
        return false;
      });
    }
    if (size) matches = matches.filter((g) => g.sizeBucket === size);
    if (fOnline) matches = matches.filter((g) => g.online_supported);
    if (fBypass) matches = matches.filter((g) => g.bypass_supported);
    if (fHyper)  matches = matches.filter((g) => g.hypervisor_bypass);

    const total = matches.length;
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 24, 1), 60);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
    const slice = matches.slice((page - 1) * pageSize, page * pageSize);

    // Single source of truth for genres dropdown: real Steam Store Genres
    const genres = STEAM_CANONICAL_GENRES.map(name => ({ id: name, name }));

    res.json({
      total, page, pages, pageSize, catalogTotal: games.length, scopeTotal: pool.length,
      genres,
      games: slice.map((g) => ({
        appid: g.appid,
        name: g.name,
        genre: g.genre,
        genres: g.genres,
        genreName: g.genreName,
        developers: g.developers,
        releaseDate: g.releaseDate,
        size_gb: g.size_gb,
        sizeGB: g.sizeGB,
        adult: g.adult,
        online_supported: g.online_supported,
        bypass_supported: g.bypass_supported,
        hypervisor_bypass: g.hypervisor_bypass,
        cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
      })),
    });
  } catch (e) { res.status(502).json({ error: 'Catalog unavailable' }); }
});

// Per-game live info for the card & modal popup — mirrors the desktop app:
const GAME_INFO_CACHE_FILE = path.join(__dirname, 'game_info_cache.json');
const _infoCache = new Map();
const _infoPending = new Map();

(function loadGameInfoFromDisk() {
  try {
    if (fs.existsSync(GAME_INFO_CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(GAME_INFO_CACHE_FILE, 'utf8'));
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          if (v && (v.cover || (v.genres && v.genres.length) || (v.rating && v.rating.score))) {
            _infoCache.set(k, v);
          }
        }
        console.log(`[Game Info] Seeded ${_infoCache.size} game info records from disk cache`);
      }
    }
  } catch (e) { console.error('[Game Info] disk load failed:', e.message); }
})();

let _saveInfoTimeout = null;
function saveGameInfoToDisk() {
  if (_saveInfoTimeout) return;
  _saveInfoTimeout = setTimeout(() => {
    _saveInfoTimeout = null;
    try {
      const obj = Object.fromEntries(_infoCache);
      fs.writeFileSync(GAME_INFO_CACHE_FILE, JSON.stringify(obj));
    } catch (_) {}
  }, 5000);
}

const REVIEW_LABELS = { 9: 'Overwhelmingly Positive', 8: 'Very Positive', 7: 'Positive',
  6: 'Mostly Positive', 5: 'Mixed', 4: 'Mostly Negative', 3: 'Negative',
  2: 'Very Negative', 1: 'Overwhelmingly Negative' };

async function fetchAppDetails(appid) {
  try {
    const r = await fetchT(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=en&cc=my`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, 8000);
    const data = await r.json().catch(() => null);
    let node = data && data[appid];
    if (!(node && node.success && node.data) && data) {
      for (const v of Object.values(data)) {
        if (v && v.success && v.data && String(v.data.steam_appid) === appid) { node = v; break; }
      }
    }
    if (node && node.success && node.data) {
      const d = node.data;
      const genres = Array.isArray(d.genres) ? d.genres.map((x) => x && x.description).filter(Boolean) : [];
      const screenshots = Array.isArray(d.screenshots) ? d.screenshots.map((s) => s.path_full || s.path_thumbnail).filter(Boolean) : [];
      const developers = Array.isArray(d.developers) ? d.developers.join(', ') : (d.developers || '');
      const publishers = Array.isArray(d.publishers) ? d.publishers.join(', ') : (d.publishers || '');
      const releaseDate = (d.release_date && d.release_date.date) || '';
      const description = d.about_the_game || d.detailed_description || d.short_description || '';
      const movies = Array.isArray(d.movies) ? d.movies.map((m) => {
        const webm = (m.webm && (m.webm.max || m.webm[480])) || (typeof m.webm === 'string' ? m.webm : '');
        const mp4 = (m.mp4 && (m.mp4.max || m.mp4[480])) || (typeof m.mp4 === 'string' ? m.mp4 : '');
        const hls = m.hls_h264 || m.hls || '';
        const dash = m.dash_h264 || m.dash || '';
        return {
          name: m.name || '',
          thumbnail: m.thumbnail || '',
          webm, mp4, hls, dash
        };
      }).filter(m => m.webm || m.mp4 || m.hls || m.dash) : [];

      return {
        cover: d.header_image || '', capsule: d.capsule_image || '', screenshots, movies,
        genres, genre: genres[0] || '',
        developers, publishers, releaseDate, description,
        about_the_game: d.about_the_game || d.detailed_description || d.short_description || '',
        requiredAge: parseInt(d.required_age, 10) || 0, isFree: !!d.is_free,
        recommendations: (d.recommendations && d.recommendations.total) || 0,
        metacritic: (d.metacritic && d.metacritic.score) || 0,
      };
    }
  } catch (e) { /* ignore */ }
  return { cover: '', capsule: '', screenshots: [], movies: [], genres: [], genre: '', developers: '', publishers: '', releaseDate: '', description: '', about_the_game: '', requiredAge: 0, isFree: false, recommendations: 0, metacritic: 0 };
}

async function fetchReviewScore(appid) {
  try {
    const r = await fetchT(`https://api.steamcmd.net/v1/info/${appid}`, {}, 2500);
    const data = await r.json().catch(() => null);
    const common = data && data.data && data.data[appid] && data.data[appid].common;
    if (common) {
      const score = parseInt(common.review_score, 10);
      const pct = parseInt(common.review_percentage, 10);
      return { score: (!isNaN(score) ? score : null), pct: (!isNaN(pct) ? pct : null) };
    }
  } catch (e) { /* ignore */ }
  return { score: null, pct: null };
}

// Turn the review score (+ appdetails fallbacks) into a display label/class/count.
function computeRating(rv, det) {
  if (rv.score && rv.score >= 1) {
    return { score: rv.score, label: REVIEW_LABELS[rv.score] || '',
      cls: rv.score >= 6 ? 'pos' : (rv.score <= 3 ? 'neg' : 'mix'),
      count: (rv.pct != null ? rv.pct + '% positive' : '') };
  }
  if (det.recommendations > 0) {
    const t = det.recommendations;
    const score = t > 50000 ? 9 : t > 10000 ? 8 : t > 500 ? 6 : 7;
    return { score, label: REVIEW_LABELS[score], cls: 'pos', count: t.toLocaleString() + ' reviews' };
  }
  if (det.metacritic > 0) {
    const s = det.metacritic;
    const score = s >= 85 ? 9 : s >= 75 ? 8 : s >= 60 ? 6 : s >= 40 ? 5 : 4;
    return { score, label: REVIEW_LABELS[score], cls: s >= 60 ? 'pos' : s >= 40 ? 'mix' : 'neg', count: 'Metacritic ' + s };
  }
  return { score: null, label: '', cls: '', count: '' };
}

app.get('/api/gameinfo/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  if (!appid) return res.status(400).json({ error: 'appid required' });
  if (_infoCache.has(appid)) {
    const cached = _infoCache.get(appid);
    if (cached && cached.cover && (cached.about_the_game || cached.description)) {
      return res.json(cached);
    }
    _infoCache.delete(appid);
  }

  if (_infoPending.has(appid)) {
    try {
      const out = await _infoPending.get(appid);
      return res.json(out);
    } catch {
      return res.json({ appid, genre: '', genres: [], developers: '', publishers: '', releaseDate: '', description: '', about_the_game: '', required_age: 0, is_free: false, adult: false, cover: '', capsule: '', screenshots: [], movies: [], rating: { score: null, label: '', cls: '', count: '' } });
    }
  }

  const p = (async () => {
    const [det, rv] = await Promise.all([fetchAppDetails(appid), fetchReviewScore(appid)]);
    const out = {
      appid,
      genre: det.genre, genres: det.genres,
      developers: det.developers, publishers: det.publishers,
      releaseDate: det.releaseDate, description: det.description,
      about_the_game: det.about_the_game || det.description || '',
      required_age: det.requiredAge, is_free: det.isFree, adult: det.requiredAge >= 18,
      cover: det.cover, capsule: det.capsule, screenshots: det.screenshots, movies: det.movies,
      rating: computeRating(rv, det),
    };
    if (det.cover || (det.genres && det.genres.length) || (rv.score != null && rv.score >= 1) || det.recommendations > 0) {
      _infoCache.set(appid, out);
      saveGameInfoToDisk();
    }
    return out;
  })();

  _infoPending.set(appid, p);
  try {
    const out = await p;
    res.json(out);
  } catch (err) {
    res.json({ appid, genre: '', genres: [], developers: '', publishers: '', releaseDate: '', description: '', about_the_game: '', required_age: 0, is_free: false, adult: false, cover: '', capsule: '', screenshots: [], movies: [], rating: { score: null, label: '', cls: '', count: '' } });
  } finally {
    _infoPending.delete(appid);
  }
});
// Back-compat alias for the older reviews endpoint.
app.get('/api/reviews/:appid', (req, res) => res.redirect(307, `/api/gameinfo/${String(req.params.appid || '').replace(/\D/g, '')}`));

// Unlock a game remotely — requires an ACTIVE membership on this SteamID.
app.post('/dash/api/unlock', requireSteam, async (req, res) => {
  try {
    const sid = toSteamId64(req.steamid);
    const appId = String((req.body && req.body.appid) || '').replace(/\D/g, '');
    if (!appId) return res.status(400).json({ error: 'appid required' });
    const mem = await suLookup(sid);
    if (!mem.found) return res.status(403).json({ error: mem.expired ? 'Your membership has expired.' : 'No active membership — activate a CD key first.' });
    const migrated = await ensureMigrated(sid);
    await dbAddUnlock(sid, appId);
    const appids = (await dbGetUnlocks(sid)).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (migrated) mirrorUserToGitHub(sid);
    console.log(`[Dashboard] ${sid} += ${appId} (${appids.length} total)`);
    res.json({ success: true, appids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a previously-unlocked game from this SteamID's list. Because the DLL
// injects purely from this list (nothing written to stplug-in), dropping the
// appid here revokes it on the next Steam launch.
app.post('/dash/api/remove', requireSteam, async (req, res) => {
  try {
    const sid = toSteamId64(req.steamid);
    const appId = String((req.body && req.body.appid) || '').replace(/\D/g, '');
    if (!appId) return res.status(400).json({ error: 'appid required' });
    const migrated = await ensureMigrated(sid);
    await dbRemoveUnlock(sid, appId);
    const appids = (await dbGetUnlocks(sid)).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (migrated) mirrorUserToGitHub(sid);
    console.log(`[Dashboard] ${sid} -= ${appId} (${appids.length} total)`);
    res.json({ success: true, appids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Steam screenshot proxy (landscape fallback when no header/cover exists) ───
// The dashboard tries the header capsule first; if a game has none, it falls
// back here. We query Steam's appdetails once per appid and 302 to the first
// screenshot (a landscape image), caching the result (and misses).
const _shotCache = new Map(); // appid -> screenshot URL ('' = none)
app.get('/api/screenshot/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  if (!appid) return res.status(400).end();
  if (_shotCache.has(appid)) {
    const u = _shotCache.get(appid);
    return u ? res.redirect(u) : res.status(404).end();
  }
  try {
    const r = await fetchT(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=screenshots`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 6000);
    const data = await r.json().catch(() => null);
    const node = data && data[appid];
    const shots = (node && node.success && node.data && Array.isArray(node.data.screenshots)) ? node.data.screenshots : [];
    if (shots.length) {
      const url = shots[0].path_thumbnail || shots[0].path_full;
      if (url) { _shotCache.set(appid, url); return res.redirect(url); }
    }
  } catch (e) { /* fall through */ }
  _shotCache.set(appid, ''); // remember the miss
  return res.status(404).end();
});

// ── SteamGridDB cover proxy (fills in covers Steam's CDN doesn't have) ────────
const SGDB_API_KEY = process.env.SGDB_API_KEY || 'a37cf00b6dbbc62bac4650e53e902b46';
const _sgdbCache = new Map(); // "type_appid" -> resolved image URL (or '' = none)

app.get('/api/sgdb/:type/:appid', async (req, res) => {
  const appid = String(req.params.appid || '').replace(/\D/g, '');
  const type = String(req.params.type || 'grid').toLowerCase();
  if (!appid) return res.status(400).end();
  const cacheKey = `${type}_${appid}`;
  if (_sgdbCache.has(cacheKey)) {
    const u = _sgdbCache.get(cacheKey);
    return u ? res.redirect(u) : res.status(404).end();
  }
  // Map asset type → SGDB endpoint + dimensions.
  let sgdbType = 'grids', dims = '';
  if (type === 'grid' || type === 'capsule') { sgdbType = 'grids'; dims = '600x900'; }
  else if (type === 'header') { sgdbType = 'grids'; dims = '460x215,920x430'; }
  else if (type === 'hero') { sgdbType = 'heroes'; }
  else if (type === 'logo') { sgdbType = 'logos'; }
  let url = `https://www.steamgriddb.com/api/v2/${sgdbType}/steam/${appid}`;
  if (dims) url += `?dimensions=${dims}`;
  try {
    const r = await fetchT(url, { headers: { Authorization: `Bearer ${SGDB_API_KEY}` } }, 6000);
    if (r.ok) {
      const data = await r.json().catch(() => null);
      if (data && data.success && Array.isArray(data.data) && data.data.length > 0) {
        const img = data.data[0].url;
        _sgdbCache.set(cacheKey, img);
        return res.redirect(img);
      }
    }
  } catch (e) { /* fall through */ }
  _sgdbCache.set(cacheKey, ''); // remember the miss so we don't re-query
  return res.status(404).end();
});

// Serve the dashboard page (browsers). PowerShell still gets install.ps1 at '/'.
app.get('/dashboard', (req, res) => {
  const p = path.join(__dirname, 'public', 'dashboard.html');
  if (fs.existsSync(p)) { res.type('html'); return res.send(fs.readFileSync(p, 'utf8')); }
  res.status(404).send('Dashboard not found');
});

// Admin & reseller console — same page; the login decides which tabs show.
// Clean aliases for public/index.html so it's reachable at /admin and /reseller.
app.get(['/admin', '/reseller'], (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(p)) { res.type('html'); return res.send(fs.readFileSync(p, 'utf8')); }
  res.status(404).send('Console not found');
});

// OneGamers (OG) per-game CD-key system — own tables + /api/og/* routes,
// reusing the shared accounts/credits and the member_unlocks entitlement store.
// Kept in its own module so a server.js revert can't silently drop it.
require('./og')(app, {
  db, authenticateToken, requireAdmin,
  dbAddUnlock, dbRemoveUnlock, mirrorUserToGitHub,
  commitKeyToGitHub, deleteKeyFromGitHub, toSteamId64,
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`OpenSteamTool Core Server running on port ${PORT}`);
  console.log(`Dashboard Web Interface: http://localhost:${PORT}`);
  console.log(`Key Activation API: http://localhost:${PORT}/api/activate`);
  console.log(`====================================================`);
});