interface GuestbookEntry {
  readonly id: number;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly message: string;
}

interface GuestbookPage {
  readonly entries: readonly GuestbookEntry[];
  readonly nextBefore: number | null;
}

const form = document.querySelector<HTMLFormElement>('#guestbook-form')!;
const nameInput = document.querySelector<HTMLInputElement>('#guestbook-name')!;
const messageInput = document.querySelector<HTMLTextAreaElement>('#guestbook-message')!;
const submitButton = document.querySelector<HTMLButtonElement>('#guestbook-submit')!;
const list = document.querySelector<HTMLOListElement>('#guestbook-list')!;
const empty = document.querySelector<HTMLParagraphElement>('#guestbook-empty')!;
const feedback = document.querySelector<HTMLParagraphElement>('#guestbook-feedback')!;
const readFeedback = document.querySelector<HTMLParagraphElement>('#guestbook-read-feedback')!;
const olderButton = document.querySelector<HTMLButtonElement>('#older-entries')!;
const latestButton = document.querySelector<HTMLButtonElement>('#latest-entries')!;

if (form && nameInput && messageInput && submitButton && list && empty && feedback && readFeedback && olderButton && latestButton) {
  let before: number | null = null;
  let nextBefore: number | null = null;
  let submitting = false;
  let pending: { fingerprint: string; requestId: string } | null = null;

  const setStatus = (target: HTMLElement, message: string, state = '') => {
    target.textContent = message;
    target.dataset.state = state;
  };

  const formatTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));

  function makeEntry(item: GuestbookEntry): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'entry-row';
    const heading = document.createElement('div');
    heading.className = 'entry-heading';
    const name = document.createElement('span');
    name.className = 'entry-name';
    name.textContent = item.displayName || 'A visitor';
    const time = document.createElement('time');
    time.className = 'entry-time';
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = formatTime(item.createdAt);
    heading.append(name, time);
    const message = document.createElement('p');
    message.className = 'entry-message';
    message.textContent = item.message;
    row.append(heading, message);
    return row;
  }

  async function loadEntries(cursor: number | null): Promise<void> {
    before = cursor;
    const url = new URL('/api/guestbook/entries', location.origin);
    if (cursor !== null) url.searchParams.set('before', String(cursor));
    setStatus(readFeedback, '');
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('read');
      const page = await response.json() as GuestbookPage;
      list.replaceChildren(...page.entries.map(makeEntry));
      nextBefore = page.nextBefore;
      empty.hidden = page.entries.length !== 0 || cursor !== null;
      olderButton.hidden = nextBefore === null;
      latestButton.hidden = cursor === null;
      setStatus(readFeedback, '');
    } catch {
      setStatus(readFeedback, 'The guestbook is hard to reach. Try again in a moment.', 'error');
    }
  }

  olderButton.addEventListener('click', () => {
    if (nextBefore !== null) void loadEntries(nextBefore);
  });
  latestButton.addEventListener('click', () => void loadEntries(null));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const displayName = nameInput.value;
    const message = messageInput.value;
    if (!message.trim()) {
      setStatus(feedback, 'Write a short message before signing.', 'error');
      messageInput.focus();
      return;
    }
    const fingerprint = JSON.stringify([displayName, message]);
    if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() };
    submitting = true;
    submitButton.disabled = true;
    setStatus(feedback, 'Saving your signature…');
    try {
      const response = await fetch('/api/guestbook/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId, displayName, message }),
      });
      const result = await response.json() as { error?: string; retryAfterMs?: number; duplicate?: boolean };
      if (!response.ok) {
        if (response.status === 429 && result.error === 'cooldown') {
          const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000));
          setStatus(feedback, `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before signing again. Your words are still here.`, 'error');
        } else if (response.status === 400) {
          setStatus(feedback, result.error === 'message too long' ? 'Keep the message within 220 characters and 500 UTF-8 bytes.' : 'Check the name and message, then try again.', 'error');
        } else {
          setStatus(feedback, 'Saving is temporarily paused. Your words are still here.', 'error');
        }
        return;
      }
      pending = null;
      messageInput.value = '';
      nameInput.value = '';
      await loadEntries(null);
      setStatus(feedback, result.duplicate ? 'Your signature is already in the book.' : 'Your signature is in the book.', 'success');
    } catch {
      setStatus(feedback, 'Saving is temporarily paused. Your words are still here.', 'error');
    } finally {
      submitting = false;
      submitButton.disabled = false;
    }
  });

  void loadEntries(null);
}
