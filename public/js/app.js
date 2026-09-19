/**
 * Frontend for the random text chat platform.
 *
 * The client renders what the server tells it and nothing more: whether the
 * partner is a human or the AI, and whether a message was translated, are both
 * server facts carried on every message (§38). The client never guesses.
 */
import { applyTranslations, getLocale, interestLabel, setLocale, t } from './i18n.js';

const el = (id) => document.getElementById(id);

const ui = {
  screens: {
    home: el('screen-home'),
    searching: el('screen-searching'),
    chat: el('screen-chat'),
    ended: el('screen-ended'),
  },
  languageSelect: el('language-select'),
  interestChips: el('interest-chips'),
  startButton: el('start-button'),
  densityLine: el('density-line'),
  searchStatus: el('search-status'),
  searchDetail: el('search-detail'),
  botOffer: el('bot-offer'),
  acceptBot: el('accept-bot'),
  declineBot: el('decline-bot'),
  requestBot: el('request-bot'),
  cancelSearch: el('cancel-search'),
  badges: el('chat-badges'),
  translationBanner: el('translation-banner'),
  degradedBanner: el('degraded-banner'),
  messages: el('messages'),
  typingIndicator: el('typing-indicator'),
  composer: el('composer'),
  composerInput: el('composer-input'),
  skipButton: el('skip-button'),
  stopButton: el('stop-button'),
  reportButton: el('report-button'),
  endedTitle: el('ended-title'),
  endedDetail: el('ended-detail'),
  newChat: el('new-chat'),
  backHome: el('back-home'),
  humanModal: el('human-modal'),
  acceptHuman: el('accept-human'),
  stayWithBot: el('stay-with-bot'),
  toast: el('toast'),
};

const state = {
  config: null,
  socket: null,
  connected: false,
  reconnectAttempts: 0,
  /** Kept in localStorage so "never matched before" survives a refresh. */
  anonymousUserId: null,
  language: 'en',
  interests: new Set(),
  languageNames: new Map(),
  partnerKind: null,
  translation: null,
  /** Set while the user intends to be searching, so reconnects resume it. */
  wantsToSearch: false,
  typingSentAt: 0,
  typingStopTimer: null,
};

// ------------------------------------------------------------------ storage

function loadStored() {
  try {
    state.anonymousUserId = localStorage.getItem('sc:anon') ?? null;
    const language = localStorage.getItem('sc:lang');
    if (language) state.language = language;
    const interests = localStorage.getItem('sc:interests');
    if (interests) for (const i of JSON.parse(interests)) state.interests.add(i);
  } catch {
    /* private mode or blocked storage — defaults are fine */
  }
}

function persist() {
  try {
    if (state.anonymousUserId) localStorage.setItem('sc:anon', state.anonymousUserId);
    localStorage.setItem('sc:lang', state.language);
    localStorage.setItem('sc:interests', JSON.stringify([...state.interests]));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------- language display

const displayNamesCache = new Map();

/**
 * A language name in the language the user is reading.
 *
 * The server only ever sends codes, so the name is rendered client-side:
 * Intl.DisplayNames when the browser has it ("İngilizce" for a Turkish
 * reader), otherwise the endonym from /api/config ("English").
 */
function languageName(code) {
  const locale = getLocale();
  const key = `${locale}:${code}`;
  if (displayNamesCache.has(key)) return displayNamesCache.get(key);

  let name;
  try {
    name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
  } catch {
    name = undefined;
  }
  if (!name || name === code) name = state.languageNames.get(code) ?? code;

  displayNamesCache.set(key, name);
  return name;
}

// ------------------------------------------------------------------ screens

function show(name) {
  for (const [key, node] of Object.entries(ui.screens)) {
    if (key === name) node.setAttribute('data-active', '');
    else node.removeAttribute('data-active');
  }
  if (name === 'chat') ui.composerInput.focus();
}

let toastTimer = null;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 3200);
}

// ------------------------------------------------------------------- set-up

