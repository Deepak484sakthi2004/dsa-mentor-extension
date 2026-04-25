/**
 * @fileoverview Side panel UI controller for the DSA Mentor extension.
 *
 * This module manages the entire side panel: tab switching, code extraction,
 * AI hint requests, settings configuration, and conversation history display.
 *
 * Architecture:
 *   - All chrome.runtime.sendMessage calls go through typed helper functions
 *     (sendMessage, requestHint, etc.) — never raw sendMessage in event handlers
 *   - State is kept minimal: only what the UI currently displays
 *   - Persistent state goes to the service worker / StorageManager (never stored
 *     in module-level variables that would be lost on panel close/reopen)
 *
 * @author   DSA Mentor Extension
 * @created  2026-04-08
 * @module   sidepanel/sidepanel
 */

import { MessageType, AIProvider, AI_MODELS } from '../utils/constants.js';
import logger from '../utils/logger.js';
import supabase from '../utils/supabase.js';
import AuthManager from '../auth/auth-manager.js';

// ---------------------------------------------------------------------------
// UI State
// ---------------------------------------------------------------------------

/**
 * In-memory state for the current panel session.
 * Cleared if the panel is closed and reopened (which is expected).
 *
 * @type {{
 *   problemContext: object|null,
 *   messages: Array<{role: string, content: string}>,
 *   currentProvider: string,
 *   currentModel: string,
 *   isLoading: boolean,
 *   currentConversationId: string|null
 * }}
 */
const state = {
  problemContext: null,
  messages: [],
  currentProvider: AIProvider.CLAUDE,
  currentModel: 'claude-sonnet-4-6',
  isLoading: false,
  currentConversationId: null,
};

// ---------------------------------------------------------------------------
// DOM Element References
// ---------------------------------------------------------------------------

// Cached after DOMContentLoaded — never query the DOM in hot paths
const UI = {};

/**
 * Caches references to all DOM elements used by the controller.
 * Called once on DOMContentLoaded.
 */
function cacheUIElements() {
  // Tabs
  UI.tabBtns = document.querySelectorAll('.tab-nav__btn');
  UI.tabPanels = document.querySelectorAll('.tab-panel');

  // Mentor tab
  UI.problemBar       = document.getElementById('problem-bar');
  UI.problemTitle     = document.getElementById('problem-title');
  UI.problemPlatform  = document.getElementById('problem-platform');
  UI.problemLanguage  = document.getElementById('problem-language');
  UI.welcomeSection   = document.getElementById('welcome-section');
  UI.extractionBar    = document.getElementById('extraction-bar');
  UI.extractionStatus = document.getElementById('extraction-status');
  UI.chatThread       = document.getElementById('chat-thread');
  UI.chatError        = document.getElementById('chat-error');
  UI.chatErrorText    = document.getElementById('chat-error-text');
  UI.btnCloseError    = document.getElementById('btn-close-error');
  UI.inputArea        = document.getElementById('input-area');
  UI.userInput        = document.getElementById('user-input');
  UI.btnGetHint       = document.getElementById('btn-get-hint');
  UI.hintStatus       = document.getElementById('hint-status');
  UI.btnExtractWelcome = document.getElementById('btn-extract-welcome');
  UI.btnExtract       = document.getElementById('btn-extract');
  UI.btnClearChat     = document.getElementById('btn-clear-chat');

  // Settings tab
  UI.providerCards    = document.querySelectorAll('.provider-card');
  UI.providerRadios   = document.querySelectorAll('input[name="provider"]');
  UI.modelSelect      = document.getElementById('model-select');
  UI.apiKeyInput      = document.getElementById('api-key-input');
  UI.btnToggleKeyVis  = document.getElementById('btn-toggle-key-visibility');
  UI.apiKeyStatus     = document.getElementById('api-key-status');
  UI.btnSaveSettings  = document.getElementById('btn-save-settings');
  UI.settingsSaveMsg  = document.getElementById('settings-save-msg');

  // History tab
  UI.historyList      = document.getElementById('history-list');
  UI.historyEmpty     = document.getElementById('history-empty');

  // Auth screen elements
  UI.authScreen       = document.getElementById('auth-screen');
  UI.appShell         = document.getElementById('app');
  UI.authTabLogin     = document.getElementById('auth-tab-login');
  UI.authTabSignup    = document.getElementById('auth-tab-signup');
  UI.authPanelLogin   = document.getElementById('auth-panel-login');
  UI.authPanelSignup  = document.getElementById('auth-panel-signup');
  UI.formLogin        = document.getElementById('form-login');
  UI.formSignup       = document.getElementById('form-signup');
  UI.loginEmail       = document.getElementById('login-email');
  UI.loginPassword    = document.getElementById('login-password');
  UI.signupEmail      = document.getElementById('signup-email');
  UI.signupPassword   = document.getElementById('signup-password');
  UI.signupConfirm    = document.getElementById('signup-confirm');
  UI.btnLogin         = document.getElementById('btn-login');
  UI.btnSignup        = document.getElementById('btn-signup');
  UI.btnGoogleAuth    = document.getElementById('btn-google-auth');
  UI.btnForgotPwd     = document.getElementById('btn-forgot-password');
  UI.authPanelForgot  = document.getElementById('auth-panel-forgot');
  UI.formForgot       = document.getElementById('form-forgot');
  UI.forgotEmail      = document.getElementById('forgot-email');
  UI.btnForgotSubmit  = document.getElementById('btn-forgot-submit');
  UI.forgotSuccess    = document.getElementById('forgot-success');
  UI.btnBackToLogin   = document.getElementById('btn-back-to-login');
  UI.btnBackToLogin2  = document.getElementById('btn-back-to-login-2');
  UI.authError        = document.getElementById('auth-error');
  UI.authErrorText    = document.getElementById('auth-error-text');
  UI.btnLogout        = document.getElementById('btn-logout');
}

