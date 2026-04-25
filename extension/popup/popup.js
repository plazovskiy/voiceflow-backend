// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_BACKEND = 'https://voiceflow-backend-production-b82d.up.railway.app';

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
async function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function getBackendUrl() {
  return DEFAULT_BACKEND;
}

async function apiFetch(path, options = {}, retry = true) {
  const baseUrl = await getBackendUrl();
  const data = await getStorage(['accessToken', 'refreshToken']);

  const headers = { ...options.headers };
  if (data.accessToken) headers['Authorization'] = `Bearer ${data.accessToken}`;
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });

  if (res.status === 401 && retry) {
    const errBody = await res.json().catch(() => ({}));
    if (errBody.code === 'TOKEN_EXPIRED' && data.refreshToken) {
      const refreshed = await refreshAccessToken(data.refreshToken);
      if (refreshed) return apiFetch(path, options, false);
    }
    await logout(false);
    showScreen('auth');
    return null;
  }
  return res;
}

async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetch(`${DEFAULT_BACKEND}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    await setStorage({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
    return true;
  } catch { return false; }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function login(email, password) {
  const res = await fetch(`${DEFAULT_BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  await setStorage({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
  return data.user;
}

async function register(email, password) {
  const res = await fetch(`${DEFAULT_BACKEND}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  await setStorage({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
  return data.user;
}

async function logout(callServer = true) {
  if (callServer) {
    const data = await getStorage(['refreshToken']);
    await apiFetch('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: data.refreshToken }),
    }).catch(() => {});
  }
  await setStorage({ accessToken: null, refreshToken: null, user: null });
}

async function fetchUserData() {
  const res = await apiFetch('/api/user/me');
  if (!res || !res.ok) return null;
  const data = await res.json();
  await setStorage({ user: data });
  return data;
}

// ─── Screens ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

function updateMainUI(user) {
  if (!user) return 'main';
  const badge       = document.getElementById('plan-badge');
  const planLabel   = document.getElementById('plan-label');
  const trialCount  = document.getElementById('trial-count');
  const upgradeBanner = document.getElementById('upgrade-banner');
  const upgradeSettings = document.getElementById('upgrade-settings');

  if (user.plan === 'PRO' && user.status === 'ACTIVE') {
    badge.className = 'plan-badge pro';
    planLabel.textContent = '⚡ Pro';
    trialCount.textContent = 'Unlimited';
    upgradeBanner.classList.add('hidden');
    upgradeSettings?.classList.add('hidden');
    return 'main';
  } else {
    badge.className = 'plan-badge trial';
    planLabel.textContent = 'Trial';
    const used  = parseFloat(user.trialSecondsUsed || 0);
    const limit = parseFloat(user.trialSecondsLimit || 600);
    const usedMin  = (used  / 60).toFixed(1);
    const limitMin = (limit / 60).toFixed(0);
    trialCount.textContent = `${usedMin}/${limitMin} min used`;

    if (document.getElementById('settings-plan')) {
      document.getElementById('settings-plan').textContent =
        `Trial — ${user.trialMinutesRemaining || '10.0'} min remaining`;
    }
    if (document.getElementById('settings-email')) {
      document.getElementById('settings-email').textContent = user.email || '';
    }

    const remaining = limit - used;
    if (remaining <= 0) {
      return 'upgrade'; // caller will call showScreen('upgrade')
    } else if (remaining < limit * 0.3) {
      upgradeBanner.classList.remove('hidden');
      upgradeSettings?.classList.remove('hidden');
    }
    return 'main';
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const data = await getStorage(['accessToken', 'user', 'language', 'autoInsert']);

  if (data.language) document.getElementById('language-select').value = data.language;
  if (data.autoInsert !== undefined) document.getElementById('toggle-autoinsert').checked = data.autoInsert;

  if (data.accessToken) {
    const user = await fetchUserData() || data.user;
    if (user) {
      const screen = updateMainUI(user);
      showScreen(screen || 'main');
      return;
    }
  }
  showScreen('auth');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Auth tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Login
  document.getElementById('btn-login').addEventListener('click', async () => {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    const btn      = document.getElementById('btn-login');

    errEl.classList.add('hidden');
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loader').classList.remove('hidden');

    try {
      const user = await login(email, password);
      const screen = updateMainUI(user);
      showScreen(screen || 'main');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.querySelector('.btn-text').classList.remove('hidden');
      btn.querySelector('.btn-loader').classList.add('hidden');
    }
  });

  // Register
  document.getElementById('btn-register').addEventListener('click', async () => {
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl    = document.getElementById('reg-error');
    const btn      = document.getElementById('btn-register');

    errEl.classList.add('hidden');
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loader').classList.remove('hidden');

    try {
      const user = await register(email, password);
      const screen = updateMainUI(user);
      showScreen(screen || 'main');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.querySelector('.btn-text').classList.remove('hidden');
      btn.querySelector('.btn-loader').classList.add('hidden');
    }
  });

  // Settings navigation
  document.getElementById('btn-settings').addEventListener('click', () => showScreen('settings'));
  document.getElementById('btn-open-settings').addEventListener('click', () => showScreen('settings'));
  document.getElementById('btn-back').addEventListener('click', () => showScreen('main'));
  document.getElementById('btn-upgrade-settings-nav')?.addEventListener('click', () => showScreen('settings'));

  // Save settings
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const language   = document.getElementById('language-select').value;
    const autoInsert = document.getElementById('toggle-autoinsert').checked;
    await setStorage({ language, autoInsert });
    const btn = document.getElementById('btn-save-settings');
    btn.textContent = '✓ Saved!';
    setTimeout(() => { btn.textContent = 'Save Settings'; }, 2000);
  });

  // Upgrade buttons
  const upgradeHandler = () => chrome.tabs.create({ url: 'https://your-website.com/upgrade' });
  document.getElementById('btn-upgrade')?.addEventListener('click', upgradeHandler);
  document.getElementById('btn-upgrade-settings')?.addEventListener('click', upgradeHandler);
  document.getElementById('btn-upgrade-main')?.addEventListener('click', upgradeHandler);

  // Logout
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await logout(true);
    showScreen('auth');
  });

  // Enter key in auth
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-login').click();
  });
  document.getElementById('reg-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-register').click();
  });
});
