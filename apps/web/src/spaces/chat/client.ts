import { formatChatTime } from './presentation.js';

interface ChatMessage {
  id: number;
  createdAt: number;
  nickname: string;
  anonymousId?: string;
  text: string;
}

interface ChatEventMessage extends ChatMessage {
  v: 1;
  space: 'chat';
  type: 'message';
}

interface ChatEventRemoval {
  v: 1;
  space: 'chat';
  type: 'remove';
  id: number;
}

type ChatEvent = ChatEventMessage | ChatEventRemoval;
interface HistorySnapshot {
  messages: ChatMessage[];
  latestId: number;
  oldestId: number | null;
  identity?: { anonymousId?: string };
}

const region = document.querySelector<HTMLElement>('#message-region')!;
const list = document.querySelector<HTMLOListElement>('#messages')!;
const emptyState = document.querySelector<HTMLElement>('#empty-state')!;
const newestButton = document.querySelector<HTMLButtonElement>('#newest')!;
const connectionStatus = document.querySelector<HTMLElement>('#connection-status')!;
const composer = document.querySelector<HTMLFormElement>('#composer')!;
const messageInput = document.querySelector<HTMLInputElement>('#message-input')!;
const sendButton = document.querySelector<HTMLButtonElement>('#send')!;
const feedback = document.querySelector<HTMLElement>('#send-feedback')!;
const identityButton = document.querySelector<HTMLButtonElement>('#identity-button')!;
const identityLabel = document.querySelector<HTMLElement>('#identity-label')!;
const nicknameDialog = document.querySelector<HTMLDialogElement>('#nickname-dialog')!;
const nicknameForm = document.querySelector<HTMLFormElement>('#nickname-form')!;
const nicknameInput = document.querySelector<HTMLInputElement>('#nickname')!;
const nicknameFeedback = document.querySelector<HTMLElement>('#nickname-feedback')!;

const messages = new Map<number, ChatMessage>();
const rows = new Map<number, HTMLLIElement>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const storageKey = 'the-open-web.chat.nickname';
const anonymousIdPattern = /^\d{9}$/;
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let syncGeneration = 0;
let syncing = false;
let syncBuffer: ChatEvent[] = [];
let bufferOverflowed = false;
let stickToBottom = true;
let unseen = 0;
let anonymousId: string | undefined;
let historyReady = false;
let currentNickname = '';
let sending = false;
let cooldownUntil = 0;
let cooldownTimer: number | undefined;
let feedbackTimer: number | undefined;
let pendingSend: { text: string; nickname: string; requestId: string } | undefined;
let viewportFrame: number | undefined;

try {
  const storedNickname = normalizeNickname(localStorage.getItem(storageKey) ?? '');
  currentNickname = /^anonymous\d+$/iu.test(storedNickname) ? '' : storedNickname;
  if (currentNickname !== storedNickname) localStorage.removeItem(storageKey);
} catch { /* The current visit remains usable when local storage is unavailable. */ }
nicknameInput.value = currentNickname;

function normalizeNickname(value: string): string {
  return value.normalize('NFC').replace(/[\t\r\n\p{White_Space}]+/gu, ' ').trim();
}

function validPublicId(value: unknown): value is string {
  return typeof value === 'string' && anonymousIdPattern.test(value);
}

function groupedId(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
}

function identityText(nickname: string, id = anonymousId): string {
  if (!id) return nickname || 'Checking your name…';
  return nickname ? `${nickname} · #${groupedId(id)}` : `Anonymous${id}`;
}

function renderIdentity(): void {
  const label = identityText(currentNickname);
  identityLabel.textContent = label;
  identityLabel.dataset.kind = currentNickname ? 'nickname' : 'anonymous';
  identityButton.setAttribute('aria-label', `${label}. Change nickname`);
}

function setConnection(text: string, state: 'connecting' | 'synchronizing' | 'connected' | 'reconnecting' | 'disconnected'): void {
  connectionStatus.textContent = text;
  connectionStatus.dataset.state = state;
}

