// VoiceFlow Background Service Worker
// Handles API calls (transcription) so content script doesn't need fetch CORS

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['language', 'autoInsert'], (data) => {
    const defaults = {};
    if (data.language === undefined) defaults.language = 'auto';
    if (data.autoInsert === undefined) defaults.autoInsert = true;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

const DEFAULT_BACKEND = 'https://voiceflow-backend-production-b82d.up.railway.app'; // change this

async function getBackendUrl() {
  const data = await chrome.storage.local.get(['backendUrl']);
  return (data.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

async function getTokens() {
  return chrome.storage.local.get(['accessToken', 'refreshToken']);
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
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    });
    return data.accessToken;
  } catch { return false; }
}

async function callTranscribe(base64Audio, mimeType, accessToken, language) {
  const baseUrl = await getBackendUrl();

  // base64 → Blob → FormData
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });

  const formData = new FormData();
  formData.append('audio', blob, 'audio.webm');
  formData.append('language', language || 'auto');

  return fetch(`${baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Transcribe ─────────────────────────────────────────────────────────────
  if (message.type === 'TRANSCRIBE') {
    (async () => {
      try {
        const { accessToken, refreshToken } = await getTokens();
        if (!accessToken) {
          sendResponse({ success: false, error: 'Not logged in' });
          return;
        }

        const settings = await chrome.storage.local.get(['language']);
        const language = settings.language || 'auto';

        let res = await callTranscribe(message.audio, message.mimeType, accessToken, language);

        // Auto-refresh on 401
        if (res.status === 401 && refreshToken) {
          const newToken = await refreshAccessToken(refreshToken);
          if (newToken) {
            res = await callTranscribe(message.audio, message.mimeType, newToken, language);
          } else {
            sendResponse({ success: false, error: 'Session expired' });
            return;
          }
        }

        if (res.status === 429) {
          sendResponse({ success: false, error: 'LIMIT' });
          return;
        }

        if (!res.ok) {
          sendResponse({ success: false, error: 'Server error' });
          return;
        }

        const data = await res.json();
        sendResponse({ success: true, text: data.text });

      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async
  }

  // ── Badge ──────────────────────────────────────────────────────────────────
  if (message.type === 'RECORDING_START') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#fc4a6c' });
  }
  if (message.type === 'RECORDING_STOP') {
    chrome.action.setBadgeText({ text: '' });
  }
});
