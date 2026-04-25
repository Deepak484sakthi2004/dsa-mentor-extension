/**
 * @fileoverview Factory for creating AI provider client instances.
 *
 * The AIClientFactory is the single point where the active AI provider
 * (Claude, OpenAI, or Gemini) is resolved to a concrete client object.
 * All three clients implement the same interface:
 *   - constructor(apiKey, model)
 *   - getHint(systemPrompt, messages): Promise<string>
 *
 * Adding a new AI provider requires:
 *   1. Create a new XyzClient class in ai/xyz-client.js
 *   2. Import it here
 *   3. Add a case to the switch statement in AIClientFactory.create()
 *   Nothing else in the codebase needs to change — the service worker
 *   always calls AIClientFactory.create() and never imports clients directly.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   ai/ai-client-factory
 */

import ClaudeClient  from './claude-client.js';
import OpenAIClient  from './openai-client.js';
import GeminiClient  from './gemini-client.js';
import { AIProvider } from '../utils/constants.js';
import logger        from '../utils/logger.js';

// ---------------------------------------------------------------------------
// AIClientFactory
// ---------------------------------------------------------------------------

/**
 * Factory class for AI provider clients.
 *
 * Use the static `create` method to get a client instance.
 * Do not instantiate this class.
 *
 * @example
 * const client = AIClientFactory.create('claude', 'sk-ant-...', 'claude-sonnet-4-6');
 * const hint   = await client.getHint(systemPrompt, messages);
 */
class AIClientFactory {
  /**
   * Creates and returns the appropriate AI client for the given provider.
   *
   * @param {string} provider - One of the AIProvider enum values ('claude', 'openai', 'gemini').
   * @param {string} apiKey   - The user's API key for the selected provider.
   * @param {string} model    - The model ID to use (must be valid for the provider).
   * @returns {ClaudeClient|OpenAIClient|GeminiClient} Instantiated client ready for use.
   * @throws {Error} If the provider is not recognised or apiKey is empty.
   *
   * @example
   * // In the service worker's REQUEST_HINT handler:
   * const settings = await StorageManager.getSettings();
   * const apiKey   = settings.apiKeys[settings.activeProvider];
   * const client   = AIClientFactory.create(
   *   settings.activeProvider,
   *   apiKey,
   *   settings.activeModel
   * );
   * const hint = await client.getHint(systemPrompt, messages);
   */
  static create(provider, apiKey, model) {
    if (!apiKey) {
      throw new Error(
        `No API key configured for provider "${provider}". ` +
        'Please add your API key in the Settings tab.'
      );
    }

    logger.debug('AIClientFactory.create', { provider, model });

    switch (provider) {
      case AIProvider.CLAUDE:
        return new ClaudeClient(apiKey, model);

      case AIProvider.OPENAI:
        return new OpenAIClient(apiKey, model);

      case AIProvider.GEMINI:
        return new GeminiClient(apiKey, model);

      default:
        throw new Error(
          `AIClientFactory: Unknown provider "${provider}". ` +
          `Valid values are: ${Object.values(AIProvider).join(', ')}`
        );
    }
  }
}

export default AIClientFactory;
