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
  next();
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

// Helper: PUT any file to the GitHub repo (main/<path>), creating or updating it.
async function putFileToGitHub(filePath, contentString, message) {
  if (!GITHUB_TOKEN) return { success: false, reason: 'No GITHUB_TOKEN configured' };

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'OST-Server/1.0',
    'Accept': 'application/vnd.github+json'
  };

  try {
    let sha = null;
    const checkRes = await fetch(`${url}?ref=main`, { headers });
    if (checkRes.ok) sha = (await checkRes.json()).sha;

    const body = {
      message,
      content: Buffer.from(contentString).toString('base64'),
      branch: 'main'
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (putRes.ok) return { success: true };
    return { success: false, reason: await putRes.text() };
  } catch (err) {
    return { success: false, reason: err.message };
  }
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
// Read the AppIDs already recorded in users/<steamid64>.json (membership unlocks
// live here). Returns [] if the file/token is missing.
async function readUsersJsonAppids(sid64) {
  if (!GITHUB_TOKEN) return [];
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/users/${sid64}.json?ref=main`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'OST-Server/1.0',
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!r.ok) return [];
    const j = await r.json();
    const body = Buffer.from(j.content || '', 'base64').toString('utf8');
    let data = null;
    try { data = JSON.parse(body); } catch { /* fall back to digit scan */ }
    let arr = (data && Array.isArray(data.appids)) ? data.appids
            : (Array.isArray(data) ? data : (body.match(/\d{2,10}/g) || []));
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch { return []; }
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
  const vr = await fetch(SU_VALIDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cd_key: cd, cdkey: cd,
      steamid: sid64, steamid64: sid64, steam_id: sid64, steamID: sid64,
    }),
  });
  return await vr.json().catch(() => null);
}

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

    // 2. Append the AppID to users/<steamid64>.json (dedupe).
    const current = await readUsersJsonAppids(sid);
    const set = new Set(current);
    set.add(appId);
    const appids = [...set].sort((a, b) => Number(a) - Number(b));
    const json = JSON.stringify({ appids: appids.map(Number) }, null, 2);
    const result = await putFileToGitHub(`users/${sid}.json`, json, `Unlock ${appId} for ${sid}`);
    if (!result.success) {
      return res.status(502).json({ success: false, error: 'Could not record the unlock' });
    }

    console.log(`[SU Unlock] ${sid} += ${appId} (${appids.length} total)`);
    res.json({ success: true, appids: appids.map(Number) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/su/unlock', (req, res) => suUnlock(req.query, res));
app.post('/api/su/unlock', (req, res) => suUnlock(req.body, res));

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
let gamesCache = { data: null, fetchedAt: 0, pending: null };

async function getGameCatalog() {
  const fresh = gamesCache.data && (Date.now() - gamesCache.fetchedAt < GAMES_CACHE_MS);
  if (fresh) return gamesCache.data;
  if (gamesCache.pending) return gamesCache.pending;

  gamesCache.pending = (async () => {
    try {
      const r = await fetch(GAMES_API_URL, { headers: { 'User-Agent': 'OST-Server/1.0' } });
      if (!r.ok) throw new Error(`Game catalog returned HTTP ${r.status}`);
      const json = await r.json();
      const list = Array.isArray(json) ? json : (json.games || json.data || []);
      // Keep only what the generator needs
      gamesCache.data = list
        .filter(g => g && g.appid && g.name)
        .map(g => ({ appid: String(g.appid), name: String(g.name) }));
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

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`OpenSteamTool Core Server running on port ${PORT}`);
  console.log(`Dashboard Web Interface: http://localhost:${PORT}`);
  console.log(`Key Activation API: http://localhost:${PORT}/api/activate`);
  console.log(`====================================================`);
});
