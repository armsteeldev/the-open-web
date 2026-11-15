import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../apps/server/src/db.js';
import {
  ANSWER_COOLDOWN_MS,
  ANSWERS_PER_QUESTION_CAP,
  QUESTION_COOLDOWN_MS,
  QUESTIONS_RETENTION_MS,
  cleanupQuestionsState,
  createOrEditAnswer,
  createQuestion,
  readQuestion,
  readQuestionList,
  removeAnswer,
  removeQuestion,
} from '../apps/server/src/spaces/questions/database.js';
import { validateAnswerSubmission, validateQuestionSubmission } from '../apps/server/src/spaces/questions/validation.js';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string) => ({ dbPath, origin, cooldown: 10_000, writes: true, secure: false });
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (n: number) => n.toString(16).padStart(64, 'b');
const submit = (text: string, id: number) => ({ requestId: requestId(id), text });

test('Open Questions validates short single-line questions and bounded plain-text answers', () => {
  assert.deepEqual(validateQuestionSubmission(submit('  e\u0301\r\nquestion  ', 1)), {
    ok: true, value: { requestId: requestId(1), text: 'é question' },
  });
  assert.equal(validateAnswerSubmission(submit('<script>literal</script>\nA thought.', 2)).ok, true);
  assert.deepEqual(validateQuestionSubmission(submit('x'.repeat(181), 3)), { ok: false, error: 'text too long' });
  assert.deepEqual(validateAnswerSubmission(submit('x'.repeat(301), 4)), { ok: false, error: 'text too long' });
  assert.deepEqual(validateAnswerSubmission(submit('hidden\u202etext', 5)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateQuestionSubmission({ ...submit('valid', 6), other: true }), { ok: false, error: 'invalid input' });
});

test('Open Questions keeps one editable current answer per cookie, supports retries, and removes nested content safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-questions-db-'));
  const db = openDb(join(root, 'questions.sqlite'));
  try {
    const questionColumns = db.prepare('PRAGMA table_info(questions_items)').all() as { name: string }[];
    assert.equal(questionColumns.some(column => column.name === 'visitor_digest'), false, 'asking a question does not retain the asker cookie digest');
    const now = 1_000_000;
    const created = createQuestion(db, digest(1), submit('What sound would you keep?', 1), now);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('question not created');
    const duplicateQuestion = createQuestion(db, digest(1), submit('What sound would you keep?', 1), now + 1);
    assert.equal(duplicateQuestion.ok, true);
    if (!duplicateQuestion.ok) throw new Error('question retry failed');
    assert.equal(duplicateQuestion.duplicate, true);
    assert.deepEqual(createQuestion(db, digest(1), submit('A new question', 2), now + 2), {
      ok: false, reason: 'cooldown', retryAfterMs: QUESTION_COOLDOWN_MS - 2,
    });

    const first = createOrEditAnswer(db, digest(2), created.question.id, submit('Rain on a roof.', 3), now);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('answer not created');
    const retry = createOrEditAnswer(db, digest(2), created.question.id, submit('Rain on a roof.', 3), now + 1);
    assert.equal(retry.ok, true);
    if (!retry.ok) throw new Error('answer retry failed');
    assert.equal(retry.duplicate, true);
    assert.deepEqual(createOrEditAnswer(db, digest(2), created.question.id, submit('A different answer.', 4), now + 2), {
      ok: false, reason: 'cooldown', retryAfterMs: ANSWER_COOLDOWN_MS - 2,
    });
    const edited = createOrEditAnswer(db, digest(2), created.question.id, submit('Rain on a roof, and a distant train.', 4), now + ANSWER_COOLDOWN_MS);
    assert.equal(edited.ok, true);
    if (!edited.ok) throw new Error('answer edit failed');
    assert.equal(edited.answer.id, first.answer.id);
    assert.equal(edited.answer.createdAt, now);
    assert.equal(edited.answer.text, 'Rain on a roof, and a distant train.');
    const otherVisitor = createOrEditAnswer(db, digest(3), created.question.id, submit('A kettle beginning to sing.', 5), now + ANSWER_COOLDOWN_MS);
    assert.equal(otherVisitor.ok, true);
    assert.equal(readQuestion(db, created.question.id, digest(2))?.answers.length, 2);
    assert.equal(readQuestion(db, created.question.id, digest(2))?.viewerAnswer?.id, first.answer.id);
    assert.equal(readQuestion(db, created.question.id, null)?.viewerAnswer, null);

    const secondQuestion = createQuestion(db, digest(4), submit('What would you ask the moon?', 6), now + 1);
    assert.equal(secondQuestion.ok, true);
    if (!secondQuestion.ok) throw new Error('second question not created');
    assert.equal(readQuestionList(db).questions[0].id, secondQuestion.question.id);
    assert.equal(readQuestionList(db).questions[0].answerCount, 0);
    assert.equal(removeAnswer(db, first.answer.id), true);
    assert.equal(removeAnswer(db, first.answer.id), false);
    assert.equal(readQuestion(db, created.question.id)?.answers.length, 1);
    assert.equal(removeQuestion(db, created.question.id), true);
    assert.equal(removeQuestion(db, created.question.id), false);
    assert.equal(readQuestion(db, created.question.id), null);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Open Questions keeps each question within the answer cap and expires old question trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-questions-bounds-'));
  const db = openDb(join(root, 'questions.sqlite'));
  try {
    const now = QUESTIONS_RETENTION_MS + 10_000_000;
    const created = createQuestion(db, digest(1000), submit('A bounded question?', 1000), now);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('question not created');
    const insert = db.prepare(`INSERT INTO questions_answers(question_id, visitor_digest, created_at, updated_at, body)
      VALUES (?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    for (let i = 1; i <= ANSWERS_PER_QUESTION_CAP; i += 1) insert.run(created.question.id, digest(i), now + i, now + i, `answer ${i}`);
    db.exec('COMMIT');
    const newest = createOrEditAnswer(db, digest(1001), created.question.id, submit('The newest perspective.', 1001), now + ANSWERS_PER_QUESTION_CAP + 1);
    assert.equal(newest.ok, true);
    assert.equal(readQuestion(db, created.question.id)?.answers.length, ANSWERS_PER_QUESTION_CAP);
    assert.equal(readQuestion(db, created.question.id)?.answers.some(answer => answer.text === 'answer 1'), false);

    const oldId = Number(db.prepare(`INSERT INTO questions_items(created_at, body)
      VALUES (?, ?) RETURNING id`).get(now - QUESTIONS_RETENTION_MS - 100, 'Old question')!.id);
    db.prepare(`INSERT INTO questions_answers(question_id, visitor_digest, created_at, updated_at, body)
      VALUES (?, ?, ?, ?, ?)`).run(oldId, digest(2001), now - QUESTIONS_RETENTION_MS, now - QUESTIONS_RETENTION_MS, 'Old answer');
    cleanupQuestionsState(db, now + ANSWERS_PER_QUESTION_CAP + 2);
    assert.equal(readQuestion(db, oldId), null);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Open Questions API supports empty browsing, visitor-scoped editing, cookie reset limits, and restart persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-questions-api-'));
  const path = join(root, 'questions.sqlite');
  let app = await createApp(options(path));
  try {
    assert.deepEqual((await app.inject('/api/questions')).json(), { questions: [], nextBefore: null });
    const asked = await app.inject({ method: 'POST', url: '/api/questions', headers: { origin }, payload: submit('Which small thing makes a day better?', 10) });
    assert.equal(asked.statusCode, 200);
    const question = asked.json().question;
    const cookie = (asked.headers['set-cookie'] as string).split(';', 1)[0];
    const answer = await app.inject({ method: 'POST', url: `/api/questions/${question.id}/answers`, headers: { origin, cookie }, payload: submit('A quiet walk.', 11) });
    assert.equal(answer.statusCode, 200);
    const detail = await app.inject({ url: `/api/questions/${question.id}`, headers: { cookie } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().viewerAnswer.text, 'A quiet walk.');
    assert.equal(JSON.stringify(detail.json()).includes(cookie.slice('ow_id='.length)), false);
    const duplicate = await app.inject({ method: 'POST', url: `/api/questions/${question.id}/answers`, headers: { origin, cookie }, payload: submit('A quiet walk.', 11) });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);

    const clearedCookieAnswer = await app.inject({ method: 'POST', url: `/api/questions/${question.id}/answers`, headers: { origin }, payload: submit('A different browser can answer too.', 12) });
    assert.equal(clearedCookieAnswer.statusCode, 200);
    const noIdentity = await app.inject({ url: `/api/questions/${question.id}` });
    assert.equal(noIdentity.json().viewerAnswer, null);
    assert.equal(noIdentity.json().answers.length, 2);
    const clearedCookie = (clearedCookieAnswer.headers['set-cookie'] as string).split(';', 1)[0];
    assert.equal((await app.inject({ method: 'POST', url: `/api/questions/${question.id}/answers`, headers: { origin, cookie: clearedCookie }, payload: submit('bad', 13) })).statusCode, 429);

    await app.close();
    app = await createApp(options(path));
    const persisted = await app.inject(`/api/questions/${question.id}`);
    assert.equal(persisted.statusCode, 200);
    assert.equal(persisted.json().answers.length, 2);
    assert.equal((await app.inject('/api/questions/999999')).statusCode, 404);
    assert.equal((await app.inject('/api/session')).statusCode, 200);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
