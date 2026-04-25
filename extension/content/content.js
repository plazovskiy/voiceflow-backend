if (window.__voiceflowLoaded) { throw new Error('VF already loaded'); }
window.__voiceflowLoaded = true;

(function () {
  'use strict';

  let lastFocusedElement = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;
  let isRecording = false;
  let timerInterval = null;
  let seconds = 0;
  let dragStartX = 0, dragStartY = 0, elemStartX = 0, elemStartY = 0;
  let moved = false;

  // ── Track focused inputs ─────────────────────────────────────────────────
  function isInsertable(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.contentEditable === 'true' || el.getAttribute('role') === 'textbox';
  }

  document.addEventListener('focusin', (e) => {
    if (isInsertable(e.target) && !e.target.closest?.('#vf-host')) {
      lastFocusedElement = e.target;
    }
  }, true);

  // ── Create widget host with Shadow DOM ───────────────────────────────────
  const host = document.createElement('div');
  host.id = 'vf-host';
  Object.assign(host.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    left: 'auto',
    top: 'auto',
    zIndex: '2147483647',
    width: 'auto',
    height: 'auto',
    pointerEvents: 'none',
  });

  // Restore saved position
  try {
    const sx = localStorage.getItem('vf-pos-x');
    const sy = localStorage.getItem('vf-pos-y');
    if (sx && sy) {
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = sx + 'px';
      host.style.top = sy + 'px';
    }
  } catch (_) {}

  const shadowRoot = host.attachShadow({ mode: 'open' });

  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

      #wrap {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        pointer-events: all;
      }

      #result {
        display: none;
        background: rgba(10,10,14,0.93);
        border-radius: 10px;
        padding: 8px 11px;
        max-width: 230px;
        font-size: 12.5px;
        color: #f0f0f5;
        line-height: 1.45;
        word-break: break-word;
        border: 1px solid rgba(255,255,255,0.08);
      }
      #result.show { display: block; }

      #btn {
        display: flex;
        align-items: center;
        gap: 7px;
        background: #7c6cfc;
        border: none;
        border-radius: 50px;
        padding: 9px 15px 9px 13px;
        cursor: grab;
        color: white;
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        outline: none;
        box-shadow: 0 2px 10px rgba(124,108,252,0.45);
        transition: background 0.2s;
        -webkit-user-select: none;
        user-select: none;
      }
      #btn:active { cursor: grabbing; }
      #btn.rec {
        background: #fc4a6c;
        box-shadow: 0 2px 14px rgba(252,74,108,0.5);
        animation: pulse 1.4s ease-in-out infinite;
      }
      @keyframes pulse {
        0%,100% { box-shadow: 0 2px 10px rgba(252,74,108,0.4); }
        50%      { box-shadow: 0 2px 22px rgba(252,74,108,0.75); }
      }
    </style>

    <div id="wrap">
      <div id="result"></div>
      <button id="btn">
        <svg id="mic" width="15" height="15" viewBox="0 0 24 24" fill="none">
          <rect x="8" y="1" width="8" height="13" rx="4" fill="white"/>
          <path d="M5 11a7 7 0 0 0 14 0" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/>
          <line x1="12" y1="18" x2="12" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <svg id="stop" width="13" height="13" viewBox="0 0 24 24" fill="white" style="display:none">
          <rect x="6" y="6" width="12" height="12" rx="2"/>
        </svg>
        <span id="lbl">Voice</span>
      </button>
    </div>
  `;

  // Wait for body to be ready
  function mount() {
    if (document.body) {
      document.body.appendChild(host);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(host));
    }
  }
  mount();

  const btn    = shadowRoot.getElementById('btn');
  const lbl    = shadowRoot.getElementById('lbl');
  const mic    = shadowRoot.getElementById('mic');
  const stop   = shadowRoot.getElementById('stop');
  const result = shadowRoot.getElementById('result');

  // ── Drag ──────────────────────────────────────────────────────────────────
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    moved = false;
    const rect = host.getBoundingClientRect();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    elemStartX = rect.left;
    elemStartY = rect.top;

    function onMove(e) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 120, elemStartX + dx));
      const ny = Math.max(0, Math.min(window.innerHeight - 50, elemStartY + dy));
      host.style.left = nx + 'px';
      host.style.top  = ny + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      try { localStorage.setItem('vf-pos-x', nx); localStorage.setItem('vf-pos-y', ny); } catch(_) {}
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Click = toggle record ─────────────────────────────────────────────────
  btn.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    isRecording ? stopRecording() : startRecording();
  });

  // ── Start recording ───────────────────────────────────────────────────────
  async function startRecording() {
    // Check mic API exists (requires HTTPS)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMsg('Need HTTPS page');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Map common DOMException names to readable messages
      const msg = {
        'NotAllowedError':  'Allow mic in browser',
        'NotFoundError':    'No microphone found',
        'NotReadableError': 'Mic used by another app',
        'SecurityError':    'HTTPS required',
      }[err.name] || ('Mic error: ' + err.name);
      showMsg(msg);
      return;
    }

    audioChunks = [];
    isRecording = true;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.addEventListener('dataavailable', e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    });
    mediaRecorder.start(100);

    btn.classList.add('rec');
    mic.style.display = 'none';
    stop.style.display = 'block';
    result.classList.remove('show');
    seconds = 0;
    lbl.textContent = '0:00';
    timerInterval = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      lbl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);

    // Auto-stop after 3 min
    setTimeout(() => { if (isRecording) stopRecording(); }, 180000);
  }

  // ── Stop recording ────────────────────────────────────────────────────────
  function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    isRecording = false;
    clearInterval(timerInterval);

    btn.classList.remove('rec');
    mic.style.display = 'block';
    stop.style.display = 'none';
    lbl.textContent = '…';

    mediaRecorder.addEventListener('stop', () => {
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      sendForTranscription(blob, mediaRecorder.mimeType);
    });
    mediaRecorder.stop();
  }

  // ── Send to background for API call ──────────────────────────────────────
  function sendForTranscription(blob, mimeType) {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      chrome.runtime.sendMessage({ type: 'TRANSCRIBE', audio: base64, mimeType }, (response) => {
        lbl.textContent = 'Voice';
        if (chrome.runtime.lastError) {
          showMsg('Extension error — reload page');
          return;
        }
        if (!response?.success) {
          showMsg(response?.error === 'LIMIT' ? '⚡ Daily limit reached' : 'Error: ' + (response?.error || 'unknown'));
          return;
        }
        showMsg(response.text);
        insertText(response.text);
      });
    };
    reader.readAsDataURL(blob);
  }

  // ── Show result bubble ────────────────────────────────────────────────────
  let hideTimer = null;
  function showMsg(text) {
    result.textContent = text;
    result.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => result.classList.remove('show'), 8000);
  }

  // ── Insert text into last focused element ────────────────────────────────
  function insertText(text) {
    const target = lastFocusedElement;
    if (!target || !document.body.contains(target)) return;
    try {
      if (target.contentEditable === 'true') {
        target.focus();
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          target.textContent += text;
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        target.focus();
        const s = target.selectionStart ?? target.value.length;
        const e = target.selectionEnd   ?? target.value.length;
        target.value = target.value.slice(0, s) + text + target.value.slice(e);
        target.setSelectionRange(s + text.length, s + text.length);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ alive: true }); return; }
    if (msg.type === 'INSERT_TEXT') { insertText(msg.text); sendResponse({ success: true }); }
  });

})();
