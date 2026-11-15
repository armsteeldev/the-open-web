interface Question {
  readonly id: number;
  readonly createdAt: number;
  readonly text: string;
  readonly answerCount: number;
}

interface Answer {
  readonly id: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly text: string;
}

interface QuestionDetail {
  readonly question: Question;
  readonly answers: readonly Answer[];
  readonly viewerAnswer: Answer | null;
}

interface QuestionPage {
  readonly questions: readonly Question[];
  readonly nextBefore: number | null;
}

const layout = document.querySelector<HTMLDivElement>('#questions-layout')!;
const questionForm = document.querySelector<HTMLFormElement>('#question-form')!;
const questionInput = document.querySelector<HTMLInputElement>('#question-input')!;
const questionSubmit = document.querySelector<HTMLButtonElement>('#question-submit')!;
const questionFeedback = document.querySelector<HTMLParagraphElement>('#question-feedback')!;
const list = document.querySelector<HTMLOListElement>('#question-list')!;
const questionsEmpty = document.querySelector<HTMLParagraphElement>('#questions-empty')!;
const listFeedback = document.querySelector<HTMLParagraphElement>('#list-feedback')!;
const olderButton = document.querySelector<HTMLButtonElement>('#older-questions')!;
const detail = document.querySelector<HTMLElement>('#question-detail')!;
const detailEmpty = document.querySelector<HTMLParagraphElement>('#detail-empty')!;
const questionTitle = document.querySelector<HTMLHeadingElement>('#question-text')!;
const questionTime = document.querySelector<HTMLTimeElement>('#question-time')!;
const answers = document.querySelector<HTMLOListElement>('#answer-list')!;
const answersEmpty = document.querySelector<HTMLParagraphElement>('#answers-empty')!;
const answerForm = document.querySelector<HTMLFormElement>('#answer-form')!;
const answerInput = document.querySelector<HTMLTextAreaElement>('#answer-input')!;
const answerLabel = document.querySelector<HTMLLabelElement>('#answer-label')!;
const answerSubmit = document.querySelector<HTMLButtonElement>('#answer-submit')!;
const answerFeedback = document.querySelector<HTMLParagraphElement>('#answer-feedback')!;
const allQuestions = document.querySelector<HTMLButtonElement>('#all-questions')!;

