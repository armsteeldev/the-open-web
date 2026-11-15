interface Results {
  readonly optionA: number;
  readonly optionB: number;
  readonly total: number;
}

interface Decision {
  readonly id: number;
  readonly question: string;
  readonly optionA: string;
  readonly optionB: string;
  readonly status: 'queued' | 'active' | 'closed';
  readonly createdAt: number;
  readonly openedAt: number | null;
  readonly closesAt: number | null;
  readonly closedAt: number | null;
  readonly viewerChoice: 'a' | 'b' | null;
  readonly results: Results | null;
}

interface ChoiceState {
  readonly active: Decision | null;
  readonly queuedCount: number;
}

interface ArchivePage {
  readonly decisions: readonly Decision[];
  readonly nextBefore: number | null;
}

const active = document.querySelector<HTMLDivElement>('#active-decision')!;
const empty = document.querySelector<HTMLParagraphElement>('#choice-empty')!;
const question = document.querySelector<HTMLHeadingElement>('#decision-question')!;
const closes = document.querySelector<HTMLParagraphElement>('#decision-closes')!;
const buttonA = document.querySelector<HTMLButtonElement>('#option-a')!;
const buttonB = document.querySelector<HTMLButtonElement>('#option-b')!;
const voteFeedback = document.querySelector<HTMLParagraphElement>('#vote-feedback')!;
const results = document.querySelector<HTMLElement>('#choice-results')!;
const resultsCount = document.querySelector<HTMLParagraphElement>('#results-count')!;
const labelA = document.querySelector<HTMLSpanElement>('#result-label-a')!;
const labelB = document.querySelector<HTMLSpanElement>('#result-label-b')!;
const countA = document.querySelector<HTMLSpanElement>('#result-count-a')!;
const countB = document.querySelector<HTMLSpanElement>('#result-count-b')!;
const barA = document.querySelector<HTMLSpanElement>('#result-bar-a')!;
const barB = document.querySelector<HTMLSpanElement>('#result-bar-b')!;
const proposalPanel = document.querySelector<HTMLDetailsElement>('#proposal-panel')!;
const proposalForm = document.querySelector<HTMLFormElement>('#proposal-form')!;
const proposalQuestion = document.querySelector<HTMLInputElement>('#proposal-question')!;
const proposalA = document.querySelector<HTMLInputElement>('#proposal-a')!;
const proposalB = document.querySelector<HTMLInputElement>('#proposal-b')!;
const proposalSubmit = document.querySelector<HTMLButtonElement>('#proposal-submit')!;
const proposalFeedback = document.querySelector<HTMLParagraphElement>('#proposal-feedback')!;
const archiveList = document.querySelector<HTMLOListElement>('#choice-archive')!;
const archiveEmpty = document.querySelector<HTMLParagraphElement>('#archive-empty')!;
const archiveFeedback = document.querySelector<HTMLParagraphElement>('#archive-feedback')!;
const olderButton = document.querySelector<HTMLButtonElement>('#older-decisions')!;
const archivePanel = document.querySelector<HTMLDetailsElement>('#archive-panel')!;

