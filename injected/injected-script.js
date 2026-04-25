/**
 * @fileoverview Page-context script for extracting Monaco Editor content.
 *
 * IMPORTANT: This script runs in world: 'MAIN' (the page's JavaScript context),
 * NOT the extension's isolated content script world. That is intentional:
 * content scripts cannot access `window.monaco` because Chrome isolates the
 * extension JS environment from the page's JS environment. By injecting this
 * script into the page world, we get direct access to the Monaco API.
 *
 * Communication with the content script uses window.postMessage because
 * direct function calls across the world boundary are impossible.
 * The content script listens for messages with type 'DSA_MENTOR_CODE_RESULT'.
 *
 * Extraction strategy (in priority order):
 *   1. Monaco API  — window.monaco.editor.getModels()[0].getValue()
 *      Most reliable; gives the exact code string with correct whitespace.
 *   2. CodeMirror 6 — EditorView instance via DOM traversal
 *      NeetCode uses CodeMirror 6; accessed via the view's state.doc.
 *   3. DOM fallback — concatenate text from .view-lines spans
 *      Last resort; works even if the editor API is not accessible,
 *      but may have whitespace/indentation artifacts.
 *
 * No ES module imports — this file runs in the raw page context and cannot
 * reference extension URLs.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   injected/injected-script
 */

