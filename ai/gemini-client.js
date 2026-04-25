/**
 * @fileoverview Google Gemini API client for the DSA Mentor extension.
 *
 * Calls the Gemini generateContent API directly via fetch from the extension's
 * background service worker. Uses the REST API rather than the Google AI SDK
 * to avoid bundling dependencies into the extension.
 *
 * Gemini API differences from OpenAI/Anthropic:
 *   - API key is passed as a URL query parameter (?key=...) rather than a header
 *   - Messages use 'user' and 'model' roles (not 'user' and 'assistant')
 *   - System instruction is a separate `systemInstruction` top-level field
 *   - Content is wrapped: { role: '...', parts: [{ text: '...' }] }
 *
 * CORS: Google's Gemini API allows browser-side requests from any origin.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   ai/gemini-client
 */

import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// API Configuration
// ---------------------------------------------------------------------------

/**
 * Gemini REST API base URL.
 * The model name and action are appended dynamically in getHint().
 */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Maximum tokens to generate per AI response */
const MAX_OUTPUT_TOKENS = 1024;

// ---------------------------------------------------------------------------
// GeminiClient Class
// ---------------------------------------------------------------------------

/**
 * Client for the Google Gemini generateContent API.
 *
 * Implements the same interface as ClaudeClient and OpenAIClient:
 *   - Constructor accepts (apiKey, model)
 *   - getHint(systemPrompt, messages) returns Promise<string>
 *
 * @example
 * const client = new GeminiClient('AIzaSy...', 'gemini-2.0-flash');
 * const hint = await client.getHint(systemPrompt, conversationMessages);
 */
class GeminiClient {
  /**
   * @param {string} apiKey - Google AI API key (starts with 'AIzaSy').
   * @param {string} [model='gemini-2.0-flash'] - Model ID from the AI_MODELS catalogue.
   */
  constructor(apiKey, model = 'gemini-2.0-flash') {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('GeminiClient: apiKey is required and must be a string');
    }

    /** @type {string} @private */
    this._apiKey = apiKey;

    /** @type {string} @private */
    this._model = model;

    logger.debug('GeminiClient initialized', { model });
  }

  // -------------------------------------------------------------------------
  // Public Interface
  // -------------------------------------------------------------------------

  /**
   * Sends the conversation to Gemini and returns its text response.
   *
   * Converts the standard {role, content} message format to Gemini's
   * {role, parts: [{text}]} format, and maps 'assistant' → 'model'
   * (Gemini's term for the AI's role).
   *
   * @param {string} systemPrompt - The fully-rendered mentor system prompt.
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages
   *   Conversation history in the standard format.
   * @returns {Promise<string>} The assistant's text response.
   * @throws {Error} On API errors (4xx, 5xx), network failures, or rate limits.
   *
   * @example
   * const response = await client.getHint(systemPrompt, [
   *   { role: 'user', content: "What does O(n log n) mean?" }
   * ]);
   */
  async getHint(systemPrompt, messages) {
    logger.debug('GeminiClient.getHint called', {
      model: this._model,
      messageCount: messages.length,
    });

    // Convert standard messages to Gemini's format:
    //   role: 'assistant' → 'model' (Gemini-specific term)
    //   content: string   → parts: [{ text: string }]
    const geminiContents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    // Gemini requires the conversation to start with a user turn.
    // If messages is empty, add a default user message.
    if (geminiContents.length === 0) {
      geminiContents.push({
        role: 'user',
        parts: [{ text: 'I need help with this problem.' }],
      });
    }

    const requestBody = {
      // systemInstruction is the Gemini equivalent of Anthropic's `system` field
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.7,
        // candidateCount: 1 is the default; explicitly set to avoid ambiguity
        candidateCount: 1,
      },
    };

    // Gemini uses the API key as a query parameter rather than a header
    const apiUrl = `${GEMINI_API_BASE}/${this._model}:generateContent?key=${this._apiKey}`;

    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (networkError) {
      logger.error('GeminiClient: Network error during fetch', networkError);
      throw new Error(`Network error calling Gemini API: ${networkError.message}`);
    }

    if (!response.ok) {
      await this._handleApiError(response);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      throw new Error('GeminiClient: Failed to parse API response JSON');
    }

    // Gemini response structure:
    // { candidates: [{ content: { parts: [{ text: '...' }] } }] }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      // Check for safety blocks
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        throw new Error('Gemini blocked this response due to safety filters. Try rephrasing your question.');
      }
      throw new Error('GeminiClient: API response contained no text content');
    }

    logger.debug('GeminiClient.getHint succeeded', {
      promptTokenCount: data.usageMetadata?.promptTokenCount,
      candidatesTokenCount: data.usageMetadata?.candidatesTokenCount,
    });

    return text;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Reads the Gemini error response and throws a descriptive Error.
   *
   * Gemini error responses: { error: { code, message, status } }
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

    logger.error('GeminiClient: API error', { status, errorMessage });

    if (status === 400) {
      throw new Error(`Gemini API request error: ${errorMessage}`);
    }

    if (status === 403) {
      throw new Error('Invalid Gemini API key or insufficient permissions. Please check your key in Settings.');
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
      const error = new Error(
        `Gemini rate limit reached. Please wait ${waitSeconds} seconds before trying again.`
      );
      error.retryAfter = waitSeconds;
      throw error;
    }

    if (status >= 500) {
      throw new Error(`Gemini API server error (${status}). Please try again in a moment.`);
    }

    throw new Error(`Gemini API error (${status}): ${errorMessage}`);
  }
}

export default GeminiClient;
