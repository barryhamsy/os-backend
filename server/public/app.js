// State management
let state = {
  token: localStorage.getItem('ost_token') || null,
  user: null,
  activeTab: 'overview',
  generatedKeys: [],
  product: 'og',   // 'og' (OneGamers per-game keys)
  catalogCache: null,
  catalogGenres: [],
  catalogFetchedAt: 0,
};

const CATALOG_CACHE_KEY = 'ost_catalog_cache_v3';
const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 minutes client-side cache TTL

function initCatalogCache() {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.games) && parsed.games.length > 500) {
        state.catalogCache = parsed.games;
        state.catalogGenres = parsed.genres || [];
        state.catalogFetchedAt = parsed.fetchedAt || 0;
      }
    }
  } catch (_) { }
}

// API Helper
async function apiCall(endpoint, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(endpoint, opts);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Server request failed');
    }
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// DOM Elements
function getEl(id) { return document.getElementById(id); }

// Initialize Application
function initApp() {
  initCatalogCache();
  initEventListeners();
  checkAuth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Check Authentication Status
async function checkAuth() {
  if (!state.token) {
    showLogin();
    return;
  }

  try {
    const data = await apiCall('/api/auth/me');
    state.user = data.user;
    showDashboard();
  } catch (err) {
    logout();
  }
}

function showLogin() {
  const screen = getEl('login-screen');
  const dash = getEl('dashboard-wrapper');
  if (screen) screen.classList.remove('hidden');
  if (dash) dash.classList.add('hidden');
}

function showDashboard() {
  const screen = getEl('login-screen');
  const dash = getEl('dashboard-wrapper');
  if (screen) screen.classList.add('hidden');
  if (dash) dash.classList.remove('hidden');

  // Update navbar user profile
  const uEl = getEl('nav-username');
  const cEl = getEl('nav-user-credits');
  if (uEl) uEl.textContent = state.user.username;
  if (cEl) cEl.textContent = parseFloat(state.user.credits || 0).toFixed(2);

  const roleBadge = getEl('nav-role-badge');
  if (roleBadge) {
    roleBadge.textContent = String(state.user.role || '').toUpperCase();
    roleBadge.className = `badge badge-${state.user.role}`;
  }

  // Show/Hide Admin Elements
  const adminElements = document.querySelectorAll('.admin-only');
  adminElements.forEach(el => {
    if (state.user.role === 'admin') {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  // Load Active Tab
  switchTab(state.activeTab);
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('ost_token');
  showLogin();
  showToast('Logged out successfully', 'info');
}

// Event Listeners Initialization
function initEventListeners() {
  // Login Form
  const form = getEl('login-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const uEl = getEl('username');
      const pEl = getEl('password');
      const username = uEl ? uEl.value.trim() : '';
      const password = pEl ? pEl.value : '';

      try {
        const data = await apiCall('/api/auth/login', 'POST', { username, password });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('ost_token', data.token);
        showToast('Welcome back, ' + data.user.username, 'success');
        showDashboard();
      } catch (err) {
        // Error toasted by apiCall
      }
    });
  }

  // Logout Button
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Tab Navigation
  document.querySelectorAll('.nav-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const targetTab = tabBtn.getAttribute('data-tab');
      switchTab(targetTab);
    });
  });

  document.querySelectorAll('.switch-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-target');
      switchTab(targetTab);
    });
  });

  // Key Generator Calculator & Submit — fixed price of 1 credit per key.
  const qtyInput = document.getElementById('gen-quantity');
  const CREDIT_PER_KEY = 1;

  function updateCalc() {
    const qty = parseInt(qtyInput.value) || 1;
    const total = qty * CREDIT_PER_KEY;

    document.getElementById('calc-qty').textContent = qty;
    document.getElementById('calc-total').textContent = total.toFixed(2) + ' credits';
  }

  qtyInput.addEventListener('input', updateCalc);

  // Game search, filters & pagination
  document.getElementById('game-search-input')?.addEventListener('input', debounce(() => searchGames(1), 300));
  document.getElementById('game-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(); // don't submit the generator form
  });

  document.getElementById('game-fgenre')?.addEventListener('change', (e) => {
    gameCurGenre = e.target.value;
    searchGames(1);
  });

  document.getElementById('game-fsize')?.addEventListener('change', (e) => {
    gameCurSize = e.target.value;
    searchGames(1);
  });

  document.getElementById('game-adultchk')?.addEventListener('change', (e) => {
    gameShowAdult = !e.target.checked; // checked means "Hide 18+"
    searchGames(1);
  });

  document.querySelectorAll('.tagfilters .tagbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag');
      if (tag && gameCurTags.hasOwnProperty(tag)) {
        gameCurTags[tag] = !gameCurTags[tag];
        btn.classList.toggle('active', gameCurTags[tag]);
        searchGames(1);
      }
    });
  });

  document.getElementById('btn-game-prev')?.addEventListener('click', () => {
    if (gameCurPage > 1) searchGames(gameCurPage - 1);
  });
  document.getElementById('btn-game-next')?.addEventListener('click', () => {
    if (gameCurPage < gameTotalPages) searchGames(gameCurPage + 1);
  });

  document.getElementById('generator-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const appids = document.getElementById('gen-appids').value;
    const game_name = document.getElementById('gen-game-name').value;
    const quantity = parseInt(qtyInput.value) || 1;

    if (!appids) {
      showToast('Select a game first', 'error');
      return;
    }

    try {
      let data;
      if (state.product === 'og') {
        // OneGamers keys bind to ONE appid (the selected game).
        const appid = String(appids).split(',')[0].trim();
        data = await apiCall('/api/og/keys/generate', 'POST', { appid, game_name, quantity });
      } else {
        data = await apiCall('/api/keys/generate', 'POST', { appids, game_name, quantity });
      }
      state.generatedKeys = data.keys;

      // Update credits in UI
      if (data.remaining_credits !== undefined) {
        state.user.credits = data.remaining_credits;
        document.getElementById('nav-user-credits').textContent = parseFloat(data.remaining_credits).toFixed(2);
      }

      // Display keys in output box
      const outputBox = document.getElementById('gen-output-textarea');
      outputBox.value = data.keys.map(k => k.cdkey).join('\n');

      document.getElementById('btn-copy-raw').disabled = false;
      document.getElementById('btn-copy-protocol').disabled = false;

      showToast(`Generated ${data.keys.length} CDKey(s) successfully!`, 'success');
    } catch (err) {
      // Error toasted
    }
  });

  // Copy Buttons
  document.getElementById('btn-copy-raw').addEventListener('click', () => {
    if (state.generatedKeys.length === 0) return;
    const rawText = state.generatedKeys.map(k => k.cdkey).join('\n');
    navigator.clipboard.writeText(rawText);
    showToast('Copied raw keys to clipboard!', 'success');
  });

  document.getElementById('btn-copy-protocol').addEventListener('click', () => {
    if (state.generatedKeys.length === 0) return;
    const links = state.generatedKeys.map(k => `ostactivation://${k.cdkey}`).join('\n');
    navigator.clipboard.writeText(links);
    showToast('Copied protocol activation links!', 'success');
  });

  // Search & Filters for Keys Manager
  document.getElementById('keys-search-input').addEventListener('input', debounce(loadKeysData, 300));
  document.getElementById('keys-status-filter').addEventListener('change', loadKeysData);
  document.getElementById('btn-refresh-keys').addEventListener('click', loadKeysData);

  // Product selector (ONENNABE / OneGamers) — kept in sync across the Generator
  // and Keys tabs; switching in the Keys tab reloads the list.
  const genProd = document.getElementById('gen-product');
  const keysProd = document.getElementById('keys-product');
  function setProduct(p) {
    state.product = p;
    if (genProd) genProd.value = p;
    if (keysProd) keysProd.value = p;
  }
  if (genProd) genProd.addEventListener('change', () => setProduct(genProd.value));
  if (keysProd) keysProd.addEventListener('change', () => { setProduct(keysProd.value); loadKeysData(); });

  // Resellers Modals
  document.getElementById('btn-open-create-reseller-modal')?.addEventListener('click', () => {
    document.getElementById('modal-create-reseller').classList.remove('hidden');
  });

  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
    });
  });

  // Form: Create Reseller
  document.getElementById('form-create-reseller')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reseller-username').value;
    const password = document.getElementById('reseller-password').value;
    const initial_credits = document.getElementById('reseller-initial-credits').value;

    try {
      await apiCall('/api/admin/resellers', 'POST', { username, password, initial_credits });
      showToast(`Reseller account '${username}' created!`, 'success');
      document.getElementById('modal-create-reseller').classList.add('hidden');
      document.getElementById('form-create-reseller').reset();
      loadResellersData();
    } catch (err) {
      // Error toasted
    }
  });

  // Form: Top Up
  document.getElementById('form-topup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reseller_id = document.getElementById('topup-reseller-id').value;
    const amount = document.getElementById('topup-amount').value;
    const note = document.getElementById('topup-note').value;

    try {
      const data = await apiCall('/api/admin/topup', 'POST', { reseller_id, amount, note });
      showToast(data.message, 'success');
      document.getElementById('modal-topup').classList.add('hidden');
      document.getElementById('form-topup').reset();
      loadResellersData();
    } catch (err) {
      // Error toasted
    }
  });
}

