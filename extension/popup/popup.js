// ─── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_BACKEND = 'https://voiceflow-backend-production-b82d.up.railway.app'; // Change before publishing

// ─── State ────────────────────────────────────────────────────────────────────
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;
let lastTranscribedText = '';

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
async function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function getBackendUrl() {
  const data = await getStorage(['backendUrl']);
  return (data.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
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
    const baseUrl = await getBackendUrl();
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
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
  const baseUrl = await getBackendUrl();
  const res = await fetch(`${baseUrl}/api/auth/login`, {
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
  const baseUrl = await getBackendUrl();
  const res = await fetch(`${baseUrl}/api/auth/register`, {
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
  if (!user) return;
  const badge = document.getElementById('plan-badge');
  const planLabel = document.getElementById('plan-label');
  const trialCount = document.getElementById('trial-count');
  const upgradeBanner = document.getElementById('upgrade-banner');

  if (user.plan === 'PRO' && user.status === 'ACTIVE') {
    badge.className = 'plan-badge pro';
    planLabel.textContent = '⚡ Pro';
    trialCount.textContent = 'Unlimited';
    upgradeBanner.classList.add('hidden');
  } else {
    badge.className = 'plan-badge trial';
    planLabel.textContent = 'Trial';
    const used = user.trialUsedToday || 0;
    const limit = user.trialDailyLimit || 10;
    trialCount.textContent = `${used}/${limit} today`;
    if (used >= limit * 0.7) upgradeBanner.classList.remove('hidden');
  }

  document.getElementById('settings-email').textContent = user.email || '';
  document.getElementById('settings-plan').textContent =
    user.plan === 'PRO' ? 'Pro Plan — Unlimited' : `Trial — ${user.trialRemaining} remaining today`;
}

// ─── Recording via offscreen document ────────────────────────────────────────
async function startRecording() {
  setStatus('Starting…');

  const response = await chrome.runtime.sendMessage({ type: 'START_RECORDING' });

  if (!response || !response.success) {
    setStatus('Microphone error: ' + (response?.error || 'unknown'));
    return;
  }

  isRecording = true;
  chrome.runtime.sendMessage({ type: 'RECORDING_START' });

  // UI
  document.getElementById('btn-record').classList.add('recording');
  document.getElementById('record-ring').classList.add('recording');
  document.getElementById('icon-mic').classList.add('hidden');
  document.getElementById('icon-stop').classList.remove('hidden');
  document.getElementById('result-area').classList.add('hidden');

  // Timer
  recordSeconds = 0;
  updateTimer();
  document.getElementById('record-timer').classList.remove('hidden');
  recordTimer = setInterval(() => { recordSeconds++; updateTimer(); }, 1000);

  setStatus('Recording… click to stop');

  // Auto-stop after 3 minutes
  setTimeout(() => { if (isRecording) stopRecording(); }, 3 * 60 * 1000);
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(recordTimer);
  chrome.runtime.sendMessage({ type: 'RECORDING_STOP' });

  // UI
  document.getElementById('btn-record').classList.remove('recording');
  document.getElementById('record-ring').classList.remove('recording');
  document.getElementById('icon-mic').classList.remove('hidden');
  document.getElementById('icon-stop').classList.add('hidden');
  document.getElementById('record-timer').classList.add('hidden');
  setStatus('Processing…');

  const response = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });

  if (!response || !response.success || !response.audio) {
    setStatus('No audio captured. Try again.');
    return;
  }

  await transcribeAudio(response.audio, response.mimeType);
}

function updateTimer() {
  const m = Math.floor(recordSeconds / 60);
  const s = recordSeconds % 60;
  document.getElementById('record-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Transcription ────────────────────────────────────────────────────────────
async function transcribeAudio(base64Audio, mimeType) {
  try {
    // Convert base64 back to blob
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });

    if (blob.size < 500) {
      setStatus('No speech detected. Try again.');
      return;
    }

    const settings = await getStorage(['language', 'autoInsert']);
    const language = settings.language || 'auto';

    const formData = new FormData();
    formData.append('audio', blob, 'audio.webm');
    formData.append('language', language);

    const res = await apiFetch('/api/transcribe', { method: 'POST', body: formData });
    if (!res) return;

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setStatus('Daily limit reached. Upgrade for unlimited!');
        document.getElementById('upgrade-banner').classList.remove('hidden');
      } else {
        setStatus(err.error || 'Transcription failed. Try again.');
      }
      return;
    }

    const data = await res.json();
    lastTranscribedText = data.text;

    // Update trial counter
    if (data.trialRemaining !== undefined) {
      const stored = await getStorage(['user']);
      const user = stored.user || {};
      user.trialRemaining = data.trialRemaining;
      user.trialUsedToday = (user.trialDailyLimit || 10) - data.trialRemaining;
      await setStorage({ user });
      updateMainUI(user);
    }

    showResult(data.text);

    const autoInsert = settings.autoInsert !== false;
    if (autoInsert) await insertText(data.text);

  } catch (err) {
    console.error(err);
    setStatus('Network error. Check your connection.');
  }
}

function setStatus(text) {
  document.getElementById('record-status').textContent = text;
}

function showResult(text) {
  document.getElementById('result-text').textContent = text;
  document.getElementById('result-area').classList.remove('hidden');
  setStatus('Click to record');
}

// ─── Insert text into page ────────────────────────────────────────────────────
async function insertText(text) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await chrome.tabs.sendMessage(tab.id, { type: 'INSERT_TEXT', text });
  } catch (err) {
    console.error('Insert error:', err);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const data = await getStorage(['accessToken', 'user', 'language', 'autoInsert', 'backendUrl']);

  if (data.language) document.getElementById('language-select').value = data.language;
  if (data.autoInsert !== undefined) document.getElementById('toggle-autoinsert').checked = data.autoInsert;
  if (data.backendUrl) document.getElementById('backend-url').value = data.backendUrl;

  if (data.accessToken) {
    const user = await fetchUserData() || data.user;
    if (user) {
      updateMainUI(user);
      showScreen('main');
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
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('btn-login');

    errEl.classList.add('hidden');
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loader').classList.remove('hidden');

    try {
      const user = await login(email, password);
      updateMainUI(user);
      showScreen('main');
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
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl = document.getElementById('reg-error');
    const btn = document.getElementById('btn-register');

    errEl.classList.add('hidden');
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loader').classList.remove('hidden');

    try {
      const user = await register(email, password);
      updateMainUI(user);
      showScreen('main');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.querySelector('.btn-text').classList.remove('hidden');
      btn.querySelector('.btn-loader').classList.add('hidden');
    }
  });

  // Record toggle
  document.getElementById('btn-record').addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
  });

  // Copy
  document.getElementById('btn-copy').addEventListener('click', async () => {
    if (!lastTranscribedText) return;
    await navigator.clipboard.writeText(lastTranscribedText);
    const btn = document.getElementById('btn-copy');
    btn.textContent = '✓ Copied';
    setTimeout(() => {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
    }, 2000);
  });

  // Insert manually
  document.getElementById('btn-insert').addEventListener('click', async () => {
    if (lastTranscribedText) await insertText(lastTranscribedText);
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', () => showScreen('settings'));
  document.getElementById('btn-back').addEventListener('click', () => showScreen('main'));

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const language = document.getElementById('language-select').value;
    const autoInsert = document.getElementById('toggle-autoinsert').checked;
    const backendUrl = document.getElementById('backend-url').value.trim();
    await setStorage({ language, autoInsert, backendUrl });
    const btn = document.getElementById('btn-save-settings');
    btn.textContent = '✓ Saved!';
    setTimeout(() => { btn.textContent = 'Save Settings'; }, 2000);
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await logout(true);
    showScreen('auth');
  });

  // Upgrade
  document.getElementById('btn-upgrade')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://your-website.com/upgrade' });
  });

  // Enter key
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-login').click();
  });
  document.getElementById('reg-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-register').click();
  });
});
