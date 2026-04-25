/**
 * dashboard/dashboard.js
 *
 * Groups conversations by problem_key (platform::slug).
 * Each problem appears once; clicking it expands its list of sessions.
 * Clicking a session opens the full chat in a modal.
 */

import { MessageType } from '../utils/constants.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** All conversations from Supabase, newest first */
let allConversations = [];

/**
 * Grouped structure: Map<problemKey, { meta, sessions[] }>
 * Built from allConversations after every load/filter.
 */
let groupedProblems = new Map();

/** Session currently shown in the modal */
let activeSession = null;

// ---------------------------------------------------------------------------
// DOM Cache
// ---------------------------------------------------------------------------

const UI = {};

function cacheElements() {
  UI.loadingState    = document.getElementById('loading-state');
  UI.emptyState      = document.getElementById('empty-state');
  UI.noResults       = document.getElementById('no-results');
  UI.grid            = document.getElementById('conversations-grid');
  UI.convCount       = document.getElementById('conv-count');
  UI.btnExportJson   = document.getElementById('btn-export-json');
  UI.btnResetFilters = document.getElementById('btn-reset-filters');
  UI.filterSearch    = document.getElementById('filter-search');
  UI.filterPlatform  = document.getElementById('filter-platform');
  UI.filterTag       = document.getElementById('filter-tag');
  UI.filterProvider  = document.getElementById('filter-provider');
  UI.modal           = document.getElementById('conv-modal');
  UI.modalBackdrop   = document.getElementById('modal-backdrop');
  UI.modalTitle      = document.getElementById('modal-title');
  UI.modalMeta       = document.getElementById('modal-meta');
  UI.modalBody       = document.getElementById('modal-body');
  UI.modalBtnClose   = document.getElementById('btn-close-modal');
  UI.modalBtnExportMd  = document.getElementById('btn-modal-export-md');
  UI.modalBtnOpenProb  = document.getElementById('btn-modal-open-problem');
}

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