// Switch Active Tab
function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.nav-tab').forEach(tab => {
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  document.querySelectorAll('.tab-content').forEach(content => {
    if (content.id === `tab-${tabName}`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  // Load Tab Specific Data
  if (tabName === 'overview') loadOverviewData();
  else if (tabName === 'keys') loadKeysData();
  else if (tabName === 'resellers') loadResellersData();
  else if (tabName === 'activations') loadActivationsData();
  else if (tabName === 'generator' && !state.gamesLoaded) searchGames();
}

// Tab 1: Load Overview Data
async function loadOverviewData() {
  try {
    let data;
    if (state.user.role === 'admin') {
      data = await apiCall('/api/admin/stats');
      document.getElementById('stat-total-resellers').textContent = data.totalResellers;
    } else {
      data = await apiCall('/api/reseller/stats');
    }

    document.getElementById('stat-total-keys').textContent = data.totalKeys;
    document.getElementById('stat-active-keys').textContent = data.activeKeys;
    document.getElementById('stat-used-keys').textContent = data.usedKeys;

    // Render Recent Activations
    const tbody = document.getElementById('overview-activations-tbody');
    if (!data.recentActivations || data.recentActivations.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No recent activations found</td></tr>`;
      return;
    }

    tbody.innerHTML = data.recentActivations.map(a => `
      <tr>
        <td class="cdkey-text">${a.cdkey}</td>
        <td><strong class="text-accent">${a.steamid}</strong></td>
        <td>${a.appids}</td>
        <td>${a.creator_name || 'System'}</td>
        <td>${formatDate(a.activated_at)}</td>
      </tr>
    `).join('');

  } catch (err) {
    console.error('Failed to load overview data', err);
  }
}

// Tab 3: Load Keys Data
async function loadKeysData() {
  const search = document.getElementById('keys-search-input').value;
  const status = document.getElementById('keys-status-filter').value;

  let endpoint;
  if (state.product === 'og') {
    endpoint = state.user.role === 'admin' ? '/api/og/admin/keys' : '/api/og/keys/my';
  } else {
    endpoint = state.user.role === 'admin' ? '/api/admin/keys' : '/api/keys/my-keys';
  }
  const queryParams = new URLSearchParams();
  if (search) queryParams.append('search', search);
  if (status) queryParams.append('status', status);

  try {
    const data = await apiCall(`${endpoint}?${queryParams.toString()}`);
    const tbody = document.getElementById('keys-table-tbody');

    if (!data.keys || data.keys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No CDKeys found matching filter</td></tr>`;
      return;
    }

    tbody.innerHTML = data.keys.map(k => `
      <tr>
        <td class="cdkey-text">${escapeHtml(k.cdkey)}</td>
        <td>
          ${k.game_name ? `<div class="key-game-name">${escapeHtml(k.game_name)}</div>` : ''}
          <span class="badge badge-subtle">${escapeHtml(k.appids || k.appid || '')}</span>
        </td>
        <td>
          <span class="badge badge-${escapeHtml(k.status)}">${escapeHtml(k.status.toUpperCase())}</span>
        </td>
        <td>${escapeHtml(k.creator_name || k.reseller || state.user.username)}</td>
        <td>${formatDate(k.created_at)}</td>
        <td>${k.activated_by ? `<strong class="text-accent">${escapeHtml(k.activated_by)}</strong>` : '<span class="text-muted">-</span>'}</td>
        <td>${k.activated_at ? formatDate(k.activated_at) : '<span class="text-muted">-</span>'}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-outline copy-single-key" data-key="${escapeHtml(k.cdkey)}">Copy</button>
          <button class="btn btn-sm btn-danger revoke-key-btn" data-key="${escapeHtml(k.cdkey)}" data-status="${escapeHtml(k.status)}" data-cost="${Number(k.cost) || 0}" data-creator="${escapeHtml(k.creator_name || state.user.username)}" data-creator-role="${escapeHtml(k.creator_role || state.user.role)}">Revoke</button>
        </td>
      </tr>
    `).join('');

    // Attach copy button listeners
    tbody.querySelectorAll('.copy-single-key').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        navigator.clipboard.writeText(key);
        showToast(`Copied ${key}`, 'success');
      });
    });

    // Attach revoke button listeners (admin only)
    tbody.querySelectorAll('.revoke-key-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-key');
        const status = btn.getAttribute('data-status');
        const cost = parseFloat(btn.getAttribute('data-cost')) || 0;
        const creator = btn.getAttribute('data-creator');
        const isResellerKey = btn.getAttribute('data-creator-role') === 'reseller' || cost > 0;

        let msg = `Revoke ${key}?\n\n`;
        msg += status === 'used'
          ? '• This key is ACTIVATED. The customer will lose access and the key will be deleted.\n'
          : '• This key is unused. It will be deleted from database & GitHub.\n';
        msg += `• The key file keys/${key}.txt will be deleted from GitHub.\n`;
        msg += isResellerKey && cost > 0
          ? `\n${cost.toFixed(2)} credit(s) will be refunded to ${creator}.`
          : '\nNo refund (not generated by a reseller).';

        if (!confirm(msg)) return;

        btn.disabled = true;
        try {
          const endpoint = state.product === 'og' ? `/api/og/keys/${encodeURIComponent(key)}/revoke` : `/api/keys/${encodeURIComponent(key)}/revoke`;
          const result = await apiCall(endpoint, 'POST');
          showToast(result.message, result.github && !result.github.success ? 'error' : 'success');
          refreshCredits();
          loadKeysData();
        } catch (err) {
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    console.error('Failed to load keys', err);
  }
}