if (active && empty && question && closes && buttonA && buttonB && voteFeedback && results && resultsCount && labelA && labelB && countA && countB && barA && barB && proposalPanel && proposalForm && proposalQuestion && proposalA && proposalB && proposalSubmit && proposalFeedback && archiveList && archiveEmpty && archiveFeedback && olderButton && archivePanel) {
  let current: Decision | null = null;
  let queuedCount = 0;
  let archiveCursor: number | null = null;
  let archiveNext: number | null = null;
  let timer: number | undefined;
  let proposalPending: { fingerprint: string; requestId: string } | null = null;
  let votePending: { fingerprint: string; requestId: string } | null = null;
  let proposing = false;
  let voting = false;

  const setStatus = (element: HTMLElement, message: string, state = '') => {
    element.textContent = message;
    element.dataset.state = state;
  };
  const formatTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));

  function renderDecision(decision: Decision | null, queue = queuedCount): void {
    current = decision;
    queuedCount = queue;
    active.hidden = decision === null;
    empty.hidden = decision !== null;
    if (!decision) {
      proposalPanel.open = true;
      setStatus(voteFeedback, '');
      return;
    }
    proposalPanel.open = false;
    question.textContent = decision.question;
    buttonA.textContent = decision.optionA;
    buttonB.textContent = decision.optionB;
    buttonA.setAttribute('aria-pressed', String(decision.viewerChoice === 'a'));
    buttonB.setAttribute('aria-pressed', String(decision.viewerChoice === 'b'));
    if (decision.closesAt !== null) closes.textContent = `Closes ${formatTime(decision.closesAt)} local time.`;
    const result = decision.results;
    results.hidden = result === null;
    if (result) {
      resultsCount.textContent = result.total === 0 ? 'No votes this time.' : `${result.total} ${result.total === 1 ? 'vote' : 'votes'}`;
      labelA.textContent = decision.optionA;
      labelB.textContent = decision.optionB;
      countA.textContent = result.total === 0 ? '0' : `${result.optionA} · ${Math.round(result.optionA / result.total * 100)}%`;
      countB.textContent = result.total === 0 ? '0' : `${result.optionB} · ${Math.round(result.optionB / result.total * 100)}%`;
      const percentA = result.total === 0 ? 0 : result.optionA / result.total * 100;
      const percentB = result.total === 0 ? 0 : result.optionB / result.total * 100;
      barA.style.width = `${percentA}%`;
      barB.style.width = `${percentB}%`;
      const trackA = barA.parentElement;
      const trackB = barB.parentElement;
      trackA?.setAttribute('aria-label', `${decision.optionA}: ${result.optionA} of ${result.total} votes`);
      trackB?.setAttribute('aria-label', `${decision.optionB}: ${result.optionB} of ${result.total} votes`);
    }
    if (decision.viewerChoice) setStatus(voteFeedback, 'You can change your choice until this decision closes.');
    else setStatus(voteFeedback, '');
    if (timer !== undefined) window.clearTimeout(timer);
    if (decision.closesAt !== null) {
      timer = window.setTimeout(() => { void loadState(true); }, Math.max(500, decision.closesAt - Date.now() + 500));
    }
  }

  async function loadState(announceClose = false): Promise<void> {
    const previousId = current?.id ?? null;
    try {
      const response = await fetch('/api/choice/state', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('state');
      const state = await response.json() as ChoiceState;
      renderDecision(state.active, state.queuedCount);
      if (announceClose && previousId !== null && state.active?.id !== previousId) {
        setStatus(voteFeedback, state.active ? 'That decision has closed. The next one is open.' : 'That decision has closed. The next question is waiting for a suggestion.');
      }
      if (archiveCursor === null) await loadArchive(null);
    } catch {
      if (!current) setStatus(voteFeedback, 'The current decision is hard to reach. Try again in a moment.', 'error');
    }
  }

  function makeArchiveRow(item: Decision): HTMLLIElement {
    const row = document.createElement('li');
    const title = document.createElement('p');
    title.className = 'archive-question';
    title.textContent = item.question;
    const outcome = document.createElement('p');
    outcome.className = 'archive-outcome';
    const result = item.results;
    if (!result || result.total === 0) outcome.textContent = `No votes · ${item.optionA} / ${item.optionB}`;
    else {
      const winner = result.optionA === result.optionB ? 'Tied' : result.optionA > result.optionB ? item.optionA : item.optionB;
      outcome.textContent = `${winner} · ${item.optionA} ${result.optionA} — ${item.optionB} ${result.optionB}`;
    }
    const time = document.createElement('time');
    time.className = 'archive-time';
    const timestamp = item.closedAt ?? item.createdAt;
    time.dateTime = new Date(timestamp).toISOString();
    time.textContent = formatTime(timestamp);
    row.append(title, outcome, time);
    return row;
  }

  async function loadArchive(cursor: number | null): Promise<void> {
    archiveCursor = cursor;
    const url = new URL('/api/choice/archive', location.origin);
    if (cursor !== null) url.searchParams.set('before', String(cursor));
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('archive');
      const page = await response.json() as ArchivePage;
      archiveList.replaceChildren(...page.decisions.map(makeArchiveRow));
      archiveNext = page.nextBefore;
      archiveEmpty.hidden = page.decisions.length !== 0 || cursor !== null;
      olderButton.hidden = archiveNext === null;
      setStatus(archiveFeedback, '');
    } catch {
      setStatus(archiveFeedback, 'The archive is hard to reach. Try again in a moment.', 'error');
    }
  }

  async function castVote(choice: 'a' | 'b'): Promise<void> {
    if (!current || voting) return;
    const decisionId = current.id;
    const fingerprint = JSON.stringify([decisionId, choice]);
    if (!votePending || votePending.fingerprint !== fingerprint) votePending = { fingerprint, requestId: crypto.randomUUID() };
    voting = true;
    buttonA.disabled = true;
    buttonB.disabled = true;
    setStatus(voteFeedback, 'Saving your choice…');
    try {
      const response = await fetch(`/api/choice/decisions/${decisionId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: votePending.requestId, choice }),
      });
      const result = await response.json() as { error?: string; decision?: Decision };
      if (response.status === 409 && result.error === 'decision closed') {
        votePending = null;
        await loadState(true);
        return;
      }
      if (!response.ok || !result.decision) {
        setStatus(voteFeedback, 'Your choice could not be saved. Try again in a moment.', 'error');
        return;
      }
      votePending = null;
      renderDecision(result.decision, queuedCount);
    } catch {
      setStatus(voteFeedback, 'Your choice could not be saved. Try again in a moment.', 'error');
    } finally {
      voting = false;
      buttonA.disabled = false;
      buttonB.disabled = false;
    }
  }

  buttonA.addEventListener('click', () => void castVote('a'));
  buttonB.addEventListener('click', () => void castVote('b'));
  olderButton.addEventListener('click', () => {
    if (archiveNext !== null) void loadArchive(archiveNext);
  });
  archivePanel.addEventListener('toggle', () => {
    if (archivePanel.open) void loadArchive(null);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void loadState(true);
  });

  proposalForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (proposing) return;
    const questionText = proposalQuestion.value;
    const optionAText = proposalA.value;
    const optionBText = proposalB.value;
    if (!questionText.trim() || !optionAText.trim() || !optionBText.trim()) {
      setStatus(proposalFeedback, 'Add a question and two choices.', 'error');
      return;
    }
    const fingerprint = JSON.stringify([questionText, optionAText, optionBText]);
    if (!proposalPending || proposalPending.fingerprint !== fingerprint) proposalPending = { fingerprint, requestId: crypto.randomUUID() };
    proposing = true;
    proposalSubmit.disabled = true;
    setStatus(proposalFeedback, 'Sending your suggestion…');
    try {
      const response = await fetch('/api/choice/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: proposalPending.requestId, question: questionText, optionA: optionAText, optionB: optionBText }),
      });
      const result = await response.json() as { error?: string; retryAfterMs?: number; decision?: Decision; queuedCount?: number };
      if (!response.ok || !result.decision) {
        if (response.status === 429 && result.error === 'cooldown') setStatus(proposalFeedback, `Please wait ${Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))} seconds before suggesting again. Your draft is still here.`, 'error');
        else if (response.status === 409 && result.error === 'queue full') setStatus(proposalFeedback, 'The suggestion queue is full. Try again after a decision closes.', 'error');
        else if (response.status === 400 && (result.error === 'text too long' || result.error === 'identical choices')) setStatus(proposalFeedback, result.error === 'identical choices' ? 'Give the two choices different names.' : 'Shorten the question or choices, then try again.', 'error');
        else setStatus(proposalFeedback, 'Your suggestion could not be saved. It is still here.', 'error');
        return;
      }
      proposalPending = null;
      proposalQuestion.value = '';
      proposalA.value = '';
      proposalB.value = '';
      proposalPanel.open = false;
      if (result.decision.status === 'active') {
        renderDecision(result.decision, result.queuedCount ?? 0);
        setStatus(voteFeedback, 'Your question is now open.', 'success');
      } else {
        await loadState();
        setStatus(voteFeedback, 'Your question is in the queue.', 'success');
      }
    } catch {
      setStatus(proposalFeedback, 'Your suggestion could not be saved. It is still here.', 'error');
    } finally {
      proposing = false;
      proposalSubmit.disabled = false;
    }
  });

  void loadState();
}
