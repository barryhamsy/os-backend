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
async function fetchT(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
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

async function dbGetUnlocks(sid) {
  const rows = await db.all('SELECT appid FROM member_unlocks WHERE steamid = ?', [String(sid)]);
  return rows.map((r) => String(r.appid));
}
async function dbAddUnlock(sid, appid) {
  await db.run('INSERT OR IGNORE INTO member_unlocks (steamid, appid, added_at) VALUES (?,?,?)',
    [String(sid), String(appid), Date.now()]);
}
async function dbAddUnlocks(sid, appids) {
  for (const a of appids) await dbAddUnlock(sid, a);
}
async function dbRemoveUnlock(sid, appid) {
  await db.run('DELETE FROM member_unlocks WHERE steamid = ? AND appid = ?', [String(sid), String(appid)]);
}

// Debounced, best-effort GitHub backup of a user's unlock list. Coalesces a
// burst of unlocks into ONE commit so we never hammer GitHub. Never on the hot path.
const _mirrorTimers = new Map();
function mirrorUserToGitHub(sid) {
  sid = String(sid);
  if (_mirrorTimers.has(sid)) return; // one already scheduled — it'll read latest DB state
  const t = setTimeout(async () => {
    _mirrorTimers.delete(sid);
    try {
      const appids = (await dbGetUnlocks(sid)).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
      const json = JSON.stringify({ appids }, null, 2);
      const r = await putFileToGitHub(`users/${sid}.json`, json, `Sync unlocks for ${sid} (${appids.length})`);
      if (!r.success) console.warn(`[mirror] ${sid} backup failed: ${String(r.reason).slice(0, 120)}`);
    } catch (e) { console.error(`[mirror] ${sid} exception: ${e.message}`); }
  }, 5000);
  _mirrorTimers.set(sid, t);
}

// One-time import of an existing GitHub users/<sid>.json into the DB, so we never
// lose unlocks made before the DB became the source of truth. Returns true when
// the DB can be treated as authoritative (already had rows, or GitHub read
// succeeded); false only if GitHub was unreadable and the DB is still empty
// (so callers skip the backup mirror to avoid clobbering the GitHub copy).
const _migrated = new Set();
async function ensureMigrated(sid) {
  sid = String(sid);
  if (_migrated.has(sid)) return true;
  const have = await dbGetUnlocks(sid);
  if (have.length > 0) { _migrated.add(sid); return true; }
  const gh = await readUsersJsonFromGitHub(sid); // [] = no file, null = read failed
  if (gh === null) return false;
  if (gh.length) await dbAddUnlocks(sid, gh);
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
    const totalKeysRow = await db.get("SELECT count(*) as count FROM keys");
    const activeKeysRow = await db.get("SELECT count(*) as count FROM keys WHERE status = 'active'");
    const usedKeysRow = await db.get("SELECT count(*) as count FROM keys WHERE status = 'used'");
    const totalActivationsRow = await db.get("SELECT count(*) as count FROM activations");
    const sumCreditsRow = await db.get("SELECT SUM(credits) as sum FROM users WHERE role = 'reseller'");

    const recentActivations = await db.all(`
      SELECT a.*, k.created_by, u.username as creator_name 
      FROM activations a 
      LEFT JOIN keys k ON a.cdkey = k.cdkey 
      LEFT JOIN users u ON k.created_by = u.id 
      ORDER BY a.activated_at DESC LIMIT 10
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

// Helper: Commit Key File directly to GitHub repository (main/keys/<CDKEY>.txt)
async function commitKeyToGitHub(cdkey, appids) {
  if (!GITHUB_TOKEN) {
    console.warn(`[GitHub Commit Warning] GITHUB_TOKEN not configured in server environment. Key ${cdkey} saved locally only.`);
    return { success: false, reason: 'No GITHUB_TOKEN configured' };
  }

  const path = `keys/${cdkey}.txt`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const contentBase64 = Buffer.from(appids).toString('base64');

  try {
    // 1. Check if file already exists to get SHA if updating
    let sha = null;
    const checkRes = await fetch(`${url}?ref=main`, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'OST-Server/1.0',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (checkRes.ok) {
      const checkData = await checkRes.json();
      sha = checkData.sha;
    }

    // 2. Put file content
    const body = {
      message: `Add key ${cdkey} for AppID(s): ${appids}`,
      content: contentBase64,
      branch: 'main'
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'OST-Server/1.0',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify(body)
    });

    if (putRes.ok) {
      console.log(`[GitHub Commit] Successfully committed keys/${cdkey}.txt to ${GITHUB_REPO}`);
      return { success: true };
    } else {
      const errText = await putRes.text();
      console.error(`[GitHub Commit Error] Failed to commit keys/${cdkey}.txt (HTTP ${putRes.status}): ${errText}`);
      return { success: false, reason: errText };
    }
  } catch (err) {
    console.error(`[GitHub Commit Exception] ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// Helper: Delete Key File from GitHub repository (main/keys/<CDKEY>.txt)
async function deleteKeyFromGitHub(cdkey) {
  if (!GITHUB_TOKEN) {
    return { success: false, reason: 'No GITHUB_TOKEN configured' };
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/keys/${cdkey}.txt`;
  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'OST-Server/1.0',
    'Accept': 'application/vnd.github+json'
  };

  try {
    const checkRes = await fetch(`${url}?ref=main`, { headers });
    if (checkRes.status === 404) return { success: true, reason: 'File not on GitHub' };
    if (!checkRes.ok) return { success: false, reason: `Lookup failed (HTTP ${checkRes.status})` };
    const { sha } = await checkRes.json();

    const delRes = await fetch(url, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Revoke key ${cdkey}`, sha, branch: 'main' })
    });

    if (delRes.ok) {
      console.log(`[GitHub Delete] Removed keys/${cdkey}.txt from ${GITHUB_REPO}`);
      return { success: true };
    }
    const errText = await delRes.text();
    console.error(`[GitHub Delete Error] keys/${cdkey}.txt (HTTP ${delRes.status}): ${errText}`);
    return { success: false, reason: errText };
  } catch (err) {
    console.error(`[GitHub Delete Exception] ${err.message}`);
    return { success: false, reason: err.message };
  }
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
    res.json({ steamid: id, appids: appids.map(Number) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Steam Unlock membership. Validation lives at steamunlockonennabe; the plugin's
// Lua backend can only reliably send GET query params (not POST bodies), so these
// are GET endpoints and os-backend does the proper server-to-server POST.
const SU_VALIDATE_URL = process.env.SU_VALIDATE_URL || 'https://steamunlockonennabe.duckdns.org/validate-onennabe-cdkey';

// Server-to-server: ask steamunlockonennabe whether a CD key is valid. It needs
// both the CD key and the SteamID; we send field-name aliases so it matches
// whichever the endpoint reads (cd_key/steamid — SteamID as 64-bit).
async function suValidate(cd, sid) {
  const sid64 = sid ? toSteamId64(String(sid)) : '';
  const vr = await fetchT(SU_VALIDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cd_key: cd, cdkey: cd,
      steamid: sid64, steamid64: sid64, steam_id: sid64, steamID: sid64,
    }),
  }, 25000); // key binding is a write — allow much longer than a plain read
  return await vr.json().catch(() => null);
}

