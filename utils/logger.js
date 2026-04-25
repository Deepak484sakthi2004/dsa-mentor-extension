/**
 * @fileoverview Lightweight, levelled logger for the DSA Mentor extension.
 *
 * All extension contexts (service worker, content scripts, side panel,
 * dashboard) import the singleton exported from this module so that log
 * formatting is consistent and debug output can be suppressed in production
 * by flipping a single flag.
 *
 * Why a custom logger rather than plain console.*?
 *   - Uniform "[DSA Mentor][LEVEL]" prefix makes extension logs instantly
 *     filterable in Chrome DevTools by typing "DSA Mentor" in the console
 *     filter field.
 *   - The `debug` level is a no-op when `DEBUG = false`, eliminating
 *     performance overhead from verbose trace logs in production builds
 *     without requiring a build step.
 *   - Centralised location means adding structured logging (e.g. sending
 *     errors to a remote endpoint) requires changing only this file.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   utils/logger
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Master switch for debug-level logging.
 *
 * Set to `true` during development; flip to `false` before publishing to the
 * Chrome Web Store. In production, `debug()` calls compile to effectively
 * nothing — no string concatenation, no console call.
 *
 * @type {boolean}
 */
const DEBUG = true;

/**
 * Prefix applied to every log message so extension output is immediately
 * identifiable in a busy DevTools console shared with page scripts.
 *
 * @type {string}
 */
const LOG_PREFIX = '[DSA Mentor]';

// ---------------------------------------------------------------------------
// Log Level Definitions
// ---------------------------------------------------------------------------

/**
 * Available log levels in ascending severity order.
 *
 * @readonly
 * @enum {string}
 */
const LogLevel = Object.freeze({
  DEBUG: 'DEBUG',
  INFO:  'INFO',
  WARN:  'WARN',
  ERROR: 'ERROR',
});

// ---------------------------------------------------------------------------
// Logger Class
// ---------------------------------------------------------------------------

/**
 * Levelled logger that prefixes every message with `[DSA Mentor][LEVEL]`.
 *
 * Consumers should import the default singleton export rather than
 * instantiating this class directly — a single instance ensures consistent
 * behaviour across the module graph.
 *
 * @example
 * import logger from '../utils/logger.js';
 *
 * logger.info('Service worker started');
 * logger.debug('Extracted code', { lines: code.split('\n').length });
 * logger.error('AI API call failed', error);
 */
class Logger {
  /**
   * Creates a Logger instance.
   *
   * @param {boolean} [debugEnabled=true] - Whether debug() calls produce output.
   */
  constructor(debugEnabled = true) {
    /**
     * Whether debug-level output is active.
     * @type {boolean}
     * @private
     */
    this._debugEnabled = debugEnabled;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Builds the log-line prefix: `[DSA Mentor][LEVEL]`.
   *
   * @param {string} level - One of the {@link LogLevel} values.
   * @returns {string} Formatted prefix string.
   * @private
   */
  _prefix(level) {
    return `${LOG_PREFIX}[${level}]`;
  }

  // -------------------------------------------------------------------------
  // Public logging methods
  // -------------------------------------------------------------------------

  /**
   * Emits a DEBUG-level message.
   *
   * This method is a no-op when the logger was constructed with
   * `debugEnabled = false`, which is the intended production behaviour.
   * Use this for verbose trace information (e.g. raw DOM content,
   * intermediate extraction steps) that should never appear in production.
   *
   * @param {string} message - Primary log message.
   * @param {...*} args - Additional values passed directly to console.debug
   *   (objects are pretty-printed by DevTools).
   * @returns {void}
   *
   * @example
   * logger.debug('Monaco editor instance found', editorInstance);
   */
  debug(message, ...args) {
    // Early-exit to avoid any string/object processing overhead
    if (!this._debugEnabled) return;
    console.debug(this._prefix(LogLevel.DEBUG), message, ...args);
  }

  /**
   * Emits an INFO-level message for normal operational events
   * (e.g. "adapter loaded", "AI response received").
   *
   * @param {string} message - Primary log message.
   * @param {...*} args - Additional values to log.
   * @returns {void}
   *
   * @example
   * logger.info('Platform detected', { platform: 'leetcode' });
   */
  info(message, ...args) {
    console.info(this._prefix(LogLevel.INFO), message, ...args);
  }

  /**
   * Emits a WARN-level message for recoverable conditions that may indicate
   * a problem (e.g. expected DOM element not found, using a fallback path).
   *
   * @param {string} message - Primary log message.
   * @param {...*} args - Additional values to log.
   * @returns {void}
   *
   * @example
   * logger.warn('Could not find problem description element, using empty string');
   */
  warn(message, ...args) {
    console.warn(this._prefix(LogLevel.WARN), message, ...args);
  }

  /**
   * Emits an ERROR-level message for unrecoverable failures that the user
   * or developer should be aware of (e.g. AI API returned 401, storage
   * write failed).
   *
   * Pass the raw `Error` object as a second argument so DevTools can display
   * the full stack trace.
   *
   * @param {string} message - Human-readable description of the failure.
   * @param {...*} args - Additional values; conventionally the caught `Error`.
   * @returns {void}
   *
   * @example
   * try {
   *   await callAI();
   * } catch (error) {
   *   logger.error('AI request failed', error);
   * }
   */
  error(message, ...args) {
    console.error(this._prefix(LogLevel.ERROR), message, ...args);
  }

  // -------------------------------------------------------------------------
  // Runtime configuration
  // -------------------------------------------------------------------------

  /**
   * Enables or disables debug output at runtime without recreating the
   * instance. Useful for reading the `debugMode` setting from storage after
   * the extension loads.
   *
   * @param {boolean} enabled - Pass `true` to enable debug output.
   * @returns {void}
   *
   * @example
   * const { debugMode } = await StorageManager.getSettings();
   * logger.setDebugMode(debugMode);
   */
  setDebugMode(enabled) {
    this._debugEnabled = Boolean(enabled);
  }
}

// ---------------------------------------------------------------------------
// Singleton Export
// ---------------------------------------------------------------------------

/**
 * Shared Logger singleton.
 *
 * All extension modules should import this instance rather than constructing
 * their own, so that a single call to `logger.setDebugMode(false)` silences
 * debug output everywhere.
 *
 * @type {Logger}
 */
const logger = new Logger(DEBUG);

export default logger;

// Named export for consumers that prefer it
export { Logger, LogLevel };
