import { formatBottleTime } from './presentation.js';

interface Bottle {
  id: string;
  createdAt: number;
  message: string;
  signature: string | null;
}

const MAX_RECENT = 20;
const RECENT_KEY = 'the-open-web.bottle.recent';
const form = document.querySelector<HTMLFormElement>('#release-form')!;
const messageInput = document.querySelector<HTMLTextAreaElement>('#message-input')!;
const signatureInput = document.querySelector<HTMLInputElement>('#signature-input')!;
const releaseButton = document.querySelector<HTMLButtonElement>('#release-bottle')!;
const releaseFeedback = document.querySelector<HTMLParagraphElement>('#release-feedback')!;
const findButton = document.querySelector<HTMLButtonElement>('#find-bottle')!;
const findFeedback = document.querySelector<HTMLParagraphElement>('#find-feedback')!;
const emptyState = document.querySelector<HTMLParagraphElement>('#empty-state')!;
const currentBottle = document.querySelector<HTMLElement>('#current-bottle')!;
const bottleMessage = document.querySelector<HTMLParagraphElement>('#bottle-message')!;
const bottleSignature = document.querySelector<HTMLSpanElement>('#bottle-signature')!;
const bottleTime = document.querySelector<HTMLTimeElement>('#bottle-time')!;

function readRecentIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)).slice(-MAX_RECENT);
  } catch {
    return [];
  }
}

let recentIds = readRecentIds();
let inFlight = false;
let pendingRequest: { readonly fingerprint: string; readonly id: string } | null = null;
let releaseTimer: number | undefined;
let releaseCooldownUntil = 0;

function setFeedback(element: HTMLElement, text: string, state = ''): void {
  element.textContent = text;
  element.dataset.state = state;
}

function saveRecentIds(): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds)); } catch { /* recent history is an optional local convenience */ }
}

function showBottle(bottle: Bottle): void {
  emptyState.hidden = true;
  currentBottle.hidden = false;
  bottleMessage.textContent = bottle.message;
  bottleSignature.textContent = bottle.signature ?? '';
  bottleSignature.hidden = !bottle.signature;
  bottleTime.dateTime = new Date(bottle.createdAt).toISOString();
  bottleTime.textContent = formatBottleTime(bottle.createdAt);
  bottleTime.title = bottleTime.textContent;
  recentIds = [...recentIds.filter(id => id !== bottle.id), bottle.id].slice(-MAX_RECENT);
  saveRecentIds();
  findButton.textContent = 'Find another';
}

function showReadingMessage(text: string): void {
  currentBottle.hidden = true;
  emptyState.textContent = text;
  emptyState.hidden = false;
  findButton.textContent = 'Find a bottle';
}

function beginReleaseCooldown(milliseconds: number, message: (seconds: number) => string, state: string): void {
  releaseCooldownUntil = Date.now() + Math.max(0, milliseconds);
  if (releaseTimer !== undefined) window.clearInterval(releaseTimer);
  const update = () => {
    const seconds = Math.ceil(Math.max(0, releaseCooldownUntil - Date.now()) / 1000);
    if (seconds <= 0) {
      if (releaseTimer !== undefined) window.clearInterval(releaseTimer);
      releaseTimer = undefined;
      releaseButton.disabled = inFlight;
      setFeedback(releaseFeedback, 'You can release a bottle now.', 'success');
      return;
    }
    releaseButton.disabled = true;
    setFeedback(releaseFeedback, message(seconds), state);
  };
  update();
  releaseTimer = window.setInterval(update, 250);
}

function readableWait(milliseconds: unknown): number {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 1000;
}

