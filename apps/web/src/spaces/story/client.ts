export {};

interface Contribution {
  readonly id: number;
  readonly ordinal: number;
  readonly createdAt: number;
  readonly passage: string;
  readonly removed: boolean;
}

interface Chapter {
  readonly number: number;
  readonly status: 'current' | 'archived';
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly revision: number;
  readonly contributions: readonly Contribution[];
}

interface StoryState {
  readonly chapter: Chapter | null;
  readonly currentChapterNo: number | null;
  readonly currentRevision: number;
  readonly chapterCount: number;
  readonly full: boolean;
}

const passageRegion = document.querySelector<HTMLDivElement>('#story-passages')!;
const empty = document.querySelector<HTMLParagraphElement>('#story-empty')!;
const writing = document.querySelector<HTMLElement>('#story-writing')!;
const form = document.querySelector<HTMLFormElement>('#story-form')!;
const passageInput = document.querySelector<HTMLTextAreaElement>('#story-passage')!;
const submitButton = document.querySelector<HTMLButtonElement>('#story-submit')!;
const feedback = document.querySelector<HTMLParagraphElement>('#story-feedback')!;
const position = document.querySelector<HTMLSpanElement>('#chapter-position')!;
const previousButton = document.querySelector<HTMLButtonElement>('#previous-chapter')!;
const nextButton = document.querySelector<HTMLButtonElement>('#next-chapter')!;
const update = document.querySelector<HTMLDivElement>('#story-update')!;
const updateText = document.querySelector<HTMLParagraphElement>('#story-update-text')!;
const reviewButton = document.querySelector<HTMLButtonElement>('#story-review')!;
const fullMessage = document.querySelector<HTMLParagraphElement>('#story-full')!;
const currentButton = document.querySelector<HTMLButtonElement>('#story-current')!;

