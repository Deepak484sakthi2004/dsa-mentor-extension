/**
 * @fileoverview Shared constants for the DSA Mentor extension.
 *
 * This module is the single source of truth for all magic strings, enums,
 * and default values used across the extension. Importing from here
 * (rather than scattering literals throughout the codebase) means a
 * rename or new platform only ever requires one file change.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   utils/constants
 */

// ---------------------------------------------------------------------------
// Message Types
// ---------------------------------------------------------------------------

/**
 * Typed message-passing schema for chrome.runtime.sendMessage / onMessage.
 *
 * Every message sent between the content scripts, side panel, and service
 * worker MUST use one of these types as the `type` field. This prevents
 * stringly-typed bugs and makes message routing in the service worker
 * trivially enumerable.
 *
 * @readonly
 * @enum {string}
 *
 * @example
 * // Sending a hint request from the side panel:
 * chrome.runtime.sendMessage({ type: MessageType.REQUEST_HINT, payload: { ... } });
 */
export const MessageType = Object.freeze({
  /** Side panel → service worker: ask the active content script for current code */
  REQUEST_CODE_EXTRACTION: 'REQUEST_CODE_EXTRACTION',

  /** Content script → side panel: the extracted code, problem title, and language */
  CODE_EXTRACTED: 'CODE_EXTRACTED',

  /** Side panel → service worker: send user message + context to AI provider */
  REQUEST_HINT: 'REQUEST_HINT',

  /** Service worker → side panel: successful AI response text */
  HINT_RESPONSE: 'HINT_RESPONSE',

  /** Service worker → side panel: AI call failed — includes a user-friendly error */
  HINT_ERROR: 'HINT_ERROR',

  /** Side panel → service worker: persist a completed conversation turn */
  SAVE_CONVERSATION: 'SAVE_CONVERSATION',

  /** Dashboard → service worker: fetch all stored conversations */
  GET_CONVERSATIONS: 'GET_CONVERSATIONS',

  /** Service worker → dashboard: full conversation list payload */
  CONVERSATIONS_LIST: 'CONVERSATIONS_LIST',

  /** Any context → service worker: update active AI provider / model / key */
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  /** Any context → service worker: retrieve current settings */
  GET_SETTINGS: 'GET_SETTINGS',

  /** Service worker → any context: current settings payload */
  SETTINGS_RESPONSE: 'SETTINGS_RESPONSE',
});

// ---------------------------------------------------------------------------
// AI Provider Identifiers
// ---------------------------------------------------------------------------

/**
 * Canonical identifiers for AI providers.
 *
 * The AIClientFactory uses these values to select the correct client
 * implementation. The `activeProvider` field in storage must always be
 * one of these values — validated before saving.
 *
 * @readonly
 * @enum {string}
 */
export const AIProvider = Object.freeze({
  CLAUDE: 'claude',
  OPENAI: 'openai',
  GEMINI: 'gemini',
});

// ---------------------------------------------------------------------------
// Platform Identifiers
// ---------------------------------------------------------------------------

/**
 * Canonical identifiers for the DSA platforms the extension supports.
 *
 * Content script adapters set `window.__dsaMentorPlatform` to one of these
 * values during initialisation so the side panel knows which platform is
 * active without re-parsing the URL.
 *
 * @readonly
 * @enum {string}
 */
export const Platform = Object.freeze({
  LEETCODE: 'leetcode',
  NEETCODE: 'neetcode',
  STRIVER: 'striver',
  /** Returned when the current page does not match any supported platform. */
  UNKNOWN: 'unknown',
});

// ---------------------------------------------------------------------------
// Platform URL Patterns
// ---------------------------------------------------------------------------

/**
 * Hostname patterns used to identify the active platform.
 *
 * Keys match the values of the {@link Platform} enum. The content script
 * platform-init.js tests `window.location.hostname` against these strings
 * using `String.prototype.includes()` for resilience against subdomain
 * variations (e.g. `us.leetcode.com`).
 *
 * @type {Record<string, string>}
 */
