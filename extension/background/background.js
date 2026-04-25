// VoiceFlow Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['language', 'autoInsert'], (data) => {
    const defaults = {};
    if (data.language === undefined) defaults.language = 'auto';
    if (data.autoInsert === undefined) defaults.autoInsert = true;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    // Ping the content script — if it responds, it's already loaded
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    // Not loaded — inject it now
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
    // Small delay for script to initialize
    await new Promise(r => setTimeout(r, 200));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'START_RECORDING' || message.type === 'STOP_RECORDING') {
    getActiveTab().then(async tab => {
      if (!tab?.id) {
        sendResponse({ success: false, error: 'No active tab found. Please open a webpage first.' });
        return;
      }

      // Can't inject into chrome:// or extension pages
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        sendResponse({ success: false, error: 'Please navigate to a regular webpage first.' });
        return;
      }

      try {
        await ensureContentScript(tab.id);
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse(response);
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: 'Could not load on this page: ' + err.message });
      }
    });
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