async function loadConfig() {
  const res = await fetch('/api/config');
  state.config = await res.json();

  for (const language of state.config.languages) {
    state.languageNames.set(language.code, language.label);
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = `${language.flag} ${language.label}`;
    ui.languageSelect.append(option);
  }

  const browserDefault = navigator.language?.split('-')[0];
  if (!state.languageNames.has(state.language)) {
    state.language = state.languageNames.has(browserDefault) ? browserDefault : 'en';
  }
  ui.languageSelect.value = state.language;

  for (const interest of state.config.interests) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.interest = interest;
    chip.setAttribute('aria-pressed', String(state.interests.has(interest)));
    chip.textContent = interestLabel(interest);
    chip.addEventListener('click', () => toggleInterest(interest, chip));
    ui.interestChips.append(chip);
  }

  setLocale(state.language);
  applyTranslations();
  refreshInterestLabels();
}

function toggleInterest(interest, chip) {
  // Up to five, matching the server-side cap.
  if (state.interests.has(interest)) state.interests.delete(interest);
  else if (state.interests.size < 5) state.interests.add(interest);
  else return;
  chip.setAttribute('aria-pressed', String(state.interests.has(interest)));
  persist();
}

function refreshInterestLabels() {
  for (const chip of ui.interestChips.children) {
    chip.textContent = interestLabel(chip.dataset.interest);
  }
}

/** §6 — a quiet hint about how busy the chosen language is. */
async function refreshDensity() {
  try {
    const res = await fetch('/api/languages');
    const body = await res.json();
    const waiting = body.density?.[state.language] ?? 0;
    if (waiting > 0) {
      ui.densityLine.textContent = t('online', {
        count: waiting,
        language: languageName(state.language),
      });
      ui.densityLine.hidden = false;
    } else {
      ui.densityLine.hidden = true;
    }
  } catch {
    ui.densityLine.hidden = true;
  }
}

// --------------------------------------------------------------- websocket

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.connected = true;
    if (state.reconnectAttempts > 0) toast(t('reconnected'));
    state.reconnectAttempts = 0;
    send({
      type: 'hello',
      language: state.language,
      interests: [...state.interests],
      ...(state.anonymousUserId ? { anonymousUserId: state.anonymousUserId } : {}),
    });
    if (state.wantsToSearch) startSearch();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener('close', () => {
    state.connected = false;
    state.reconnectAttempts += 1;
    toast(t('connectionLost'));
    // Exponential-ish backoff, capped, so a server restart recovers on its own.
    const delay = Math.min(8000, 400 * 2 ** Math.min(state.reconnectAttempts, 4));
    setTimeout(connect, delay);
  });
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

// ------------------------------------------------------------ server events

function handleServerMessage(message) {
  switch (message.type) {
    case 'session':
      state.anonymousUserId = message.anonymousUserId;
      persist();
      break;

    case 'searching':
      state.partnerKind = null;
      ui.botOffer.hidden = true;
      ui.requestBot.hidden = !state.config?.bot?.enabled;
      ui.searchStatus.textContent = t('searching');
      ui.searchDetail.textContent = '';
      show('searching');
      break;

    case 'search-status':
      renderSearchStatus(message);
      break;

    case 'matched':
      enterChat(message);
      break;

    case 'bot-offer':
      // The standing button would just duplicate the offer's own accept.
      ui.requestBot.hidden = true;
      ui.botOffer.hidden = false;
      break;

    case 'bot-matched':
      enterBotChat(message);
      break;

    case 'bot-unavailable':
      ui.botOffer.hidden = true;
      toast(
        message.retryAfterMs
          ? t('botCooldown', { seconds: Math.ceil(message.retryAfterMs / 1000) })
          : t('botUnavailable'),
      );
      break;

    case 'message':
      appendMessage(message);
      break;

    case 'partner-typing':
      ui.typingIndicator.hidden = !message.active;
      if (message.active) scrollMessages();
      break;

    case 'human-available':
      ui.humanModal.hidden = false;
      break;

    case 'partner-left':
      endConversation(
        message.reason === 'disconnected' ? t('partnerDisconnected') : t('partnerLeft'),
      );
      break;

    case 'translation-degraded':
      ui.degradedBanner.textContent = `⚠️ ${t('translationDegraded')}`;
      ui.degradedBanner.hidden = false;
      break;

    case 'ended':
      handleEnded(message.reason);
      break;

    case 'error':
      if (message.code === 'rate-limited') toast(t('rateLimited'));
      break;

    default:
      break;
  }
}

