/**
 * @fileoverview Anthropic Claude API client for the DSA Mentor extension.
 *
 * This client calls the Anthropic Messages API directly from the extension's
 * background service worker via fetch(). No SDK is used — bundling the
 * Anthropic SDK into a MV3 extension requires a build step and adds ~500KB
 * to the extension. A direct fetch call is simpler and has no dependencies.
 *
 * Key header notes:
 *   x-api-key                             — user's Anthropic API key
 *   anthropic-version: 2023-06-01         — required; pins the API contract version
 *   anthropic-dangerous-direct-browser-access: true
 *     → Required when calling the Anthropic API directly from a browser
 *       context (service worker). Without this header, CORS preflight fails.
 *       This header tells Anthropic's servers that the developer is aware
 *       they are making a browser-side call (which exposes the API key in
 *       extension storage rather than a server environment). Users accept
 *       this trade-off by entering their own key.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   ai/claude-client
 */

import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// API Configuration
// ---------------------------------------------------------------------------

/** Anthropic Messages API endpoint */
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/** Maximum tokens to generate per AI response */
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// ClaudeClient Class
// ---------------------------------------------------------------------------

/**
 * Client for the Anthropic Claude API.
 *
 * Implements the same interface as OpenAIClient and GeminiClient so that
 * AIClientFactory can swap providers transparently. The interface contract:
 *   - Constructor accepts (apiKey, model)
 *   - getHint(systemPrompt, messages) returns Promise<string>
 *
 * @example
 * const client = new ClaudeClient('sk-ant-api03-...', 'claude-sonnet-4-6');
 * const hint = await client.getHint(systemPrompt, conversationMessages);
 */
class ClaudeClient {
  /**
   * @param {string} apiKey - Anthropic API key (starts with 'sk-ant-').
   * @param {string} [model='claude-sonnet-4-6'] - Model ID from AI_MODELS catalogue.
   */
  constructor(apiKey, model = 'claude-sonnet-4-6') {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('ClaudeClient: apiKey is required and must be a string');
    }

    /** @type {string} @private */
    this._apiKey = apiKey;

    /** @type {string} @private */
    this._model = model;

    logger.debug('ClaudeClient initialized', { model });
  }

  // -------------------------------------------------------------------------
  // Public Interface
  // -------------------------------------------------------------------------

  /**
   * Sends the conversation to Claude and returns its text response.
   *
   * The system prompt is passed separately from messages because the
   * Anthropic API accepts it as a top-level `system` field rather than
   * a message with role: 'system' (unlike OpenAI). This produces better
   * results than embedding the system prompt in the messages array.
   *
   * @param {string} systemPrompt - The fully-rendered mentor system prompt.
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages
   *   Conversation history (user and assistant turns only; no system role).
   * @returns {Promise<string>} The assistant's text response.
   * @throws {Error} On API errors (4xx, 5xx), network failures, or rate limits.
   *   Rate limit errors include `retryAfter` property (seconds) when available.
   *
   * @example
   * const response = await client.getHint(systemPrompt, [
   *   { role: 'user', content: "I don't know how to start this problem" }
   * ]);
   * console.log(response); // "What do you notice about the input constraints?"
   */
  async getHint(systemPrompt, messages) {
    logger.debug('ClaudeClient.getHint called', {
      model: this._model,
      messageCount: messages.length,
      systemPromptLength: systemPrompt.length,
    });

    // Anthropic requires the messages array to begin with a 'user' role.
    // If the passed array is empty or starts with 'assistant', the API will error.
    // Add a minimal user message if the array is empty.
    const normalizedMessages = messages.length > 0
      ? messages
      : [{ role: 'user', content: 'I need help with this problem.' }];

    const requestBody = {
      model: this._model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: normalizedMessages,
    };

    let response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this._apiKey,
          'anthropic-version': '2023-06-01',
          // Required for browser/extension direct API calls — see file header
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (networkError) {
      logger.error('ClaudeClient: Network error during fetch', networkError);
      throw new Error(`Network error calling Claude API: ${networkError.message}`);
    }

    // Handle non-2xx responses
    if (!response.ok) {
      await this._handleApiError(response);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      throw new Error('ClaudeClient: Failed to parse API response JSON');
    }

    // Extract the text from the first content block
    // Anthropic response structure: { content: [{ type: 'text', text: '...' }] }
    const textBlock = data.content?.find(block => block.type === 'text');
    if (!textBlock || !textBlock.text) {
      throw new Error('ClaudeClient: API response contained no text content');
    }

    logger.debug('ClaudeClient.getHint succeeded', {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
    });

    return textBlock.text;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Reads the error response body and throws a descriptive Error.
   *
   * Anthropic error responses have the shape: { error: { type, message } }
   * We use this to provide actionable error messages to the user rather than
   * cryptic HTTP status codes.
   *
   * @param {Response} response - The non-OK fetch Response.
   * @throws {Error} Always throws with a user-friendly message.
   * @private
   */
  async _handleApiError(response) {
    const status = response.status;
    let errorMessage = '';

    try {
      const errorBody = await response.json();
      errorMessage = errorBody.error?.message || JSON.stringify(errorBody);
    } catch {
      errorMessage = await response.text().catch(() => 'Unknown error body');
    }

    logger.error('ClaudeClient: API error', { status, errorMessage });

    if (status === 401) {
      throw new Error('Invalid Claude API key. Please check your key in Settings.');
    }

    if (status === 429) {
      // Rate limit — extract retry-after if present
      const retryAfter = response.headers.get('retry-after');
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
      const error = new Error(
        `Claude rate limit reached. Please wait ${waitSeconds} seconds before trying again.`
      );
      error.retryAfter = waitSeconds;
      throw error;
    }

    if (status === 400) {
      throw new Error(`Claude API request error: ${errorMessage}`);
    }

    if (status >= 500) {
      throw new Error(`Claude API server error (${status}). Please try again in a moment.`);
    }

    throw new Error(`Claude API error (${status}): ${errorMessage}`);
  }
}

export default ClaudeClient;