findButton.addEventListener('click', async () => {
  if (inFlight) return;
  inFlight = true;
  findButton.disabled = true;
  findFeedback.dataset.state = '';
  setFeedback(findFeedback, 'Looking for a bottle…', 'pending');
  try {
    const url = new URL('/api/bottle/random', location.origin);
    if (recentIds.length) url.searchParams.set('seen', recentIds.join(','));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json() as { bottle?: Bottle | null; exhausted?: boolean; retryAfterMs?: number };
    if (!response.ok) {
      if (response.status === 429) setFeedback(findFeedback, 'Please wait a moment before finding another bottle.', 'error');
      else setFeedback(findFeedback, 'The water is hard to reach right now. Try again in a moment.', 'error');
      return;
    }
    setFeedback(findFeedback, '');
    if (data.bottle) {
      showBottle(data.bottle);
    } else if (data.exhausted) {
      recentIds = [];
      saveRecentIds();
      showReadingMessage('No unseen bottles just now. Find again to begin another drift.');
    } else {
      showReadingMessage('The water is empty. Leave the first bottle for someone to find.');
    }
  } catch {
    setFeedback(findFeedback, 'The water is hard to reach right now. Try again in a moment.', 'error');
  } finally {
    inFlight = false;
    findButton.disabled = false;
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (inFlight) return;
  const message = messageInput.value;
  const signature = signatureInput.value;
  if (!message.trim()) {
    setFeedback(releaseFeedback, 'Write a message before releasing it.', 'error');
    messageInput.focus();
    return;
  }
  const normalizedMessage = message.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ').trim();
  if (new TextEncoder().encode(normalizedMessage).length > 500) {
    setFeedback(releaseFeedback, 'Keep the message under 500 UTF-8 bytes.', 'error');
    messageInput.focus();
    return;
  }
  const normalizedSignature = signature.normalize('NFC').replace(/[\t\r\n\p{White_Space}]+/gu, ' ').trim();
  if (Array.from(normalizedSignature).length > 24 || new TextEncoder().encode(normalizedSignature).length > 48) {
    setFeedback(releaseFeedback, 'Use at most 24 characters and 48 UTF-8 bytes for the signature.', 'error');
    signatureInput.focus();
    return;
  }

  const fingerprint = JSON.stringify([message, signature]);
  if (!pendingRequest || pendingRequest.fingerprint !== fingerprint) {
    pendingRequest = { fingerprint, id: crypto.randomUUID() };
  }
  inFlight = true;
  releaseButton.disabled = true;
  setFeedback(releaseFeedback, 'Sending your bottle…', 'pending');
  try {
    const response = await fetch('/api/bottle/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ requestId: pendingRequest.id, message, signature }),
    });
    const data = await response.json() as { error?: string; retryAfterMs?: number; cooldownMs?: number; bottle?: Bottle | null };
    if (!response.ok) {
      if (response.status === 429 && data.error === 'cooldown') {
        beginReleaseCooldown(readableWait(data.retryAfterMs), seconds => `Wait ${seconds} second${seconds === 1 ? '' : 's'} before leaving another bottle. Your draft stays here.`, 'cooldown');
      } else if (response.status === 429) {
        beginReleaseCooldown(readableWait(data.retryAfterMs), seconds => `Please wait ${seconds} second${seconds === 1 ? '' : 's'}. Your draft stays here.`, 'cooldown');
      } else if (response.status === 400 && data.error === 'empty message') {
        setFeedback(releaseFeedback, 'Write a message before releasing it.', 'error');
      } else if (response.status === 400 && data.error === 'message too long') {
        setFeedback(releaseFeedback, 'Keep the message under 500 UTF-8 bytes.', 'error');
      } else if (response.status === 400 && data.error === 'signature too long') {
        setFeedback(releaseFeedback, 'Use at most 24 characters and 48 UTF-8 bytes for the signature.', 'error');
      } else if (response.status === 400 && data.error === 'invalid input') {
        setFeedback(releaseFeedback, 'Remove control or directional formatting characters and try again.', 'error');
      } else {
        setFeedback(releaseFeedback, 'Releasing is temporarily paused. Your draft is still here.', 'error');
      }
      return;
    }
    pendingRequest = null;
    if (data.bottle?.id) {
      recentIds = [...recentIds.filter(id => id !== data.bottle?.id), data.bottle.id].slice(-MAX_RECENT);
      saveRecentIds();
    }
    messageInput.value = '';
    signatureInput.value = '';
    beginReleaseCooldown(data.cooldownMs ?? 20_000, seconds => `Bottle released. You can leave another bottle in ${seconds} second${seconds === 1 ? '' : 's'}.`, 'success');
  } catch {
    setFeedback(releaseFeedback, 'Releasing is temporarily paused. Your draft is still here.', 'error');
  } finally {
    inFlight = false;
    if (!releaseCooldownUntil || releaseCooldownUntil <= Date.now()) releaseButton.disabled = false;
  }
});