async function loadConversations() {
  showLoadingState(true);
  try {
    const response = await sendMessage({ type: MessageType.GET_CONVERSATIONS });
    if (!response?.success) {
      logger.error('Failed to load conversations', response?.error);
      showLoadingState(false);
      return;
    }
    allConversations = response.conversations || [];
    showLoadingState(false);
    applyFiltersAndRender();
    logger.info('Loaded conversations', { count: allConversations.length });
  } catch (err) {
    logger.error('loadConversations failed', err);
    showLoadingState(false);
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Groups the given array of conversations by problem_key.
 * Returns a Map ordered by the most-recently-saved session per problem.
 *
 * @param {object[]} conversations
 * @returns {Map<string, { problemKey, problemTitle, platform, problemUrl, sessions[] }>}
 */
function groupByProblem(conversations) {
  const map = new Map();

  for (const conv of conversations) {
    const key = conv.problemKey || conv.problem_key || `${conv.platform}::unknown`;

    if (!map.has(key)) {
      map.set(key, {
        problemKey:   key,
        problemTitle: conv.problemTitle || conv.problem_title || 'Unknown Problem',
        platform:     conv.platform     || 'unknown',
        problemUrl:   conv.problemUrl   || conv.problem_url  || '',
        sessions:     [],
      });
    }

    map.get(key).sessions.push(conv);
  }

  // Each problem's sessions are already newest-first because allConversations is.
  return map;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function getFilteredConversations() {
  const search   = UI.filterSearch.value.toLowerCase().trim();
  const platform = UI.filterPlatform.value;
  const tag      = UI.filterTag.value;
  const provider = UI.filterProvider.value;

  return allConversations.filter(conv => {
    const title = (conv.problemTitle || conv.problem_title || '').toLowerCase();
    if (search   && !title.includes(search))                          return false;
    if (platform && conv.platform   !== platform)                     return false;
    if (tag === 'untagged' && conv.tag)                               return false;
    if (tag && tag !== 'untagged' && conv.tag !== tag)                return false;
    if (provider && (conv.aiProvider || conv.ai_provider) !== provider) return false;
    return true;
  });
}

function applyFiltersAndRender() {
  const filtered = getFilteredConversations();
  groupedProblems = groupByProblem(filtered);

  UI.grid.innerHTML = '';

  const totalProblems = groupByProblem(allConversations).size;
  UI.convCount.textContent =
    `${totalProblems} problem${totalProblems !== 1 ? 's' : ''} · ${allConversations.length} session${allConversations.length !== 1 ? 's' : ''}`;

  if (allConversations.length === 0) {
    UI.emptyState.classList.remove('empty-state-dash--hidden');
    UI.noResults.classList.add('empty-state-dash--hidden');
    return;
  }
  UI.emptyState.classList.add('empty-state-dash--hidden');

  if (groupedProblems.size === 0) {
    UI.noResults.classList.remove('empty-state-dash--hidden');
    return;
  }
  UI.noResults.classList.add('empty-state-dash--hidden');

  groupedProblems.forEach(problem => {
    UI.grid.appendChild(buildProblemCard(problem));
  });
}

// ---------------------------------------------------------------------------
// Problem Card Builder
// ---------------------------------------------------------------------------

/**
 * Builds one problem card that groups all sessions under a single problem_key.
 * The sessions list is collapsed by default; clicking the header expands it.
 */
function buildProblemCard(problem) {
  const card = document.createElement('div');
  card.className = 'prob-card';

  const sessionCount = problem.sessions.length;
  const latestDate   = formatDate(problem.sessions[0]?.savedAt || problem.sessions[0]?.saved_at);

  // Collect unique tags across sessions for a summary
  const tags = [...new Set(problem.sessions.map(s => s.tag).filter(Boolean))];
  const tagBadges = tags.map(t => `<span class="badge badge--${t}">${t}</span>`).join(' ');

  card.innerHTML = `
    <div class="prob-card__header" role="button" tabindex="0" aria-expanded="false">
      <div class="prob-card__left">
        <span class="prob-card__title">${escapeHtml(problem.problemTitle)}</span>
        <div class="prob-card__meta">
          <span class="badge badge--platform">${escapeHtml(problem.platform)}</span>
          ${tagBadges}
          <span class="prob-card__date">${latestDate}</span>
        </div>
      </div>
      <div class="prob-card__right">
        <span class="prob-card__count">${sessionCount} session${sessionCount !== 1 ? 's' : ''}</span>
        <span class="prob-card__chevron">›</span>
      </div>
    </div>
    <div class="prob-card__sessions" hidden></div>
  `;

  const header   = card.querySelector('.prob-card__header');
  const sessions = card.querySelector('.prob-card__sessions');

  // Toggle expand/collapse
  function toggle() {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', !expanded);
    sessions.hidden = expanded;
    card.querySelector('.prob-card__chevron').style.transform = expanded ? '' : 'rotate(90deg)';

    if (!expanded && sessions.childElementCount === 0) {
      // Lazy-render sessions on first expand
      problem.sessions.forEach(session => {
        sessions.appendChild(buildSessionRow(session, problem));
      });
    }
  }

  header.addEventListener('click', toggle);
  header.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(); });

  return card;
}

// ---------------------------------------------------------------------------
// Session Row Builder (inside expanded problem card)
// ---------------------------------------------------------------------------

/**
 * Builds one session row inside an expanded problem card.
 * Each row = one conversation (one chat session).
 */
function buildSessionRow(session, problem) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.dataset.id = session.id;

  const date       = formatDate(session.savedAt || session.saved_at);
  const turns      = Math.floor(((session.messages || []).length) / 2);
  const provider   = session.aiProvider || session.ai_provider || '';
  const tag        = session.tag;
  const firstMsg   = (session.messages || []).find(m => m.role === 'user');
  const preview    = firstMsg?.content?.slice(0, 90) || '';

  row.innerHTML = `
    <div class="session-row__top">
      <span class="session-row__date">${date}</span>
      <span class="session-row__provider">${escapeHtml(provider)}</span>
      ${tag ? `<span class="badge badge--${tag}">${tag}</span>` : '<span class="session-row__no-tag">—</span>'}
    </div>
    ${preview ? `<p class="session-row__preview">${escapeHtml(preview)}</p>` : ''}
    <div class="session-row__actions">
      <span class="session-row__turns">${turns} exchange${turns !== 1 ? 's' : ''}</span>
      <div class="session-row__tags">
        <button class="tag-btn tag-btn--revisit  ${tag === 'revisit'   ? 'tag-btn--active' : ''}" data-tag="revisit">Revisit</button>
        <button class="tag-btn tag-btn--confident ${tag === 'confident' ? 'tag-btn--active' : ''}" data-tag="confident">Confident</button>
        <button class="tag-btn tag-btn--confused  ${tag === 'confused'  ? 'tag-btn--active' : ''}" data-tag="confused">Confused</button>
      </div>
      <button class="btn btn--ghost btn--sm session-row__view">View chat</button>
    </div>
  `;

  // Open modal on "View chat"
  row.querySelector('.session-row__view').addEventListener('click', e => {
    e.stopPropagation();
    openModal(session, problem);
  });

  // Tag buttons
  row.querySelectorAll('.tag-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      updateTag(session.id, btn.dataset.tag, row);
    });
  });

  return row;
}

// ---------------------------------------------------------------------------
// Tag Management
// ---------------------------------------------------------------------------

