/**
 * @fileoverview LeetCode platform adapter for the DSA Mentor extension.
 *
 * CRITICAL: This file is a content script. It MUST NOT use ES module
 * imports (import/export). All constants and helpers are inlined here.
 * The manifest loads this file via the content_scripts[].js array, so it
 * shares the same isolated world as platform-init.js.
 *
 * Responsibilities:
 *   1. Extract the problem title from the LeetCode problem page DOM
 *   2. Extract the problem description text
 *   3. Coordinate with the injected page-world script to get Monaco editor content
 *   4. Listen for REQUEST_CODE_EXTRACTION messages from the service worker
 *      and respond with the full problem context
 *
 * LeetCode DOM notes (as of 2025):
 *   - Problem title: .text-title-large a, or [data-cy="question-title"]
 *   - Description:   .elfjS (main content div), or #problem-statement
 *   - Language:      extracted by injected-script.js via Monaco API
 *   - Editor code:   extracted by injected-script.js via Monaco API
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   content-scripts/leetcode-adapter
 */

// ---------------------------------------------------------------------------
// Inlined constants (cannot import from constants.js in content scripts)
// ---------------------------------------------------------------------------

/** @type {string} */
const PLATFORM_LEETCODE = 'leetcode';

/**
 * Message type constants mirroring MessageType in constants.js.
 * Duplicated here because content scripts cannot use ES module imports.
 * @type {object}
 */
const MSG = {
  REQUEST_CODE_EXTRACTION: 'REQUEST_CODE_EXTRACTION',
  CODE_EXTRACTED: 'CODE_EXTRACTED',
};

// ---------------------------------------------------------------------------
// Inlined minimal logger
// ---------------------------------------------------------------------------

const log = {
  info:  (...a) => console.log('[DSA Mentor][INFO][LeetCode]',  ...a),
  debug: (...a) => console.debug('[DSA Mentor][DEBUG][LeetCode]', ...a),
  warn:  (...a) => console.warn('[DSA Mentor][WARN][LeetCode]',  ...a),
  error: (...a) => console.error('[DSA Mentor][ERROR][LeetCode]', ...a),
};

// ---------------------------------------------------------------------------
// DOM Extraction Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the problem title from the LeetCode DOM.
 *
 * Tries multiple selectors in order to handle both the 2024 and 2025 page
 * layouts. LeetCode frequently ships redesigns, so the fallback chain is
 * important for long-term resilience.
 *
 * @returns {string} Problem title, or 'Unknown Problem' if not found.
 */
function extractProblemTitle() {
  const selectors = [
    // 2025 layout: title inside a <div class="text-title-large"> with an <a>
    '.text-title-large a',
    // 2024 layout: data-cy attribute on the title element
    '[data-cy="question-title"]',
    // Older layout
    '.question-title',
    // Generic heading fallback
    'h4[class*="title"]',
    'h1',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = el.textContent.trim();
      if (text) {
        log.debug('Problem title found via selector:', selector, '→', text);
        return text;
      }
    }
  }

  // URL-based fallback: LeetCode problem URLs contain the problem slug
  // e.g. https://leetcode.com/problems/two-sum/ → "Two Sum"
  const urlMatch = window.location.pathname.match(/\/problems\/([^/]+)/);
  if (urlMatch) {
    const slug = urlMatch[1]
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    log.debug('Problem title extracted from URL slug:', slug);
    return slug;
  }

  log.warn('Could not extract problem title from DOM or URL');
  return 'Unknown Problem';
}

/**
 * Extracts the problem description from the LeetCode DOM.
 *
 * LeetCode renders descriptions in a rich content div. We extract the text
 * content only (stripping HTML tags) because the AI model does not need
 * the HTML formatting — clean text produces cleaner prompt context.
 *
 * @returns {string} Problem description text, or empty string if not found.
 */
function extractProblemDescription() {
  const selectors = [
    // 2025: main description container with dynamically generated class
    '.elfjS',
    // 2024: problem statement wrapper
    '#problem-statement',
    // Content div approach
    '[data-track-load="description_content"]',
    // Generic content area
    '.content__1Y2H',
    '.question-content',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      // Extract only text nodes — strip HTML tags, code highlighting spans, etc.
      const text = el.innerText || el.textContent;
      if (text && text.trim().length > 20) { // Sanity check: at least 20 chars
        log.debug('Problem description found via selector:', selector);
        // Normalize whitespace: collapse multiple newlines/spaces
        return text.trim().replace(/\n{3,}/g, '\n\n');
      }
    }
  }

  log.warn('Could not extract problem description');
  return 'Problem description not available.';
}

/**
 * Returns the full URL of the current LeetCode problem page.
 *
 * @returns {string} The current page URL.
 */
function getProblemUrl() {
  return window.location.href;
}

/**
 * Derives a stable problem key of the form `leetcode::problem-slug`.
 * Used to group multiple chat sessions under the same problem in the dashboard.
 *
 * @returns {string} e.g. "leetcode::two-sum"
 */
function getProblemKey() {
  const match = window.location.pathname.match(/\/problems\/([^/]+)/);
  const slug  = match ? match[1].toLowerCase() : 'unknown';
  return `leetcode::${slug}`;
}

// ---------------------------------------------------------------------------
// Monaco Code Extraction via Injected Script
// ---------------------------------------------------------------------------

