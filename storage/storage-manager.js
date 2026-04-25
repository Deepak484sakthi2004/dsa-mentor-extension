/**
 * @fileoverview Unified storage abstraction for the DSA Mentor extension.
 *
 * Storage strategy (post-Supabase migration):
 *   - chrome.storage.local   → settings, API keys, auth session (dsa_session)
 *   - chrome.storage.session → active conversation (ephemeral, cleared on browser close)
 *   - Supabase (PostgreSQL)  → conversation archive (cloud-synced, per-user, RLS-protected)
 *
 * The IndexedDB implementation has been replaced with Supabase. All conversation
 * CRUD operations now go through supabase.db.*. If the user is not authenticated,
 * archive operations return graceful empty results rather than throwing — the UI
 * handles the "please log in" messaging separately through AuthManager.
 *
 * Callers should never access chrome.storage or supabase.db directly from UI
 * components — always go through StorageManager so the storage backend can be
 * swapped without touching the rest of the codebase.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   storage/storage-manager
 */

import { StorageKey, DEFAULT_SETTINGS } from '../utils/constants.js';
import supabase from '../utils/supabase.js';
import AuthManager from '../auth/auth-manager.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// StorageManager
// ---------------------------------------------------------------------------

/**
 * Static-only class providing a unified API over all storage backends.
 *
 * @class StorageManager
 */
class StorageManager {

  // -------------------------------------------------------------------------
  // Settings (chrome.storage.local)
  // -------------------------------------------------------------------------