async function updateTag(convId, tag, rowEl) {
  const conv   = allConversations.find(c => c.id === convId);
  if (!conv) return;
  const newTag = conv.tag === tag ? null : tag;

  try {
    const response = await sendMessage({
      type: 'UPDATE_CONVERSATION_TAG',
      payload: { conversationId: convId, tag: newTag },
    });
    if (!response?.success) return;

    conv.tag = newTag;

    // Refresh tag buttons in this row
    rowEl.querySelectorAll('.tag-btn').forEach(btn => {
      btn.classList.toggle('tag-btn--active', btn.dataset.tag === newTag);
    });

    // Update badge
    const badgeEl = rowEl.querySelector('.badge[class*="badge--"]');
    const noTagEl = rowEl.querySelector('.session-row__no-tag');
    if (newTag) {
      if (badgeEl) { badgeEl.className = `badge badge--${newTag}`; badgeEl.textContent = newTag; }
      else if (noTagEl) noTagEl.outerHTML = `<span class="badge badge--${newTag}">${newTag}</span>`;
    } else {
      if (badgeEl) badgeEl.outerHTML = `<span class="session-row__no-tag">—</span>`;
    }
  } catch (err) {
    logger.error('updateTag failed', err);
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal(session, problem) {
  activeSession = session;

  UI.modalTitle.textContent = problem.problemTitle || 'Conversation';

  const provider = session.aiProvider || session.ai_provider || '';
  const model    = session.aiModel    || session.ai_model    || '';
  const date     = formatDate(session.savedAt || session.saved_at);
  const tag      = session.tag;

  UI.modalMeta.innerHTML = `
    <span class="badge badge--platform">${escapeHtml(problem.platform)}</span>
    <span class="badge badge--provider">${escapeHtml(provider)} ${model ? '/ ' + escapeHtml(model) : ''}</span>
    <span>${date}</span>
    ${tag ? `<span class="badge badge--${tag}">${tag}</span>` : ''}
  `;

  UI.modalBody.innerHTML = '';
  (session.messages || []).forEach(msg => {
    UI.modalBody.appendChild(buildModalMessage(msg));
  });

  if (problem.problemUrl) {
    UI.modalBtnOpenProb.href = problem.problemUrl;
    UI.modalBtnOpenProb.style.display = '';
  } else {
    UI.modalBtnOpenProb.style.display = 'none';
  }

  UI.modal.classList.remove('modal--hidden');
  UI.modalBody.scrollTop = 0;
}

function buildModalMessage(msg) {
  const el     = document.createElement('div');
  el.className = `modal-message modal-message--${msg.role}`;

  const roleEl    = document.createElement('span');
  roleEl.className = 'modal-message__role';
  roleEl.textContent = msg.role === 'user' ? 'You' : 'Mentor';

  const bubbleEl    = document.createElement('div');
  bubbleEl.className = 'modal-message__bubble';
  bubbleEl.textContent = msg.content;

  el.appendChild(roleEl);
  el.appendChild(bubbleEl);
  return el;
}

function closeModal() {
  UI.modal.classList.add('modal--hidden');
  activeSession = null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportAllAsJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    version: '2.0',
    problems: [...groupByProblem(allConversations).values()],
  };
  downloadFile(JSON.stringify(data, null, 2), 'dsa-mentor-export.json', 'application/json');
}

function exportSessionAsMarkdown() {
  if (!activeSession) return;
  const s     = activeSession;
  const title = s.problemTitle || s.problem_title || 'DSA Problem';
  const lines = [
    `# ${title}`, '',
    `**Platform:** ${s.platform || ''}`,
    `**Provider:** ${s.aiProvider || s.ai_provider || ''} / ${s.aiModel || s.ai_model || ''}`,
    `**Date:** ${formatDate(s.savedAt || s.saved_at)}`,
    s.tag ? `**Tag:** ${s.tag}` : '',
    s.problemUrl ? `**URL:** ${s.problemUrl || s.problem_url}` : '',
    '', '---', '', '## Conversation', '',
  ];

  (s.messages || []).forEach(m => {
    lines.push(m.role === 'user' ? '**You:**' : '**Mentor:**');
    lines.push('');
    lines.push(m.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  const filename = `dsa-${title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.md`;
  downloadFile(lines.join('\n'), filename, 'text/markdown');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function downloadFile(content, filename, mime) {
  const a  = document.createElement('a');
  a.href   = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showLoadingState(visible) {
  UI.loadingState.style.display = visible ? 'flex' : 'none';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(response);
      });
    } catch (err) { reject(err); }
  });
}

// ---------------------------------------------------------------------------
// Events & Init
// ---------------------------------------------------------------------------

function bindEvents() {
  UI.filterSearch.addEventListener('input',   applyFiltersAndRender);
  UI.filterPlatform.addEventListener('change', applyFiltersAndRender);
  UI.filterTag.addEventListener('change',      applyFiltersAndRender);
  UI.filterProvider.addEventListener('change', applyFiltersAndRender);

  UI.btnResetFilters.addEventListener('click', () => {
    UI.filterSearch.value = UI.filterPlatform.value = UI.filterTag.value = UI.filterProvider.value = '';
    applyFiltersAndRender();
  });

  UI.btnExportJson.addEventListener('click', exportAllAsJson);
  UI.modalBtnClose.addEventListener('click', closeModal);
  UI.modalBackdrop.addEventListener('click', closeModal);
  UI.modalBtnExportMd.addEventListener('click', exportSessionAsMarkdown);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !UI.modal.classList.contains('modal--hidden')) closeModal();
  });
}

async function initialize() {
  cacheElements();
  bindEvents();
  await loadConversations();
  logger.info('Dashboard initialized');
}

document.addEventListener('DOMContentLoaded', initialize);
