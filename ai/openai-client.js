/**
 * @fileoverview OpenAI GPT API client for the DSA Mentor extension.
 *
 * Calls the OpenAI Chat Completions API directly via fetch from the extension's
 * background service worker. No SDK required — keeps the extension lightweight.
 *
 * OpenAI's Chat Completions API is the most widely-used LLM API, with a
 * simple messages array format where the system prompt is included as the
 * first message with role: 'system'. This differs from Anthropic's separate
 * `system` field, but the AIClientFactory normalises the difference so
 * callers never need to know which format the provider expects.
 *
 * CORS: OpenAI allows browser-side requests to api.openai.com with a valid
 * API key. No special header is required (unlike Anthropic's
 * `anthropic-dangerous-direct-browser-access` header).
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   ai/openai-client
 */

import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// API Configuration
// ---------------------------------------------------------------------------

/** OpenAI Chat Completions endpoint */
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/** Maximum tokens to generate per AI response */
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// OpenAIClient Class
// ---------------------------------------------------------------------------

/**
 * Client for the OpenAI Chat Completions API (GPT-4o, GPT-4o-mini, etc.).
 *
 * Implements the same interface as ClaudeClient and GeminiClient:
 *   - Constructor accepts (apiKey, model)
 *   - getHint(systemPrompt, messages) returns Promise<string>
 *
 * @example
 * const client = new OpenAIClient('sk-proj-...', 'gpt-4o');
 * const hint = await client.getHint(systemPrompt, conversationMessages);
 */
class OpenAIClient {
  /**
   * @param {string} apiKey - OpenAI API key (starts with 'sk-').
   * @param {string} [model='gpt-4o'] - Model ID from the AI_MODELS catalogue.
   */
  constructor(apiKey, model = 'gpt-4o') {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('OpenAIClient: apiKey is required and must be a string');
    }

    /** @type {string} @private */
    this._apiKey = apiKey;

    /** @type {string} @private */
    this._model = model;

    logger.debug('OpenAIClient initialized', { model });
  }

  // -------------------------------------------------------------------------
  // Public Interface
  // -------------------------------------------------------------------------

  /**
   * Sends the conversation to GPT and returns its text response.
   *
   * OpenAI's format uses the messages array for everything, including the
   * system prompt (role: 'system' as the first element). We prepend the
   * system prompt to the messages array before sending.
   *
   * @param {string} systemPrompt - The fully-rendered mentor system prompt.
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages
   *   Conversation history (user and assistant turns only).
   * @returns {Promise<string>} The assistant's text response.
   * @throws {Error} On API errors (4xx, 5xx), network failures, or rate limits.
   *
   * @example
   * const response = await client.getHint(systemPrompt, [
   *   { role: 'user', content: "How should I approach the two pointer technique?" }
   * ]);
   */
  async getHint(systemPrompt, messages) {
    logger.debug('OpenAIClient.getHint called', {
      model: this._model,
      messageCount: messages.length,
    });

    // OpenAI uses the messages array for everything:
    // The system prompt goes first as a system role message,
    // followed by the conversation history
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // If no user messages, add a default opening
    if (messages.length === 0) {
      fullMessages.push({ role: 'user', content: 'I need help with this problem.' });
    }

    const requestBody = {
      model: this._model,
      max_tokens: MAX_TOKENS,
      messages: fullMessages,
      // temperature 0.7 balances creativity with consistency in Socratic hints
      temperature: 0.7,
    };

    let response;
    try {
      response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (networkError) {
      logger.error('OpenAIClient: Network error during fetch', networkError);
      throw new Error(`Network error calling OpenAI API: ${networkError.message}`);
    }

    if (!response.ok) {
      await this._handleApiError(response);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      throw new Error('OpenAIClient: Failed to parse API response JSON');
    }

    // OpenAI response structure: { choices: [{ message: { content: '...' } }] }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAIClient: API response contained no text content');
    }

    logger.debug('OpenAIClient.getHint succeeded', {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      finishReason: data.choices?.[0]?.finish_reason,
    });

    return content;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Reads the OpenAI error response and throws a descriptive Error.
   *
   * OpenAI error responses: { error: { message, type, code } }
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

    logger.error('OpenAIClient: API error', { status, errorMessage });

    if (status === 401) {
      throw new Error('Invalid OpenAI API key. Please check your key in Settings.');
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
      const error = new Error(
        `OpenAI rate limit reached. Please wait ${waitSeconds} seconds before trying again.`
      );
      error.retryAfter = waitSeconds;
      throw error;
    }

    if (status === 400) {
      throw new Error(`OpenAI API request error: ${errorMessage}`);
    }

    if (status === 402) {
      throw new Error('OpenAI account has insufficient credits. Please check your billing.');
    }

    if (status >= 500) {
      throw new Error(`OpenAI API server error (${status}). Please try again in a moment.`);
    }

    throw new Error(`OpenAI API error (${status}): ${errorMessage}`);
  }
}

export default OpenAIClient;