// ---------------------------------------------------------------------------
// Tab Switching
// ---------------------------------------------------------------------------

/**
 * Switches the visible tab panel and updates aria-selected on the nav buttons.
 *
 * @param {string} tabName - One of 'mentor' | 'settings' | 'history'.
 */
function switchTab(tabName) {
  // Update tab buttons
  UI.tabBtns.forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.classList.toggle('tab-nav__btn--active', isActive);
  });

  // Show/hide panels
  UI.tabPanels.forEach(panel => {
    const isActive = panel.id === `tab-${tabName}`;
    panel.classList.toggle('tab-panel--active', isActive);
    if (isActive) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
  });

  // Trigger tab-specific data loads
  if (tabName === 'history') {
    loadHistory();
  }

  logger.debug('Tab switched to', tabName);
}

// ---------------------------------------------------------------------------
// Code Extraction
// ---------------------------------------------------------------------------

/**
 * Sends REQUEST_CODE_EXTRACTION to the service worker, which forwards it
 * to the active tab's content script (e.g. leetcode-adapter.js).
 * Updates the UI with the extracted problem context on success.
 */
async function extractCode() {
  showExtractionStatus('Extracting problem context from page...', '');

  try {
    const response = await sendMessage({ type: MessageType.REQUEST_CODE_EXTRACTION });

    if (!response || !response.success) {
      const errorMsg = response?.error || 'Extraction failed. Are you on a problem page?';
      showExtractionStatus(errorMsg, 'error');
      return;
    }

    const ctx = response.payload;
    state.problemContext = ctx;

    // Update the problem context bar
    UI.problemTitle.textContent    = ctx.title    || 'Unknown Problem';
    UI.problemPlatform.textContent = ctx.platform || 'unknown';
    UI.problemLanguage.textContent = ctx.language || '--';

    // Show/hide UI sections appropriately
    UI.problemBar.classList.remove('problem-bar--hidden');
    UI.welcomeSection.style.display    = 'none';
    UI.extractionBar.classList.remove('extraction-bar--hidden');
    UI.inputArea.classList.remove('input-area--hidden');

    showExtractionStatus(
      `Loaded: "${ctx.title}" (${ctx.language}) — ${ctx.code?.split('\n').length || 0} lines`,
      'success'
    );

    // Focus the input so the user can immediately ask a question
    UI.userInput.focus();

    logger.info('Problem context loaded', { title: ctx.title, platform: ctx.platform });

  } catch (error) {
    logger.error('extractCode failed', error);
    showExtractionStatus(`Error: ${error.message}`, 'error');
  }
}

/**
 * Shows a temporary status message below the extraction bar.
 *
 * @param {string} message - The message to display.
 * @param {'success'|'error'|''} type - Visual style variant.
 */
function showExtractionStatus(message, type) {
  UI.extractionStatus.textContent = message;
  UI.extractionStatus.className = 'status-msg';
  if (type) UI.extractionStatus.classList.add(`status-msg--${type}`);
  UI.extractionStatus.classList.remove('status-msg--hidden');

  // Auto-hide success messages after 4 seconds
  if (type === 'success') {
    setTimeout(() => {
      UI.extractionStatus.classList.add('status-msg--hidden');
    }, 4000);
  }
}

// ---------------------------------------------------------------------------
// Hint Request
// ---------------------------------------------------------------------------

/**
 * Reads the user's message, sends a REQUEST_HINT to the service worker,
 * and appends both the user message and the AI response to the chat thread.
 */
async function getHint() {
  const userMessage = UI.userInput.value.trim();

  if (!userMessage) {
    UI.userInput.focus();
    return;
  }

  if (state.isLoading) return;

  // Check for API key before showing spinner
  if (!state.problemContext) {
    showChatError('Please extract the problem first by clicking "Extract Code".');
    return;
  }

  // Append user message to chat immediately for responsiveness
  appendMessage('user', userMessage);
  UI.userInput.value = '';
  UI.userInput.style.height = 'auto'; // Reset textarea height

  setLoadingState(true);
  hideChatError();

  try {
    const response = await sendMessage({
      type: MessageType.REQUEST_HINT,
      payload: {
        problemContext: state.problemContext,
        messages: state.messages.slice(0, -1), // Exclude the message we just added
        userMessage,
      },
    });

    if (!response || !response.success) {
      const errorMsg = response?.error || 'Failed to get hint. Check your API key in Settings.';
      showChatError(errorMsg);
      // Remove the user message we optimistically added
      removeLastUserMessage();
      return;
    }

    // Add AI response to state and UI
    const aiText = response.response;
    state.messages.push({ role: 'assistant', content: aiText });
    appendMessage('assistant', aiText);

    // Auto-save the conversation after each successful exchange
    autoSaveConversation();

    // Scroll chat to bottom
    scrollChatToBottom();

  } catch (error) {
    logger.error('getHint failed', error);
    showChatError(error.message || 'Unexpected error getting hint');
    removeLastUserMessage();
  } finally {
    setLoadingState(false);
  }
}

// ---------------------------------------------------------------------------
// Minimal Markdown Renderer
// ---------------------------------------------------------------------------

