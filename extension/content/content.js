// VoiceFlow Content Script
// Handles text insertion AND audio recording (mic permission works in page context)

// Guard against double-injection
if (window.__voiceflowLoaded) { throw new Error('already loaded'); }
window.__voiceflowLoaded = true;

(function () {
  'use strict';

  let lastFocusedElement = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;

  function isInsertable(el) {
    if (!el) return false;
    return (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.contentEditable === 'true' ||
      el.getAttribute('role') === 'textbox'
    );
  }

  document.addEventListener('focusin', (e) => {
    if (isInsertable(e.target)) lastFocusedElement = e.target;
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── Ping (liveness check) ────────────────────────────────────────────────
    if (message.type === 'PING') {
      sendResponse({ alive: true });
      return;
    }

    // ── Start recording ──────────────────────────────────────────────────────
    if (message.type === 'START_RECORDING') {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((s) => {
          stream = s;
          audioChunks = [];

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';

          mediaRecorder = new MediaRecorder(stream, { mimeType });
          mediaRecorder.addEventListener('dataavailable', (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
          });
          mediaRecorder.start(100);
          sendResponse({ success: true });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    // ── Stop recording ───────────────────────────────────────────────────────
    if (message.type === 'STOP_RECORDING') {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        sendResponse({ success: false, error: 'Not recording' });
        return;
      }

      mediaRecorder.addEventListener('stop', () => {
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }

        const mimeType = mediaRecorder.mimeType;
        const blob = new Blob(audioChunks, { type: mimeType });

        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          sendResponse({ success: true, audio: base64, mimeType });
        };
        reader.readAsDataURL(blob);
      });

      mediaRecorder.stop();
      return true;
    }

    // ── Insert text ──────────────────────────────────────────────────────────
    if (message.type === 'INSERT_TEXT') {
      const text = message.text;
      const target = isInsertable(document.activeElement)
        ? document.activeElement
        : lastFocusedElement;

      if (!target) {
        sendResponse({ success: false, error: 'No focused input found' });
        return;
      }

      try {
        if (target.contentEditable === 'true') {
          target.focus();
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            target.textContent += text;
          }
          target.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          target.focus();
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          target.value = target.value.slice(0, start) + text + target.value.slice(end);
          target.setSelectionRange(start + text.length, start + text.length);
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });
})();
