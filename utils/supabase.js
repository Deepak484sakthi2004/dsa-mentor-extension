/**
 * @fileoverview Minimal Supabase client using raw fetch() — no npm packages required.
 *
 * This module exposes a `supabase` object that mirrors the shape of the
 * official Supabase JS client for the subset of endpoints this extension needs:
 * authentication (email/password + Google OAuth via chrome.identity) and
 * database CRUD on the `conversations` table.
 *
 * All network calls are standard fetch() so they work inside MV3 extension
 * pages (sidepanel, dashboard) and service workers without any bundler.
 *
 * -----------------------------------------------------------------------
 * SUPABASE TABLE — run this SQL once in your Supabase project:
 * -----------------------------------------------------------------------
 *
 * create table if not exists conversations (
 *   id                text primary key,
 *   user_id           uuid references auth.users(id) on delete cascade not null,
 *   problem_key       text not null,
 *   problem_title     text,
 *   platform          text,
 *   problem_url       text,
 *   language          text,
 *   ai_provider       text,
 *   ai_model          text,
 *   messages          jsonb default '[]',
 *   tag               text,
 *   user_code_snapshot text,
 *   started_at        timestamptz,
 *   saved_at          timestamptz default now()
 * );
 * alter table conversations enable row level security;
 * create policy "Users own their conversations"
 *   on conversations for all
 *   using (auth.uid() = user_id)
 *   with check (auth.uid() = user_id);
 *
 * -----------------------------------------------------------------------
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   utils/supabase
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** @type {string} Your Supabase project URL. */
const SUPABASE_URL = 'https://glogzopsxrgjkqltwjto.supabase.co';

/**
 * Supabase anon/public key — safe to expose in extension code because
 * Row Level Security policies enforce per-user data isolation server-side.
 *
 * @type {string}
 */
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsb2d6b3BzeHJnamtxbHR3anRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTU0ODQsImV4cCI6MjA5MTE3MTQ4NH0.QuEuwySt1nyAnQp_YWv6mLIAbLYsIDL8-uIrsuSogNw';

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the standard headers that every Supabase REST and Auth request needs.
 *
 * @param {string|null} [accessToken] - JWT access token for authenticated requests.
 *   Pass null/undefined for unauthenticated calls (uses anon key as bearer).
 * @param {boolean}     [withPrefer]  - Whether to include `Prefer: return=representation`
 *   (required for POST/PATCH to get the inserted/updated row back).
 * @returns {Record<string, string>}
 */
function buildHeaders(accessToken = null, withPrefer = false) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  if (withPrefer) {
    // Tells PostgREST to return the full row after insert/update
    headers['Prefer'] = 'return=representation';
  }

  return headers;
}

/**
 * Wraps fetch() and throws a structured error if the response is not 2xx.
 * Returns the parsed JSON body on success.
 *
 * @param {string}      url     - Full URL to fetch.
 * @param {RequestInit} options - Standard fetch options.
 * @returns {Promise<any>} Parsed JSON response body.
 * @throws {Error} With `message` from the Supabase error body when available.
 */
async function apiFetch(url, options) {
  console.log('[DSA Mentor][FETCH]', options.method || 'GET', url);

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    console.error('[DSA Mentor][FETCH] Network error:', networkErr.message);
    throw new Error(`Network error: ${networkErr.message}. Check your internet connection and that ${SUPABASE_URL} is reachable.`);
  }

  console.log('[DSA Mentor][FETCH] Status:', response.status, response.statusText);

  // For DELETE 204 No Content, there is no body to parse
  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Supabase error bodies include `error_description`, `msg`, or `message`
    const message =
      data.error_description ||
      data.msg ||
      data.message ||
      data.error ||
      `HTTP ${response.status}`;
    console.error('[DSA Mentor][FETCH] Error body:', JSON.stringify(data, null, 2));
    const err = new Error(message);
    // Attach the error_code so callers can distinguish e.g. "email_not_confirmed" from "invalid_credentials"
    err.errorCode = data.error_code || null;
    err.statusCode = response.status;
    throw err;
  }

  return data;
}

// ---------------------------------------------------------------------------
// PKCE Helpers (for secure OAuth in extensions)
// ---------------------------------------------------------------------------

