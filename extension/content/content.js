if (window.__voiceflowLoaded) { throw new Error('already loaded'); }
window.__voiceflowLoaded = true;

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let lastFocusedElement = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let stream = null;
  let isRecording = false;
  let timerInterval = null;
  let seconds = 0;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // ── Track focused inputs ───────────────────────────────────────────────────
  function isInsertable(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.contentEditable === 'true' || el.getAttribute('role') === 'textbox';
  }

  document.addEventListener('focusin', (e) => {
    if (isInsertable(e.target) && !e.target.closest('#vf-widget')) {
      lastFocusedElement = e.target;
    }
  }, true);

  // ── Build floating widget ──────────────────────────────────────────────────
  const shadow = document.createElement('div');
  shadow.id = 'vf-widget';
  shadow.setAttribute('data-vf', '1');

  // Load saved position
  const savedX = localStorage.getItem('vf-x');
  const savedY = localStorage.getItem('vf-y');
  const initRight = savedX ? null : '20px';
  const initBottom = savedY ? null : '20px';

  Object.assign(shadow.style, {
    position: 'fixed',
    right: initRight || 'auto',
    bottom: initBottom || 'auto',
    left: savedX ? savedX + 'px' : 'auto',
    top: savedY ? savedY + 'px' : 'auto',
    zIndex: '2147483647',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    userSelect: 'none',
  });

  shadow.innerHTML = `
    <style>
      #vf-btn {
        display: flex; align-items: center; gap: 7px;
        background: #7c6cfc;
        border: none; border-radius: 50px;
        padding: 9px 15px; cursor: grab;
        box-shadow: 0 2px 12px rgba(124,108,252,0.4);
        transition: background 0.2s, box-shadow 0.2s;
        color: white; font-size: 13px; font-weight: 500;
        white-space: nowrap;
      }
      #vf-btn:active { cursor: grabbing; }
      #vf-btn.recording {
        background: #fc4a6c;
        box-shadow: 0 2px 12px rgba(252,74,108,0.4);
        animation: vf-pulse 1.5s infinite;
      }
      @keyframes vf-pulse {
        0%, 100% { box-shadow: 0 2px 12px rgba(252,74,108,0.4); }
        50% { box-shadow: 0 2px 20px rgba(252,74,108,0.7); }
      }
      #vf-result {
        display: none;
        background: rgba(15,15,18,0.92);
        backdrop-filter: blur(8px);
        border-radius: 10px;
        padding: 8px 10px;
        margin-bottom: 6px;
        max-width: 240px;
        font-size: 12px;
        color: #f0f0f5;
        line-height: 1.4;
        word-break: break-word;
      }
      #vf-result.visible { display: block; }
    </style>
    <div id="vf-result"></div>
    <button id="vf-btn">
      <svg id="vf-icon-mic" width="15" height="15" viewBox="0 0 24 24" fill="none">
        <rect x="8" y="1" width="8" height="13" rx="4" fill="white"/>
        <path d="M5 11a7 7 0 0 0 14 0" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/>
        <line x1="12" y1="18" x2="12" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <svg id="vf-icon-stop" width="13" height="13" viewBox="0 0 24 24" fill="white" style="display:none">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
      <span id="vf-label">Voice</span>
    </button>
  `;

  document.body.appendChild(shadow);

  const btn = shadow.querySelector('#vf-btn');
  const label = shadow.querySelector('#vf-label');
  const iconMic = shadow.querySelector('#vf-icon-mic');
  const iconStop = shadow.querySelector('#vf-icon-stop');
  const resultBox = shadow.querySelector('#vf-result');

  // ── Dragging ───────────────────────────────────────────────────────────────
  let moved = false;

  btn.addEventListener('mousedown', (e) => {
    isDragging = true;
    moved = false;
    const rect = shadow.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    btn.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    moved = true;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    Object.assign(shadow.style, {
      left: x + 'px', top: y + 'px',
      right: 'auto', bottom: 'auto',
    });
    localStorage.setItem('vf-x', x);
    localStorage.setItem('vf-y', y);
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    btn.style.cursor = 'grab';
  });

  // ── Record logic ───────────────────────────────────────────────────────────
  btn.addEventListener('click', () => {
    if (moved) { moved = false; return; } // was a drag, not a click
    if (isRecording) stopRecording();
    else startRecording();
  });

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      isRecording = true;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      });
      mediaRecorder.start(100);

      // UI
      btn.classList.add('recording');
      iconMic.style.display = 'none';
      iconStop.style.display = 'block';
      resultBox.classList.remove('visible');
      seconds = 0;
      label.textContent = '0:00';
      timerInterval = setInterval(() => {
        seconds++;
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        label.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      }, 1000);

      // Auto-stop at 3 min
      setTimeout(() => { if (isRecording) stopRecording(); }, 3 * 60 * 1000);

    } catch (err) {
      label.textContent = 'No mic';
      setTimeout(() => { label.textContent = 'Voice'; }, 2000);
    }
  }

  function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    isRecording = false;
    clearInterval(timerInterval);

    mediaRecorder.addEventListener('stop', () => {
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      sendToBackground(blob, mediaRecorder.mimeType);
    });
    mediaRecorder.stop();

    // UI
    btn.classList.remove('recording');
    iconMic.style.display = 'block';
    iconStop.style.display = 'none';
    label.textContent = '…';
  }

  async function sendToBackground(blob, mimeType) {
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result.split(',')[1];
      chrome.runtime.sendMessage(
        { type: 'TRANSCRIBE', audio: base64, mimeType },
        (response) => {
          if (!response || !response.success) {
            label.textContent = response?.error === 'LIMIT' ? 'Limit!' : 'Error';
            setTimeout(() => { label.textContent = 'Voice'; }, 2500);
            return;
          }
          const text = response.text;
          showResult(text);
          insertIntoFocused(text);
          label.textContent = 'Voice';
        }
      );
    };
    reader.readAsDataURL(blob);
  }

  function showResult(text) {
    resultBox.textContent = text;
    resultBox.classList.add('visible');
    setTimeout(() => resultBox.classList.remove('visible'), 8000);
  }

  // ── Insert text ────────────────────────────────────────────────────────────
  function insertIntoFocused(text) {
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
        const e2 = target.selectionEnd ?? target.value.length;
        target.value = target.value.slice(0, s) + text + target.value.slice(e2);
        target.setSelectionRange(s + text.length, s + text.length);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
  }

  // ── Messages from background ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') { sendResponse({ alive: true }); return; }
    if (message.type === 'INSERT_TEXT') {
      insertIntoFocused(message.text);
      sendResponse({ success: true });
    }
  });

})();
