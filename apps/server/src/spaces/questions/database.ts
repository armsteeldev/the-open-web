import type { DatabaseSync } from 'node:sqlite';
import { payloadHash } from '../plain-text.js';
import type { QuestionSubmission } from './validation.js';

export const QUESTIONS_PER_PAGE = 12;
export const QUESTIONS_CAP = 5_000;
export const QUESTIONS_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
export const ANSWERS_PER_QUESTION_CAP = 100;
export const ANSWERS_TOTAL_CAP = 20_000;
export const QUESTIONS_IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const QUESTIONS_IDEMPOTENCY_CAP = 50_000;
export const QUESTIONS_COOLDOWNS_CAP = 50_000;
export const QUESTION_COOLDOWN_MS = 60 * 60 * 1000;
export const ANSWER_COOLDOWN_MS = 5_000;

export interface OpenQuestion {
  readonly id: number;
  readonly createdAt: number;
  readonly text: string;
  readonly answerCount: number;
}

export interface QuestionAnswer {
  readonly id: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly text: string;
}

interface QuestionRow {
  id: number;
  created_at: number;
  body: string;
  answer_count: number;
}

interface AnswerRow {
  id: number;
  created_at: number;
  updated_at: number;
  body: string;
}

function immediate<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already have rolled back */ }
    throw error;
  }
}

function deferred<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already have rolled back */ }
    throw error;
  }
}

function question(row: QuestionRow): OpenQuestion {
  return { id: row.id, createdAt: row.created_at, text: row.body, answerCount: row.answer_count };
}

function cleanup(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM questions_item_idempotency WHERE created_at < ?').run(now - QUESTIONS_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM questions_answer_idempotency WHERE created_at < ?').run(now - QUESTIONS_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM questions_visitor_cooldowns WHERE acted_at <= ?').run(now - Math.max(QUESTION_COOLDOWN_MS, ANSWER_COOLDOWN_MS));
  db.prepare('DELETE FROM questions_items WHERE created_at < ?').run(now - QUESTIONS_RETENTION_MS);
  db.prepare(`DELETE FROM questions_items WHERE id IN (
    SELECT id FROM questions_items ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(QUESTIONS_CAP);
  db.prepare(`DELETE FROM questions_answers WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY updated_at DESC, id DESC) AS position
      FROM questions_answers
    ) WHERE position > ?
  )`).run(ANSWERS_PER_QUESTION_CAP);
  db.prepare(`DELETE FROM questions_answers WHERE id IN (
    SELECT id FROM questions_answers ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(ANSWERS_TOTAL_CAP);
}