/**
 * Generates a random code_verifier string for PKCE.
 * @returns {string} 43–128 character URL-safe random string.
 */
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a code_challenge from a code_verifier using SHA-256.
 * @param {string} verifier - The code_verifier string.
 * @returns {Promise<string>} Base64url-encoded SHA-256 hash.
 */
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

/**
 * @namespace supabase.auth
 * Authentication helpers for Supabase Auth v1 endpoints.
 */
const auth = {

  /**
   * Creates a new user account with email and password.
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<{ user: object, session: object|null }>}
   * @throws {Error} If email already exists or password is too short.
   *
   * @example
   * const { user, session } = await supabase.auth.signUp({ email, password });
   */
  async signUp({ email, password }) {
    console.log('[DSA Mentor][AUTH] signUp called for:', email);
    console.log('[DSA Mentor][AUTH] signUp URL:', `${SUPABASE_URL}/auth/v1/signup`);

    try {
      const data = await apiFetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ email, password }),
      });

      console.log('[DSA Mentor][AUTH] signUp response:', JSON.stringify(data, null, 2));

      return {
        user: data.user || data,
        session: data.access_token ? data : null,
      };
    } catch (err) {
      console.error('[DSA Mentor][AUTH] signUp error:', err.message);
      throw err;
    }
  },

  /**
   * Signs in an existing user with email and password.
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<{ access_token: string, refresh_token: string, user: object, expires_in: number }>}
   * @throws {Error} If credentials are invalid.
   *
   * @example
   * const session = await supabase.auth.signInWithPassword({ email, password });
   * await AuthManager.saveSession(session);
   */
  async signInWithPassword({ email, password }) {
    const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
    console.log('[DSA Mentor][AUTH] signInWithPassword called for:', email);
    console.log('[DSA Mentor][AUTH] signInWithPassword URL:', url);

    try {
      const data = await apiFetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ email, password }),
      });

      console.log('[DSA Mentor][AUTH] signInWithPassword success — user:', data.user?.email, 'expires_in:', data.expires_in);
      return data;
    } catch (err) {
      console.error('[DSA Mentor][AUTH] signInWithPassword error:', err.message);
      throw err;
    }
  },

  /**
   * Initiates Google OAuth via chrome.identity.launchWebAuthFlow.
   *
   * The flow:
   *   1. Build the Supabase authorize URL with the extension's redirect URI
   *   2. Open a popup via chrome.identity.launchWebAuthFlow
   *   3. Supabase redirects back to the extension's redirect URL with tokens
   *      in the URL fragment (#access_token=...&refresh_token=...)
   *   4. Parse and return the token data
   *
   * NOTE: The Supabase project MUST have the extension's redirect URL added
   * to the "Additional Redirect URLs" list in Authentication > URL Configuration.
   * The redirect URL looks like:
   *   https://<extension-id>.chromiumapp.org/
   *
   * @returns {Promise<{ access_token: string, refresh_token: string, user: object, expires_in: number }>}
   * @throws {Error} If the user cancels or auth fails.
   *
   * @example
   * const session = await supabase.auth.signInWithGoogle();
   */
  async signInWithGoogle() {
    // Verify chrome.identity is available (only in extension contexts)
    if (!chrome?.identity?.launchWebAuthFlow) {
      throw new Error('Google sign-in requires the chrome.identity API. Make sure you are using the extension side panel.');
    }

    const redirectUrl = chrome.identity.getRedirectURL();
    console.log('[DSA Mentor][AUTH] Google OAuth redirect URL:', redirectUrl);
    console.log('[DSA Mentor][AUTH] Add this URL to Supabase > Authentication > URL Configuration > Redirect URLs');

    // Generate PKCE code_verifier and code_challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Build Supabase authorize URL with PKCE
    const authorizeUrl =
      `${SUPABASE_URL}/auth/v1/authorize` +
      `?provider=google` +
      `&redirect_to=${encodeURIComponent(redirectUrl)}` +
      `&flow_type=pkce` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256`;
    console.log('[DSA Mentor][AUTH] Authorize URL:', authorizeUrl);

    // Pre-flight: verify the authorize URL redirects to Google (not an error page)
    try {
      const preflight = await fetch(authorizeUrl, { method: 'HEAD', redirect: 'manual' });
      console.log('[DSA Mentor][AUTH] Preflight status:', preflight.status);
      const location = preflight.headers.get('location');
      console.log('[DSA Mentor][AUTH] Preflight redirect to:', location?.slice(0, 80));
      if (preflight.status !== 302 && preflight.status !== 303) {
        console.error('[DSA Mentor][AUTH] Supabase did not redirect to Google. Status:', preflight.status);
      }
    } catch (preErr) {
      console.warn('[DSA Mentor][AUTH] Preflight check failed (non-fatal):', preErr.message);
    }

    // Launch the OAuth popup
    console.log('[DSA Mentor][AUTH] Launching WebAuthFlow (interactive)...');
    const callbackUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authorizeUrl, interactive: true },
        (responseUrl) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message;
            console.error('[DSA Mentor][AUTH] WebAuthFlow error:', errMsg);

            // Provide actionable error messages
            if (errMsg.includes('Authorization page could not be loaded')) {
              reject(new Error(
                'Could not load Google sign-in page. Please verify:\n' +
                '1. Google provider is enabled in Supabase (Authentication > Providers > Google)\n' +
                '2. Google Client ID and Secret are set in Supabase\n' +
                '3. In Google Cloud Console, authorized redirect URI includes: ' +
                SUPABASE_URL + '/auth/v1/callback\n' +
                '4. Extension redirect URL is in Supabase redirect URLs: ' + redirectUrl
              ));
            } else {
              reject(new Error(errMsg));
            }
            return;
          }
          if (!responseUrl) {
            reject(new Error('OAuth flow cancelled or returned no URL'));
            return;
          }
          console.log('[DSA Mentor][AUTH] WebAuthFlow callback URL:', responseUrl);
          resolve(responseUrl);
        }
      );
    });

    // Parse the response — PKCE returns ?code=, implicit returns #access_token=
    const callbackUrlObj = new URL(callbackUrl);
    const authCode = callbackUrlObj.searchParams.get('code');

    if (authCode) {
      // PKCE flow: exchange auth code for tokens
      console.log('[DSA Mentor][AUTH] Got auth code, exchanging for tokens...');
      const tokenData = await apiFetch(
        `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`,
        {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({
            auth_code: authCode,
            code_verifier: codeVerifier,
          }),
        }
      );
      console.log('[DSA Mentor][AUTH] Token exchange success, user:', tokenData.user?.email);
      return {
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in:    tokenData.expires_in || 3600,
        user:          tokenData.user,
      };
    }

    // Fallback: implicit flow — tokens in URL fragment
    const hashFragment = callbackUrl.includes('#') ? callbackUrl.split('#')[1] : '';
    const params = new URLSearchParams(hashFragment);
    const accessToken = params.get('access_token');

    if (!accessToken) {
      console.error('[DSA Mentor][AUTH] No code or token in callback:', callbackUrl);
      throw new Error('Google sign-in failed — no token received. Check Supabase redirect URL configuration.');
    }

    const user = await auth.getUser(accessToken);
    return {
      access_token:  accessToken,
      refresh_token: params.get('refresh_token'),
      expires_in:    parseInt(params.get('expires_in') || '3600', 10),
      user,
    };
  },

  /**
   * Exchanges a refresh token for a new access token.
   * Called automatically by AuthManager when the session is close to expiring.
   *
   * @param {string} refreshToken - The stored refresh token.
   * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number, user: object }>}
   * @throws {Error} If the refresh token is expired or invalid.
   */
  async refreshSession(refreshToken) {
    const data = await apiFetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );

    return data;
  },

  /**
   * Signs the user out, invalidating their access token server-side.
   *
   * @param {string} accessToken - The current session's access token.
   * @returns {Promise<void>}
   */
  async signOut(accessToken) {
    await apiFetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: buildHeaders(accessToken),
      body: JSON.stringify({}),
    });
  },

  /**
   * Sends a password reset email to the given address.
   * Supabase handles the email delivery and reset link generation.
   *
   * @param {string} email - The user's email address.
   * @returns {Promise<void>}
   * @throws {Error} If the request fails (note: Supabase returns 200 even for non-existent emails for security).
   */
  async resetPasswordForEmail(email) {
    console.log('[DSA Mentor][AUTH] resetPasswordForEmail called for:', email);
    await apiFetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ email }),
    });
  },

  /**
   * Fetches the authenticated user's profile from the access token.
   *
   * @param {string} accessToken - A valid Supabase JWT access token.
   * @returns {Promise<object>} User object with id, email, metadata, etc.
   * @throws {Error} If the token is invalid or expired.
   */
  async getUser(accessToken) {
    const data = await apiFetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: buildHeaders(accessToken),
    });

    return data;
  },
};

// ---------------------------------------------------------------------------
// Database API
// ---------------------------------------------------------------------------

/**
 * @namespace supabase.db
 * PostgREST helpers for the `conversations` table.
 * Row Level Security ensures users can only access their own rows.
 */
const db = {

  /**
   * Inserts a new conversation record into the `conversations` table.
   *
   * The record shape must include `user_id` (UUID from the authenticated user)
   * and all the other conversation fields defined in the table schema.
   *
   * @param {object} record      - Conversation data to insert.
   * @param {string} accessToken - Authenticated user's access token.
   * @returns {Promise<object>}  The inserted record as returned by PostgREST.
   * @throws {Error} On network error or constraint violation.
   *
   * @example
   * await supabase.db.insertConversation({
   *   id: 'conv_123',
   *   user_id: user.id,
   *   problem_title: 'Two Sum',
   *   platform: 'leetcode',
   *   messages: [...],
   * }, accessToken);
   */
  async insertConversation(record, accessToken) {
    const data = await apiFetch(
      `${SUPABASE_URL}/rest/v1/conversations`,
      {
        method: 'POST',
        headers: buildHeaders(accessToken, /* withPrefer */ true),
        body: JSON.stringify(record),
      }
    );

    // PostgREST returns an array with Prefer: return=representation
    return Array.isArray(data) ? data[0] : data;
  },

  /**
   * Fetches all conversations for the given user, ordered newest first.
   *
   * RLS on the server ensures `user_id=eq.${userId}` only returns rows
   * owned by the authenticated user — the filter is a belt-and-suspenders
   * safeguard and also avoids a full-table scan.
   *
   * @param {string} userId      - The authenticated user's UUID.
   * @param {string} accessToken - Authenticated user's access token.
   * @returns {Promise<object[]>} Array of conversation records.
   */
  async getConversations(userId, accessToken) {
    const url =
      `${SUPABASE_URL}/rest/v1/conversations` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&order=saved_at.desc`;

    const data = await apiFetch(url, {
      method: 'GET',
      headers: buildHeaders(accessToken),
    });

    return Array.isArray(data) ? data : [];
  },

  /**
   * Partially updates a conversation record (e.g. updating the `tag` field).
   *
   * @param {string} id          - The conversation's primary key.
   * @param {object} updates     - Fields to update (partial object).
   * @param {string} accessToken - Authenticated user's access token.
   * @returns {Promise<object>}  The updated record.
   */
  async updateConversation(id, updates, accessToken) {
    const data = await apiFetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: buildHeaders(accessToken, /* withPrefer */ true),
        body: JSON.stringify(updates),
      }
    );

    return Array.isArray(data) ? data[0] : data;
  },

  /**
   * Deletes a conversation record by its primary key.
   *
   * RLS ensures users can only delete their own records even if they
   * somehow guess another user's conversation ID.
   *
   * @param {string} id          - The conversation's primary key.
   * @param {string} accessToken - Authenticated user's access token.
   * @returns {Promise<null>}    Resolves to null (204 No Content).
   */
  async deleteConversation(id, accessToken) {
    return apiFetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: buildHeaders(accessToken),
      }
    );
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Minimal Supabase client for the DSA Mentor extension.
 * Mirrors the shape of the official `@supabase/supabase-js` client for the
 * endpoints this extension uses, so it can be swapped for the official SDK
 * if a build step is ever added.
 *
 * @type {{ auth: typeof auth, db: typeof db }}
 */
const supabase = { auth, db };

export default supabase;
export { SUPABASE_URL, SUPABASE_ANON_KEY };