  /**
   * Loads the current extension settings, merging stored values with defaults
   * so that newly-added settings keys are always present.
   *
   * @returns {Promise<{
   *   activeProvider: string,
   *   activeModel: string,
   *   apiKeys: { claude: string, openai: string, gemini: string },
   *   maxContextMessages: number,
   *   debugMode: boolean
   * }>}
   *
   * @example
   * const settings = await StorageManager.getSettings();
   * const apiKey = settings.apiKeys[settings.activeProvider];
   */
  static async getSettings() {
    try {
      const result = await chrome.storage.local.get(StorageKey.SETTINGS);
      const stored = result[StorageKey.SETTINGS] || {};
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        // Merge apiKeys deeply so that keys for providers not in `stored` are
        // still present with their default empty-string values
        apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) },
      };
    } catch (error) {
      logger.error('getSettings failed', error);
      return { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys } };
    }
  }

  /**
   * Saves extension settings, merging the provided updates into existing values.
   *
   * @param {Partial<typeof DEFAULT_SETTINGS>} updates - Settings fields to update.
   * @returns {Promise<void>}
   * @throws {Error} If the chrome.storage write fails.
   *
   * @example
   * await StorageManager.saveSettings({
   *   activeProvider: 'openai',
   *   apiKeys: { openai: 'sk-...' },
   * });
   */
  static async saveSettings(updates) {
    try {
      const current = await StorageManager.getSettings();
      const merged = {
        ...current,
        ...updates,
        apiKeys: { ...current.apiKeys, ...(updates.apiKeys || {}) },
      };
      await chrome.storage.local.set({ [StorageKey.SETTINGS]: merged });
    } catch (error) {
      logger.error('saveSettings failed', error);
      throw error;
    }
  }

  /**
   * Returns the API key for a specific provider.
   *
   * @param {string} provider - One of the AIProvider enum values.
   * @returns {Promise<string>} API key string, or '' if not set.
   */
  static async getApiKey(provider) {
    const settings = await StorageManager.getSettings();
    return settings.apiKeys[provider] || '';
  }

  /**
   * Saves an API key for a specific provider without touching other settings.
   *
   * @param {string} provider - AIProvider value.
   * @param {string} key      - The raw API key to store.
   * @returns {Promise<void>}
   */
  static async saveApiKey(provider, key) {
    await StorageManager.saveSettings({ apiKeys: { [provider]: key } });
  }

  // -------------------------------------------------------------------------
  // Active Conversation (chrome.storage.session — ephemeral)
  // -------------------------------------------------------------------------

  /**
   * Returns the active (in-progress) conversation for the current browser session.
   * This is wiped when the browser closes, which is the desired behaviour —
   * it prevents stale state from a previous session bleeding into a new one.
   *
   * @returns {Promise<object|null>}
   */
  static async getActiveConversation() {
    try {
      const result = await chrome.storage.session.get(StorageKey.SESSION_CONVERSATION);
      return result[StorageKey.SESSION_CONVERSATION] || null;
    } catch (error) {
      logger.error('getActiveConversation failed', error);
      return null;
    }
  }

  /**
   * Persists the current in-progress conversation to the session store.
   *
   * @param {object} conversation - The conversation object to persist.
   * @returns {Promise<void>}
   * @throws {Error} If the write fails.
   */
  static async saveActiveConversation(conversation) {
    try {
      await chrome.storage.session.set({ [StorageKey.SESSION_CONVERSATION]: conversation });
    } catch (error) {
      logger.error('saveActiveConversation failed', error);
      throw error;
    }
  }

  /**
   * Clears the session-scoped active conversation.
   * Call this when the user explicitly clears the chat or navigates away.
   *
   * @returns {Promise<void>}
   */
  static async clearActiveConversation() {
    try {
      await chrome.storage.session.remove(StorageKey.SESSION_CONVERSATION);
    } catch (error) {
      logger.error('clearActiveConversation failed', error);
    }
  }

  // -------------------------------------------------------------------------
  // Conversation Archive (Supabase)
  // -------------------------------------------------------------------------

  /**
   * Saves a completed conversation to the Supabase `conversations` table.
   *
   * The record is normalised from the internal camelCase format used by the
   * extension to the snake_case column names expected by PostgREST.
   *
   * Falls back gracefully (logs, does not throw) if the user is not
   * authenticated — conversations are only archived when logged in.
   *
   * @param {{
   *   problemTitle:      string,
   *   platform:          string,
   *   problemUrl:        string,
   *   language:          string,
   *   aiProvider:        string,
   *   aiModel:           string,
   *   messages:          Array<{role: string, content: string}>,
   *   tag?:              string|null,
   *   userCodeSnapshot?: string,
   *   startedAt:         string
   * }} conversation - Conversation data from the side panel.
   * @returns {Promise<string|null>} The new record's `id`, or null if unauthenticated.
   * @throws {Error} If the Supabase insert fails for reasons other than auth.
   *
   * @example
   * const id = await StorageManager.saveConversationToArchive({
   *   problemTitle: 'Two Sum',
   *   platform: 'leetcode',
   *   messages: [...],
   *   ...
   * });
   */
  static async saveConversationToArchive(conversation) {
    const accessToken = await AuthManager.getValidAccessToken();
    if (!accessToken) {
      logger.warn('saveConversationToArchive: not authenticated — skipping archive');
      return null;
    }

    const user = await AuthManager.getCurrentUser();
    if (!user?.id) {
      logger.warn('saveConversationToArchive: no user ID — skipping archive');
      return null;
    }

    try {
      // Generate a stable ID that works as a PostgreSQL text primary key.
      // Using timestamp + random suffix gives us collision resistance without
      // needing a UUID library.
      const id = conversation.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Normalise camelCase extension fields to snake_case Supabase columns
      const record = {
        id,
        user_id:            user.id,
        problem_key:        conversation.problemKey       || `${conversation.platform || 'unknown'}::unknown`,
        problem_title:      conversation.problemTitle     || 'Unknown',
        platform:           conversation.platform         || 'unknown',
        problem_url:        conversation.problemUrl       || '',
        language:           conversation.language         || 'unknown',
        ai_provider:        conversation.aiProvider       || 'unknown',
        ai_model:           conversation.aiModel          || 'unknown',
        messages:           conversation.messages         || [],
        tag:                conversation.tag              || null,
        user_code_snapshot: conversation.userCodeSnapshot || null,
        started_at:         conversation.startedAt        || new Date().toISOString(),
        saved_at:           new Date().toISOString(),
      };

      const inserted = await supabase.db.insertConversation(record, accessToken);
      logger.info('Conversation saved to Supabase', { id });
      return inserted?.id || id;
    } catch (error) {
      logger.error('saveConversationToArchive failed', error);
      throw error;
    }
  }

  /**
   * Returns all conversations for the authenticated user, newest first.
   *
   * Normalises Supabase's snake_case column names back to the camelCase format
   * the rest of the extension (sidepanel, dashboard) expects.
   *
   * @returns {Promise<Array<object>>} Array of conversation records, or [] if
   *   not authenticated or on error.
   *
   * @example
   * const conversations = await StorageManager.getConversationArchive();
   * conversations.forEach(c => renderCard(c));
   */
  static async getConversationArchive() {
    const accessToken = await AuthManager.getValidAccessToken();
    if (!accessToken) {
      logger.debug('getConversationArchive: not authenticated');
      return [];
    }

    const user = await AuthManager.getCurrentUser();
    if (!user?.id) return [];

    try {
      const rows = await supabase.db.getConversations(user.id, accessToken);
      // Map snake_case DB columns back to camelCase for the UI
      return rows.map(StorageManager._rowToConversation);
    } catch (error) {
      logger.error('getConversationArchive failed', error);
      return [];
    }
  }

  /**
   * Updates specific fields on an existing conversation record.
   * Used primarily for tag updates from the History tab.
   *
   * @param {string} conversationId - The conversation's `id` primary key.
   * @param {object} updates        - Partial update object (camelCase keys accepted).
   * @returns {Promise<boolean>} True on success, false if not authenticated.
   * @throws {Error} If the Supabase update fails.
   *
   * @example
   * await StorageManager.updateArchivedConversation('conv_123', { tag: 'revisit' });
   */
  static async updateArchivedConversation(conversationId, updates) {
    const accessToken = await AuthManager.getValidAccessToken();
    if (!accessToken) {
      logger.warn('updateArchivedConversation: not authenticated');
      return false;
    }

    try {
      // Accept both camelCase and snake_case update objects.
      // Only snake_case keys are sent to Supabase.
      const snakeCaseUpdates = StorageManager._camelToSnakeUpdates(updates);
      await supabase.db.updateConversation(conversationId, snakeCaseUpdates, accessToken);
      logger.debug('Conversation updated in Supabase', { conversationId, updates });
      return true;
    } catch (error) {
      logger.error('updateArchivedConversation failed', error);
      throw error;
    }
  }

  /**
   * Deletes a conversation record from Supabase.
   *
   * @param {string} conversationId - The conversation's `id` primary key.
   * @returns {Promise<boolean>} True on success, false if not authenticated.
   * @throws {Error} If the Supabase delete fails.
   *
   * @example
   * await StorageManager.deleteArchivedConversation('conv_123');
   */
  static async deleteArchivedConversation(conversationId) {
    const accessToken = await AuthManager.getValidAccessToken();
    if (!accessToken) {
      logger.warn('deleteArchivedConversation: not authenticated');
      return false;
    }

    try {
      await supabase.db.deleteConversation(conversationId, accessToken);
      logger.info('Conversation deleted from Supabase', { conversationId });
      return true;
    } catch (error) {
      logger.error('deleteArchivedConversation failed', error);
      throw error;
    }
  }

  /**
   * Filters the archive client-side by platform and/or tag.
   * Fetches the full archive first, then filters in memory.
   * Suitable for the small dataset sizes a typical user accumulates.
   *
   * @param {{ platform?: string, tag?: string }} filters
   * @returns {Promise<Array<object>>}
   */
  static async queryConversations({ platform, tag } = {}) {
    try {
      const all = await StorageManager.getConversationArchive();
      return all.filter(c => {
        if (platform && c.platform !== platform) return false;
        if (tag      && c.tag      !== tag)      return false;
        return true;
      });
    } catch (error) {
      logger.error('queryConversations failed', error);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Writes default settings to chrome.storage.local on first install.
   * Safe to call on every startup — only writes if no settings exist yet.
   *
   * @returns {Promise<void>}
   */
  static async initializeDefaults() {
    try {
      const result = await chrome.storage.local.get(StorageKey.SETTINGS);
      if (!result[StorageKey.SETTINGS]) {
        await chrome.storage.local.set({
          [StorageKey.SETTINGS]: {
            ...DEFAULT_SETTINGS,
            apiKeys: { ...DEFAULT_SETTINGS.apiKeys },
          },
        });
        logger.info('Default settings written on first install');
      }
    } catch (error) {
      logger.error('initializeDefaults failed', error);
    }
  }

  // -------------------------------------------------------------------------
  // Private Normalisation Helpers
  // -------------------------------------------------------------------------

  /**
   * Converts a Supabase row (snake_case) to the camelCase shape the UI expects.
   *
   * @param {object} row - Raw row from PostgREST.
   * @returns {object} camelCase conversation object.
   * @private
   */
  static _rowToConversation(row) {
    return {
      id:               row.id,
      userId:           row.user_id,
      problemKey:       row.problem_key,
      problemTitle:     row.problem_title,
      platform:         row.platform,
      problemUrl:       row.problem_url,
      language:         row.language,
      aiProvider:       row.ai_provider,
      aiModel:          row.ai_model,
      messages:         row.messages || [],
      tag:              row.tag,
      userCodeSnapshot: row.user_code_snapshot,
      startedAt:        row.started_at,
      savedAt:          row.saved_at,
    };
  }

  /**
   * Converts a partial camelCase update object to snake_case for Supabase PATCH.
   * Only the fields present in `updates` are included in the result.
   *
   * @param {object} updates - Partial update with camelCase keys.
   * @returns {object} Partial update with snake_case keys.
   * @private
   */
  static _camelToSnakeUpdates(updates) {
    const mapping = {
      problemKey:       'problem_key',
      problemTitle:     'problem_title',
      platform:         'platform',
      problemUrl:       'problem_url',
      language:         'language',
      aiProvider:       'ai_provider',
      aiModel:          'ai_model',
      messages:         'messages',
      tag:              'tag',
      userCodeSnapshot: 'user_code_snapshot',
      startedAt:        'started_at',
      savedAt:          'saved_at',
    };

    const result = {};
    for (const [camel, value] of Object.entries(updates)) {
      const snake = mapping[camel] || camel; // Pass through if no mapping found
      result[snake] = value;
    }
    return result;
  }
}

export default StorageManager;