// Tab 4: Load Resellers Data (Admin Only)
async function loadResellersData() {
  if (state.user.role !== 'admin') return;

  try {
    const data = await apiCall('/api/admin/resellers');
    const tbody = document.getElementById('resellers-table-tbody');

    if (!data.resellers || data.resellers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No reseller accounts exist yet</td></tr>`;
      return;
    }

    tbody.innerHTML = data.resellers.map(r => `
      <tr>
        <td>#${r.id}</td>
        <td><strong>${escapeHtml(r.username)}</strong></td>
        <td><span class="text-accent" style="font-weight:700;">${parseFloat(r.credits).toFixed(2)}</span> credits</td>
        <td>${r.keys_generated}</td>
        <td>${r.keys_used}</td>
        <td>${formatDate(r.created_at)}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary open-topup-btn" data-id="${r.id}" data-username="${escapeHtml(r.username)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Top Up</span>
          </button>
          <button class="btn btn-sm btn-danger remove-reseller-btn" data-id="${r.id}" data-username="${escapeHtml(r.username)}" data-credits="${parseFloat(r.credits).toFixed(2)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
            <span>Remove</span>
          </button>
        </td>
      </tr>
    `).join('');

    // Attach remove reseller listeners
    tbody.querySelectorAll('.remove-reseller-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-username');
        const credits = btn.getAttribute('data-credits');

        const ok = confirm(
          `Remove reseller '${username}'?\n\n` +
          `• They will be logged out and can no longer sign in.\n` +
          `• Their remaining ${credits} credits will be lost.\n` +
          `• Keys they already generated stay valid.\n\nThis cannot be undone.`
        );
        if (!ok) return;

        btn.disabled = true;
        try {
          const result = await apiCall(`/api/admin/resellers/${id}`, 'DELETE');
          showToast(result.message, 'success');
          loadResellersData();
        } catch (err) {
          btn.disabled = false;
        }
      });
    });

    // Attach topup modal listeners
    tbody.querySelectorAll('.open-topup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-username');

        document.getElementById('topup-reseller-id').value = id;
        document.getElementById('topup-reseller-name').value = username;
        document.getElementById('modal-topup').classList.remove('hidden');
      });
    });

  } catch (err) {
    console.error('Failed to load resellers', err);
  }
}

// Tab 5: Load Activations Audit Data (Admin Only)
async function loadActivationsData() {
  if (state.user.role !== 'admin') return;

  try {
    const data = await apiCall('/api/admin/activations');
    const tbody = document.getElementById('activations-table-tbody');

    if (!data.activations || data.activations.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No activation logs recorded</td></tr>`;
      return;
    }

    tbody.innerHTML = data.activations.map(a => `
      <tr>
        <td>#${a.id}</td>
        <td class="cdkey-text">${a.cdkey}</td>
        <td><strong class="text-accent">${a.steamid}</strong></td>
        <td><span class="badge badge-subtle">${a.appids}</span></td>
        <td>${a.ip_address || '127.0.0.1'}</td>
        <td>${a.creator_name || 'System'}</td>
        <td>${formatDate(a.activated_at)}</td>
      </tr>
    `).join('');

  } catch (err) {
    console.error('Failed to load activations data', err);
  }
}

// Key Generator: Game Cover Resolution (mirrors dashboard.html)
function coverCandidates(appid) {
  return [
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + appid + '/header.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg',
    'https://cdn.akamai.steamstatic.com/steam/apps/' + appid + '/header.jpg',
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + appid + '/capsule_616x353.jpg',
    '/api/sgdb/header/' + appid,
  ];
}

function setCover(img, appid, nameEl) {
  img._sources = coverCandidates(appid);
  img._i = 0;
  img.style.opacity = '0';
  img.onload = () => {
    img.style.display = 'block';
    img.style.opacity = '1';
    if (nameEl) nameEl.classList.remove('noart');
  };
  img.onerror = () => {
    img._i++;
    if (img._i < img._sources.length) {
      img.src = img._sources[img._i];
    } else {
      img.style.display = 'none';
      if (nameEl) nameEl.classList.add('noart');
    }
  };
  img.src = img._sources[0];
}

function addCoverCandidates(img, nameEl, urls) {
  urls = (urls || []).filter(Boolean);
  if (!img || !urls.length) return;
  const start = img._sources ? img._sources.length : 0;
  img._sources = (img._sources || []).concat(urls);
  if (nameEl && nameEl.classList.contains('noart')) {
    img._i = start;
    nameEl.classList.remove('noart');
    img.src = img._sources[img._i];
  }
}

async function loadGameInfo(el, appid) {
  try {
    const info = await apiCall('/api/gameinfo/' + appid);
    const img = el.querySelector('.art img, img.selected-cover'), art = el.querySelector('.art, .selected-cover-wrap');
    if (img && art) {
      addCoverCandidates(img, art, [info.cover, info.capsule].concat(info.screenshots || []));
    }
    if (info.adult && el.dataset.adult !== '1') {
      el.dataset.adult = '1';
      const meta = el.querySelector('.meta');
      if (meta && !meta.querySelector('.chip.adult')) {
        const a = document.createElement('span'); a.className = 'chip adult'; a.textContent = '18+'; meta.appendChild(a);
      }
    }
  } catch (_) { }
}

let gameSearchSeq = 0;
let gameCurPage = 1;
let gameTotalPages = 1;
let gameCurQuery = '';
let gameCurGenre = '';
let gameCurSize = '';
let gameCurTags = { online: false, bypass: false, hypervisor: false };
let gameShowAdult = true; // By default show all unless hidden

async function ensureCatalogLoaded(force = false) {
  const isFresh = state.catalogCache && (Date.now() - state.catalogFetchedAt < CATALOG_TTL_MS);
  if (isFresh && !force) {
    return { games: state.catalogCache, genres: state.catalogGenres };
  }

  try {
    const data = await apiCall('/api/games?limit=100000');
    if (data && Array.isArray(data.games)) {
      state.catalogCache = data.games;
      state.catalogGenres = data.genres || [];
      state.catalogFetchedAt = Date.now();
      try {
        localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
          games: data.games,
          genres: data.genres,
          fetchedAt: state.catalogFetchedAt
        }));
      } catch (_) { }
    }
  } catch (err) {
    if (!state.catalogCache) throw err;
  }
  return { games: state.catalogCache || [], genres: state.catalogGenres || [] };
}