// Full key list (server-side only). Used to look up an existing user's own key
// for one-click re-activation. We NEVER expose this whole list to a client — the
// lookup endpoint below returns only the requesting SteamID's own key.
const SU_VIEW_URL = process.env.SU_VIEW_URL || 'https://steamunlockonennabe.duckdns.org/api/view-onennabe-cdkeys';

// Cache the full CD-key list. It has thousands of entries and — while fast from
// the public internet — is slow to pull from GCE, so fetching it on every
// membership lookup was timing out (→ "NO MEMBERSHIP" / 502). Fetch at most once
// per few minutes, dedupe concurrent misses, and serve the last good copy if the
// upstream is slow or down so lookups keep working.
const KEYLIST_CACHE_MS = 3 * 60 * 1000;
let keyListCache = { data: null, fetchedAt: 0, pending: null };
async function getKeyList() {
  const fresh = keyListCache.data && (Date.now() - keyListCache.fetchedAt < KEYLIST_CACHE_MS);
  if (fresh) return keyListCache.data;
  if (keyListCache.pending) return keyListCache.pending;
  keyListCache.pending = (async () => {
    try {
      const vr = await fetchT(SU_VIEW_URL, {}, 20000);
      const data = await vr.json().catch(() => null);
      const keys = (data && Array.isArray(data.keys)) ? data.keys : null;
      if (!keys) throw new Error('bad key-list payload');
      keyListCache.data = keys;
      keyListCache.fetchedAt = Date.now();
      return keys;
    } catch (err) {
      if (keyListCache.data) {
        console.error(`[KeyList] refresh failed, serving cached: ${err.message}`);
        return keyListCache.data;
      }
      throw err;
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
    const keys = await getKeyList(); // cached; served stale if the upstream is slow
    const today = suTodayStr();

    // Every key this SteamID has activated.
    const matches = [];
    for (const k of keys) {
      const ids = Array.isArray(k.steamids) ? k.steamids : [];
      const mine = ids.find((s) => String(s && s.steamid) === sid64);
      if (!mine) continue;
      const exp = String(k.expiry_date || '');
      // YYYY-MM-DD compares correctly as a string. Treat "no expiry" as active.
      const expired = exp ? (exp < today) : false;
      matches.push({
        cd_key: k.cd_key,
        expiry_date: exp,
        key_type: k.key_type || '',
        // The SteamID's own activation date, falling back to the key's.
        activation_date: String((mine && mine.activation_date) || k.activation_date || ''),
        expired,
      });
    }

    // Prefer the highest-priority key type, then the furthest-out expiry.
    const active = matches
      .filter((m) => !m.expired)
      .sort(suKeyCompare);
    if (active.length) {
      const m = active[0];
      return res.json({
        found: true,
        cd_key: m.cd_key,
        key_type: m.key_type,
        activation_date: m.activation_date,
        expiry_date: m.expiry_date,
      });
    }
    if (matches.length) {
      // Expired — still return the details so the UI can show what expired.
      const m = matches.slice().sort(suKeyCompare)[0];
      return res.json({
        found: false,
        expired: true,
        cd_key: m.cd_key,
        key_type: m.key_type,
        activation_date: m.activation_date,
        expiry_date: m.expiry_date,
        message: 'Your Steam Unlock membership has expired.',
      });
    }
    return res.json({ found: false, message: 'No Steam Unlock membership found for this Steam account.' });
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
    // Serve from the shared 10-minute catalog cache (deduped, timed). This used
    // to fetch the FULL catalog on every call — the plugin hits this once per
    // installed game, so a large library hammered api/onennabe and crashed us.
    await getGameCatalog();
    const g = gamesCache.byId && gamesCache.byId.get(appid);
    if (!g) return res.json({ appid, found: false, patchable: false });
    return res.json({
      appid, found: true, name: g.name || '',
      online_supported: g.online_supported,
      bypass_supported: g.bypass_supported,
      hypervisor_bypass: g.hypervisor_bypass,
      patchable: g.online_supported || g.bypass_supported || g.hypervisor_bypass,
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

    const github = await deleteKeyFromGitHub(cdkey);

    // If this key had been activated, recompute that SteamID's entitlements so
    // the revoked AppID(s) drop out of users/<steamid>.json — unless another of
    // the customer's still-valid keys also grants them.
    let entitlements = null;
    if (keyRecord.activated_by) {
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
const GAMES_CACHE_MS = 10 * 60 * 1000;
let gamesCache = { data: null, byId: null, fetchedAt: 0, pending: null };
const _yesFlag = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'yes' || s === '1' || s === 'true'; };

async function getGameCatalog() {
  const fresh = gamesCache.data && (Date.now() - gamesCache.fetchedAt < GAMES_CACHE_MS);
  if (fresh) return gamesCache.data;
  if (gamesCache.pending) return gamesCache.pending;

  gamesCache.pending = (async () => {
    try {
      const r = await fetchT(GAMES_API_URL, { headers: { 'User-Agent': 'OST-Server/1.0' } }, 20000);
      if (!r.ok) throw new Error(`Game catalog returned HTTP ${r.status}`);
      const json = await r.json();
      const list = Array.isArray(json) ? json : (json.games || json.data || []);
      // Keep only what we need — name for the grid, plus the patch flags so
      // /api/patch-info can answer from cache instead of re-fetching the whole
      // catalog on every call (that per-game hammering is what crashed the server).
      const data = list
        .filter(g => g && g.appid && g.name)
        .map(g => ({
          appid: String(g.appid),
          name: String(g.name),
          online_supported: _yesFlag(g.online_supported),
          bypass_supported: _yesFlag(g.bypass_supported),
          hypervisor_bypass: _yesFlag(g.hypervisor_bypass),
        }));
      gamesCache.data = data;
      gamesCache.byId = new Map(data.map(g => [g.appid, g]));
      gamesCache.fetchedAt = Date.now();
      return gamesCache.data;
    } catch (err) {
      // Serve stale data if we have it
      if (gamesCache.data) {
        console.error(`[Game Catalog] Refresh failed, serving cached list: ${err.message}`);
        return gamesCache.data;
      }
      throw err;
    } finally {
      gamesCache.pending = null;
    }
  })();

  return gamesCache.pending;
}

// Search games by name or AppID
app.get('/api/games', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.search || '').trim().toLowerCase();
    const games = await getGameCatalog();

    let results;
    if (!q) {
      results = games.slice(0, 30);
    } else if (/^\d+$/.test(q)) {
      results = games.filter(g => g.appid.startsWith(q))
        .sort((a, b) => (a.appid === q ? -1 : b.appid === q ? 1 : 0));
    } else {
      results = games.filter(g => g.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const as = a.name.toLowerCase().startsWith(q), bs = b.name.toLowerCase().startsWith(q);
          return as === bs ? 0 : as ? -1 : 1;
        });
    }

    res.json({ total: games.length, games: results.slice(0, 50) });
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
    const user = await db.get('SELECT credits FROM users WHERE id = ?', [req.user.id]);
    const totalKeysRow = await db.get('SELECT count(*) as count FROM keys WHERE created_by = ?', [req.user.id]);
    const activeKeysRow = await db.get("SELECT count(*) as count FROM keys WHERE created_by = ? AND status = 'active'", [req.user.id]);
    const usedKeysRow = await db.get("SELECT count(*) as count FROM keys WHERE created_by = ? AND status = 'used'", [req.user.id]);

    res.json({
      credits: user.credits,
      totalKeys: totalKeysRow ? totalKeysRow.count : 0,
      activeKeys: activeKeysRow ? activeKeysRow.count : 0,
      usedKeys: usedKeysRow ? usedKeysRow.count : 0
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
  const keys = await getKeyList(); // cached; served stale if the upstream is slow
  const today = suTodayStr();
  const matches = [];
  for (const k of keys) {
    const ids = Array.isArray(k.steamids) ? k.steamids : [];
    const mine = ids.find((s) => String(s && s.steamid) === sid64);
    if (!mine) continue;
    const exp = String(k.expiry_date || '');
    matches.push({
      cd_key: k.cd_key, expiry_date: exp, key_type: k.key_type || '',
      activation_date: String((mine && mine.activation_date) || k.activation_date || ''),
      expired: exp ? (exp < today) : false,
    });
  }
  const active = matches.filter((m) => !m.expired).sort(suKeyCompare);
  if (active.length) return { found: true, ...active[0] };
  if (matches.length) { const m = matches.slice().sort(suKeyCompare)[0]; return { found: false, expired: true, ...m }; }
  return { found: false };
}

// ── Dashboard API (session-authenticated) ─────────────────────────────────────
// Who am I + membership + my unlocked games.
app.get('/dash/api/me', requireSteam, async (req, res) => {
  try {
    const sid = toSteamId64(req.steamid);
    const [mem, appids] = await Promise.all([
      suLookup(sid).catch(() => ({ found: false })),
      readUsersJsonAppids(sid).catch(() => []),
    ]);
    res.json({ steamid: sid, membership: mem, appids: appids.map(Number) });
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

// Search + paginate the onennabe catalog (name / appid). Returns cover art plus
// the total match count and page metadata for the grid.
app.get('/dash/api/games', requireSteam, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const games = await getGameCatalog();
    let matches;
    if (!q) matches = games;
    else if (/^\d+$/.test(q)) matches = games.filter((g) => g.appid.includes(q));
    else matches = games.filter((g) => g.name.toLowerCase().includes(q));

    const total = matches.length;
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 24, 1), 60);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
    const slice = matches.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      total, page, pages, pageSize, catalogTotal: games.length,
      games: slice.map((g) => ({
        appid: g.appid,
        name: g.name,
        cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
      })),
    });
  } catch (e) { res.status(502).json({ error: 'Catalog unavailable' }); }
});

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

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`OpenSteamTool Core Server running on port ${PORT}`);
  console.log(`Dashboard Web Interface: http://localhost:${PORT}`);
  console.log(`Key Activation API: http://localhost:${PORT}/api/activate`);
  console.log(`====================================================`);
});
