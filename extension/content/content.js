// VoiceFlow Content Script
// Tracks the last focused input/textarea/contenteditable element
// so text can be inserted even after the popup opens (which blurs the page)

(function () {
  'use strict';

  let lastFocusedElement = null;

  function isInsertable(el) {
    if (!el) return false;
    return (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.contentEditable === 'true' ||
      el.getAttribute('role') === 'textbox'
    );
  }

  // Track the last focused insertable element
  document.addEventListener('focusin', (e) => {
    if (isInsertable(e.target)) {
      lastFocusedElement = e.target;
    }
  }, true);

  // Listen for insert messages from the popup/background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'INSERT_TEXT') return;

    const text = message.text;
    if (!text) {
      sendResponse({ success: false, error: 'No text provided' });
      return;
    }

    const target = document.activeElement && isInsertable(document.activeElement)
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
        target.dispatchEvent(new Event('change', { bubbles: true }));

      } else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        target.focus();
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        const before = target.value.slice(0, start);
        const after = target.value.slice(end);
        target.value = before + text + after;
        const newPos = start + text.length;
        target.setSelectionRange(newPos, newPos);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));

        // React/Vue synthetic event support
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(target, before + text + after);
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }

    return true; // keep message channel open for async response
  });
})();
