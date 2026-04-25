/**
 * @fileoverview Striver/TakeUForward platform adapter for the DSA Mentor extension.
 *
 * CRITICAL: No ES module imports — this is a content script.
 *
 * TakeUForward (takeuforward.org) hosts Striver's DSA playlists.
 * The site embeds an online IDE (typically Judge0-powered) for problem solving.
 * Problem titles and descriptions are in standard HTML elements.
 *
 * DOM notes (as of 2025):
 *   - Problem title: h1 or .entry-title or the page <title>
 *   - Description:   .entry-content, .problem-body, or article content
 *   - Editor:        CodeMirror (classic or 6) or Monaco depending on embed
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   content-scripts/striver-adapter
 */

// Guard: only activate on TakeUForward
if (!window.location.hostname.includes('takeuforward.org')) {
  // Not Striver — no-op
} else {

// ---------------------------------------------------------------------------
// Inlined Constants
// ---------------------------------------------------------------------------

const PLATFORM_STRIVER = 'striver';

const MSG = {
  REQUEST_CODE_EXTRACTION: 'REQUEST_CODE_EXTRACTION',
  CODE_EXTRACTED: 'CODE_EXTRACTED',
};

// ---------------------------------------------------------------------------
// Inlined Logger
// ---------------------------------------------------------------------------

const log = {
  info:  (...a) => console.log('[DSA Mentor][INFO][Striver]',   ...a),
  debug: (...a) => console.debug('[DSA Mentor][DEBUG][Striver]', ...a),
  warn:  (...a) => console.warn('[DSA Mentor][WARN][Striver]',   ...a),
  error: (...a) => console.error('[DSA Mentor][ERROR][Striver]', ...a),
};

// ---------------------------------------------------------------------------
// DOM Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the problem/article title from TakeUForward.
 *
 * @returns {string}
 */
function extractTitle() {
  const selectors = [
    'h1.entry-title',
    'h1.wp-block-heading',
    'article h1',
    'h1',
    '.problem-title',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }

  // Title element fallback
  const docTitle = document.title.replace('- TakeUForward', '').replace('| takeUforward', '').trim();
  return docTitle || 'Unknown Problem';
}

/**
 * Extracts the problem description / article content from TakeUForward.
 *
 * TakeUForward posts are WordPress articles; the content is in .entry-content.
 *
 * @returns {string}
 */
function extractDescription() {
  const selectors = [
    '.entry-content',
    'article .wp-block-group',
    '.problem-statement',
    'article',
    '.post-content',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text.length > 30) {
        // Truncate very long articles to first 3000 chars for token efficiency
        return text.slice(0, 3000).replace(/\n{3,}/g, '\n\n');
      }
    }
  }

  return 'Problem description not available.';
}

/**
 * Extracts code via injected script (handles embedded Monaco or CodeMirror IDEs).
 *
 * @returns {Promise<{code: string, language: string}>}
 */
function extractCodeViaInjectedScript() {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ code: '', language: 'unknown' });
    }, 5000);

    function handler(event) {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'DSA_MENTOR_CODE_RESULT') return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve(event.data.success
        ? { code: event.data.code, language: event.data.language }
        : { code: '', language: 'unknown' }
      );
    }

    window.addEventListener('message', handler);

    try {
      const scriptEl = document.createElement('script');
      scriptEl.src   = chrome.runtime.getURL('injected/injected-script.js');
      scriptEl.onload  = () => scriptEl.remove();
      scriptEl.onerror = () => {
        scriptEl.remove();
        clearTimeout(timeoutId);
        window.removeEventListener('message', handler);
        resolve({ code: '', language: 'unknown' });
      };
      (document.head || document.documentElement).appendChild(scriptEl);
    } catch (err) {
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve({ code: '', language: 'unknown' });
    }
  });
}

/**
 * Assembles the full problem context for Striver/TakeUForward.
 *
 * @returns {Promise<object>}
 */
async function extractFullContext() {
  log.info('Extracting context on TakeUForward/Striver');
  const title       = extractTitle();
  const description = extractDescription();
  const problemUrl  = window.location.href;
  const { code, language } = await extractCodeViaInjectedScript();
  const urlMatch   = window.location.pathname.match(/\/([^/]+)\/?$/);
  const slug       = urlMatch ? urlMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'unknown';
  const problemKey = `striver::${slug}`;
  return { title, platform: PLATFORM_STRIVER, description, language, code, problemUrl, problemKey };
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG.REQUEST_CODE_EXTRACTION) return false;
  log.info('REQUEST_CODE_EXTRACTION received on Striver');

  extractFullContext()
    .then(ctx => sendResponse({ type: MSG.CODE_EXTRACTED, success: true, payload: ctx }))
    .catch(err => sendResponse({ type: MSG.CODE_EXTRACTED, success: false, error: err.message, payload: null }));

  return true;
});

log.info('Striver adapter loaded');
window.__dsaMentorPlatform     = PLATFORM_STRIVER;
window.__dsaMentorAdapterReady = true;

} // end hostname guard