(function extractEditorContent() {
  // Guard: if we've already responded to an extraction request in this page
  // session, skip re-execution. The guard flag is reset by the content script
  // clearing window.__dsaMentorInjected before re-injecting.
  // NOTE: We do NOT use a persistent guard here because the service worker
  // may inject this script multiple times (once per "Extract Code" click).
  // Each injection should produce a fresh extraction result.

  // ---------------------------------------------------------------------------
  // Strategy 1: Monaco Editor API
  // ---------------------------------------------------------------------------

  /**
   * Attempts to extract code and language via the Monaco Editor JavaScript API.
   *
   * LeetCode embeds Monaco and exposes it on window.monaco. The models array
   * always has exactly one entry on problem pages — the user's solution file.
   *
   * @returns {{ code: string, language: string }|null} Extracted data, or null on failure.
   */
  function tryMonaco() {
    try {
      // window.monaco is the Monaco namespace; available on LeetCode problem pages
      if (typeof window.monaco === 'undefined') return null;

      const models = window.monaco.editor.getModels();
      if (!models || models.length === 0) return null;

      // Use the first model — on LeetCode there is always exactly one active model
      const activeModel = models[0];
      const code = activeModel.getValue();

      // getLanguageId() returns LeetCode-specific language IDs like 'python3',
      // 'cpp', 'javascript', 'java', etc.
      const language = activeModel.getLanguageId() || 'unknown';

      return { code, language };
    } catch (error) {
      // Monaco exists but something went wrong — fall through to next strategy
      console.warn('[DSA Mentor] Monaco extraction error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy 2: CodeMirror 6 (used by NeetCode)
  // ---------------------------------------------------------------------------

  /**
   * Attempts to extract code via CodeMirror 6's EditorView instance.
   *
   * CodeMirror 6 does not expose a global API — the EditorView instance is
   * attached to the DOM element as a private property. We reach it through
   * the `.cm-editor` element's `.__cmView` or `._view` property, which
   * CodeMirror sets internally.
   *
   * @returns {{ code: string, language: string }|null} Extracted data, or null on failure.
   */
  function tryCodeMirror6() {
    try {
      // CodeMirror 6 sets the EditorView on the .cm-editor DOM element
      const editorEl = document.querySelector('.cm-editor');
      if (!editorEl) return null;

      // The EditorView is attached as a non-enumerable property
      // Different CM6 builds use different property names
      const view = editorEl.cmView || editorEl._view || (function() {
        // Walk own properties to find the EditorView instance
        for (const key of Object.keys(editorEl)) {
          const val = editorEl[key];
          if (val && typeof val === 'object' && val.state && val.state.doc) {
            return val;
          }
        }
        return null;
      })();

      if (!view || !view.state) return null;

      const code = view.state.doc.toString();
      // Language cannot be reliably extracted from CM6 without knowing the compartment;
      // fall back to reading it from the UI language selector
      const language = detectLanguageFromUI() || 'unknown';

      return { code, language };
    } catch (error) {
      console.warn('[DSA Mentor] CodeMirror 6 extraction error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy 3: DOM text extraction fallback
  // ---------------------------------------------------------------------------

  /**
   * Extracts code by reading text from Monaco's .view-lines DOM elements.
   *
   * Monaco renders each code line as a separate <span> inside `.view-lines`.
   * Concatenating their text content gives the source code, though with
   * potential whitespace normalization artifacts.
   *
   * @returns {{ code: string, language: string }|null} Extracted data, or null on failure.
   */
  function tryDOMFallback() {
    try {
      // .view-lines is Monaco's line container — present even without API access
      const viewLines = document.querySelector('.view-lines');
      if (!viewLines) return null;

      // Each .view-line div contains one line of code; collect all and join
      const lineElements = viewLines.querySelectorAll('.view-line');
      if (lineElements.length === 0) return null;

      const code = Array.from(lineElements)
        .map(line => line.textContent)
        .join('\n');

      const language = detectLanguageFromUI() || 'unknown';

      return { code, language };
    } catch (error) {
      console.warn('[DSA Mentor] DOM fallback extraction error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Language Detection from UI
  // ---------------------------------------------------------------------------

  /**
   * Reads the currently selected language from the platform's language picker UI.
   *
   * Each platform shows the selected language in a different element:
   *   LeetCode: button with class containing "rounded" showing language name
   *   NeetCode: select element or button
   *
   * @returns {string} Normalized language string, or empty string if not found.
   */
  function detectLanguageFromUI() {
    // LeetCode 2024/2025: language appears in a button in the editor toolbar
    // The button text looks like "Python3" or "C++"
    const selectors = [
      // LeetCode's editor language button (various layouts)
      '[data-layout-path^="/"][class*="rounded"] button',
      '.editor-toolbar button[data-state]',
      // Try any button near the code editor that looks like a language name
      '.code-area button',
    ];

    // Common DSA language identifiers for validation
    const knownLanguages = [
      'python3', 'python', 'javascript', 'typescript', 'java', 'c++', 'cpp',
      'c', 'csharp', 'c#', 'go', 'rust', 'swift', 'kotlin', 'ruby', 'scala',
      'php', 'dart', 'r',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim().toLowerCase();
        if (knownLanguages.some(lang => text.includes(lang))) {
          // Normalize: remove spaces, lowercase
          return text.replace(/\s+/g, '').toLowerCase();
        }
      }
    }

    // LeetCode often stores the language in a select or data attribute
    const selectEl = document.querySelector('select[name="lang"], select[class*="language"]');
    if (selectEl) {
      return selectEl.value.toLowerCase();
    }

    return '';
  }

  // ---------------------------------------------------------------------------
  // Main Extraction Logic
  // ---------------------------------------------------------------------------

  /**
   * Runs all extraction strategies in priority order and posts the result
   * back to the content script via window.postMessage.
   *
   * The message format is:
   * {
   *   type: 'DSA_MENTOR_CODE_RESULT',
   *   success: boolean,
   *   code: string,
   *   language: string,
   *   strategy: string  // which extraction method succeeded, for debugging
   * }
   */
  function runExtraction() {
    let result = null;
    let strategy = 'none';

    // Try each strategy in order; stop at first success
    result = tryMonaco();
    if (result) {
      strategy = 'monaco';
    }

    if (!result) {
      result = tryCodeMirror6();
      if (result) strategy = 'codemirror6';
    }

    if (!result) {
      result = tryDOMFallback();
      if (result) strategy = 'dom-fallback';
    }

    // Post result back to the content script (which listens for this message)
    // Use '*' as targetOrigin because we don't know the exact LeetCode origin
    // variant (some users use us.leetcode.com). The content script validates
    // the message type before acting on it.
    if (result) {
      window.postMessage({
        type: 'DSA_MENTOR_CODE_RESULT',
        success: true,
        code: result.code,
        language: result.language,
        strategy,
      }, '*');
    } else {
      window.postMessage({
        type: 'DSA_MENTOR_CODE_RESULT',
        success: false,
        code: '',
        language: 'unknown',
        strategy: 'none',
        error: 'No editor found on this page. Make sure you are on a problem page.',
      }, '*');
    }
  }

  // Run extraction immediately — the service worker injects this script only
  // when an extraction is requested, so it should run right away.
  runExtraction();

})();