function populateGenresDropdown(genres) {
  const sel = document.getElementById('game-fgenre');
  if (!sel) return;
  const cur = gameCurGenre;
  sel.innerHTML = '<option value="">All genres</option>' +
    genres.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('');
  sel.value = cur;
}

async function searchGames(page = 1) {
  gameCurPage = page || 1;
  const input = document.getElementById('game-search-input');
  const box = document.getElementById('game-results');
  const pager = document.getElementById('game-pager');
  const prevBtn = document.getElementById('btn-game-prev');
  const nextBtn = document.getElementById('btn-game-next');
  const pageInfo = document.getElementById('game-page-info');
  const countBadge = document.getElementById('game-count-badge');

  gameCurQuery = input ? input.value.trim().toLowerCase() : '';
  const seq = ++gameSearchSeq;

  box.innerHTML = `<div class="game-results-empty"><span class="spin"></span> Loading games catalog...</div>`;

  try {
    const params = new URLSearchParams({
      page: String(gameCurPage),
      limit: '24',
      adult: gameShowAdult ? '1' : '0'
    });

    if (gameCurQuery) params.set('search', gameCurQuery);
    if (gameCurGenre) params.set('genre', gameCurGenre);
    if (gameCurSize) params.set('size', gameCurSize);
    if (gameCurTags.online) params.set('online', '1');
    if (gameCurTags.bypass) params.set('bypass', '1');
    if (gameCurTags.hypervisor) params.set('hypervisor', '1');

    const data = await apiCall(`/api/games?${params.toString()}`);
    if (seq !== gameSearchSeq) return;

    state.gamesLoaded = true;
    if (data.genres && data.genres.length) {
      populateGenresDropdown(data.genres);
    }

    const games = data.games || [];
    const total = data.total || 0;
    gameTotalPages = data.pages || 1;
    gameCurPage = data.page || 1;

    if (pager) {
      if (gameTotalPages > 1) {
        pager.classList.remove('hidden');
        if (pageInfo) pageInfo.textContent = `Page ${gameCurPage} of ${gameTotalPages}`;
        if (prevBtn) prevBtn.disabled = gameCurPage <= 1;
        if (nextBtn) nextBtn.disabled = gameCurPage >= gameTotalPages;
      } else {
        pager.classList.add('hidden');
      }
    }

    if (countBadge) {
      if (total === 0) {
        countBadge.textContent = '0 games found';
      } else {
        const start = (gameCurPage - 1) * 24 + 1;
        const end = Math.min(gameCurPage * 24, total);
        countBadge.textContent = `Showing ${start}-${end} of ${total.toLocaleString()} games`;
      }
    }

    if (!total) {
      box.innerHTML = `<div class="game-results-empty">No games found ${gameCurQuery ? `for "${escapeHtml(gameCurQuery)}"` : ''}</div>`;
      return;
    }

    const selectedAppid = document.getElementById('gen-appids').value;
    box.innerHTML = '';

    games.forEach(g => {
      const isSelected = String(g.appid) === String(selectedAppid);
      const card = document.createElement('div');
      card.className = `game${isSelected ? ' selected' : ''}`;
      card.dataset.appid = g.appid;
      if (g.adult) card.dataset.adult = '1';

      const art = document.createElement('div');
      art.className = 'art';
      art.setAttribute('data-name', g.name);

      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      art.appendChild(img);
      card.appendChild(art);

      setCover(img, g.appid, art);

      const body = document.createElement('div');
      body.className = 'body';

      const metaHtml = `
        <div class="meta">
          ${g.genreName ? `<span class="chip">${escapeHtml(g.genreName)}</span>` : ''}
          ${g.size_gb ? `<span class="chip">${escapeHtml(g.size_gb)}</span>` : ''}
          ${g.online_supported ? `<span class="chip tag online" title="Online-fix supported">Online</span>` : ''}
          ${g.bypass_supported ? `<span class="chip tag bypass" title="Bypass supported">Bypass</span>` : ''}
          ${g.hypervisor_bypass ? `<span class="chip tag hyper" title="Hypervisor bypass">Hypervisor</span>` : ''}
          ${g.adult ? `<span class="chip adult">18+</span>` : ''}
        </div>
      `;

      body.innerHTML = `
        <div class="nm">${escapeHtml(g.name)}</div>
        <div class="ap">AppID ${escapeHtml(g.appid)}</div>
        ${metaHtml}
        <button type="button" class="btn ${isSelected ? 'btn-primary' : 'btn-secondary'} btn-select">
          ${isSelected ? '✓ Selected' : 'Select Game'}
        </button>
      `;

      card.appendChild(body);

      card.addEventListener('click', () => {
        selectGame(g.appid, g.name);
      });

      box.appendChild(card);

      loadGameInfo(card, g.appid);
    });
  } catch (err) {
    if (seq === gameSearchSeq) {
      box.innerHTML = `<div class="game-results-empty">Could not load game list. Try refreshing.</div>`;
    }
  }
}