if (layout && questionForm && questionInput && questionSubmit && questionFeedback && list && questionsEmpty && listFeedback && olderButton && detail && detailEmpty && questionTitle && questionTime && answers && answersEmpty && answerForm && answerInput && answerLabel && answerSubmit && answerFeedback && allQuestions) {
  let before: number | null = null;
  let nextBefore: number | null = null;
  let selectedId: number | null = null;
  let questionPending: { fingerprint: string; requestId: string } | null = null;
  let answerPending: { fingerprint: string; requestId: string } | null = null;
  let busy = false;

  const setStatus = (element: HTMLElement, message: string, state = '') => {
    element.textContent = message;
    element.dataset.state = state;
  };
  const formatTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));

  function makeQuestionRow(item: Question): HTMLLIElement {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'question-link';
    link.href = `/questions?id=${item.id}`;
    link.dataset.questionId = String(item.id);
    link.setAttribute('aria-current', selectedId === item.id ? 'page' : 'false');
    const text = document.createElement('span');
    text.className = 'question-link-text';
    text.textContent = item.text;
    const meta = document.createElement('span');
    meta.className = 'question-link-meta';
    const date = document.createElement('span');
    date.textContent = formatTime(item.createdAt);
    const count = document.createElement('span');
    count.textContent = `${item.answerCount} ${item.answerCount === 1 ? 'answer' : 'answers'}`;
    meta.append(date, count);
    link.append(text, meta);
    row.append(link);
    return row;
  }

  async function loadQuestions(cursor: number | null): Promise<void> {
    before = cursor;
    const url = new URL('/api/questions', location.origin);
    if (cursor !== null) url.searchParams.set('before', String(cursor));
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('list');
      const page = await response.json() as QuestionPage;
      list.replaceChildren(...page.questions.map(makeQuestionRow));
      nextBefore = page.nextBefore;
      questionsEmpty.hidden = page.questions.length !== 0 || cursor !== null;
      olderButton.hidden = nextBefore === null;
      setStatus(listFeedback, '');
    } catch {
      setStatus(listFeedback, 'Questions are hard to reach. Try again in a moment.', 'error');
    }
  }

  function renderQuestion(data: QuestionDetail): void {
    selectedId = data.question.id;
    questionTitle.textContent = data.question.text;
    questionTime.dateTime = new Date(data.question.createdAt).toISOString();
    questionTime.textContent = formatTime(data.question.createdAt);
    answers.replaceChildren(...data.answers.map(item => {
      const row = document.createElement('li');
      row.className = 'answer-row';
      const body = document.createElement('p');
      body.textContent = item.text;
      const time = document.createElement('time');
      time.dateTime = new Date(item.updatedAt).toISOString();
      time.textContent = formatTime(item.updatedAt);
      row.append(body, time);
      return row;
    }));
    answersEmpty.hidden = data.answers.length !== 0;
    detail.hidden = false;
    detailEmpty.hidden = true;
    layout.dataset.focused = 'true';
    allQuestions.hidden = false;
    answerInput.value = data.viewerAnswer?.text ?? '';
    const editing = data.viewerAnswer !== null;
    answerLabel.textContent = editing ? 'Your current answer' : 'Your answer';
    answerSubmit.textContent = editing ? 'Update your answer' : 'Add your answer';
    for (const link of Array.from(list.querySelectorAll<HTMLAnchorElement>('.question-link'))) {
      if (Number(link.dataset.questionId) === selectedId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  async function loadQuestion(id: number, updateUrl = true): Promise<void> {
    try {
      const response = await fetch(`/api/questions/${id}`, { headers: { Accept: 'application/json' } });
      if (response.status === 404) {
        selectedId = null;
        detail.hidden = true;
        detailEmpty.hidden = false;
        layout.dataset.focused = 'false';
        setStatus(listFeedback, 'That question is no longer available.', 'error');
        return;
      }
      if (!response.ok) throw new Error('question');
      renderQuestion(await response.json() as QuestionDetail);
      if (updateUrl) history.pushState(null, '', `/questions?id=${id}`);
      setStatus(answerFeedback, '');
    } catch {
      setStatus(listFeedback, 'That question is hard to reach. Try again in a moment.', 'error');
    }
  }

  list.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLAnchorElement>('a[data-question-id]');
    if (!target) return;
    event.preventDefault();
    const id = Number(target.dataset.questionId);
    if (Number.isSafeInteger(id) && id > 0) void loadQuestion(id);
  });
  olderButton.addEventListener('click', () => {
    if (nextBefore !== null) void loadQuestions(nextBefore);
  });
  allQuestions.addEventListener('click', () => {
    selectedId = null;
    detail.hidden = true;
    detailEmpty.hidden = false;
    allQuestions.hidden = true;
    layout.dataset.focused = 'false';
    history.pushState(null, '', '/questions');
  });
  window.addEventListener('popstate', () => {
    const id = new URL(location.href).searchParams.get('id');
    if (id && /^[1-9]\d{0,15}$/.test(id)) void loadQuestion(Number(id), false);
    else {
      selectedId = null;
      detail.hidden = true;
      detailEmpty.hidden = false;
      allQuestions.hidden = true;
      layout.dataset.focused = 'false';
    }
  });

  questionForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const text = questionInput.value;
    if (!text.trim()) {
      setStatus(questionFeedback, 'Write a question first.', 'error');
      questionInput.focus();
      return;
    }
    const fingerprint = text;
    if (!questionPending || questionPending.fingerprint !== fingerprint) questionPending = { fingerprint, requestId: crypto.randomUUID() };
    busy = true;
    questionSubmit.disabled = true;
    setStatus(questionFeedback, 'Asking…');
    try {
      const response = await fetch('/api/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: questionPending.requestId, text }),
      });
      const result = await response.json() as { error?: string; retryAfterMs?: number; question?: Question };
      if (!response.ok || !result.question) {
        if (response.status === 429 && result.error === 'cooldown') setStatus(questionFeedback, `Please wait ${Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))} seconds before asking again. Your question is still here.`, 'error');
        else if (response.status === 400 && result.error === 'text too long') setStatus(questionFeedback, 'Keep a question within 180 characters and 420 UTF-8 bytes.', 'error');
        else setStatus(questionFeedback, 'Your question could not be saved. It is still here.', 'error');
        return;
      }
      questionPending = null;
      questionInput.value = '';
      await loadQuestions(null);
      await loadQuestion(result.question.id);
      setStatus(questionFeedback, 'Your question is open to answers.', 'success');
    } catch {
      setStatus(questionFeedback, 'Your question could not be saved. It is still here.', 'error');
    } finally {
      busy = false;
      questionSubmit.disabled = false;
    }
  });

  answerForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || selectedId === null) return;
    const text = answerInput.value;
    if (!text.trim()) {
      setStatus(answerFeedback, 'Write a response before sending.', 'error');
      answerInput.focus();
      return;
    }
    const fingerprint = JSON.stringify([selectedId, text]);
    if (!answerPending || answerPending.fingerprint !== fingerprint) answerPending = { fingerprint, requestId: crypto.randomUUID() };
    busy = true;
    answerSubmit.disabled = true;
    setStatus(answerFeedback, 'Saving your answer…');
    try {
      const response = await fetch(`/api/questions/${selectedId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ requestId: answerPending.requestId, text }),
      });
      const result = await response.json() as { error?: string; retryAfterMs?: number };
      if (!response.ok) {
        if (response.status === 429 && result.error === 'cooldown') setStatus(answerFeedback, `Please wait ${Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000))} seconds before answering again. Your draft is still here.`, 'error');
        else if (response.status === 400 && result.error === 'text too long') setStatus(answerFeedback, 'Keep an answer within 300 characters and 500 UTF-8 bytes.', 'error');
        else setStatus(answerFeedback, 'Your answer could not be saved. It is still here.', 'error');
        return;
      }
      answerPending = null;
      await loadQuestion(selectedId, false);
      await loadQuestions(before);
      setStatus(answerFeedback, 'Your answer is here.', 'success');
    } catch {
      setStatus(answerFeedback, 'Your answer could not be saved. It is still here.', 'error');
    } finally {
      busy = false;
      answerSubmit.disabled = false;
    }
  });

  const urlId = new URL(location.href).searchParams.get('id');
  void loadQuestions(null).then(() => {
    if (urlId && /^[1-9]\d{0,15}$/.test(urlId)) void loadQuestion(Number(urlId), false);
  });
}
