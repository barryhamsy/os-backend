// og.js — OneGamers (OG) per-game CD-key system.
//
// A self-contained module, parallel to the ONENNABE membership system and the
// existing OST key system. It has its OWN tables (og_keys, og_activations) and
// its OWN /api/og/* routes, but reuses the shared users/credits/topup accounts
// and the member_unlocks entitlement store.
//
// Key model: one OG key (OG-XXXX-XXXX-XXXX) is bound to exactly ONE appid.
// Activation grants the unlock by inserting into member_unlocks, so the DLL's
// /api/entitlements poll injects the game within ~2s — no DLL changes, no
// GitHub key files.
//
// Wire-in (in server.js, after db/auth/helpers are defined):
//   require('./og')(app, { db, authenticateToken, requireAdmin,
//                          dbAddUnlock, mirrorUserToGitHub, toSteamId64 });

module.exports = function registerOG(app, ctx) {
  const {
    db, authenticateToken, requireAdmin,
    dbAddUnlock, dbRemoveUnlock, mirrorUserToGitHub,
    commitKeyToGitHub, deleteKeyFromGitHub, toSteamId64,
  } = ctx;

  const CREDIT_PER_KEY = 1.0;

  // ── Schema ──────────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS og_keys (
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
  )`).catch((e) => console.error('[og] og_keys init:', e.message));

  db.run(`CREATE TABLE IF NOT EXISTS og_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cdkey TEXT NOT NULL,
    steamid TEXT NOT NULL,
    appid TEXT NOT NULL,
    ip_address TEXT,
    activated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).catch((e) => console.error('[og] og_activations init:', e.message));

  db.run(`CREATE INDEX IF NOT EXISTS idx_og_keys_created_by  ON og_keys(created_by)`).catch(() => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_og_keys_activated_by ON og_keys(activated_by)`).catch(() => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_og_acts_steamid      ON og_activations(steamid)`).catch(() => {});

  // OG key string: same alphabet as OST keys, "OG-" prefix so it never collides
  // with an OST-/ONENNABE key.
  function ogKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const blk = () => {
      let s = '';
      for (let i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
      return s;
    };
    return `OG-${blk()}-${blk()}-${blk()}`;
  }

  // ── Generate keys (admin or reseller) ────────────────────────────────────────
  // Body: { appid, game_name?, quantity? }. One appid per key. Resellers pay
  // 1 credit/key (server-fixed, like the OST key system).
  app.post('/api/og/keys/generate', authenticateToken, async (req, res) => {
    try {
      let { appid, game_name, quantity } = req.body || {};
      appid = String(appid || '').trim();
      if (!/^\d+$/.test(appid)) return res.status(400).json({ error: 'A numeric AppID is required' });
      game_name = game_name ? String(game_name).trim().slice(0, 200) : null;

      const numKeys = parseInt(quantity, 10) || 1;
      if (numKeys < 1 || numKeys > 100) return res.status(400).json({ error: 'Quantity must be between 1 and 100' });

      const totalCost = numKeys * CREDIT_PER_KEY;
      if (req.user.role === 'reseller') {
        const u = await db.get('SELECT credits FROM users WHERE id = ?', [req.user.id]);
        if (!u || u.credits < totalCost) {
          return res.status(400).json({ error: `Insufficient credit balance! Required: ${totalCost}, Available: ${u ? u.credits : 0}.` });
        }
        await db.run('UPDATE users SET credits = credits - ? WHERE id = ?', [totalCost, req.user.id]);
      }

      const keys = [];
      for (let i = 0; i < numKeys; i++) {
        let k = ogKey();
        while (await db.get('SELECT id FROM og_keys WHERE cdkey = ?', [k])) k = ogKey();
        await db.run(
          `INSERT INTO og_keys (cdkey, appid, game_name, created_by, cost, status) VALUES (?,?,?,?,?, 'active')`,
          [k, appid, game_name, req.user.id, CREDIT_PER_KEY]
        );
        if (typeof commitKeyToGitHub === 'function') {
          commitKeyToGitHub(k, appid);
        }
        keys.push({ cdkey: k, appid, game_name, cost: CREDIT_PER_KEY });
      }

      const u = await db.get('SELECT credits FROM users WHERE id = ?', [req.user.id]);
      res.json({
        message: `Successfully generated ${numKeys} OG key(s)`,
        total_cost: totalCost,
        remaining_credits: u ? u.credits : null,
        keys,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reseller: my own OG keys ─────────────────────────────────────────────────
  app.get('/api/og/keys/my', authenticateToken, async (req, res) => {
    try {
      const { search, status } = req.query;
      let q = 'SELECT * FROM og_keys WHERE created_by = ?';
      const p = [req.user.id];
      if (status && status !== 'all') { q += ' AND status = ?'; p.push(status); }
      if (search) {
        q += ' AND (cdkey LIKE ? OR appid LIKE ? OR game_name LIKE ? OR activated_by LIKE ?)';
        const s = `%${search}%`; p.push(s, s, s, s);
      }
      q += ' ORDER BY created_at DESC LIMIT 1000';
      res.json({ keys: await db.all(q, p) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: all OG keys ───────────────────────────────────────────────────────
  app.get('/api/og/admin/keys', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { search, status } = req.query;
      let q = `SELECT k.*, u.username AS reseller
               FROM og_keys k LEFT JOIN users u ON k.created_by = u.id WHERE 1=1`;
      const p = [];
      if (status && status !== 'all') { q += ' AND k.status = ?'; p.push(status); }
      if (search) {
        q += ' AND (k.cdkey LIKE ? OR k.appid LIKE ? OR k.game_name LIKE ? OR k.activated_by LIKE ? OR u.username LIKE ?)';
        const s = `%${search}%`; p.push(s, s, s, s, s);
      }
      q += ' ORDER BY k.created_at DESC LIMIT 2000';
      res.json({ keys: await db.all(q, p) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: OG stats ──────────────────────────────────────────────────────────
  app.get('/api/og/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const total  = await db.get('SELECT COUNT(*) AS c FROM og_keys');
      const used   = await db.get("SELECT COUNT(*) AS c FROM og_keys WHERE status = 'used'");
      const active = await db.get("SELECT COUNT(*) AS c FROM og_keys WHERE status = 'active'");
      const acts   = await db.get('SELECT COUNT(*) AS c FROM og_activations');
      res.json({
        total_keys: total.c, used_keys: used.c, active_keys: active.c,
        total_activations: acts.c,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: OG activation log ─────────────────────────────────────────────────
  app.get('/api/og/admin/activations', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { search } = req.query;
      let q = `SELECT a.*, k.game_name
               FROM og_activations a LEFT JOIN og_keys k ON a.cdkey = k.cdkey WHERE 1=1`;
      const p = [];
      if (search) {
        q += ' AND (a.cdkey LIKE ? OR a.steamid LIKE ? OR a.appid LIKE ?)';
        const s = `%${search}%`; p.push(s, s, s);
      }
      q += ' ORDER BY a.activated_at DESC LIMIT 1000';
      res.json({ activations: await db.all(q, p) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reseller & Admin: Revoke OG key ──────────────────────────────────────────
  // Revokes a key: deletes from DB, refunds reseller credits, deletes keys/<cdkey>.txt
  // from GitHub, and revokes the unlocked appid from the customer's SteamID entitlements.
  app.post('/api/og/keys/:cdkey/revoke', authenticateToken, async (req, res) => {
    try {
      const cdkey = String(req.params.cdkey).trim().toUpperCase();

      // Check og_keys first
      let keyRecord = await db.get('SELECT * FROM og_keys WHERE cdkey = ?', [cdkey]);
      let isOG = true;

      if (!keyRecord) {
        // Fallback to keys table
        keyRecord = await db.get('SELECT * FROM keys WHERE cdkey = ?', [cdkey]);
        isOG = false;
      }

      if (!keyRecord) {
        return res.status(404).json({ error: 'CDKey not found' });
      }

      // Permission check: admins can revoke any key; resellers can only revoke their own keys
      if (req.user.role !== 'admin' && keyRecord.created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only revoke keys you generated' });
      }

      // Atomic DB deletion
      const tableName = isOG ? 'og_keys' : 'keys';
      const del = await db.run(`DELETE FROM ${tableName} WHERE id = ?`, [keyRecord.id]);
      if (del.changes !== 1) {
        return res.status(409).json({ error: 'CDKey was already revoked' });
      }

      // Refund credits if created by reseller
      let refunded = 0;
      let refundedTo = null;
      const creator = await db.get('SELECT id, username, role FROM users WHERE id = ?', [keyRecord.created_by]);
      if (creator && creator.role === 'reseller' && keyRecord.cost > 0) {
        refunded = keyRecord.cost;
        refundedTo = creator.username;
        await db.run('UPDATE users SET credits = credits + ? WHERE id = ?', [refunded, creator.id]);
        await db.run(
          `INSERT INTO topup_logs (reseller_id, admin_id, amount, note) VALUES (?, ?, ?, ?)`,
          [creator.id, req.user.id, refunded, `Refund: revoked ${keyRecord.status === 'used' ? 'activated' : 'unused'} key ${cdkey}`]
        );
      }

      // Delete keys/<cdkey>.txt from GitHub repository
      let github = { success: false };
      if (typeof deleteKeyFromGitHub === 'function') {
        github = await deleteKeyFromGitHub(cdkey);
      }

      // Delete user_memberships record if present
      await db.run('DELETE FROM user_memberships WHERE cd_key = ?', [cdkey]).catch(() => {});

      // If key had been activated, remove the appid from member_unlocks & update GitHub entitlements
      if (keyRecord.activated_by) {
        const sid = String(keyRecord.activated_by);
        await db.run('DELETE FROM user_memberships WHERE steamid = ?', [toSteamId64(sid)]).catch(() => {});
        if (isOG) {
          if (keyRecord.appid && typeof dbRemoveUnlock === 'function') {
            await dbRemoveUnlock(sid, keyRecord.appid);
          }
        } else {
          const appidsList = String(keyRecord.appids || '').split(',').map(a => a.trim()).filter(Boolean);
          if (typeof dbRemoveUnlock === 'function') {
            for (const aid of appidsList) {
              await dbRemoveUnlock(sid, aid);
            }
          }
        }
        if (typeof mirrorUserToGitHub === 'function') {
          mirrorUserToGitHub(sid);
        }
      }

      let message = `Revoked ${cdkey}`;
      if (refundedTo) message += ` and refunded ${refunded.toFixed(2)} credits to ${refundedTo}`;
      if (github && !github.success) message += `. (GitHub note: ${github.reason || 'could not remove key file'})`;

      res.json({ message, refunded, refunded_to: refundedTo, github });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin: disable / revoke a key ────────────────────────────────────────────
  app.post('/api/og/admin/keys/:cdkey/disable', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const r = await db.run("UPDATE og_keys SET status = 'disabled' WHERE cdkey = ?", [String(req.params.cdkey).trim().toUpperCase()]);
      res.json({ success: r.changes > 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ownership cross-check: does this SteamID already own every appid in `appids`?
  // OG grants (and membership grants) land in member_unlocks, so that table is the
  // source of truth. If ctx.computeEntitlements is wired in, fold it in too.
  async function alreadyOwnsAll(sid, appids) {
    const want = appids.map((a) => String(a).trim()).filter(Boolean);
    if (!want.length) return false;
    const owned = new Set();
    try {
      const rows = await db.all('SELECT appid FROM member_unlocks WHERE steamid = ?', [String(sid)]);
      for (const r of rows) owned.add(String(r.appid));
    } catch (_) { /* best-effort */ }
    if (typeof ctx.computeEntitlements === 'function') {
      try { for (const a of await ctx.computeEntitlements(sid)) owned.add(String(a)); } catch (_) {}
    }
    return want.every((a) => owned.has(a));
  }

  // ── PUBLIC: activate an OG key (called by the OneGamers plugin) ───────────────
  // Supports both GET and POST requests (Millennium plugin issues GET to /api/og/activate).
  // Validates the key, binds it to this SteamID, grants the bound appid via member_unlocks,
  // and logs the activation. Checks og_keys first, and falls back to legacy keys table if needed.
  async function handleOGActivate(req, res) {
    try {
      const cd = String((req.body && (req.body.cdkey || req.body.key)) || (req.query && (req.query.cdkey || req.query.key)) || '').trim().toUpperCase();
      let sid = String((req.body && (req.body.steamid || req.body.steamid64)) || (req.query && (req.query.steamid || req.query.steamid64)) || '').trim();
      if (!cd) return res.status(400).json({ success: false, message: 'CD key required' });
      if (!/^\d{17}$/.test(sid)) sid = toSteamId64(sid);
      if (!/^\d{17}$/.test(sid)) return res.status(400).json({ success: false, message: 'A valid SteamID is required' });

      // 1. Check og_keys first
      const key = await db.get('SELECT * FROM og_keys WHERE cdkey = ?', [cd]);
      if (key) {
        if (key.status === 'disabled') return res.status(403).json({ success: false, message: 'This key has been disabled' });

        if (key.status === 'used') {
          if (String(key.activated_by) === sid) {
            await dbAddUnlock(sid, key.appid);
            mirrorUserToGitHub(sid);
            return res.json({ success: true, already: true, appid: key.appid, game_name: key.game_name, message: 'Already activated on this account' });
          }
          return res.status(409).json({ success: false, message: 'This key was already used on another account' });
        }

        // Cross-check: don't burn an active key on a game the account already owns.
        if (await alreadyOwnsAll(sid, [key.appid])) {
          return res.status(409).json({
            success: false, already_owned: true, appid: key.appid, game_name: key.game_name,
            message: 'This account already owns this game — the key was not used.',
          });
        }

        const upd = await db.run(
          "UPDATE og_keys SET status = 'used', activated_by = ?, activated_at = CURRENT_TIMESTAMP WHERE cdkey = ? AND status = 'active'",
          [sid, cd]
        );
        if (!upd.changes) return res.status(409).json({ success: false, message: 'Key is no longer available' });

        await dbAddUnlock(sid, key.appid);
        mirrorUserToGitHub(sid);
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
        await db.run('INSERT INTO og_activations (cdkey, steamid, appid, ip_address) VALUES (?,?,?,?)', [cd, sid, key.appid, ip]);

        return res.json({ success: true, appid: key.appid, game_name: key.game_name, message: 'Activated' });
      }

      // 2. Fallback: check legacy keys table (e.g. OST- keys generated in previous build)
      const legacyKey = await db.get('SELECT * FROM keys WHERE cdkey = ?', [cd]);
      if (legacyKey) {
        if (legacyKey.status === 'disabled') return res.status(403).json({ success: false, message: 'This key has been disabled' });

        if (legacyKey.status === 'used') {
          if (String(legacyKey.activated_by) === sid) {
            const appidsList = String(legacyKey.appids || '').split(',').map(a => a.trim()).filter(Boolean);
            for (const aid of appidsList) {
              await dbAddUnlock(sid, aid);
            }
            mirrorUserToGitHub(sid);
            return res.json({ success: true, already: true, appid: legacyKey.appids, game_name: legacyKey.game_name, message: 'Already activated on this account' });
          }
          return res.status(409).json({ success: false, message: 'This key was already used on another account' });
        }

        const appidsList = String(legacyKey.appids || '').split(',').map(a => a.trim()).filter(Boolean);

        // Cross-check: don't burn an active key on a game the account already owns.
        if (await alreadyOwnsAll(sid, appidsList)) {
          return res.status(409).json({
            success: false, already_owned: true, appid: legacyKey.appids, game_name: legacyKey.game_name || '',
            message: 'This account already owns this game — the key was not used.',
          });
        }

        const upd = await db.run(
          "UPDATE keys SET status = 'used', activated_by = ?, activated_at = CURRENT_TIMESTAMP WHERE cdkey = ? AND status = 'active'",
          [sid, cd]
        );
        if (!upd.changes) return res.status(409).json({ success: false, message: 'Key is no longer available' });

        for (const aid of appidsList) {
          await dbAddUnlock(sid, aid);
        }
        mirrorUserToGitHub(sid);
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
        await db.run('INSERT INTO activations (cdkey, steamid, appids, ip_address) VALUES (?,?,?,?)', [cd, sid, legacyKey.appids, ip]);

        return res.json({ success: true, appid: legacyKey.appids, game_name: legacyKey.game_name || '', message: 'Activated' });
      }

      return res.status(404).json({ success: false, message: 'Invalid key' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  app.post('/api/og/activate', handleOGActivate);
  app.get('/api/og/activate', handleOGActivate);

  console.log('[og] OneGamers per-game key routes registered (/api/og/*)');
};