export const PLATFORM_URLS = Object.freeze({
  [Platform.LEETCODE]: 'leetcode.com',
  [Platform.NEETCODE]: 'neetcode.io',
  [Platform.STRIVER]: 'takeuforward.org',
});

// ---------------------------------------------------------------------------
// Model Catalogue
// ---------------------------------------------------------------------------

/**
 * Available models per provider.
 *
 * The UI model-switcher is populated from this catalogue so that adding a
 * newly-released model only requires updating this constant — no UI code
 * changes needed.
 *
 * @type {Record<string, Array<{id: string, label: string}>>}
 */
export const AI_MODELS = Object.freeze({
  [AIProvider.CLAUDE]: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (fast)' },
    { id: 'claude-opus-4', label: 'Claude Opus 4 (powerful)' },
  ],
  [AIProvider.OPENAI]: [
    { id: 'gpt-4o', label: 'GPT-4o (recommended)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (fast)' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  [AIProvider.GEMINI]: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (recommended)' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (fast)' },
  ],
});

// ---------------------------------------------------------------------------
// Default Settings
// ---------------------------------------------------------------------------

/**
 * Default extension settings written to chrome.storage.local on first install.
 *
 * API keys are intentionally empty strings — the user must supply their own.
 * These values are also used as a schema reference: any key missing from a
 * stored settings object is backfilled from here during the settings migration
 * step in the service worker.
 *
 * @type {{
 *   activeProvider: string,
 *   activeModel: string,
 *   apiKeys: { claude: string, openai: string, gemini: string },
 *   maxContextMessages: number,
 *   debugMode: boolean
 * }}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  activeProvider: AIProvider.CLAUDE,
  activeModel: 'claude-sonnet-4-6',
  apiKeys: Object.freeze({
    [AIProvider.CLAUDE]: '',
    [AIProvider.OPENAI]: '',
    [AIProvider.GEMINI]: '',
  }),
  /** Number of most-recent message pairs kept in AI context window. */
  maxContextMessages: 10,
  /** When true, verbose logs are emitted in content scripts and the panel. */
  debugMode: false,
});

// ---------------------------------------------------------------------------
// Storage Keys
// ---------------------------------------------------------------------------

/**
 * Keys used with chrome.storage.local / chrome.storage.session.
 *
 * Centralised here so a typo in one file does not silently create a
 * parallel storage entry that is never cleaned up.
 *
 * @readonly
 * @enum {string}
 */
export const StorageKey = Object.freeze({
  SETTINGS: 'dsa_mentor_settings',
  CONVERSATIONS: 'dsa_mentor_conversations',
  /** Session-only: OAuth access token — cleared when browser closes */
  AUTH_TOKEN: 'dsa_mentor_auth_token',
  /** Session-only: current problem context (title, description, platform) */
  ACTIVE_PROBLEM: 'dsa_mentor_active_problem',
  /** Session-only: in-progress conversation for the current tab */
  SESSION_CONVERSATION: 'dsa_mentor_session_conversation',
});

// ---------------------------------------------------------------------------
// AI Mentor System Prompt Template
// ---------------------------------------------------------------------------

/**
 * Template for the system prompt sent to every AI provider.
 *
 * Placeholder tokens are replaced at call time by the AI client:
 *   {problemTitle}        — e.g. "Two Sum"
 *   {platform}            — e.g. "leetcode"
 *   {problemStatement}    — full problem description text
 *   {language}            — e.g. "python", "javascript"
 *   {userCode}            — the user's current editor content
 *   {conversationHistory} — last N message pairs as a formatted string
 *
 * @type {string}
 */
export const MENTOR_SYSTEM_PROMPT = `You are a DSA mentor. Your role is to guide the user to solve coding problems themselves.
NEVER give the complete solution. Instead:
1. Ask a Socratic question that helps them discover the next step.
2. If they are stuck, give a conceptual hint (e.g., "Think about what data structure gives O(1) lookup").
3. If they have wrong logic, point to the specific line and ask what they expect it to do.
4. Praise correct approaches and build on them.

Problem: {problemTitle}
Platform: {platform}
Problem Description: {problemStatement}
User's Current Code ({language}):
{userCode}

Conversation so far:
{conversationHistory}`;