function selectGame(appid, name) {
  document.getElementById('gen-appids').value = appid;
  document.getElementById('gen-game-name').value = name;

  const el = document.getElementById('selected-game');
  el.classList.remove('empty');
  el.innerHTML = '';

  const art = document.createElement('div');
  art.className = 'selected-cover-wrap';
  art.style.width = '120px';
  art.style.aspectRatio = '460/215';
  art.style.borderRadius = '8px';
  art.style.overflow = 'hidden';
  art.style.flexShrink = '0';
  art.setAttribute('data-name', name);

  const img = document.createElement('img');
  img.className = 'selected-cover';
  img.alt = '';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  art.appendChild(img);

  setCover(img, appid, art);

  const info = document.createElement('div');
  info.className = 'game-info';
  info.innerHTML = `
    <span class="game-name" style="font-weight: 700; font-size: 0.95rem;">${escapeHtml(name)}</span>
    <span class="game-appid" style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-muted);">AppID ${escapeHtml(appid)}</span>
  `;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-sm btn-ghost';
  clearBtn.id = 'btn-clear-game';
  clearBtn.title = 'Clear selection';
  clearBtn.innerHTML = '&times;';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSelectedGame();
  });

  el.appendChild(art);
  el.appendChild(info);
  el.appendChild(clearBtn);

  document.querySelectorAll('#game-results .game').forEach(card => {
    const isThis = String(card.dataset.appid) === String(appid);
    card.classList.toggle('selected', isThis);
    const btn = card.querySelector('.btn-select');
    if (btn) {
      btn.className = `btn ${isThis ? 'btn-primary' : 'btn-secondary'} btn-select`;
      btn.textContent = isThis ? '✓ Selected' : 'Select Game';
    }
  });

  loadGameInfo(el, appid);
}

function clearSelectedGame() {
  document.getElementById('gen-appids').value = '';
  document.getElementById('gen-game-name').value = '';
  const el = document.getElementById('selected-game');
  el.classList.add('empty');
  el.innerHTML = `<span class="text-muted">No game selected. Click a game from the catalog.</span>`;
  document.querySelectorAll('#game-results .game.selected').forEach(card => {
    card.classList.remove('selected');
    const btn = card.querySelector('.btn-select');
    if (btn) {
      btn.className = 'btn btn-secondary btn-select';
      btn.textContent = 'Select Game';
    }
  });
}

// Refresh the credit balance shown in the top bar
async function refreshCredits() {
  try {
    const data = await apiCall('/api/auth/me');
    state.user.credits = data.user.credits;
    document.getElementById('nav-user-credits').textContent = parseFloat(data.user.credits).toFixed(2);
  } catch (err) { /* toasted */ }
}

// Helpers
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString();
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
