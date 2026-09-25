// State management
let state = {
  token: localStorage.getItem('ost_token') || null,
  user: null,
  activeTab: 'overview',
  generatedKeys: []
};

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
const loginScreen = document.getElementById('login-screen');
const dashboardWrapper = document.getElementById('dashboard-wrapper');
const loginForm = document.getElementById('login-form');

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  checkAuth();
});

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
  loginScreen.classList.remove('hidden');
  dashboardWrapper.classList.add('hidden');
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboardWrapper.classList.remove('hidden');

  // Update navbar user profile
  document.getElementById('nav-username').textContent = state.user.username;
  document.getElementById('nav-user-credits').textContent = parseFloat(state.user.credits).toFixed(2);
  
  const roleBadge = document.getElementById('nav-role-badge');
  roleBadge.textContent = state.user.role.toUpperCase();
  roleBadge.className = `badge badge-${state.user.role}`;

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
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

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

  // Key Generator Calculator & Submit
  const qtyInput = document.getElementById('gen-quantity');
  const costInput = document.getElementById('gen-cost');

  function updateCalc() {
    const qty = parseInt(qtyInput.value) || 1;
    const cost = parseFloat(costInput.value) || 0;
    const total = qty * cost;

    document.getElementById('calc-qty').textContent = qty;
    document.getElementById('calc-cost').textContent = cost.toFixed(2) + ' credits';
    document.getElementById('calc-total').textContent = total.toFixed(2) + ' credits';
  }

  qtyInput.addEventListener('input', updateCalc);
  costInput.addEventListener('input', updateCalc);

  // Game search
  document.getElementById('game-search-input').addEventListener('input', debounce(searchGames, 300));
  document.getElementById('game-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(); // don't submit the generator form
  });

  document.getElementById('generator-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const appids = document.getElementById('gen-appids').value;
    const game_name = document.getElementById('gen-game-name').value;
    const quantity = parseInt(qtyInput.value) || 1;
    const cost = parseFloat(costInput.value) || 1.0;

    if (!appids) {
      showToast('Select a game first', 'error');
      return;
    }

    try {
      const data = await apiCall('/api/keys/generate', 'POST', { appids, game_name, quantity, cost });
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

  const endpoint = state.user.role === 'admin' ? '/api/admin/keys' : '/api/keys/my-keys';
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
          <span class="badge badge-subtle">${escapeHtml(k.appids)}</span>
        </td>
        <td>
          <span class="badge badge-${escapeHtml(k.status)}">${escapeHtml(k.status.toUpperCase())}</span>
        </td>
        <td>${escapeHtml(k.creator_name || state.user.username)}</td>
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
        const isResellerKey = btn.getAttribute('data-creator-role') === 'reseller';

        let msg = `Revoke ${key}?\n\n`;
        msg += status === 'used'
          ? 'This key is ACTIVATED. The customer will lose access and the key will be deleted.\n'
          : 'This key is unused. It will be deleted and can no longer be activated.\n';
        msg += isResellerKey && cost > 0
          ? `\n${cost.toFixed(2)} credits will be refunded to ${creator}.`
          : '\nNo refund (not generated by a reseller).';

        if (!confirm(msg)) return;

        btn.disabled = true;
        try {
          const result = await apiCall(`/api/keys/${encodeURIComponent(key)}/revoke`, 'POST');
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

// Key Generator: Game Search & Selection
const COVER_URLS = [
  id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`,
  id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_184x69.jpg`,
  id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`
];

function coverImg(appid, cls) {
  return `<img class="${cls}" src="${COVER_URLS[0](appid)}" data-appid="${escapeHtml(appid)}" data-try="0" alt="" loading="lazy" onerror="nextCover(this)">`;
}

// Try the next Steam image URL; show a placeholder when none exist
function nextCover(img) {
  const next = parseInt(img.dataset.try, 10) + 1;
  if (next < COVER_URLS.length) {
    img.dataset.try = next;
    img.src = COVER_URLS[next](img.dataset.appid);
  } else {
    img.onerror = null;
    img.classList.add('cover-missing');
    img.removeAttribute('src');
  }
}

let gameSearchSeq = 0;
async function searchGames() {
  const input = document.getElementById('game-search-input');
  const box = document.getElementById('game-results');
  const q = input.value.trim();
  const seq = ++gameSearchSeq;

  box.innerHTML = `<div class="game-results-empty">Searching...</div>`;

  try {
    const data = await apiCall(`/api/games?search=${encodeURIComponent(q)}`);
    if (seq !== gameSearchSeq) return; // a newer search is running
    state.gamesLoaded = true;

    if (!data.games.length) {
      box.innerHTML = `<div class="game-results-empty">No games found for "${escapeHtml(q)}"</div>`;
      return;
    }

    const selected = document.getElementById('gen-appids').value;
    box.innerHTML = data.games.map(g => `
      <button type="button" class="game-item${g.appid === selected ? ' selected' : ''}" data-appid="${escapeHtml(g.appid)}" data-name="${escapeHtml(g.name)}">
        ${coverImg(g.appid, 'game-cover')}
        <span class="game-info">
          <span class="game-name">${escapeHtml(g.name)}</span>
          <span class="game-appid">AppID ${escapeHtml(g.appid)}</span>
        </span>
      </button>
    `).join('');

    box.querySelectorAll('.game-item').forEach(btn => {
      btn.addEventListener('click', () => selectGame(btn.dataset.appid, btn.dataset.name));
    });
  } catch (err) {
    if (seq === gameSearchSeq) {
      box.innerHTML = `<div class="game-results-empty">Could not load the game list. Try again.</div>`;
    }
  }
}

function selectGame(appid, name) {
  document.getElementById('gen-appids').value = appid;
  document.getElementById('gen-game-name').value = name;

  const el = document.getElementById('selected-game');
  el.classList.remove('empty');
  el.innerHTML = `
    ${coverImg(appid, 'selected-cover')}
    <div class="game-info">
      <span class="game-name">${escapeHtml(name)}</span>
      <span class="game-appid">AppID ${escapeHtml(appid)}</span>
    </div>
    <button type="button" class="btn btn-sm btn-ghost" id="btn-clear-game" title="Clear selection">&times;</button>
  `;
  document.getElementById('btn-clear-game').addEventListener('click', clearSelectedGame);

  document.querySelectorAll('#game-results .game-item').forEach(b => {
    b.classList.toggle('selected', b.dataset.appid === appid);
  });
}

function clearSelectedGame() {
  document.getElementById('gen-appids').value = '';
  document.getElementById('gen-game-name').value = '';
  const el = document.getElementById('selected-game');
  el.classList.add('empty');
  el.innerHTML = `<span class="text-muted">No game selected. Click a game above.</span>`;
  document.querySelectorAll('#game-results .game-item.selected').forEach(b => b.classList.remove('selected'));
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
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