/**
 * Injects the injected-script.js into the page's MAIN world and waits
 * for the extracted code to come back via window.postMessage.
 *
 * Why inject a script instead of calling chrome.scripting directly?
 * Content scripts run in an isolated world and cannot access window.monaco.
 * The service worker injects injected-script.js with world: 'MAIN', but
 * in this adapter we also need the result synchronously within the content
 * script context. We use a two-step approach:
 *   1. Create a <script> tag pointing to the extension's injected-script.js URL
 *      (the URL is constructed using chrome.runtime.getURL)
 *   2. Listen for the postMessage response
 *
 * @returns {Promise<{ code: string, language: string }>}
 *   Resolves with extracted code and language, or fallback empty values.
 */
function extractCodeViaInjectedScript() {
  return new Promise((resolve) => {
    // Timeout: if injected script doesn't respond in 5 seconds, use empty values
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', messageHandler);
      log.warn('Injected script did not respond within 5 seconds');
      resolve({ code: '', language: 'unknown' });
    }, 5000);

    // Listen for the result posted back by injected-script.js
    function messageHandler(event) {
      // Only process messages from the same page (same origin)
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'DSA_MENTOR_CODE_RESULT') return;

      clearTimeout(timeoutId);
      window.removeEventListener('message', messageHandler);

      if (event.data.success) {
        log.info('Code extracted via strategy:', event.data.strategy, '| language:', event.data.language);
        resolve({ code: event.data.code, language: event.data.language });
      } else {
        log.warn('Injected script extraction failed:', event.data.error);
        resolve({ code: '', language: 'unknown' });
      }
    }

    window.addEventListener('message', messageHandler);

    // Inject the script into the page world by creating a <script> element.
    // chrome.runtime.getURL converts the relative path to the full extension URL.
    // This is the approach for content scripts; the service worker uses
    // chrome.scripting.executeScript with world: 'MAIN' for its flow.
    try {
      const scriptUrl = chrome.runtime.getURL('injected/injected-script.js');
      const scriptEl = document.createElement('script');
      scriptEl.src = scriptUrl;
      scriptEl.type = 'text/javascript';

      // Remove script element after it loads to keep the DOM clean
      scriptEl.onload = () => scriptEl.remove();
      scriptEl.onerror = () => {
        scriptEl.remove();
        log.warn('Failed to inject extraction script');
        clearTimeout(timeoutId);
        window.removeEventListener('message', messageHandler);
        resolve({ code: '', language: 'unknown' });
      };

      // Append to head so it executes in the page context
      (document.head || document.documentElement).appendChild(scriptEl);
    } catch (error) {
      log.error('Script injection failed', error);
      clearTimeout(timeoutId);
      window.removeEventListener('message', messageHandler);
      resolve({ code: '', language: 'unknown' });
    }
  });
}

// ---------------------------------------------------------------------------
// Full Problem Context Assembly
// ---------------------------------------------------------------------------

/**
 * Assembles the complete problem context by extracting all available data.
 *
 * This is the main entry point for a code extraction request. It gathers
 * DOM-accessible data synchronously, then asynchronously fetches the code
 * from the Monaco editor via the injected script.
 *
 * @returns {Promise<{
 *   title: string,
 *   platform: string,
 *   description: string,
 *   language: string,
 *   code: string,
 *   problemUrl: string
 * }>} Complete problem context ready for the AI prompt builder.
 */
async function extractFullProblemContext() {
  log.info('Starting problem context extraction on LeetCode');

  // Extract DOM-based fields synchronously — these are fast
  const title       = extractProblemTitle();
  const description = extractProblemDescription();
  const problemUrl  = getProblemUrl();

  // Extract code and language asynchronously via page-world injection
  const { code, language } = await extractCodeViaInjectedScript();

  const context = {
    title,
    platform: PLATFORM_LEETCODE,
    description,
    language,
    code,
    problemUrl,
    problemKey: getProblemKey(),
  };

  log.info('Problem context assembled', {
    title,
    language,
    codeLength: code.length,
    descriptionLength: description.length,
  });

  return context;
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

/**
 * Listens for REQUEST_CODE_EXTRACTION messages from the extension service worker.
 *
 * When the user clicks "Extract Code" in the side panel, the service worker
 * sends this message to the active tab's content scripts. We respond with
 * the full problem context.
 *
 * The listener returns `true` to keep the message channel open for the
 * async response — required for async sendResponse patterns.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== MSG.REQUEST_CODE_EXTRACTION) return false;

  log.info('Received REQUEST_CODE_EXTRACTION, extracting problem context...');

  // Execute async extraction and respond when done
  extractFullProblemContext()
    .then((context) => {
      sendResponse({
        type: MSG.CODE_EXTRACTED,
        success: true,
        payload: context,
      });
    })
    .catch((error) => {
      log.error('extractFullProblemContext threw:', error);
      sendResponse({
        type: MSG.CODE_EXTRACTED,
        success: false,
        error: error.message || 'Unknown extraction error',
        payload: null,
      });
    });

  // Return true to signal async response
  return true;
});

// ---------------------------------------------------------------------------
// Adapter Initialization
// ---------------------------------------------------------------------------

log.info('LeetCode adapter loaded on', window.location.href);

// Signal to platform-init.js (if needed) that this adapter is active
window.__dsaMentorPlatform  = PLATFORM_LEETCODE;
window.__dsaMentorAdapterReady = true;
