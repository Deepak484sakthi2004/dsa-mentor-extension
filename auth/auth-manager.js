/**
 * @fileoverview Session persistence and token lifecycle management for the DSA Mentor extension.
 *
 * AuthManager is the single place responsible for reading, writing, and validating
 * the Supabase session stored in chrome.storage.local. No other module should
 * access the `dsa_session` storage key directly — all session access goes through
 * this class.
 *
 * Session structure stored under key `dsa_session`:
 * {
 *   access_token:  string,   // Supabase JWT
 *   refresh_token: string,   // Used to mint a new access_token
 *   user:          object,   // Supabase user object (id, email, metadata)
 *   expires_at:    number    // Unix timestamp (seconds) when access_token expires
 * }
 *
 * Token refresh strategy:
 *   - On every call to getValidAccessToken(), the expiry is checked.
 *   - If the token expires within REFRESH_BUFFER_SECONDS (5 min), a refresh
 *     is attempted silently before returning.
 *   - If the refresh fails (e.g. refresh token is also expired), the session
 *     is cleared and null is returned — the UI should then prompt re-login.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   auth/auth-manager
 */

import supabase from '../utils/supabase.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** chrome.storage.local key that holds the serialised session object. */
const SESSION_STORAGE_KEY = 'dsa_session';

/**
 * How many seconds before actual expiry we proactively refresh the token.
 * 5 minutes gives plenty of headroom for a slow network.
 */
const REFRESH_BUFFER_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// AuthManager
// ---------------------------------------------------------------------------

/**
 * Static-only class for session management.
 *
 * All methods are async because they interact with chrome.storage, which is
 * callback-based. Using a class (rather than module-level functions) groups the
 * API cleanly and makes it easy to mock in tests.
 *
 * @class AuthManager
 */
class AuthManager {

  /**
   * Reads the raw session object from chrome.storage.local.
   * Returns null if no session has been saved.
   *
   * @returns {Promise<{
   *   access_token: string,
   *   refresh_token: string,
   *   user: object,
   *   expires_at: number
   * }|null>}
   *
   * @example
   * const session = await AuthManager.getSession();
   * if (session) console.log('Logged in as', session.user.email);
   */
  static async getSession() {
    try {
      const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
      return result[SESSION_STORAGE_KEY] || null;
    } catch (error) {
      logger.error('AuthManager.getSession failed', error);
      return null;
    }
  }

  /**
   * Persists a session object to chrome.storage.local.
   *
   * Automatically calculates `expires_at` from `expires_in` if the caller
   * passes the raw Supabase token response (which uses `expires_in` seconds
   * rather than an absolute timestamp).
   *
   * @param {{
   *   access_token:  string,
   *   refresh_token: string,
   *   user:          object,
   *   expires_in?:   number,
   *   expires_at?:   number
   * }} session - Raw session from Supabase auth or a previously stored session.
   * @returns {Promise<void>}
   *
   * @example
   * const tokenResponse = await supabase.auth.signInWithPassword({ email, password });
   * await AuthManager.saveSession(tokenResponse);
   */
  static async saveSession(session) {
    try {
      // Normalise to absolute Unix timestamp in seconds.
      // Supabase token responses provide `expires_in` (relative seconds).
      // When we read back from storage, the field is already `expires_at`.
      let expiresAt = session.expires_at;
      if (!expiresAt && session.expires_in) {
        expiresAt = Math.floor(Date.now() / 1000) + session.expires_in;
      }
      if (!expiresAt) {
        // Fallback: assume 1 hour if neither field is present
        expiresAt = Math.floor(Date.now() / 1000) + 3600;
        logger.warn('AuthManager.saveSession: no expiry info in session — defaulting to 1 hour');
      }

      const normalised = {
        access_token:  session.access_token,
        refresh_token: session.refresh_token,
        user:          session.user,
        expires_at:    expiresAt,
      };

      await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: normalised });
      logger.info('Session saved', { userId: session.user?.id, expiresAt });
    } catch (error) {
      logger.error('AuthManager.saveSession failed', error);
      throw error;
    }
  }

  /**
   * Removes the session from chrome.storage.local.
   * Call this on explicit logout or when a refresh token is confirmed invalid.
   *
   * @returns {Promise<void>}
   *
   * @example
   * await supabase.auth.signOut(accessToken);
   * await AuthManager.clearSession();
   */
  static async clearSession() {
    try {
      await chrome.storage.local.remove(SESSION_STORAGE_KEY);
      logger.info('Session cleared');
    } catch (error) {
      logger.error('AuthManager.clearSession failed', error);
    }
  }

  /**
   * Returns true if a non-expired session exists in storage.
   *
   * This is a quick check that does NOT refresh the token — it just tells the
   * UI whether to show the auth screen or the main app. Token validity is
   * enforced lazily in getValidAccessToken().
   *
   * @returns {Promise<boolean>}
   *
   * @example
   * if (!(await AuthManager.isAuthenticated())) {
   *   showAuthScreen();
   * }
   */
  static async isAuthenticated() {
    const session = await AuthManager.getSession();
    if (!session?.access_token) return false;

    // Consider authenticated if the token hasn't expired yet.
    // We use the raw expiry (no buffer) here — the buffer is only applied
    // when we need to make an actual API call in getValidAccessToken().
    const nowSeconds = Math.floor(Date.now() / 1000);
    return session.expires_at > nowSeconds;
  }

  /**
   * Returns a valid access token, refreshing the session silently if needed.
   *
   * This is the method all API callers should use to get a token. It handles:
   *   - No session → returns null
   *   - Token close to expiry → refreshes transparently
   *   - Refresh fails → clears session, returns null (UI should re-prompt login)
   *
   * @returns {Promise<string|null>} Valid access token, or null if unauthenticated.
   *
   * @example
   * const token = await AuthManager.getValidAccessToken();
   * if (!token) { showAuthScreen(); return; }
   * const conversations = await supabase.db.getConversations(userId, token);
   */
  static async getValidAccessToken() {
    const session = await AuthManager.getSession();

    if (!session?.access_token) {
      return null;
    }

    const nowSeconds     = Math.floor(Date.now() / 1000);
    const secondsToExpiry = session.expires_at - nowSeconds;

    if (secondsToExpiry > REFRESH_BUFFER_SECONDS) {
      // Token is fresh enough — return it directly
      return session.access_token;
    }

    // Token is expiring soon (or already expired) — attempt a refresh
    logger.info('Access token expiring soon, refreshing...', { secondsToExpiry });

    if (!session.refresh_token) {
      logger.warn('No refresh token available — clearing session');
      await AuthManager.clearSession();
      return null;
    }

    try {
      const refreshed = await supabase.auth.refreshSession(session.refresh_token);
      await AuthManager.saveSession({
        ...refreshed,
        user: refreshed.user || session.user, // Preserve user if not returned
      });
      logger.info('Token refreshed successfully');
      return refreshed.access_token;
    } catch (error) {
      // Refresh token is expired or revoked — force re-login
      logger.error('Token refresh failed — clearing session', error);
      await AuthManager.clearSession();
      return null;
    }
  }

  /**
   * Returns the stored user object, or null if not authenticated.
   *
   * Uses the locally stored user data (not a network call) for speed.
   * The user object is guaranteed to be current as of the last login/refresh.
   *
   * @returns {Promise<object|null>} Supabase user object or null.
   *
   * @example
   * const user = await AuthManager.getCurrentUser();
   * if (user) console.log('Hello,', user.email);
   */
  static async getCurrentUser() {
    const session = await AuthManager.getSession();
    return session?.user || null;
  }
}

export default AuthManager;