if (passageRegion && empty && writing && form && passageInput && submitButton && feedback && position && previousButton && nextButton && update && updateText && reviewButton && fullMessage && currentButton) {
  let state: StoryState | null = null;
  let selectedNumber: number | null = null;
  let reviewTarget: number | null = null;
  let busy = false;
  let pending: { fingerprint: string; requestId: string } | null = null;

  const setFeedback = (message: string, kind = '') => {
    feedback.textContent = message;
    feedback.dataset.state = kind;
  };

  const chapterFromUrl = (): number | null => {
    const value = new URL(location.href).searchParams.get('chapter');
    if (!value || !/^[1-9]\d{0,2}$/.test(value)) return null;
    const number = Number(value);
    return number <= 100 ? number : null;
  };

  function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  }

  function render(next: StoryState): void {
    state = next;
    selectedNumber = next.chapter?.number ?? null;
    passageRegion.replaceChildren();
    empty.hidden = true;
    if (!next.chapter) {
      position.textContent = '';
      empty.textContent = next.full ? 'The story is complete. Its chapters remain here to read.' : 'No one has started the story yet.';
      empty.hidden = false;
    } else {
      position.textContent = `Chapter ${next.chapter.number}${next.chapter.status === 'current' ? ' · open' : ''}`;
      for (const contribution of next.chapter.contributions) {
        const paragraph = document.createElement('p');
        paragraph.className = 'story-fragment';
        paragraph.dataset.removed = String(contribution.removed);
        paragraph.textContent = contribution.passage;
        const stamp = formatTime(contribution.createdAt);
        const details = document.createElement('details');
        details.className = 'story-meta';
        const summary = document.createElement('summary');
        summary.setAttribute('aria-label', 'Show passage timestamp: ' + stamp);
        summary.textContent = '·';
        const time = document.createElement('time');
        time.dateTime = new Date(contribution.createdAt).toISOString();
        time.textContent = stamp;
        details.append(summary, time);
        paragraph.append(details);
        passageRegion.append(paragraph);
      }
      if (next.chapter.contributions.length === 0) {
        empty.textContent = next.chapter.status === 'current' ? 'This chapter is waiting for its first passage.' : 'This chapter has no remaining passages.';
        empty.hidden = false;
      }
    }

    const number = next.chapter?.number ?? null;
    previousButton.hidden = number === null || number <= 1;
    nextButton.hidden = number === null || number >= next.chapterCount;
    const isCurrentChapter = next.chapter?.status === 'current';
    writing.hidden = next.full || (next.chapter !== null && !isCurrentChapter);
    fullMessage.hidden = !next.full;
    currentButton.hidden = !next.chapter || isCurrentChapter || next.currentChapterNo === null;
  }

  async function loadChapter(number: number | null, updateUrl = true): Promise<StoryState | null> {
    const path = number === null ? '/api/story/state' : `/api/story/chapters/${number}`;
    try {
      const response = await fetch(path, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('story unavailable');
      const next = await response.json() as StoryState;
      render(next);
      if (updateUrl) {
        const url = new URL(location.href);
        if (number === null) url.searchParams.delete('chapter');
        else url.searchParams.set('chapter', String(number));
        history.pushState(null, '', url);
      }
      return next;
    } catch {
      empty.textContent = 'The story is hard to reach. Try again in a moment.';
      empty.hidden = false;
      return null;
    }
  }

  previousButton.addEventListener('click', () => {
    if (selectedNumber !== null && selectedNumber > 1) void loadChapter(selectedNumber - 1);
  });
  nextButton.addEventListener('click', () => {
    if (selectedNumber !== null && state && selectedNumber < state.chapterCount) void loadChapter(selectedNumber + 1);
  });
  currentButton.addEventListener('click', () => {
    if (state?.currentChapterNo !== null && state?.currentChapterNo !== undefined) void loadChapter(state.currentChapterNo);
  });
  window.addEventListener('popstate', () => void loadChapter(chapterFromUrl(), false));

  reviewButton.addEventListener('click', async () => {
    if (reviewTarget === null) return;
    const refreshed = await loadChapter(reviewTarget, false);
    if (!refreshed) return;
    reviewTarget = null;
    update.hidden = true;
    setFeedback('The ending is up to date. Your draft is still here.');
    passageInput.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const passage = passageInput.value;
    if (!passage.trim()) {
      setFeedback('Add a passage before continuing.', 'error');
      passageInput.focus();
      return;
    }
    if (update.hidden === false) {
      setFeedback('Read the new ending before adding your passage.', 'error');
      return;
    }
    const chapterNo = state?.chapter?.status === 'current' ? state.chapter.number : null;
    const revision = state?.chapter?.status === 'current' ? state.chapter.revision : 0;
    const fingerprint = JSON.stringify([chapterNo, revision, passage]);
    if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() };
    busy = true;
    submitButton.disabled = true;
    setFeedback('Adding your passage…');
    try {
      const response = await fetch('/api/story/contributions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId, chapterNo, revision, passage }),
      });
      const result = await response.json() as { error?: string; retryAfterMs?: number; state?: StoryState; duplicate?: boolean };
      if (response.status === 409 && result.error === 'story changed' && result.state) {
        const latest = result.state;
        const hasOpen = latest.currentChapterNo !== null;
        if (hasOpen && latest.chapter && latest.chapter.contributions.length === 0 && latest.chapter.number > 1) {
          const prior = await loadChapter(latest.chapter.number - 1, false);
          if (!prior) return;
          reviewTarget = latest.currentChapterNo;
          updateText.textContent = `A new chapter ${latest.currentChapterNo} has opened. Read the previous ending, then continue from the new chapter.`;
        } else {
          render(latest);
          reviewTarget = latest.currentChapterNo ?? (latest.chapter ? latest.chapter.number : null);
          updateText.textContent = latest.full
            ? 'The story reached its archive limit while you were writing. Your draft is still here.'
            : 'Someone added to the story while you were writing. Read the new ending before continuing.';
        }
        update.hidden = false;
        setFeedback('Your draft is still here.');
        return;
      }
      if (!response.ok) {
        if (response.status === 429 && result.error === 'cooldown') {
          setFeedback(`Please wait ${Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))} seconds before continuing. Your draft is still here.`, 'error');
        } else if (response.status === 409 && result.error === 'story complete') {
          const latest = await loadChapter(null, false);
          if (latest) setFeedback('The story reached its archive limit. Your draft is still here.', 'error');
        } else if (response.status === 400) {
          setFeedback(result.error === 'passage too long' ? 'Keep a passage within 220 characters and 500 UTF-8 bytes.' : 'Check the passage and try again.', 'error');
        } else {
          setFeedback('The story is temporarily unavailable. Your draft is still here.', 'error');
        }
        return;
      }
      pending = null;
      passageInput.value = '';
      update.hidden = true;
      const acceptedChapter = chapterNo ?? 1;
      if (result.state?.currentChapterNo !== acceptedChapter) {
        await loadChapter(acceptedChapter, false);
        currentButton.hidden = false;
        setFeedback(`Chapter ${acceptedChapter} is complete. The story continues in Chapter ${result.state?.currentChapterNo ?? acceptedChapter}.`, 'success');
      } else {
        await loadChapter(result.state?.currentChapterNo ?? acceptedChapter, false);
        setFeedback(result.duplicate ? 'That passage is already part of the story.' : 'Your passage is part of the story.', 'success');
        passageRegion.lastElementChild?.scrollIntoView({ block: 'nearest' });
      }
    } catch {
      setFeedback('The story is temporarily unavailable. Your draft is still here.', 'error');
    } finally {
      busy = false;
      submitButton.disabled = false;
    }
  });

  void loadChapter(chapterFromUrl(), false);
}
