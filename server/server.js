require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ost-secret-jwt-key-change-in-production-2026';

app.use(cors());
app.use(express.json());
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

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
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

// Admin List All Generated Keys
app.get('/api/admin/keys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `
      SELECT k.*, u.username as creator_name
      FROM keys k
      JOIN users u ON k.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ' AND k.status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (k.cdkey LIKE ? OR k.appids LIKE ? OR k.activated_by LIKE ? OR u.username LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
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

// Reseller / Admin Generate Keys
app.post('/api/keys/generate', authenticateToken, async (req, res) => {
  try {
    let { appids, quantity, cost } = req.body;

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

    const keyCost = parseFloat(cost) >= 0 ? parseFloat(cost) : 1.0;
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
        INSERT INTO keys (cdkey, appids, created_by, cost, status)
        VALUES (?, ?, ?, ?, 'active')
      `, [keyStr, appids, req.user.id, keyCost]);

      // Automatically commit key file to GitHub repository keys/<cdkey>.txt
      commitKeyToGitHub(keyStr, appids);

      generatedKeys.push({
        cdkey: keyStr,
        appids,
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
      query += ' AND (cdkey LIKE ? OR appids LIKE ? OR activated_by LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
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

  const appidsArray = keyRecord.appids.split(',').map(a => a.trim()).filter(Boolean).map(a => isNaN(Number(a)) ? a : Number(a));

  return {
    status: 200,
    data: {
      success: true,
      message: 'CDKey activated successfully!',
      cdkey: cleanKey,
      steamid: cleanSteamID,
      appids: appidsArray
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
