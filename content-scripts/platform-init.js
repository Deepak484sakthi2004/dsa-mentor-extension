/**
 * @fileoverview Content script entry point — detects the active DSA platform
 * and bootstraps platform-specific adapter logic.
 *
 * CRITICAL: This file is a content script. NO ES module imports allowed.
 * All adapters are loaded by having them listed AFTER this file in the
 * manifest content_scripts array, or inlined here.
 *
 * Architecture note:
 *   Because content scripts share the same isolated JavaScript world when
 *   loaded from the same manifest entry, platform-init.js and the adapter
 *   files (leetcode-adapter.js etc.) all run as plain scripts in the same
 *   scope. The manifest loads them in declared order:
 *     1. platform-init.js  (runs first — detects platform)
 *     2. leetcode-adapter.js, neetcode-adapter.js, striver-adapter.js
 *        (run after — register their message listeners)
 *   Each adapter guards itself with a hostname check so only the correct
 *   adapter activates on each platform.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   content-scripts/platform-init
 */

// ---------------------------------------------------------------------------
// Inlined Platform Constants
// ---------------------------------------------------------------------------

/** @type {object} Platform identifier strings */
const Platform = {
  LEETCODE: 'leetcode',
  NEETCODE: 'neetcode',
  STRIVER:  'striver',
  UNKNOWN:  'unknown'
};

/** @type {object} Hostname fragments mapped to platform identifiers */
const PLATFORM_URLS = {
  [Platform.LEETCODE]: 'leetcode.com',
  [Platform.NEETCODE]: 'neetcode.io',
  [Platform.STRIVER]:  'takeuforward.org',
};

// ---------------------------------------------------------------------------
// Inlined Minimal Logger
// ---------------------------------------------------------------------------

const logger = {
  info:  (...a) => console.log('[DSA Mentor][INFO]',   ...a),
  debug: (...a) => console.debug('[DSA Mentor][DEBUG]', ...a),
  warn:  (...a) => console.warn('[DSA Mentor][WARN]',   ...a),
  error: (...a) => console.error('[DSA Mentor][ERROR]', ...a),
};

// ---------------------------------------------------------------------------
// Platform Detection
// ---------------------------------------------------------------------------

/**
 * Identifies the current platform by matching window.location.hostname
 * against the known hostname fragments.
 *
 * Uses String.includes() rather than exact equality to handle subdomain
 * variations (e.g. "us.leetcode.com" still contains "leetcode.com").
 *
 * @returns {string} One of the Platform enum values.
 */
function detectPlatform() {
  const hostname = window.location.hostname;
  for (const [platform, urlFragment] of Object.entries(PLATFORM_URLS)) {
    if (hostname.includes(urlFragment)) {
      return platform;
    }
  }
  return Platform.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

(function init() {
  const platform = detectPlatform();
  logger.info('Platform init | hostname:', window.location.hostname, '| platform:', platform);

  if (platform === Platform.UNKNOWN) {
    logger.debug('No matching platform — content script idle');
    return;
  }

  // Expose the detected platform on window so the injected script and
  // other extension contexts can read it without re-parsing the URL
  window.__dsaMentorPlatform = platform;

  logger.info('Platform detected:', platform, '| Adapter files will activate via manifest ordering');

  // The adapter files (leetcode-adapter.js, neetcode-adapter.js, striver-adapter.js)
  // are loaded by the manifest AFTER this file in the same content_scripts entry.
  // Each adapter self-guards using window.location.hostname, so only the
  // correct one registers its chrome.runtime.onMessage listener.
})();
