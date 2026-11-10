interface ChatMessage {
  id: number;
  createdAt: number;
  nickname: string;
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
interface HistorySnapshot { messages: ChatMessage[]; latestId: number; oldestId: number | null; }

const region = document.querySelector<HTMLElement>('#message-region')!;
const list = document.querySelector<HTMLOListElement>('#messages')!;
const emptyState = document.querySelector<HTMLElement>('#empty-state')!;
const newestButton = document.querySelector<HTMLButtonElement>('#newest')!;
const connectionStatus = document.querySelector<HTMLElement>('#connection-status')!;
const composer = document.querySelector<HTMLFormElement>('#composer')!;
const messageInput = document.querySelector<HTMLInputElement>('#message-input')!;
const nicknameInput = document.querySelector<HTMLInputElement>('#nickname')!;
const sendButton = document.querySelector<HTMLButtonElement>('#send')!;
const feedback = document.querySelector<HTMLElement>('#send-feedback')!;

const messages = new Map<number, ChatMessage>();
const rows = new Map<number, HTMLLIElement>();
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let syncGeneration = 0;
let syncing = false;
let syncBuffer: ChatEvent[] = [];
let bufferOverflowed = false;
let stickToBottom = true;
let unseen = 0;
let cooldownUntil = 0;
let cooldownTimer: number | undefined;
let pendingSend: { text: string; nickname: string; requestId: string } | undefined;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const storageKey = 'the-open-web.chat.nickname';

try { nicknameInput.value = localStorage.getItem(storageKey) ?? ''; } catch { /* private browsing may disable local storage */ }

function updateEmptyState(): void {
  emptyState.hidden = messages.size > 0;
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
  const time = document.createElement('time');
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = time.dateTime;
  time.textContent = `${time.dateTime.slice(11, 16)} UTC`;
  const author = document.createElement('span');
  author.className = 'nickname';
  author.textContent = `${message.nickname}:`;
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = message.text;
  row.append(time, author, text);
  return row;
}

function insertMessage(message: ChatMessage, countAsNew: boolean): void {
  if (!Number.isSafeInteger(message.id) || message.id < 1 || !Number.isSafeInteger(message.createdAt)) return;
  const previous = messages.get(message.id);
  if (previous) return;
  const wasAtBottom = stickToBottom && atBottom();
  messages.set(message.id, message);
  const row = makeRow(message);
  rows.set(message.id, row);
  const next = [...messages.keys()].filter(id => id > message.id).sort((a, b) => a - b)[0];
  const nextRow = next === undefined ? undefined : rows.get(next);
  if (nextRow) list.insertBefore(row, nextRow);
  else list.append(row);

  const sorted = [...messages.keys()].sort((a, b) => a - b);
  while (sorted.length > 100) {
    const oldestId = sorted.shift()!;
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
  messages.delete(id);
  rows.get(id)?.remove();
  rows.delete(id);
  updateEmptyState();
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
  const oldAnchor = Array.from(list.querySelectorAll<HTMLLIElement>('.message')).find(row => row.getBoundingClientRect().bottom > region.getBoundingClientRect().top);
  const oldAnchorId = oldAnchor?.dataset.messageId;
  const oldAnchorTop = oldAnchor?.getBoundingClientRect().top;

  messages.clear();
  rows.clear();
  list.replaceChildren();
  for (const message of snapshot.messages) messages.set(message.id, message);
  const removed = new Set<number>();
  for (const event of events) {
    if (event.type === 'message') messages.set(event.id, { id: event.id, createdAt: event.createdAt, nickname: event.nickname, text: event.text });
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
  connectionStatus.textContent = 'Synchronizing';
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
    connectionStatus.textContent = 'Connected';
    if (overflowed) void synchronize();
  } catch {
    if (generation !== syncGeneration) return;
    syncing = true;
    connectionStatus.textContent = 'Connected · restoring recent messages';
    window.setTimeout(() => { if (socket?.readyState === WebSocket.OPEN) void synchronize(); }, 1_500);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  if (!navigator.onLine) {
    connectionStatus.textContent = 'Disconnected';
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
    connectionStatus.textContent = 'Disconnected';
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connectionStatus.textContent = reconnectAttempt ? 'Reconnecting' : 'Connecting';
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
    connectionStatus.textContent = 'Disconnected · reconnecting';
    scheduleReconnect();
  });
  next.addEventListener('error', () => next.close());
}

window.addEventListener('offline', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  connectionStatus.textContent = 'Disconnected';
});

window.addEventListener('online', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    connectionStatus.textContent = 'Reconnecting';
    connect();
  }
});

nicknameInput.addEventListener('change', () => {
  try { localStorage.setItem(storageKey, nicknameInput.value); } catch { /* Preference remains usable for this visit. */ }
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
  sendButton.disabled = remaining > 0;
  if (remaining <= 0) {
    feedback.textContent = '';
    return;
  }
  cooldownTimer = window.setInterval(() => {
    const wait = cooldownUntil - Date.now();
    if (wait <= 0) {
      updateCooldown();
      return;
    }
    sendButton.disabled = true;
  }, 250);
}

composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = messageInput.value;
  if (sendButton.disabled) return;
  if (!text.trim()) {
    feedback.textContent = 'Enter a message before sending.';
    messageInput.focus();
    return;
  }
  const nickname = nicknameInput.value;
  if (!pendingSend || pendingSend.text !== text || pendingSend.nickname !== nickname) {
    pendingSend = { text, nickname, requestId: crypto.randomUUID() };
  }
  const submitted = pendingSend;
  sendButton.disabled = true;
  feedback.textContent = 'Sending…';
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
      sendButton.disabled = false;
      feedback.textContent = result.duplicate ? (result.message ? 'Already sent.' : 'Your earlier message was accepted and has since left recent history.') : 'Sent';
      window.setTimeout(() => { if (feedback.textContent === 'Sent' || feedback.textContent === 'Already sent.') feedback.textContent = ''; }, 2_500);
    } else if (response.status === 429 && Number.isFinite(result.retryAfterMs)) {
      cooldownUntil = Date.now() + Math.max(1, result.retryAfterMs!);
      feedback.textContent = `Please wait about ${Math.max(1, Math.ceil(result.retryAfterMs! / 1_000))} seconds before sending again. Your text is saved here.`;
      updateCooldown();
    } else if (response.status === 400) {
      feedback.textContent = result.error === 'message too long' ? 'That message is too long. Shorten it and try again.' : result.error === 'invalid nickname' ? 'Check the nickname and try again.' : 'Enter a message before sending.';
      pendingSend = undefined;
      sendButton.disabled = false;
    } else if (response.status === 503) {
      feedback.textContent = 'Sending is temporarily disabled. Your text is still here.';
      sendButton.disabled = false;
    } else if (response.status === 401) {
      feedback.textContent = 'Your anonymous session needs refreshing. Your text is still here; try Send again.';
      sendButton.disabled = false;
    } else {
      feedback.textContent = 'Could not confirm the send. Your text is still here; try Send again.';
      sendButton.disabled = false;
    }
  } catch {
    feedback.textContent = 'Connection interrupted. Your text is still here; try Send again.';
    sendButton.disabled = false;
  }
});

window.addEventListener('pagehide', () => {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer);
  socket?.close();
});

connect();