function setFeedback(text: string, state: '' | 'pending' | 'success' | 'error' | 'cooldown' = '', clearAfter = 0): void {
  if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
  feedback.textContent = text;
  feedback.dataset.state = state;
  if (clearAfter > 0) {
    feedbackTimer = window.setTimeout(() => {
      if (feedback.textContent === text) setFeedback('');
    }, clearAfter);
  }
}

function updateEmptyState(): void {
  emptyState.hidden = messages.size > 0;
  if (messages.size > 0) return;
  emptyState.textContent = historyReady ? 'No messages yet.' : 'Loading messages…';
}

function atBottom(): boolean {
  return region.scrollHeight - region.scrollTop - region.clientHeight <= 48;
}

function scrollToBottom(smooth = false): void {
  region.scrollTo({ top: region.scrollHeight, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' });
  stickToBottom = true;
  unseen = 0;
  newestButton.hidden = true;
}

function showNewest(): void {
  if (unseen <= 0) {
    newestButton.hidden = true;
    newestButton.textContent = 'Jump to newest';
    newestButton.setAttribute('aria-label', 'Jump to newest messages');
    return;
  }
  newestButton.textContent = `${unseen} new ${unseen === 1 ? 'message' : 'messages'} · Jump to newest`;
  newestButton.setAttribute('aria-label', `Return to newest messages, ${unseen} new`);
  newestButton.hidden = false;
}

function makeRow(message: ChatMessage): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'message';
  row.dataset.messageId = String(message.id);
  if (validPublicId(message.anonymousId)) row.dataset.anonymousId = message.anonymousId;

  const date = new Date(message.createdAt);
  const time = document.createElement('time');
  time.dateTime = date.toISOString();
  const formattedTime = formatChatTime(message.createdAt);
  time.textContent = formattedTime.text;
  time.title = formattedTime.accessibleLabel;
  time.setAttribute('aria-label', formattedTime.accessibleLabel);

  const sender = document.createElement('span');
  sender.className = 'sender';
  const nickname = document.createElement('span');
  nickname.className = 'nickname';
  const isAnonymous = !message.nickname || message.nickname === 'Anonymous';
  nickname.textContent = isAnonymous && validPublicId(message.anonymousId)
    ? `Anonymous${message.anonymousId}`
    : (message.nickname || 'Anonymous');
  sender.append(nickname);
  if (!isAnonymous && validPublicId(message.anonymousId)) {
    const identityTag = document.createElement('span');
    identityTag.className = 'identity-tag';
    identityTag.textContent = `· #${groupedId(message.anonymousId)}`;
    identityTag.setAttribute('aria-label', `anonymous number ${message.anonymousId}`);
    sender.append(identityTag);
  }

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = message.text;
  row.append(time, sender, text);
  return row;
}

function insertMessage(message: ChatMessage, countAsNew: boolean): void {
  if (!Number.isSafeInteger(message.id) || message.id < 1 || !Number.isSafeInteger(message.createdAt)) return;
  if (messages.has(message.id)) return;
  const wasAtBottom = stickToBottom && atBottom();
  messages.set(message.id, message);
  const row = makeRow(message);
  rows.set(message.id, row);
  const nextId = [...messages.keys()].filter(id => id > message.id).sort((a, b) => a - b)[0];
  const nextRow = nextId === undefined ? undefined : rows.get(nextId);
  if (nextRow) list.insertBefore(row, nextRow);
  else list.append(row);

  const orderedIds = [...messages.keys()].sort((a, b) => a - b);
  while (orderedIds.length > 100) {
    const oldestId = orderedIds.shift()!;
    messages.delete(oldestId);
    rows.get(oldestId)?.remove();
    rows.delete(oldestId);
  }
  updateEmptyState();
  if (wasAtBottom) scrollToBottom();
  else if (countAsNew) {
    unseen += 1;
    showNewest();
  }
}

function removeMessage(id: number): void {
  const visibleAnchor = Array.from(list.querySelectorAll<HTMLLIElement>('.message'))
    .find(row => row.getBoundingClientRect().bottom > region.getBoundingClientRect().top);
  const anchorId = visibleAnchor?.dataset.messageId;
  const anchorTop = visibleAnchor?.getBoundingClientRect().top;
  const wasAtBottom = stickToBottom && atBottom();
  messages.delete(id);
  rows.get(id)?.remove();
  rows.delete(id);
  updateEmptyState();
  if (wasAtBottom) scrollToBottom();
  else if (anchorId && anchorId !== String(id) && anchorTop !== undefined) {
    const anchor = rows.get(Number(anchorId));
    if (anchor) region.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
}

function receiveEvent(event: ChatEvent): void {
  if (syncing) {
    if (syncBuffer.length < 1_000) syncBuffer.push(event);
    else bufferOverflowed = true;
    return;
  }
  if (event.type === 'message') insertMessage(event, true);
  else removeMessage(event.id);
}

function reconcile(snapshot: HistorySnapshot, events: ChatEvent[]): void {
  const previousBottom = atBottom();
  const previousIds = new Set(messages.keys());
  const oldAnchor = Array.from(list.querySelectorAll<HTMLLIElement>('.message'))
    .find(row => row.getBoundingClientRect().bottom > region.getBoundingClientRect().top);
  const oldAnchorId = oldAnchor?.dataset.messageId;
  const oldAnchorTop = oldAnchor?.getBoundingClientRect().top;

  if (validPublicId(snapshot.identity?.anonymousId)) {
    anonymousId = snapshot.identity.anonymousId;
    renderIdentity();
  }
  messages.clear();
  rows.clear();
  list.replaceChildren();
  for (const message of snapshot.messages) messages.set(message.id, message);
  const removed = new Set<number>();
  for (const event of events) {
    if (event.type === 'message') messages.set(event.id, {
      id: event.id,
      createdAt: event.createdAt,
      nickname: event.nickname,
      anonymousId: event.anonymousId,
      text: event.text,
    });
    else removed.add(event.id);
  }
  for (const id of removed) messages.delete(id);

  const ordered = [...messages.values()].sort((a, b) => a.id - b.id).slice(-100);
  const newlyVisible = ordered.reduce((count, message) => count + (previousIds.has(message.id) ? 0 : 1), 0);
  messages.clear();
  for (const message of ordered) {
    messages.set(message.id, message);
    const row = makeRow(message);
    rows.set(message.id, row);
    list.append(row);
  }
  historyReady = true;
  updateEmptyState();

  if (previousBottom || !oldAnchorId) scrollToBottom();
  else {
    const anchor = rows.get(Number(oldAnchorId));
    if (anchor && oldAnchorTop !== undefined) region.scrollTop += anchor.getBoundingClientRect().top - oldAnchorTop;
    stickToBottom = false;
  }
  unseen = previousBottom || !oldAnchorId ? 0 : newlyVisible;
  showNewest();
}

async function synchronize(): Promise<void> {
  const generation = ++syncGeneration;
  syncing = true;
  syncBuffer = [];
  bufferOverflowed = false;
  setConnection('Synchronizing', 'synchronizing');
  try {
    const response = await fetch('/api/chat/history', { cache: 'no-store' });
    if (!response.ok) throw new Error('history unavailable');
    const snapshot = await response.json() as HistorySnapshot;
    if (generation !== syncGeneration || socket?.readyState !== WebSocket.OPEN) return;
    const buffered = syncBuffer;
    const overflowed = bufferOverflowed;
    reconcile(snapshot, buffered);
    syncBuffer = [];
    syncing = false;
    setConnection('Connected', 'connected');
    if (overflowed) void synchronize();
  } catch {
    if (generation !== syncGeneration) return;
    syncing = true;
    setConnection('Restoring history', 'synchronizing');
    window.setTimeout(() => { if (socket?.readyState === WebSocket.OPEN) void synchronize(); }, 1_500);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  if (!navigator.onLine) {
    setConnection('Disconnected', 'disconnected');
    reconnectTimer = undefined;
    return;
  }
  const base = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(connect, delay);
}

function connect(): void {
  if (!navigator.onLine) {
    setConnection('Disconnected', 'disconnected');
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setConnection(reconnectAttempt ? 'Reconnecting' : 'Connecting', reconnectAttempt ? 'reconnecting' : 'connecting');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const next = new WebSocket(`${scheme}//${location.host}/api/events?space=chat`);
  socket = next;
  next.addEventListener('open', () => {
    reconnectAttempt = 0;
    void synchronize();
  });
  next.addEventListener('message', event => {
    try {
      const value = JSON.parse(String(event.data)) as ChatEvent;
      if (value.v !== 1 || value.space !== 'chat') return;
      if (value.type === 'message' && Number.isSafeInteger(value.id) && typeof value.nickname === 'string' && typeof value.text === 'string' && Number.isSafeInteger(value.createdAt)) receiveEvent(value);
      else if (value.type === 'remove' && Number.isSafeInteger(value.id)) receiveEvent(value);
    } catch { /* Ignore malformed frames; a future snapshot restores authoritative state. */ }
  });
  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = undefined;
    syncGeneration += 1;
    syncing = false;
    syncBuffer = [];
    setConnection('Reconnecting…', 'disconnected');
    scheduleReconnect();
  });
  next.addEventListener('error', () => next.close());
}

function updateViewportMetrics(): void {
  const visual = window.visualViewport;
  const height = visual?.height ?? window.innerHeight;
  const offsetTop = visual?.offsetTop ?? 0;
  const previousTop = region.scrollTop;
  const wasAtBottom = stickToBottom;
  document.documentElement.style.setProperty('--chat-viewport-height', `${height}px`);
  document.documentElement.style.setProperty('--chat-viewport-offset-top', `${offsetTop}px`);
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  viewportFrame = window.requestAnimationFrame(() => {
    if (wasAtBottom) scrollToBottom();
    else region.scrollTop = previousTop;
  });
}

window.addEventListener('offline', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  setConnection('Disconnected', 'disconnected');
});

window.addEventListener('online', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    setConnection('Reconnecting', 'reconnecting');
    connect();
  }
});