function renderSearchStatus(message) {
  const language = languageName(message.language);
  if (message.statusKey === 'still-looking-same-language') {
    ui.searchStatus.textContent = t('stillLookingSameLanguage', { language });
  } else if (message.statusKey === 'expanding-other-languages') {
    ui.searchStatus.textContent = t('searching');
    ui.searchDetail.textContent = t('expandingOtherLanguages');
  }
}

// ---------------------------------------------------------------- chat view

function resetChatView() {
  clearTimeout(state.typingStopTimer);
  state.typingStopTimer = null;
  state.typingSentAt = 0;
  ui.messages.replaceChildren();
  ui.typingIndicator.hidden = true;
  ui.degradedBanner.hidden = true;
  ui.translationBanner.hidden = true;
  ui.humanModal.hidden = true;
  ui.botOffer.hidden = true;
}

/** §38 — the header badges: 🟢 Human / 🌐 Translated / 🤖 AI. */
function renderBadges({ human, translated, ai }) {
  ui.badges.replaceChildren();
  const add = (className, text) => {
    const span = document.createElement('span');
    span.className = `badge badge--${className}`;
    span.textContent = text;
    ui.badges.append(span);
  };
  if (human) add('human', `🟢 ${t('badgeHuman')}`);
  if (ai) add('ai', `🤖 ${t('badgeAi')}`);
  if (translated) add('translated', `🌐 ${t('badgeTranslated')}`);
}

function enterChat(message) {
  resetChatView();
  state.wantsToSearch = false;
  state.partnerKind = 'human';
  state.translation = message.translation;

  renderBadges({ human: true, translated: message.translation.enabled, ai: false });

  // §14 — say plainly why the other person's words arrive in your language.
  if (message.translation.enabled) {
    ui.translationBanner.textContent = `🌐 ${t('translationBanner', {
      your: languageName(message.translation.yourLanguage),
      partner: languageName(message.translation.partnerLanguage),
    })}`;
    ui.translationBanner.hidden = false;
  }

  systemMessage(t('connected'));
  if (message.commonInterests?.length) {
    systemMessage(
      t('sharedInterests', {
        interests: message.commonInterests.map(interestLabel).join(', '),
      }),
    );
  }
  show('chat');
}

function enterBotChat(message) {
  resetChatView();
  state.wantsToSearch = false;
  state.partnerKind = 'bot';
  state.translation = null;
  renderBadges({ human: false, translated: false, ai: true });
  systemMessage(t('connectedBot'));
  show('chat');
}

function systemMessage(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message message--system';
  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';
  bubble.textContent = text;
  wrapper.append(bubble);
  ui.messages.append(wrapper);
  scrollMessages();
}

