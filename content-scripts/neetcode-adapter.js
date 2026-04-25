/**
 * @fileoverview NeetCode platform adapter for the DSA Mentor extension.
 *
 * CRITICAL: No ES module imports — this is a content script.
 * All helpers are inlined.
 *
 * NeetCode (neetcode.io) renders its problem list and coding interface
 * using Angular. The code editor is CodeMirror 6 (unlike LeetCode's Monaco).
 * Problem data is embedded in the page title and description elements.
 *
 * DOM notes (as of 2025):
 *   - Problem title: <h1> inside .problem-name or the <title> element
 *   - Description:   .problem-description or .description-content div
 *   - Editor:        .cm-editor (CodeMirror 6)
 *   - Language:      Language selector button or data attribute
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   content-scripts/neetcode-adapter
 */

// Guard: only activate on NeetCode
if (!window.location.hostname.includes('neetcode.io')) {
  // Not NeetCode — this adapter is a no-op
} else {

// ---------------------------------------------------------------------------
// Inlined Constants
// ---------------------------------------------------------------------------

const PLATFORM_NEETCODE = 'neetcode';

const MSG = {
  REQUEST_CODE_EXTRACTION: 'REQUEST_CODE_EXTRACTION',
  CODE_EXTRACTED: 'CODE_EXTRACTED',
};

// ---------------------------------------------------------------------------
// Inlined Logger
// ---------------------------------------------------------------------------

const log = {
  info:  (...a) => console.log('[DSA Mentor][INFO][NeetCode]',   ...a),
  debug: (...a) => console.debug('[DSA Mentor][DEBUG][NeetCode]', ...a),
  warn:  (...a) => console.warn('[DSA Mentor][WARN][NeetCode]',   ...a),
  error: (...a) => console.error('[DSA Mentor][ERROR][NeetCode]', ...a),
};

// ---------------------------------------------------------------------------
// DOM Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the problem title from NeetCode's DOM.
 *
 * @returns {string} Problem title or fallback from document.title.
 */
function extractTitle() {
  const selectors = [
    'h1.problem-name',
    '.problem-title h1',
    'h1',
    '.problem-header h1',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }

  // Fall back to document title (NeetCode sets it to the problem name)
  const title = document.title.replace(' - NeetCode', '').trim();
  return title || 'Unknown Problem';
}

/**
 * Extracts the problem description text.
 *
 * @returns {string} Description text.
 */
function extractDescription() {
  const selectors = [
    '.problem-description',
    '.description-content',
    '.problem-content',
    '[class*="description"]',
    '.problem-detail',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text.length > 20) return text.replace(/\n{3,}/g, '\n\n');
    }
  }

  return 'Problem description not available on this page.';
}

/**
 * Extracts code from the CodeMirror 6 editor via injected script.
 *
 * @returns {Promise<{code: string, language: string}>}
 */
function extractCodeViaInjectedScript() {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      log.warn('NeetCode: injected script timeout');
      resolve({ code: '', language: 'unknown' });
    }, 5000);

    function handler(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'DSA_MENTOR_CODE_RESULT') return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      if (event.data.success) {
        resolve({ code: event.data.code, language: event.data.language });
      } else {
        resolve({ code: '', language: 'unknown' });
      }
    }

    window.addEventListener('message', handler);

    try {
      const scriptUrl = chrome.runtime.getURL('injected/injected-script.js');
      const scriptEl  = document.createElement('script');
      scriptEl.src    = scriptUrl;
      scriptEl.onload = () => scriptEl.remove();
      scriptEl.onerror = () => {
        scriptEl.remove();
        clearTimeout(timeoutId);
        window.removeEventListener('message', handler);
        resolve({ code: '', language: 'unknown' });
      };
      (document.head || document.documentElement).appendChild(scriptEl);
    } catch (err) {
      log.error('NeetCode: script injection failed', err);
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve({ code: '', language: 'unknown' });
    }
  });
}

/**
 * Assembles the full problem context for NeetCode.
 *
 * @returns {Promise<object>}
 */
async function extractFullContext() {
  log.info('Extracting context on NeetCode');
  const title       = extractTitle();
  const description = extractDescription();
  const problemUrl  = window.location.href;
  const { code, language } = await extractCodeViaInjectedScript();
  const urlMatch   = window.location.pathname.match(/\/problems\/([^/]+)/);
  const slug       = urlMatch ? urlMatch[1].toLowerCase() : 'unknown';
  const problemKey = `neetcode::${slug}`;
  return { title, platform: PLATFORM_NEETCODE, description, language, code, problemUrl, problemKey };
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG.REQUEST_CODE_EXTRACTION) return false;
  log.info('REQUEST_CODE_EXTRACTION received on NeetCode');

  extractFullContext()
    .then(ctx => sendResponse({ type: MSG.CODE_EXTRACTED, success: true, payload: ctx }))
    .catch(err => sendResponse({ type: MSG.CODE_EXTRACTED, success: false, error: err.message, payload: null }));

  return true;
});

log.info('NeetCode adapter loaded');
window.__dsaMentorPlatform     = PLATFORM_NEETCODE;
window.__dsaMentorAdapterReady = true;

} // end hostname guard