function showNicknameError(text: string): void {
  nicknameFeedback.textContent = text;
  nicknameFeedback.hidden = !text;
}

function openNicknameEditor(): void {
  nicknameInput.value = currentNickname;
  showNicknameError('');
  if (!nicknameDialog.open) nicknameDialog.showModal();
  window.requestAnimationFrame(() => nicknameInput.focus());
}

function closeNicknameEditor(): void {
  if (nicknameDialog.open) nicknameDialog.close();
}

identityButton.addEventListener('click', openNicknameEditor);
document.querySelector<HTMLButtonElement>('#nickname-cancel')!.addEventListener('click', closeNicknameEditor);
nicknameDialog.addEventListener('close', () => identityButton.focus());

nicknameForm.addEventListener('submit', event => {
  event.preventDefault();
  const next = normalizeNickname(nicknameInput.value);
  if (Array.from(next).length > 24 || new TextEncoder().encode(next).length > 48) {
    showNicknameError('Use up to 24 characters (48 bytes).');
    nicknameInput.focus();
    return;
  }
  if (/^anonymous\d+$/iu.test(next)) {
    showNicknameError('That pattern is reserved for anonymous visitor names.');
    nicknameInput.focus();
    return;
  }
  currentNickname = next;
  try { localStorage.setItem(storageKey, currentNickname); } catch { /* Keep the choice for this visit if storage is unavailable. */ }
  renderIdentity();
  closeNicknameEditor();
  setFeedback('Nickname saved for new messages.', 'success', 3_000);
});