function appendMessage(message) {
  if (message.from === 'system') {
    systemMessage(message.text);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message message--${message.from} message--${message.kind}`;

  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';
  bubble.textContent = message.text;
  wrapper.append(bubble);

  // §10 — a translated message keeps its original one tap away.
  if (message.translated && message.originalText) {
    const meta = document.createElement('div');
    meta.className = 'message__meta';

    const tag = document.createElement('span');
    tag.textContent = `🌐 ${t('badgeTranslated')}`;
    meta.append(tag);

    const original = document.createElement('div');
    original.className = 'message__original';
    original.textContent = message.originalText;
    original.hidden = true;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'message__original-toggle';
    toggle.textContent = t('showOriginal');
    toggle.addEventListener('click', () => {
      original.hidden = !original.hidden;
      toggle.textContent = original.hidden ? t('showOriginal') : t('hideOriginal');
      scrollMessages();
    });
    meta.append(toggle);

    wrapper.append(meta, original);
  }

  ui.messages.append(wrapper);
  scrollMessages();
}

function scrollMessages() {
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function endConversation(detail) {
  state.partnerKind = null;
  ui.endedTitle.textContent = t('conversationEnded');
  ui.endedDetail.textContent = detail;
  ui.humanModal.hidden = true;
  show('ended');
}

function handleEnded(reason) {
  const detail =
    reason === 'cancelled'
      ? t('cancelled')
      : reason === 'bot-session-limit'
        ? t('botLimitReached')
        : t('youLeft');

  if (reason === 'cancelled') {
    state.wantsToSearch = false;
    show('home');
    void refreshDensity();
    return;
  }
  endConversation(detail);
}

// ------------------------------------------------------------------ actions

function startSearch() {
  state.wantsToSearch = true;
  resetChatView();
  send({ type: 'start', language: state.language, interests: [...state.interests] });
}

ui.languageSelect.addEventListener('change', () => {
  state.language = ui.languageSelect.value;
  setLocale(state.language);
  displayNamesCache.clear();
  applyTranslations();
  refreshInterestLabels();
  persist();
  void refreshDensity();
});

ui.startButton.addEventListener('click', () => startSearch());

ui.cancelSearch.addEventListener('click', () => {
  state.wantsToSearch = false;
  send({ type: 'cancel' });
});

ui.acceptBot.addEventListener('click', () => {
  ui.botOffer.hidden = true;
  send({ type: 'accept-bot' });
});

ui.declineBot.addEventListener('click', () => {
  ui.botOffer.hidden = true;
  // They chose to wait, so leave the door open without interrupting again.
  ui.requestBot.hidden = !state.config?.bot?.enabled;
  send({ type: 'decline-bot' });
});

ui.requestBot.addEventListener('click', () => {
  ui.botOffer.hidden = true;
  send({ type: 'request-bot' });
});

function stopTyping() {
  clearTimeout(state.typingStopTimer);
  state.typingStopTimer = null;
  if (state.typingSentAt === 0) return;
  state.typingSentAt = 0;
  send({ type: 'typing', active: false });
}

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.composerInput.value.trim();
  if (!text) return;
  stopTyping();
  send({ type: 'message', text });
  ui.composerInput.value = '';
});

ui.composerInput.addEventListener('input', () => {
  // Clear the partner's indicator once the user pauses, not only when they send.
  clearTimeout(state.typingStopTimer);
  state.typingStopTimer = setTimeout(stopTyping, 3000);

  if (ui.composerInput.value === '') {
    stopTyping();
    return;
  }

  // Throttled so a fast typist does not flood the socket.
  const now = Date.now();
  if (now - state.typingSentAt < 1800) return;
  state.typingSentAt = now;
  send({ type: 'typing', active: true });
});

ui.skipButton.addEventListener('click', () => {
  state.wantsToSearch = true;
  send({ type: 'skip' });
});

ui.stopButton.addEventListener('click', () => {
  state.wantsToSearch = false;
  send({ type: 'leave' });
});

ui.reportButton.addEventListener('click', () => {
  send({ type: 'report' });
  toast(t('reported'));
  state.wantsToSearch = true;
});

ui.acceptHuman.addEventListener('click', () => {
  ui.humanModal.hidden = true;
  state.wantsToSearch = true;
  send({ type: 'accept-human' });
});

ui.stayWithBot.addEventListener('click', () => {
  ui.humanModal.hidden = true;
  send({ type: 'stay-with-bot' });
});

ui.newChat.addEventListener('click', () => startSearch());

ui.backHome.addEventListener('click', () => {
  state.wantsToSearch = false;
  show('home');
  void refreshDensity();
});

// Keep the connection honest while a tab sits in the background.
setInterval(() => {
  if (state.connected) send({ type: 'ping' });
}, 20000);

// ---------------------------------------------------------------- bootstrap

loadStored();
await loadConfig();
connect();
void refreshDensity();
setInterval(() => {
  if (ui.screens.home.hasAttribute('data-active')) void refreshDensity();
}, 15000);

// Re-apply translations if the locale changed before the DOM was ready.
setLocale(getLocale());
