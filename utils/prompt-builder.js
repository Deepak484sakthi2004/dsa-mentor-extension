/**
 * @fileoverview Builds the structured system prompt sent to AI providers.
 *
 * The MENTOR_SYSTEM_PROMPT template in constants.js contains placeholder
 * tokens like `{problemTitle}`. This module provides the single function
 * that performs all substitutions, so the AI client implementations stay
 * clean — they receive a fully-resolved string and never handle templating.
 *
 * Context window management strategy:
 *   - Only the last `maxContextMessages` message pairs are included in the
 *     prompt's conversationHistory section. Older messages are dropped to
 *     stay within token limits. This is a simple FIFO truncation; a future
 *     enhancement could summarise older messages using a cheaper model.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   utils/prompt-builder
 */

import { MENTOR_SYSTEM_PROMPT } from './constants.js';

// ---------------------------------------------------------------------------
// System Prompt Builder
// ---------------------------------------------------------------------------

/**
 * Substitutes all placeholder tokens in MENTOR_SYSTEM_PROMPT with actual values.
 *
 * Tokens replaced:
 *   {problemTitle}        → e.g. "Two Sum"
 *   {platform}            → e.g. "leetcode"
 *   {problemStatement}    → full problem description text
 *   {language}            → e.g. "python3"
 *   {userCode}            → the user's current editor content
 *   {conversationHistory} → last N message pairs as "User: ...\nAssistant: ..."
 *
 * @param {{
 *   title: string,
 *   platform: string,
 *   description: string,
 *   language: string,
 *   code: string,
 *   messages?: Array<{role: string, content: string}>,
 *   maxContextMessages?: number
 * }} problemContext - The current problem state gathered by the platform adapter.
 * @returns {string} The fully-resolved system prompt string.
 *
 * @example
 * const systemPrompt = buildSystemPrompt({
 *   title: 'Two Sum',
 *   platform: 'leetcode',
 *   description: 'Given an array of integers nums...',
 *   language: 'python3',
 *   code: 'class Solution:\n    def twoSum(self, nums, target):\n        pass',
 *   messages: [
 *     { role: 'user', content: 'I don\'t know where to start' },
 *     { role: 'assistant', content: 'Think about what data structure...' },
 *   ],
 *   maxContextMessages: 10,
 * });
 */
export function buildSystemPrompt(problemContext) {
  const {
    title = 'Unknown Problem',
    platform = 'unknown',
    description = 'No description available.',
    language = 'unknown',
    code = '',
    messages = [],
    maxContextMessages = 10,
  } = problemContext;

  // Format the conversation history as a readable dialogue.
  // We take only the last `maxContextMessages` pairs (user + assistant = 2 entries),
  // so multiply by 2 to get the correct slice length.
  const historySlice = messages.slice(-(maxContextMessages * 2));
  const conversationHistory = historySlice.length > 0
    ? historySlice
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n')
    : 'No conversation yet — this is the first message.';

  // Replace each placeholder with its actual value.
  // Using replaceAll with literal strings rather than regex to avoid
  // accidental regex metacharacter issues in user-provided content.
  return MENTOR_SYSTEM_PROMPT
    .replaceAll('{problemTitle}', title)
    .replaceAll('{platform}', platform)
    .replaceAll('{problemStatement}', description || 'No description available.')
    .replaceAll('{language}', language)
    .replaceAll('{userCode}', code || '// No code extracted yet.')
    .replaceAll('{conversationHistory}', conversationHistory);
}

// ---------------------------------------------------------------------------
// Message Array Builder
// ---------------------------------------------------------------------------

/**
 * Formats the messages array for AI API calls.
 *
 * All three AI providers (Anthropic, OpenAI, Gemini) accept a `messages`
 * array with `role` and `content` fields. This function normalises the
 * stored conversation format into that common shape, trimming to the
 * context window limit.
 *
 * The system prompt is NOT included in the messages array here — it is
 * passed separately to each AI client which injects it in the
 * provider-specific way (Anthropic uses `system`, OpenAI uses a system
 * role message, Gemini uses `systemInstruction`).
 *
 * @param {Array<{role: string, content: string}>} messages - Full message history.
 * @param {number} [maxPairs=10] - Maximum number of user/assistant pairs to include.
 * @returns {Array<{role: string, content: string}>} Trimmed message array for the API.
 */
export function buildMessagesArray(messages, maxPairs = 10) {
  // Take only the last N pairs; each pair = 1 user + 1 assistant message = 2 entries
  return messages.slice(-(maxPairs * 2));
}
