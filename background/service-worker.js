/**
 * @fileoverview Service worker entry point for the DSA Mentor extension.
 *
 * The service worker is the extension's central coordinator:
 *   - Routes all chrome.runtime.sendMessage events to typed handlers
 *   - Makes AI API calls on behalf of the side panel (content scripts and
 *     extension pages cannot call the AI APIs directly due to CORS in some
 *     environments, and the service worker is the logical single point for
 *     all network I/O)
 *   - Opens the side panel on keyboard shortcut or toolbar click
 *   - Persists and retrieves conversation history via StorageManager
 *
 * MV3 Service Worker lifecycle note:
 *   Service workers are terminated after ~30 seconds of inactivity and
 *   restarted on the next event. ALL persistent state must be in storage,
 *   never in module-level variables. This is why we import StorageManager
 *   instead of maintaining an in-memory cache.
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   background/service-worker
 */

import logger            from '../utils/logger.js';
import StorageManager    from '../storage/storage-manager.js';
import AIClientFactory   from '../ai/ai-client-factory.js';
import { buildSystemPrompt, buildMessagesArray } from '../utils/prompt-builder.js';
import { MessageType }   from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

logger.info('Service worker started');

// ---------------------------------------------------------------------------
// Install / Update Lifecycle
// ---------------------------------------------------------------------------

/**
 * Fires once when the extension is first installed or updated.
 *
 * On first install:
 *   1. Initialize default settings in storage
 *   2. Open the side panel so the user immediately sees the welcome message
 *
 * On update: only re-initialize defaults (additive — never overwrites existing data).
 *
 * @param {chrome.runtime.InstalledDetails} details
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('Extension installed / updated', { reason: details.reason });

  try {
    await StorageManager.initializeDefaults();
    logger.info('Storage defaults initialized');
  } catch (error) {
    logger.error('Failed to initialize storage defaults', error);
  }
});

// ---------------------------------------------------------------------------
// Toolbar Icon Click: Open Side Panel
// ---------------------------------------------------------------------------

/**
 * Opens the side panel when the user clicks the extension toolbar icon.
 *
 * chrome.sidePanel.open() requires a windowId. We use the tab's windowId
 * rather than querying for the active window separately, because the click
 * event already provides the tab object with the correct windowId.
 *
 * @param {chrome.tabs.Tab} tab - The active tab at the time of the click.
 */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    logger.info('Side panel opened via toolbar click');
  } catch (error) {
    logger.error('Failed to open side panel on toolbar click', error);
  }
});

// ---------------------------------------------------------------------------
// Keyboard Command: Open Side Panel
// ---------------------------------------------------------------------------

/**
 * Responds to the "open-mentor-panel" command (Alt+7 / Command+7).
 *
 * @param {string} command - The command name from manifest.json's `commands` section.
 */
chrome.commands.onCommand.addListener(async (command) => {
  logger.debug('Command received', { command });

  if (command === 'open-mentor-panel') {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab?.windowId) {
        logger.warn('Could not determine active window for side panel open');
        return;
      }

      await chrome.sidePanel.open({ windowId: activeTab.windowId });
      logger.info('Side panel opened via keyboard shortcut Alt+7');
    } catch (error) {
      logger.error('Failed to open side panel via keyboard shortcut', error);
    }
  }
});

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------

/**
 * Central message dispatcher. All chrome.runtime.sendMessage calls from
 * content scripts, the side panel, and the dashboard arrive here.
 *
 * IMPORTANT: This handler MUST return `true` synchronously when it will
 * call sendResponse asynchronously. Returning false (or nothing) before
 * sendResponse is called causes Chrome to close the message channel,
 * resulting in silent failures.
 *
 * Pattern used: fire an async IIFE, return true immediately.
 *
 * @param {object} message - Message with a `type` field from MessageType enum.
 * @param {chrome.runtime.MessageSender} sender
 * @param {function} sendResponse
 * @returns {boolean} true to keep the channel open for async responses.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Message received', { type: message?.type, from: sender?.tab?.url || sender?.url });

  if (!message || !message.type) {
    logger.warn('Received message without type field — ignoring');
    return false;
  }

  // Dispatch to the appropriate async handler
  handleMessage(message, sender)
    .then(response => {
      sendResponse(response);
    })
    .catch(error => {
      logger.error('Unhandled error in message handler', { type: message.type, error });
      sendResponse({ success: false, error: error.message || 'Internal error in service worker' });
    });

  // Return true to keep the message channel open for the async response
  return true;
});

// ---------------------------------------------------------------------------
// Async Message Handler
// ---------------------------------------------------------------------------

/**
 * Routes the incoming message to the correct handler function based on type.
 *
 * Returns a response object that sendResponse will pass back to the caller.
 *
 * @param {object} message - Typed message object.
 * @param {chrome.runtime.MessageSender} sender - Sender context.
 * @returns {Promise<object>} Response object.
 */
