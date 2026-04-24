// VoiceFlow Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['language', 'autoInsert'], (data) => {
    const defaults = {};
    if (data.language === undefined) defaults.language = 'auto';
    if (data.autoInsert === undefined) defaults.autoInsert = true;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

// ─── Offscreen document management ───────────────────────────────────────────
async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording audio from microphone for voice-to-text',
    });
  }
}

// ─── Message relay: popup ↔ offscreen ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage(
        { ...message, target: 'offscreen' },
        (response) => sendResponse(response)
      );
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    chrome.runtime.sendMessage(
      { ...message, target: 'offscreen' },
      (response) => sendResponse(response)
    );
    return true;
  }

  if (message.type === 'RECORDING_START') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#fc4a6c' });
  }

  if (message.type === 'RECORDING_STOP') {
    chrome.action.setBadgeText({ text: '' });
  }
});
