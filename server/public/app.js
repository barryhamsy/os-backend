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

  document.getElementById('generator-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const appids = document.getElementById('gen-appids').value;
    const quantity = parseInt(qtyInput.value) || 1;
    const cost = parseFloat(costInput.value) || 1.0;

    try {
      const data = await apiCall('/api/keys/generate', 'POST', { appids, quantity, cost });
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
        <td class="cdkey-text">${k.cdkey}</td>
        <td><span class="badge badge-subtle">${k.appids}</span></td>
        <td>
          <span class="badge badge-${k.status}">${k.status.toUpperCase()}</span>
        </td>
        <td>${k.creator_name || state.user.username}</td>
        <td>${formatDate(k.created_at)}</td>
        <td>${k.activated_by ? `<strong class="text-accent">${k.activated_by}</strong>` : '<span class="text-muted">-</span>'}</td>
        <td>${k.activated_at ? formatDate(k.activated_at) : '<span class="text-muted">-</span>'}</td>
        <td>
          <button class="btn btn-sm btn-outline copy-single-key" data-key="${k.cdkey}">Copy</button>
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
        <td><strong>${r.username}</strong></td>
        <td><span class="text-accent" style="font-weight:700;">${parseFloat(r.credits).toFixed(2)}</span> credits</td>
        <td>${r.keys_generated}</td>
        <td>${r.keys_used}</td>
        <td>${formatDate(r.created_at)}</td>
        <td>
          <button class="btn btn-sm btn-secondary open-topup-btn" data-id="${r.id}" data-username="${r.username}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Top Up</span>
          </button>
        </td>
      </tr>
    `).join('');

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

// Helpers
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