/**
 * Converts a markdown string to safe HTML for display in chat bubbles.
 * Handles: fenced code blocks, inline code, bold, italic, headers,
 * unordered/ordered lists, blockquotes, and paragraphs.
 * All non-code text is escaped to prevent XSS.
 *
 * @param {string} text - Raw markdown text from the AI.
 * @returns {string} Safe HTML string.
 */
function renderMarkdown(text) {
  // Escape HTML special chars (applied to non-code segments only)
  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Step 1: Extract and replace fenced code blocks with placeholders
  const codeBlocks = [];
  let out = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langLabel = lang || 'code';
    const header = `<div class="code-block-header">${esc(langLabel)}</div>`;
    const block  = `<pre><code>${esc(code.trimEnd())}</code></pre>`;
    codeBlocks.push(header + block);
    return `__CODEBLOCK_${idx}__`;
  });

  // Step 2: Process line-by-line for block-level elements
  const lines = out.split('\n');
  const processed = [];
  let inList = false;
  let listType = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3) { closeList(); processed.push(`<h3>${inlineMarkdown(esc(h3[1]))}</h3>`); continue; }
    if (h2) { closeList(); processed.push(`<h2>${inlineMarkdown(esc(h2[1]))}</h2>`); continue; }
    if (h1) { closeList(); processed.push(`<h1>${inlineMarkdown(esc(h1[1]))}</h1>`); continue; }

    // Blockquote
    const bq = line.match(/^> (.+)/);
    if (bq) { closeList(); processed.push(`<blockquote>${inlineMarkdown(esc(bq[1]))}</blockquote>`); continue; }

    // Unordered list
    const ul = line.match(/^[-*] (.+)/);
    if (ul) {
      if (!inList || listType !== 'ul') { if (inList) processed.push(`</${listType}>`); processed.push('<ul>'); inList = true; listType = 'ul'; }
      processed.push(`<li>${inlineMarkdown(esc(ul[1]))}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+\. (.+)/);
    if (ol) {
      if (!inList || listType !== 'ol') { if (inList) processed.push(`</${listType}>`); processed.push('<ol>'); inList = true; listType = 'ol'; }
      processed.push(`<li>${inlineMarkdown(esc(ol[1]))}</li>`);
      continue;
    }

    // Code placeholder — reinsert verbatim
    if (line.includes('__CODEBLOCK_')) {
      closeList();
      processed.push(line);
      continue;
    }

    // Blank line → close list or paragraph break
    if (line.trim() === '') {
      closeList();
      processed.push('');
      continue;
    }

    // Normal paragraph line
    closeList();
    processed.push(inlineMarkdown(esc(line)));
  }

  closeList();

  function closeList() {
    if (inList) { processed.push(`</${listType}>`); inList = false; listType = ''; }
  }

  // Step 3: Wrap non-empty, non-block-tag lines in <p>
  let html = processed
    .join('\n')
    .split(/\n{2,}/)
    .map(block => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[1-3]|ul|ol|li|blockquote|pre|div)/.test(block)) return block;
      if (block.includes('__CODEBLOCK_')) return block;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  // Step 4: Restore code blocks
  html = html.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return html;
}

/**
 * Processes inline markdown: bold, italic, inline code.
 * Input must already be HTML-escaped.
 *
 * @param {string} s - Escaped text segment.
 * @returns {string} HTML with inline elements.
 */
function inlineMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g,   '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g,   '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,   '<em>$1</em>')
    .replace(/_(.+?)_/g,     '<em>$1</em>');
}

// ---------------------------------------------------------------------------
// Message Rendering
// ---------------------------------------------------------------------------

/**
 * Appends a message bubble to the chat thread (WhatsApp style).
 * User messages: right-aligned green bubble.
 * Assistant messages: left-aligned dark bubble with markdown rendered.
 *
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function appendMessage(role, content) {
  if (role === 'user') {
    state.messages.push({ role, content });
  }

  const messageEl = document.createElement('div');
  messageEl.className = `chat-message chat-message--${role}`;

  const roleEl = document.createElement('span');
  roleEl.className = 'chat-message__role';
  roleEl.textContent = role === 'user' ? 'You' : 'Mentor';

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'chat-message__bubble';

  if (role === 'user') {
    // User messages: plain text, no markdown needed
    bubbleEl.textContent = content;
  } else {
    // Assistant messages: render markdown to HTML
    bubbleEl.innerHTML = renderMarkdown(content);
  }

  messageEl.appendChild(roleEl);
  messageEl.appendChild(bubbleEl);
  UI.chatThread.appendChild(messageEl);

  scrollChatToBottom();
}

/**
 * Removes the last user message from the chat thread and state.
 * Called when an API error occurs after optimistic UI insertion.
 */
function removeLastUserMessage() {
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg?.role === 'user') {
    state.messages.pop();
    const messages = UI.chatThread.querySelectorAll('.chat-message--user');
    if (messages.length > 0) {
      messages[messages.length - 1].remove();
    }
  }
}

/**
 * Clears the chat thread and resets message state.
 */
function clearChat() {
  state.messages = [];
  UI.chatThread.innerHTML = '';
  hideChatError();
  logger.info('Chat cleared');
}

/**
 * Scrolls the chat thread to show the latest message.
 */
function scrollChatToBottom() {
  requestAnimationFrame(() => {
    UI.chatThread.scrollTop = UI.chatThread.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Loading State
// ---------------------------------------------------------------------------

/**
 * Enables or disables the loading state for the hint request.
 *
 * @param {boolean} loading - True to show loading indicator.
 */
function setLoadingState(loading) {
  state.isLoading = loading;
  UI.btnGetHint.disabled = loading;
  UI.userInput.disabled  = loading;

  if (loading) {
    UI.hintStatus.classList.remove('hint-status--hidden');
  } else {
    UI.hintStatus.classList.add('hint-status--hidden');
  }
}

// ---------------------------------------------------------------------------
// Error Display
// ---------------------------------------------------------------------------

/**
 * Shows the error banner with the given message.
 *
 * @param {string} message - User-readable error text.
 */
function showChatError(message) {
  UI.chatErrorText.textContent = message;
  UI.chatError.classList.remove('error-banner--hidden');
}

/** Hides the chat error banner. */
function hideChatError() {
  UI.chatError.classList.add('error-banner--hidden');
}

// ---------------------------------------------------------------------------
// Auto-Save Conversation
// ---------------------------------------------------------------------------

/**
 * Saves the current conversation to the archive after each AI exchange.
 * Runs in the background without blocking the UI.
 */
async function autoSaveConversation() {
  if (state.messages.length < 2) return; // Need at least one exchange

  try {
    const settings = await getSettings();
    const conversationData = {
      problemTitle:  state.problemContext?.title      || 'Unknown',
      platform:      state.problemContext?.platform   || 'unknown',
      problemUrl:    state.problemContext?.problemUrl || '',
      problemKey:    state.problemContext?.problemKey || `${state.problemContext?.platform || 'unknown'}::unknown`,
      language:      state.problemContext?.language   || 'unknown',
      aiProvider:    settings?.activeProvider || 'unknown',
      aiModel:       settings?.activeModel    || 'unknown',
      messages:      [...state.messages],
      startedAt:     state.sessionStartedAt || new Date().toISOString(),
    };

    const response = await sendMessage({
      type: MessageType.SAVE_CONVERSATION,
      payload: conversationData,
    });

    if (response?.success) {
      state.currentConversationId = response.id;
      logger.debug('Conversation auto-saved', { id: response.id });
    }
  } catch (error) {
    // Auto-save failures are non-critical — log but don't show to user
    logger.error('Auto-save conversation failed', error);
  }
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------

/**
 * Loads the current settings from the service worker and populates the
 * Settings tab UI with the stored values.
 */
async function loadSettings() {
  try {
    const response = await getSettings();
    if (!response) return;

    // Update in-memory state
    state.currentProvider = response.activeProvider || AIProvider.CLAUDE;
    state.currentModel    = response.activeModel    || 'claude-sonnet-4-6';

    // Select the correct provider radio button
    UI.providerRadios.forEach(radio => {
      radio.checked = radio.value === state.currentProvider;
    });

    // Highlight the selected provider card
    updateProviderCardSelection(state.currentProvider);

    // Populate model dropdown for the selected provider
    populateModelDropdown(state.currentProvider, state.currentModel);

    // Show API key status
    updateApiKeyStatus(state.currentProvider, response.apiKeys?.[state.currentProvider] || '');

    // Load the actual key into the input (masked by type="password")
    UI.apiKeyInput.value = response.apiKeys?.[state.currentProvider] || '';

    logger.debug('Settings loaded into UI', { provider: state.currentProvider, model: state.currentModel });

  } catch (error) {
    logger.error('Failed to load settings', error);
  }
}

/**
 * Fetches current settings from the service worker.
 *
 * @returns {Promise<object|null>} Settings object or null on error.
 */
async function getSettings() {
  try {
    const response = await sendMessage({ type: MessageType.GET_SETTINGS });
    return response?.settings || null;
  } catch (error) {
    logger.error('getSettings failed', error);
    return null;
  }
}

/**
 * Populates the model <select> with options for the given provider.
 *
 * @param {string} provider - One of the AIProvider values.
 * @param {string} [selectedModel] - Model ID to pre-select.
 */
function populateModelDropdown(provider, selectedModel) {
  const models = AI_MODELS[provider] || [];

  UI.modelSelect.innerHTML = models
    .map(m => `<option value="${m.id}" ${m.id === selectedModel ? 'selected' : ''}>${m.label}</option>`)
    .join('');
}

/**
 * Adds/removes the visual selected state from provider cards.
 *
 * @param {string} provider - The currently selected provider.
 */
function updateProviderCardSelection(provider) {
  UI.providerCards.forEach(card => {
    card.classList.toggle('provider-card--selected', card.dataset.provider === provider);
  });
}

/**
 * Updates the API key status indicator below the key input.
 *
 * @param {string} provider - The active provider.
 * @param {string} apiKey   - The current API key value (may be empty).
 */
function updateApiKeyStatus(provider, apiKey) {
  if (apiKey) {
    UI.apiKeyStatus.textContent = `API key saved for ${provider}`;
    UI.apiKeyStatus.className   = 'api-key-status api-key-status--set';
  } else {
    UI.apiKeyStatus.textContent = `No API key set for ${provider}`;
    UI.apiKeyStatus.className   = 'api-key-status api-key-status--not-set';
  }
}

/**
 * Reads the Settings form and saves the new values via the service worker.
 */
async function saveSettings() {
  const selectedProvider = getSelectedProvider();
  const selectedModel    = UI.modelSelect.value;
  const apiKey           = UI.apiKeyInput.value.trim();

  try {
    const response = await sendMessage({
      type: MessageType.UPDATE_SETTINGS,
      payload: {
        activeProvider: selectedProvider,
        activeModel:    selectedModel,
        apiKeys: {
          [selectedProvider]: apiKey,
        },
      },
    });

    if (response?.success) {
      // Update in-memory state to reflect saved values
      state.currentProvider = selectedProvider;
      state.currentModel    = selectedModel;

      updateApiKeyStatus(selectedProvider, apiKey);
      showSettingsSaveMessage('Settings saved!', 'success');
      logger.info('Settings saved', { provider: selectedProvider, model: selectedModel });
    } else {
      showSettingsSaveMessage(response?.error || 'Failed to save settings', 'error');
    }
  } catch (error) {
    logger.error('saveSettings failed', error);
    showSettingsSaveMessage(error.message, 'error');
  }
}

/**
 * Returns the currently selected provider from the radio buttons.
 *
 * @returns {string} Provider value.
 */
function getSelectedProvider() {
  for (const radio of UI.providerRadios) {
    if (radio.checked) return radio.value;
  }
  return AIProvider.CLAUDE;
}

/**
 * Shows a save confirmation/error message below the Save button.
 *
 * @param {string} message
 * @param {'success'|'error'} type
 */
function showSettingsSaveMessage(message, type) {
  UI.settingsSaveMsg.textContent = message;
  UI.settingsSaveMsg.className   = `save-msg save-msg--${type}`;

  setTimeout(() => {
    UI.settingsSaveMsg.classList.add('save-msg--hidden');
  }, 3000);
}

// ---------------------------------------------------------------------------
// History Tab
// ---------------------------------------------------------------------------

/**
 * Loads and renders the conversation archive in the History tab.
 */
async function loadHistory() {
  try {
    const response = await sendMessage({ type: MessageType.GET_CONVERSATIONS });

    if (!response?.success) {
      logger.error('Failed to load conversation history', response?.error);
      return;
    }

    const conversations = response.conversations || [];

    UI.historyList.innerHTML = '';

    if (conversations.length === 0) {
      UI.historyEmpty.classList.remove('empty-state--hidden');
      return;
    }

    UI.historyEmpty.classList.add('empty-state--hidden');
    conversations.forEach(conv => {
      UI.historyList.appendChild(buildHistoryCard(conv));
    });

  } catch (error) {
    logger.error('loadHistory failed', error);
  }
}

/**
 * Builds a DOM element for a single conversation history card.
 *
 * @param {{
 *   id: string,
 *   problemTitle: string,
 *   platform: string,
 *   problemUrl: string,
 *   aiProvider: string,
 *   aiModel: string,
 *   messages: Array,
 *   tag: string|null,
 *   savedAt: string
 * }} conversation
 * @returns {HTMLElement}
 */
function buildHistoryCard(conversation) {
  const card = document.createElement('div');
  card.className = 'history-card';
  card.dataset.id = conversation.id;

  const savedDate = new Date(conversation.savedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const tagBadge = conversation.tag
    ? `<span class="badge badge--${conversation.tag}">${conversation.tag}</span>`
    : '';

  card.innerHTML = `
    <div class="history-card__header">
      <span class="history-card__title truncate">${escapeHtml(conversation.problemTitle)}</span>
      ${tagBadge}
    </div>
    <div class="history-card__meta">
      <span class="badge badge--platform">${escapeHtml(conversation.platform)}</span>
      <span class="badge badge--language">${escapeHtml(conversation.aiProvider)}</span>
      <span class="history-card__date">${savedDate}</span>
    </div>
    <div class="history-card__actions">
      <button class="tag-btn tag-btn--revisit ${conversation.tag === 'revisit' ? 'tag-btn--active' : ''}"
              data-tag="revisit" title="Mark for revisit">Revisit</button>
      <button class="tag-btn tag-btn--confident ${conversation.tag === 'confident' ? 'tag-btn--active' : ''}"
              data-tag="confident" title="Mark as confident">Confident</button>
      <button class="tag-btn tag-btn--confused ${conversation.tag === 'confused' ? 'tag-btn--active' : ''}"
              data-tag="confused" title="Mark as confused">Confused</button>
      ${conversation.problemUrl
        ? `<a href="${escapeHtml(conversation.problemUrl)}" target="_blank" class="btn btn--ghost btn--sm">Open &#8599;</a>`
        : ''}
    </div>
  `;

  // Tag button click handlers
  card.querySelectorAll('.tag-btn').forEach(btn => {
    btn.addEventListener('click', () => updateConversationTag(conversation.id, btn.dataset.tag, card));
  });

  return card;
}

/**
 * Updates the tag on a conversation both in storage (via service worker)
 * and in the UI card.
 *
 * We use chrome.storage directly here via a StorageManager call pattern
 * since we need to call updateArchivedConversation which isn't exposed via
 * message passing. Instead we send a tagged UPDATE message.
 *
 * @param {string}      conversationId - The conversation's id field.
 * @param {string}      tag            - 'revisit' | 'confident' | 'confused'.
 * @param {HTMLElement} cardEl         - The card DOM element to update visually.
 */
async function updateConversationTag(conversationId, tag, cardEl) {
  try {
    // Toggle off if same tag is clicked again
    const allConversations = await sendMessage({ type: MessageType.GET_CONVERSATIONS });
    const conversation = allConversations?.conversations?.find(c => c.id === conversationId);
    const newTag = conversation?.tag === tag ? null : tag;

    // We send a SAVE_CONVERSATION with the existing data + updated tag
    // The cleanest approach: add an UPDATE_CONVERSATION message type
    // For now, we use chrome.storage directly via background with a special payload
    await sendMessage({
      type: 'UPDATE_CONVERSATION_TAG',
      payload: { conversationId, tag: newTag },
    });

    // Update visual state of all tag buttons in the card
    cardEl.querySelectorAll('.tag-btn').forEach(btn => {
      btn.classList.toggle('tag-btn--active', btn.dataset.tag === newTag);
    });

    // Update the badge shown in the card header
    const existingBadge = cardEl.querySelector('.badge--revisit, .badge--confident, .badge--confused');
    if (existingBadge) existingBadge.remove();

    if (newTag) {
      const badge = document.createElement('span');
      badge.className = `badge badge--${newTag}`;
      badge.textContent = newTag;
      cardEl.querySelector('.history-card__header').appendChild(badge);
    }

    logger.debug('Tag updated', { conversationId, tag: newTag });

  } catch (error) {
    logger.error('updateConversationTag failed', error);
  }
}

// ---------------------------------------------------------------------------
// Message Passing Helper
// ---------------------------------------------------------------------------

/**
 * Sends a message to the extension service worker and returns the response.
 *
 * Wraps chrome.runtime.sendMessage in a Promise for use with async/await.
 * Also handles the common case where chrome.runtime.lastError indicates
 * that no listener received the message.
 *
 * @param {object} message - Message object with `type` from MessageType enum.
 * @returns {Promise<object>} The response from the service worker.
 * @throws {Error} If no listener responds or the message channel closes.
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// Security Utility
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent XSS when injecting user-visible
 * strings into innerHTML. Used for conversation titles, platform names, etc.
 *
 * @param {string} str - Raw string from storage or API.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// Auth Screen Logic
// ---------------------------------------------------------------------------

/**
 * Switches between the Login and Sign Up tabs inside the auth screen.
 *
 * @param {'login'|'signup'} mode - Which tab to activate.
 */
function switchAuthTab(mode) {
  const isLogin = mode === 'login';

  // Update tab button states
  UI.authTabLogin.setAttribute('aria-selected', isLogin ? 'true' : 'false');
  UI.authTabSignup.setAttribute('aria-selected', isLogin ? 'false' : 'true');
  UI.authTabLogin.classList.toggle('auth-tab--active', isLogin);
  UI.authTabSignup.classList.toggle('auth-tab--active', !isLogin);

  // Show/hide form panels
  UI.authPanelLogin.classList.toggle('auth-panel--hidden', !isLogin);
  UI.authPanelSignup.classList.toggle('auth-panel--hidden', isLogin);

  // Clear any lingering error when switching modes
  hideAuthError();
}

/**
 * Shows the auth screen and hides the main app shell.
 * Called on initial load when not authenticated and on logout.
 */
function showAuthScreen() {
  UI.authScreen.style.display = 'flex';
  UI.appShell.style.display   = 'none';
}

/**
 * Hides the auth screen and shows the main app shell.
 * Called after a successful login or sign-up.
 */
function showAppShell() {
  UI.authScreen.style.display = 'none';
  UI.appShell.style.display   = 'flex';
}

/**
 * Displays an inline error message on the auth screen.
 * Replaces alert() to keep error messages contextual and non-blocking.
 *
 * @param {string} message - Human-readable error text.
 */
function showAuthError(message) {
  UI.authErrorText.textContent = message;
  UI.authError.classList.remove('auth-error--hidden');
}

/** Hides the auth screen error banner. */
function hideAuthError() {
  UI.authError.classList.add('auth-error--hidden');
  UI.authErrorText.textContent = '';
}

/**
 * Shows the forgot password panel and hides the login/signup panels + tabs.
 */
function showForgotPassword() {
  hideAuthError();
  UI.authPanelLogin.classList.add('auth-panel--hidden');
  UI.authPanelSignup.classList.add('auth-panel--hidden');
  UI.authPanelForgot.classList.remove('auth-panel--hidden');
  UI.forgotSuccess.classList.add('auth-panel--hidden');
  UI.formForgot.classList.remove('auth-panel--hidden');
  UI.authTabLogin.style.display = 'none';
  UI.authTabSignup.style.display = 'none';
  // Pre-fill with login email if available
  if (UI.loginEmail.value.trim()) {
    UI.forgotEmail.value = UI.loginEmail.value.trim();
  }
}

/**
 * Hides the forgot password panel and returns to the login tab.
 */
function hideForgotPassword() {
  hideAuthError();
  UI.authPanelForgot.classList.add('auth-panel--hidden');
  UI.authTabLogin.style.display = '';
  UI.authTabSignup.style.display = '';
  switchAuthTab('login');
}

/**
 * Handles the forgot password form submission.
 * Sends a password reset email via Supabase.
 *
 * @param {SubmitEvent} event
 */
async function handleForgotPassword(event) {
  event.preventDefault();
  hideAuthError();

  const email = UI.forgotEmail.value.trim();
  if (!email) {
    showAuthError('Please enter your email address.');
    return;
  }

  UI.btnForgotSubmit.disabled = true;
  UI.btnForgotSubmit.textContent = 'Sending...';

  try {
    await supabase.auth.resetPasswordForEmail(email);
    // Show success message regardless of whether email exists (security best practice)
    UI.formForgot.classList.add('auth-panel--hidden');
    UI.forgotSuccess.classList.remove('auth-panel--hidden');
  } catch (error) {
    console.error('[DSA Mentor][AUTH] Password reset error:', error.message);
    showAuthError(error.message || 'Failed to send reset email. Please try again.');
  } finally {
    UI.btnForgotSubmit.disabled = false;
    UI.btnForgotSubmit.textContent = 'Send reset link';
  }
}

/**
 * Puts auth form buttons into a loading / disabled state while the network
 * request is in flight, preventing double-submissions.
 *
 * @param {boolean} loading - True to disable, false to re-enable.
 */
function setAuthLoading(loading) {
  UI.btnLogin.disabled      = loading;
  UI.btnSignup.disabled     = loading;
  UI.btnGoogleAuth.disabled = loading;

  // Provide visual feedback by changing button text during loading
  if (loading) {
    UI.btnLogin.textContent      = 'Signing in...';
    UI.btnSignup.textContent     = 'Creating account...';
    UI.btnGoogleAuth.querySelector('span').textContent = 'Connecting...';
  } else {
    UI.btnLogin.textContent      = 'Sign in';
    UI.btnSignup.textContent     = 'Create account';
    UI.btnGoogleAuth.querySelector('span').textContent = 'Continue with Google';
  }
}

/**
 * Handles the login form submission.
 * Validates inputs, calls Supabase, saves the session, and transitions to the app.
 *
 * @param {SubmitEvent} event - The form submit event.
 */
async function handleLogin(event) {
  event.preventDefault();
  hideAuthError();

  const email    = UI.loginEmail.value.trim();
  const password = UI.loginPassword.value;

  logger.info('Login attempt', { email });

  if (!email || !password) {
    showAuthError('Please enter your email and password.');
    return;
  }

  setAuthLoading(true);

  try {
    logger.debug('Calling supabase.auth.signInWithPassword...');
    const session = await supabase.auth.signInWithPassword({ email, password });
    logger.info('Login response received', {
      hasAccessToken: !!session.access_token,
      hasUser: !!session.user,
      userId: session.user?.id,
      expiresIn: session.expires_in,
    });
    await AuthManager.saveSession(session);
    await onAuthSuccess();
  } catch (error) {
    logger.error('Login failed', error);
    logger.error('Login error details', {
      message: error.message,
      stack: error.stack,
    });

    // Provide actionable guidance based on the error
    let friendlyMsg = error.message || 'Login failed. Please check your credentials.';
    if (error.errorCode === 'email_not_confirmed' || error.message?.includes('Email not confirmed')) {
      friendlyMsg = 'Your email is not confirmed yet. Please check your inbox for a confirmation link.';
    } else if (error.message?.includes('Invalid login credentials')) {
      friendlyMsg = 'Invalid login credentials. If you just signed up, check your email for a confirmation link before logging in.';
    }
    showAuthError(friendlyMsg);
  } finally {
    setAuthLoading(false);
  }
}

/**
 * Handles the sign-up form submission.
 * Validates inputs (including password match), calls Supabase, then auto-logs in.
 *
 * @param {SubmitEvent} event - The form submit event.
 */
async function handleSignup(event) {
  event.preventDefault();
  hideAuthError();

  const email    = UI.signupEmail.value.trim();
  const password = UI.signupPassword.value;
  const confirm  = UI.signupConfirm.value;

  logger.info('Signup attempt', { email });

  if (!email || !password || !confirm) {
    showAuthError('Please fill in all fields.');
    return;
  }

  if (password !== confirm) {
    showAuthError('Passwords do not match.');
    return;
  }

  if (password.length < 6) {
    showAuthError('Password must be at least 6 characters.');
    return;
  }

  setAuthLoading(true);

  try {
    logger.debug('Calling supabase.auth.signUp...');
    const signupResult = await supabase.auth.signUp({ email, password });
    logger.info('Signup response received', {
      hasSession: !!signupResult.session,
      hasUser: !!signupResult.user,
      userId: signupResult.user?.id,
      emailConfirmed: signupResult.user?.email_confirmed_at || 'NOT CONFIRMED',
      hasIdentities: !!(signupResult.user?.identities?.length),
    });

    if (signupResult.session) {
      // Email confirmation is disabled — we got a session directly
      logger.info('Email confirmation disabled — auto-logging in');
      await AuthManager.saveSession(signupResult.session);
      await onAuthSuccess();
    } else if (signupResult.user && signupResult.user.identities?.length === 0) {
      // Empty identities = user already exists (Supabase returns the existing
      // user object without identities to avoid leaking account existence).
      logger.warn('Signup returned empty identities — user likely already exists');
      showAuthError(
        'An account with this email already exists. Please log in instead, or check your inbox for a confirmation email.'
      );
      switchAuthTab('login');
      UI.loginEmail.value = email;
    } else {
      // Email confirmation is enabled — user must verify before logging in.
      logger.info('Email confirmation required — showing confirmation message');
      showAuthError(
        'Account created! Please check your email to confirm your address, then log in.'
      );
      switchAuthTab('login');
      UI.loginEmail.value = email;
    }
  } catch (error) {
    logger.error('Signup failed', error);
    logger.error('Signup error details', {
      message: error.message,
      stack: error.stack,
    });
    showAuthError(error.message || 'Sign up failed. This email may already be registered.');
  } finally {
    setAuthLoading(false);
  }
}

/**
 * Handles the Google OAuth button click.
 * Uses chrome.identity.launchWebAuthFlow (available in extension pages).
 */
async function handleGoogleAuth() {
  hideAuthError();
  setAuthLoading(true);

  try {
    const session = await supabase.auth.signInWithGoogle();
    await AuthManager.saveSession(session);
    await onAuthSuccess();
  } catch (error) {
    logger.error('Google auth failed', error);

    // User cancellation is not an error worth alarming the user about
    if (error.message?.includes('cancelled') || error.message?.includes('canceled')) {
      showAuthError('Sign-in was cancelled.');
    } else {
      showAuthError(
        error.message ||
        'Google sign-in failed. Ensure your Supabase project has the extension redirect URL configured.'
      );
    }
  } finally {
    setAuthLoading(false);
  }
}

/**
 * Called after any successful authentication (login, signup, or Google OAuth).
 * Hides the auth screen, shows the app, and loads initial data.
 *
 * @returns {Promise<void>}
 */
async function onAuthSuccess() {
  showAppShell();
  // Load settings now that we are authenticated
  await loadSettings();
  // Ensure the Mentor tab is active on first show
  switchTab('mentor');
  logger.info('Auth successful — app shell shown');
}

/**
 * Handles the logout button click.
 * Signs the user out via Supabase, clears the local session, and returns to
 * the auth screen.
 */
async function handleLogout() {
  try {
    const token = await AuthManager.getValidAccessToken();
    if (token) {
      // Best-effort server-side sign out — ignore failure (token may be expired)
      await supabase.auth.signOut(token).catch(err =>
        logger.warn('Server-side sign-out failed (non-fatal)', err)
      );
    }
  } catch (error) {
    logger.warn('Logout encountered an error (proceeding with local clear)', error);
  } finally {
    // Always clear the local session regardless of server-side result
    await AuthManager.clearSession();
    showAuthScreen();
    switchAuthTab('login');
    logger.info('User signed out');
  }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

/**
 * Binds all event listeners after the DOM is ready.
 * Using named functions (not inline lambdas) makes the handlers inspectable
 * in DevTools and avoids accidental multiple registrations.
 */
function bindEvents() {

  // ---- Tab switching ----
  UI.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ---- "Link" buttons that switch tabs from within content ----
  document.querySelectorAll('[data-tab-link]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tabLink));
  });

  // ---- Code extraction ----
  UI.btnExtractWelcome.addEventListener('click', extractCode);
  UI.btnExtract.addEventListener('click', extractCode);

  // ---- Clear chat ----
  UI.btnClearChat.addEventListener('click', clearChat);

  // ---- Get Hint ----
  UI.btnGetHint.addEventListener('click', getHint);

  // Allow Ctrl+Enter to submit from the textarea
  UI.userInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      getHint();
    }
  });

  // ---- Dismiss error ----
  UI.btnCloseError.addEventListener('click', hideChatError);

  // ---- Settings: provider selection ----
  UI.providerRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const provider = radio.value;
      updateProviderCardSelection(provider);
      populateModelDropdown(provider, AI_MODELS[provider]?.[0]?.id);

      // Load the stored key for the newly selected provider and update status
      getSettings().then(settings => {
        const key = settings?.apiKeys?.[provider] || '';
        UI.apiKeyInput.value = key;
        updateApiKeyStatus(provider, key);
      });
    });
  });

  // Also allow clicking the card label to select the radio
  UI.providerCards.forEach(card => {
    card.addEventListener('click', () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
      }
    });
  });

  // ---- Settings: save ----
  UI.btnSaveSettings.addEventListener('click', saveSettings);

  // ---- Settings: toggle API key visibility ----
  UI.btnToggleKeyVis.addEventListener('click', () => {
    const isPassword = UI.apiKeyInput.type === 'password';
    UI.apiKeyInput.type = isPassword ? 'text' : 'password';
    UI.btnToggleKeyVis.textContent = isPassword ? '\uD83D\uDEAB' : '\uD83D\uDC41\uFE0F';
  });

  // ---- Settings: model select ----
  UI.modelSelect.addEventListener('change', () => {
    state.currentModel = UI.modelSelect.value;
  });

  // ---- Auth: tab switching ----
  UI.authTabLogin.addEventListener('click',  () => switchAuthTab('login'));
  UI.authTabSignup.addEventListener('click', () => switchAuthTab('signup'));

  // ---- Auth: form submissions ----
  UI.formLogin.addEventListener('submit',  handleLogin);
  UI.formSignup.addEventListener('submit', handleSignup);

  // ---- Auth: Google OAuth ----
  UI.btnGoogleAuth.addEventListener('click', handleGoogleAuth);

  // ---- Auth: forgot password ----
  UI.btnForgotPwd.addEventListener('click', showForgotPassword);
  UI.formForgot.addEventListener('submit', handleForgotPassword);
  UI.btnBackToLogin.addEventListener('click', hideForgotPassword);
  UI.btnBackToLogin2.addEventListener('click', hideForgotPassword);

  // ---- Auth: logout ----
  UI.btnLogout.addEventListener('click', handleLogout);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Entry point — runs when the side panel HTML is fully parsed.
 *
 * Auth gate:
 *   1. Cache DOM refs and bind all event listeners first (so the auth
 *      form is interactive immediately, without waiting for auth check).
 *   2. Check AuthManager.isAuthenticated() — if true, go straight to
 *      the app; if false, show the auth screen.
 *
 * This ordering matters: if we show the auth screen before binding events,
 * the login button would be unresponsive until the auth check resolves.
 */
async function initialize() {
  cacheUIElements();
  bindEvents();

  // Record session start time for conversation archiving
  state.sessionStartedAt = new Date().toISOString();

  // Check authentication state to decide which screen to show.
  // isAuthenticated() is a fast local check (no network call).
  const isAuthenticated = await AuthManager.isAuthenticated();

  if (isAuthenticated) {
    // User has a valid (non-expired) session — show the app directly
    showAppShell();
    await loadSettings();
    switchTab('mentor');
    logger.info('Side panel initialized — user authenticated');
  } else {
    // No valid session — show the auth screen
    showAuthScreen();
    switchAuthTab('login'); // Always start on the login tab
    logger.info('Side panel initialized — auth screen shown');
  }
}

// Run when DOM is ready
document.addEventListener('DOMContentLoaded', initialize);