function trimAnswers(db: DatabaseSync, questionId: number): void {
  db.prepare(`DELETE FROM questions_answers WHERE id IN (
    SELECT id FROM questions_answers WHERE question_id=? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(questionId, ANSWERS_PER_QUESTION_CAP);
  db.prepare(`DELETE FROM questions_answers WHERE id IN (
    SELECT id FROM questions_answers ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(ANSWERS_TOTAL_CAP);
}

export interface QuestionPage {
  readonly questions: readonly OpenQuestion[];
  readonly nextBefore: number | null;
}

export function readQuestionList(db: DatabaseSync, before: number | null = null): QuestionPage {
  const rows = db.prepare(`SELECT q.id, q.created_at, q.body,
      (SELECT COUNT(*) FROM questions_answers a WHERE a.question_id=q.id) AS answer_count
    FROM questions_items q ${before === null ? '' : 'WHERE q.id < ?'}
    ORDER BY q.id DESC LIMIT ?`).all(
    ...(before === null ? [QUESTIONS_PER_PAGE + 1] : [before, QUESTIONS_PER_PAGE + 1]),
  ) as unknown as QuestionRow[];
  const hasOlder = rows.length > QUESTIONS_PER_PAGE;
  const questions = rows.slice(0, QUESTIONS_PER_PAGE).map(question);
  return { questions, nextBefore: hasOlder ? questions.at(-1)?.id ?? null : null };
}

export interface QuestionDetail {
  readonly question: OpenQuestion;
  readonly answers: readonly QuestionAnswer[];
  readonly viewerAnswer: QuestionAnswer | null;
}

function detailWithin(db: DatabaseSync, id: number, visitorDigest?: string | null): QuestionDetail | null {
  const row = db.prepare(`SELECT q.id, q.created_at, q.body,
      (SELECT COUNT(*) FROM questions_answers a WHERE a.question_id=q.id) AS answer_count
    FROM questions_items q WHERE q.id=?`).get(id) as QuestionRow | undefined;
  if (!row) return null;
  const answers = db.prepare(`SELECT id, created_at, updated_at, body FROM questions_answers
    WHERE question_id=? ORDER BY created_at, id`).all(id) as unknown as AnswerRow[];
  let viewerAnswer: QuestionAnswer | null = null;
  if (visitorDigest) {
    const mine = db.prepare(`SELECT id, created_at, updated_at, body FROM questions_answers
      WHERE question_id=? AND visitor_digest=?`).get(id, visitorDigest) as unknown as AnswerRow | undefined;
    if (mine) viewerAnswer = { id: mine.id, createdAt: mine.created_at, updatedAt: mine.updated_at, text: mine.body };
  }
  return {
    question: question(row),
    answers: answers.map(answer => ({ id: answer.id, createdAt: answer.created_at, updatedAt: answer.updated_at, text: answer.body })),
    viewerAnswer,
  };
}

export function readQuestion(db: DatabaseSync, id: number, visitorDigest?: string | null): QuestionDetail | null {
  return deferred(db, () => detailWithin(db, id, visitorDigest));
}

export type CreateQuestionResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly question: OpenQuestion }
  | { readonly ok: false; readonly reason: 'cooldown' | 'capacity' | 'idempotency-conflict'; readonly retryAfterMs?: number };

export function createQuestion(db: DatabaseSync, visitorDigest: string, submission: QuestionSubmission, now = Date.now()): CreateQuestionResult {
  const hash = payloadHash([submission.text]);
  return immediate(db, () => {
    cleanup(db, now);
    const previous = db.prepare(`SELECT i.payload_hash, q.id, q.created_at, q.body,
        (SELECT COUNT(*) FROM questions_answers a WHERE a.question_id=q.id) AS answer_count
      FROM questions_item_idempotency i JOIN questions_items q ON q.id=i.question_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ payload_hash: string } & QuestionRow) | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      return { ok: true, duplicate: true, question: question(previous) } as const;
    }

    const previousWrite = db.prepare(`SELECT acted_at FROM questions_visitor_cooldowns
      WHERE visitor_digest=? AND action='question'`).get(visitorDigest) as { acted_at: number } | undefined;
    if (previousWrite && previousWrite.acted_at + QUESTION_COOLDOWN_MS > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: previousWrite.acted_at + QUESTION_COOLDOWN_MS - now } as const;
    }
    const requestCount = Number((db.prepare('SELECT COUNT(*) AS count FROM questions_item_idempotency').get() as { count: number }).count);
    const cooldownCount = Number((db.prepare('SELECT COUNT(*) AS count FROM questions_visitor_cooldowns').get() as { count: number }).count);
    if (requestCount >= QUESTIONS_IDEMPOTENCY_CAP || cooldownCount >= QUESTIONS_COOLDOWNS_CAP) return { ok: false, reason: 'capacity' } as const;

    const id = Number(db.prepare(`INSERT INTO questions_items(created_at, body) VALUES (?, ?) RETURNING id`)
      .get(now, submission.text)!.id);
    db.prepare(`INSERT INTO questions_item_idempotency(visitor_digest, request_id, payload_hash, created_at, question_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, submission.requestId, hash, now, id);
    db.prepare(`INSERT INTO questions_visitor_cooldowns(visitor_digest, action, acted_at) VALUES (?, 'question', ?)
      ON CONFLICT(visitor_digest, action) DO UPDATE SET acted_at=excluded.acted_at`).run(visitorDigest, now);
    cleanup(db, now);
    const inserted = detailWithin(db, id, visitorDigest)!.question;
    return { ok: true, duplicate: false, question: inserted } as const;
  });
}

export type CreateAnswerResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly answer: QuestionAnswer }
  | { readonly ok: false; readonly reason: 'not-found' | 'cooldown' | 'capacity' | 'idempotency-conflict'; readonly retryAfterMs?: number };

export function createOrEditAnswer(
  db: DatabaseSync,
  visitorDigest: string,
  questionId: number,
  submission: QuestionSubmission,
  now = Date.now(),
): CreateAnswerResult {
  const hash = payloadHash([questionId, submission.text]);
  return immediate(db, () => {
    cleanup(db, now);
    const previous = db.prepare(`SELECT i.payload_hash, a.id, a.created_at, a.updated_at, a.body
      FROM questions_answer_idempotency i JOIN questions_answers a ON a.id=i.answer_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ payload_hash: string } & AnswerRow) | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      return {
        ok: true,
        duplicate: true,
        answer: { id: previous.id, createdAt: previous.created_at, updatedAt: previous.updated_at, text: previous.body },
      } as const;
    }
    if (!db.prepare('SELECT id FROM questions_items WHERE id=?').get(questionId)) return { ok: false, reason: 'not-found' } as const;

    const previousWrite = db.prepare(`SELECT acted_at FROM questions_visitor_cooldowns
      WHERE visitor_digest=? AND action='answer'`).get(visitorDigest) as { acted_at: number } | undefined;
    if (previousWrite && previousWrite.acted_at + ANSWER_COOLDOWN_MS > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: previousWrite.acted_at + ANSWER_COOLDOWN_MS - now } as const;
    }
    const requestCount = Number((db.prepare('SELECT COUNT(*) AS count FROM questions_answer_idempotency').get() as { count: number }).count);
    const cooldownCount = Number((db.prepare('SELECT COUNT(*) AS count FROM questions_visitor_cooldowns').get() as { count: number }).count);
    if (requestCount >= QUESTIONS_IDEMPOTENCY_CAP || cooldownCount >= QUESTIONS_COOLDOWNS_CAP) return { ok: false, reason: 'capacity' } as const;

    db.prepare(`INSERT INTO questions_answers(question_id, visitor_digest, created_at, updated_at, body)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(question_id, visitor_digest) DO UPDATE SET updated_at=excluded.updated_at, body=excluded.body`)
      .run(questionId, visitorDigest, now, now, submission.text);
    const answer = db.prepare(`SELECT id, created_at, updated_at, body FROM questions_answers
      WHERE question_id=? AND visitor_digest=?`).get(questionId, visitorDigest) as unknown as AnswerRow;
    db.prepare(`INSERT INTO questions_answer_idempotency(visitor_digest, request_id, payload_hash, created_at, answer_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, submission.requestId, hash, now, answer.id);
    db.prepare(`INSERT INTO questions_visitor_cooldowns(visitor_digest, action, acted_at) VALUES (?, 'answer', ?)
      ON CONFLICT(visitor_digest, action) DO UPDATE SET acted_at=excluded.acted_at`).run(visitorDigest, now);
    trimAnswers(db, questionId);
    cleanup(db, now);
    const saved = db.prepare(`SELECT id, created_at, updated_at, body FROM questions_answers WHERE id=?`).get(answer.id) as unknown as AnswerRow | undefined;
    if (!saved) return { ok: false, reason: 'capacity' } as const;
    return {
      ok: true,
      duplicate: false,
      answer: { id: saved.id, createdAt: saved.created_at, updatedAt: saved.updated_at, text: saved.body },
    } as const;
  });
}

export function cleanupQuestionsState(db: DatabaseSync, now = Date.now()): void {
  immediate(db, () => cleanup(db, now));
}

export function removeQuestion(db: DatabaseSync, id: number): boolean {
  return immediate(db, () => Number(db.prepare('DELETE FROM questions_items WHERE id=?').run(id).changes) > 0);
}

export function removeAnswer(db: DatabaseSync, id: number): boolean {
  return immediate(db, () => Number(db.prepare('DELETE FROM questions_answers WHERE id=?').run(id).changes) > 0);
}
