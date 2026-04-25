/**
 * @fileoverview DOM helper utilities for content script adapters.
 *
 * LeetCode and other DSA platforms are single-page applications that load
 * content asynchronously after the initial HTML is parsed. Content scripts
 * run at `document_idle`, but problem titles, descriptions, and editor
 * instances may not yet exist in the DOM at that point. These utilities
 * provide resilient element queries that wait for the DOM to settle before
 * returning, preventing race conditions in the platform adapters.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   utils/dom-utils
 */

// ---------------------------------------------------------------------------
// Element Waiting
// ---------------------------------------------------------------------------

/**
 * Waits for a CSS selector to match a DOM element, polling via MutationObserver.
 *
 * Why MutationObserver instead of setInterval?
 *   MutationObserver fires synchronously after each batch of DOM mutations,
 *   so it responds immediately when the element appears rather than waiting
 *   for the next timer tick. This makes it ~10x more responsive than a
 *   100ms polling interval while using less CPU when the element is slow to appear.
 *
 * @param {string}  selector - CSS selector to wait for (e.g. '.view-lines').
 * @param {number}  [timeout=10000] - Maximum milliseconds to wait before rejecting.
 * @param {Element} [root=document.body] - DOM subtree to observe. Narrowing the
 *   root improves performance on large DOMs.
 * @returns {Promise<Element>} Resolves with the first matching element.
 * @throws {Error} Rejects if the element does not appear within `timeout` ms.
 *
 * @example
 * // Wait for the Monaco editor container to appear before extracting code
 * try {
 *   const editorEl = await waitForElement('.view-lines', 8000);
 *   console.log('Editor ready', editorEl);
 * } catch (e) {
 *   console.warn('Editor never appeared', e.message);
 * }
 */
export function waitForElement(selector, timeout = 10000, root = document.body) {
  return new Promise((resolve, reject) => {
    // Fast path: element already exists in the DOM when we're called
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    // Timeout guard — reject if the element never appears
    const timeoutId = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElement: "${selector}" not found within ${timeout}ms`));
    }, timeout);

    // MutationObserver watches the root subtree for any DOM change, then
    // re-checks whether our selector now matches
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        clearTimeout(timeoutId);
        observer.disconnect();
        resolve(element);
      }
    });

    // subtree: true — watch all descendants, not just direct children
    // childList: true — detect added/removed nodes
    // attributes: true — detect class changes that might make a hidden el visible
    observer.observe(root || document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Text Extraction
// ---------------------------------------------------------------------------

/**
 * Safely extracts text content from a DOM element matched by a CSS selector.
 *
 * Returns an empty string (rather than throwing) if the element is absent.
 * The returned text is trimmed to remove leading/trailing whitespace that
 * commonly appears in LeetCode's rendered problem descriptions.
 *
 * @param {string}  selector - CSS selector to query.
 * @param {Element} [context=document] - Element to query within.
 * @returns {string} Trimmed text content, or empty string if not found.
 *
 * @example
 * const title = getTextContent('[data-cy="question-title"]');
 * // Returns "Two Sum" or "" if selector not found
 */
export function getTextContent(selector, context = document) {
  const element = context.querySelector(selector);
  return element ? element.textContent.trim() : '';
}

/**
 * Tries a list of CSS selectors in order and returns the first match's text.
 *
 * Useful for platform adapters that need to handle multiple DOM layouts
 * (e.g. LeetCode redesigned their problem page in 2024 and again in 2025,
 * so we keep both old and new selectors for resilience).
 *
 * @param {string[]} selectors - Selectors to try, in priority order.
 * @param {Element}  [context=document] - Element to query within.
 * @returns {string} Text content of the first matching element, or ''.
 *
 * @example
 * const title = getTextContentFallback([
 *   '.text-title-large',           // 2025 layout
 *   '[data-cy="question-title"]',  // 2024 layout
 *   '.question-title',             // legacy layout
 * ]);
 */
export function getTextContentFallback(selectors, context = document) {
  for (const selector of selectors) {
    const text = getTextContent(selector, context);
    if (text) return text;
  }
  return '';
}

/**
 * Extracts visible text from all elements matching a selector, joined with newlines.
 *
 * Used for multi-element content like problem description paragraphs where
 * a single querySelector would only return the first element.
 *
 * @param {string}  selector - CSS selector to query (querySelectorAll).
 * @param {Element} [context=document] - Element to query within.
 * @returns {string} Joined text from all matching elements.
 */
export function getAllTextContent(selector, context = document) {
  const elements = context.querySelectorAll(selector);
  return Array.from(elements)
    .map(el => el.textContent.trim())
    .filter(Boolean)
    .join('\n');
}