region.addEventListener('scroll', () => {
  stickToBottom = atBottom();
  if (stickToBottom) {
    unseen = 0;
    showNewest();
  }
}, { passive: true });

newestButton.addEventListener('click', () => scrollToBottom(true));

function updateCooldown(): void {
  if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer);
  const remaining = cooldownUntil - Date.now();
  sendButton.disabled = sending || remaining > 0;
  if (remaining <= 0) {
    cooldownTimer = undefined;
    if (feedback.dataset.state === 'cooldown') setFeedback('You can send again. Your draft is still here.', '');
    return;
  }
  const showRemaining = () => {
    const wait = cooldownUntil - Date.now();
    if (wait <= 0) {
      updateCooldown();
      return;
    }
    sendButton.disabled = sending || wait > 0;
    setFeedback(`Wait about ${Math.max(1, Math.ceil(wait / 1_000))} seconds. Your draft stays here.`, 'cooldown');
  };
  showRemaining();
  cooldownTimer = window.setInterval(showRemaining, 1_000);
}

composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = messageInput.value;
  if (sending || Date.now() < cooldownUntil) return;
  if (!text.trim()) {
    setFeedback('Write a message before sending.', 'error');
    messageInput.focus();
    return;
  }
  if (!pendingSend || pendingSend.text !== text || pendingSend.nickname !== currentNickname) {
    pendingSend = { text, nickname: currentNickname, requestId: crypto.randomUUID() };
  }
  const submitted = pendingSend;
  sending = true;
  sendButton.disabled = true;
  setFeedback('Sending…', 'pending');
  try {
    const response = await fetch('/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submitted),
    });
    const result = await response.json() as { ok?: boolean; duplicate?: boolean; error?: string; retryAfterMs?: number; message?: ChatMessage | null };
    if (response.ok && result.ok) {
      if (result.message) insertMessage(result.message, true);
      if (messageInput.value === submitted.text) messageInput.value = '';
      pendingSend = undefined;
      sending = false;
      sendButton.disabled = false;
      setFeedback(result.duplicate ? (result.message ? 'Already sent.' : 'Your earlier message was accepted and has left recent history.') : 'Message sent.', 'success', 2_500);
    } else if (response.status === 429 && Number.isFinite(result.retryAfterMs)) {
      sending = false;
      cooldownUntil = Date.now() + Math.max(1, result.retryAfterMs!);
      updateCooldown();
    } else if (response.status === 400) {
      sending = false;
      pendingSend = undefined;
      sendButton.disabled = false;
      setFeedback(result.error === 'message too long' ? 'That message is too long. Shorten it and try again.' : result.error === 'invalid nickname' ? 'That nickname cannot be used. Choose another.' : 'Write a message before sending.', 'error');
    } else if (response.status === 503) {
      sending = false;
      sendButton.disabled = false;
      setFeedback('Sending is temporarily paused. Your draft is still here.', 'error');
    } else if (response.status === 401) {
      sending = false;
      sendButton.disabled = false;
      setFeedback('Refreshing your anonymous session. Your draft is still here.', 'error');
      void synchronize();
    } else {
      sending = false;
      sendButton.disabled = false;
      setFeedback('Could not confirm the send. Your draft is still here; try again.', 'error');
    }
  } catch {
    sending = false;
    sendButton.disabled = false;
    setFeedback('Connection interrupted. Your draft is still here; try again.', 'error');
  }
});

window.addEventListener('resize', updateViewportMetrics, { passive: true });
window.visualViewport?.addEventListener('resize', updateViewportMetrics, { passive: true });
window.visualViewport?.addEventListener('scroll', updateViewportMetrics, { passive: true });

window.addEventListener('pagehide', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer);
  if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer);
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  socket?.close();
});

renderIdentity();
updateEmptyState();
updateViewportMetrics();
connect();