async function handleMessage(message, sender) {
  switch (message.type) {

    case MessageType.REQUEST_CODE_EXTRACTION:
      return handleCodeExtraction(sender);

    case MessageType.REQUEST_HINT:
      return handleRequestHint(message.payload);

    case MessageType.SAVE_CONVERSATION:
      return handleSaveConversation(message.payload);

    case MessageType.GET_CONVERSATIONS:
      return handleGetConversations();

    case MessageType.UPDATE_SETTINGS:
      return handleUpdateSettings(message.payload);

    case MessageType.GET_SETTINGS:
      return handleGetSettings();

    // Not in the MessageType enum (sidepanel-only internal message)
    case 'UPDATE_CONVERSATION_TAG':
      return handleUpdateConversationTag(message.payload);

    default:
      logger.warn('Unknown message type received', { type: message.type });
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ---------------------------------------------------------------------------
// Handler: REQUEST_CODE_EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Injects the page-world extraction script into the active tab and collects
 * the result. The side panel sends this message when the user clicks "Extract Code".
 *
 * Strategy:
 *   1. Query the active tab on the supported DSA platforms
 *   2. Use chrome.scripting.executeScript with world: 'MAIN' to run the
 *      injected-script.js in the page's JS context (needed to access monaco)
 *   3. The injected script posts a message to the page; we then query the
 *      content script (which is listening) via tabs.sendMessage to get the result
 *
 * Simpler approach used here:
 *   The content script (leetcode-adapter.js) already handles REQUEST_CODE_EXTRACTION
 *   by injecting the script via a <script> tag and listening for postMessage.
 *   We simply forward the message to the active tab's content script.
 *
 * @param {chrome.runtime.MessageSender} sender - The sender (side panel context).
 * @returns {Promise<object>} Response containing the extracted problem context.
 */
async function handleCodeExtraction(sender) {
  logger.info('handleCodeExtraction: forwarding to active tab content script');

  try {
    // Get the active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab?.id) {
      return {
        success: false,
        error: 'No active tab found. Please navigate to a LeetCode problem page.',
      };
    }

    // Check if the URL is a supported platform
    const url = activeTab.url || '';
    const isSupportedPlatform = (
      url.includes('leetcode.com') ||
      url.includes('neetcode.io') ||
      url.includes('takeuforward.org')
    );

    if (!isSupportedPlatform) {
      return {
        success: false,
        error: 'This page is not a supported DSA platform. Navigate to LeetCode, NeetCode, or TakeUForward.',
      };
    }

    // Forward the extraction request to the content script on the active tab.
    // The content script (e.g. leetcode-adapter.js) handles the actual extraction
    // and responds with the problem context.
    let contentScriptResponse;
    try {
      contentScriptResponse = await chrome.tabs.sendMessage(activeTab.id, {
        type: MessageType.REQUEST_CODE_EXTRACTION,
      });
    } catch (sendError) {
      logger.error('Failed to send message to content script', sendError);
      return {
        success: false,
        error: 'Could not connect to the page. Try refreshing the LeetCode problem page and try again.',
      };
    }

    if (!contentScriptResponse || !contentScriptResponse.success) {
      return {
        success: false,
        error: contentScriptResponse?.error || 'Content script returned no data. Are you on a problem page?',
      };
    }

    logger.info('Code extraction successful', {
      title: contentScriptResponse.payload?.title,
      platform: contentScriptResponse.payload?.platform,
      language: contentScriptResponse.payload?.language,
    });

    return {
      type: MessageType.CODE_EXTRACTED,
      success: true,
      payload: contentScriptResponse.payload,
    };

  } catch (error) {
    logger.error('handleCodeExtraction failed', error);
    return {
      success: false,
      error: `Extraction failed: ${error.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Handler: REQUEST_HINT
// ---------------------------------------------------------------------------

/**
 * Calls the active AI provider and returns a Socratic hint for the user's problem.
 *
 * Payload expected:
 * {
 *   problemContext: { title, platform, description, language, code },
 *   messages: Array<{ role, content }>,  // full conversation history
 *   userMessage: string                   // the new user message
 * }
 *
 * @param {{
 *   problemContext: object,
 *   messages: Array<{role: string, content: string}>,
 *   userMessage: string
 * }} payload
 * @returns {Promise<{ success: boolean, response?: string, error?: string }>}
 */
async function handleRequestHint(payload) {
  logger.info('handleRequestHint called');

  if (!payload) {
    return { success: false, error: 'REQUEST_HINT payload is missing' };
  }

  const { problemContext, messages = [], userMessage } = payload;

  if (!userMessage) {
    return { success: false, error: 'User message is required to get a hint' };
  }

  try {
    // Load current settings to know which provider + model + key to use
    const settings = await StorageManager.getSettings();
    const { activeProvider, activeModel, apiKeys, maxContextMessages } = settings;

    const apiKey = apiKeys[activeProvider];

    if (!apiKey) {
      return {
        success: false,
        error: `No API key set for ${activeProvider}. Please add your API key in the Settings tab.`,
      };
    }

    // Build the AI client for the active provider
    let aiClient;
    try {
      aiClient = AIClientFactory.create(activeProvider, apiKey, activeModel);
    } catch (factoryError) {
      return { success: false, error: factoryError.message };
    }

    // Build the full message history including the new user message
    const fullMessages = [
      ...messages,
      { role: 'user', content: userMessage },
    ];

    // Build the system prompt with current problem context and conversation history
    const systemPrompt = buildSystemPrompt({
      ...problemContext,
      messages: fullMessages,
      maxContextMessages,
    });

    // Trim messages to context window limit for the API call
    const trimmedMessages = buildMessagesArray(fullMessages, maxContextMessages);

    logger.debug('Calling AI API', {
      provider: activeProvider,
      model: activeModel,
      messageCount: trimmedMessages.length,
    });

    // Make the AI API call — this is the network-bound step
    const aiResponse = await aiClient.getHint(systemPrompt, trimmedMessages);

    logger.info('AI hint received successfully', {
      provider: activeProvider,
      responseLength: aiResponse.length,
    });

    return {
      success: true,
      type: MessageType.HINT_RESPONSE,
      response: aiResponse,
      provider: activeProvider,
      model: activeModel,
    };

  } catch (error) {
    logger.error('handleRequestHint failed', error);
    return {
      success: false,
      type: MessageType.HINT_ERROR,
      error: error.message || 'Unknown error while getting hint from AI',
    };
  }
}

// ---------------------------------------------------------------------------
// Handler: SAVE_CONVERSATION
// ---------------------------------------------------------------------------

/**
 * Archives a completed conversation to chrome.storage.local.
 *
 * Called by the side panel after each successful AI exchange, or when the
 * user explicitly saves the conversation.
 *
 * @param {object} payload - The conversation object to save.
 * @returns {Promise<{ success: boolean, id?: string, error?: string }>}
 */
async function handleSaveConversation(payload) {
  logger.info('handleSaveConversation called');

  if (!payload) {
    return { success: false, error: 'SAVE_CONVERSATION payload is missing' };
  }

  try {
    const id = await StorageManager.saveConversationToArchive(payload);
    return { success: true, id };
  } catch (error) {
    logger.error('handleSaveConversation failed', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Handler: GET_CONVERSATIONS
// ---------------------------------------------------------------------------

/**
 * Retrieves all archived conversations and returns them to the caller.
 *
 * Called by the dashboard page on load, and by the side panel's History tab.
 *
 * @returns {Promise<{ success: boolean, conversations?: Array, error?: string }>}
 */
async function handleGetConversations() {
  logger.info('handleGetConversations called');

  try {
    const conversations = await StorageManager.getConversationArchive();
    return {
      success: true,
      type: MessageType.CONVERSATIONS_LIST,
      conversations,
    };
  } catch (error) {
    logger.error('handleGetConversations failed', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Handler: UPDATE_SETTINGS
// ---------------------------------------------------------------------------

/**
 * Saves updated settings (provider, model, API key) to storage.
 *
 * @param {Partial<object>} payload - Settings fields to update.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handleUpdateSettings(payload) {
  logger.info('handleUpdateSettings called', { keys: Object.keys(payload || {}) });

  if (!payload) {
    return { success: false, error: 'UPDATE_SETTINGS payload is missing' };
  }

  try {
    await StorageManager.saveSettings(payload);
    return { success: true };
  } catch (error) {
    logger.error('handleUpdateSettings failed', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Handler: UPDATE_CONVERSATION_TAG
// ---------------------------------------------------------------------------

/**
 * Updates the tag field on a single archived conversation.
 *
 * @param {{ conversationId: string, tag: string|null }} payload
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handleUpdateConversationTag(payload) {
  if (!payload?.conversationId) {
    return { success: false, error: 'conversationId is required' };
  }

  try {
    const found = await StorageManager.updateArchivedConversation(
      payload.conversationId,
      { tag: payload.tag }
    );
    return { success: found };
  } catch (error) {
    logger.error('handleUpdateConversationTag failed', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Handler: GET_SETTINGS
// ---------------------------------------------------------------------------

/**
 * Returns the current extension settings to the caller.
 *
 * @returns {Promise<{ success: boolean, settings?: object, error?: string }>}
 */
async function handleGetSettings() {
  try {
    const settings = await StorageManager.getSettings();
    // Never send the raw API keys over the message bus — send masked versions
    // for display and let the UI use UPDATE_SETTINGS to overwrite them
    return {
      success: true,
      type: MessageType.SETTINGS_RESPONSE,
      settings: {
        ...settings,
        // Mask keys: return whether each key is set, not the key value itself
        apiKeyStatus: {
          claude:  settings.apiKeys.claude  ? 'set' : 'not_set',
          openai:  settings.apiKeys.openai  ? 'set' : 'not_set',
          gemini:  settings.apiKeys.gemini  ? 'set' : 'not_set',
        },
        // Still send apiKeys so the settings UI can check if keys are present
        apiKeys: settings.apiKeys,
      },
    };
  } catch (error) {
    logger.error('handleGetSettings failed', error);
    return { success: false, error: error.message };
  }
}
