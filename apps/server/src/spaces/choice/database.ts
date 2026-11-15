import type { DatabaseSync } from 'node:sqlite';
import { payloadHash } from '../plain-text.js';
import type { ChoiceProposal } from './validation.js';

export const CHOICE_OPEN_MS = 7 * 24 * 60 * 60 * 1000;
export const CHOICE_QUEUE_CAP = 20;
export const CHOICE_ARCHIVE_CAP = 100;
export const CHOICE_ACTIVE_VOTE_CAP = 10_000;
export const CHOICE_IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const CHOICE_IDEMPOTENCY_CAP = 50_000;
export const CHOICE_PROPOSAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface ChoiceResults {
  readonly optionA: number;
  readonly optionB: number;
  readonly total: number;
}

export interface ChoiceDecision {
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
  readonly results: ChoiceResults | null;
}

interface DecisionRow {
  id: number;
  created_at: number;
  question: string;
  option_a: string;
  option_b: string;
  status: 'queued' | 'active' | 'closed';
  opened_at: number | null;
  closes_at: number | null;
  closed_at: number | null;
  result_a: number | null;
  result_b: number | null;
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

function cleanup(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM choice_proposal_idempotency WHERE created_at < ?').run(now - CHOICE_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM choice_vote_idempotency WHERE created_at < ?').run(now - CHOICE_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM choice_proposal_cooldowns WHERE proposed_at <= ?').run(now - CHOICE_PROPOSAL_COOLDOWN_MS);
  trimArchive(db);
}

function trimArchive(db: DatabaseSync): void {
  db.prepare(`DELETE FROM choice_decisions WHERE id IN (
    SELECT id FROM choice_decisions WHERE status='closed' ORDER BY closed_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(CHOICE_ARCHIVE_CAP);
}

function activateNext(db: DatabaseSync, now: number): void {
  const queued = db.prepare(`SELECT id FROM choice_decisions WHERE status='queued' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
  if (queued) {
    db.prepare(`UPDATE choice_decisions SET status='active', opened_at=?, closes_at=? WHERE id=?`)
      .run(now, now + CHOICE_OPEN_MS, queued.id);
  }
}

function advanceWithinTransaction(db: DatabaseSync, now: number): void {
  const active = db.prepare(`SELECT id, closes_at FROM choice_decisions WHERE status='active'`).get() as
    { id: number; closes_at: number } | undefined;
  if (active && active.closes_at <= now) {
    const counts = db.prepare(`SELECT
        SUM(CASE WHEN choice='a' THEN 1 ELSE 0 END) AS option_a,
        SUM(CASE WHEN choice='b' THEN 1 ELSE 0 END) AS option_b
      FROM choice_votes WHERE decision_id=?`).get(active.id) as { option_a: number | null; option_b: number | null };
    db.prepare(`UPDATE choice_decisions SET status='closed', closed_at=?, result_a=?, result_b=? WHERE id=?`)
      .run(active.closes_at, Number(counts.option_a ?? 0), Number(counts.option_b ?? 0), active.id);
    db.prepare('DELETE FROM choice_votes WHERE decision_id=?').run(active.id);
    trimArchive(db);
  }
  if (!db.prepare(`SELECT id FROM choice_decisions WHERE status='active'`).get()) activateNext(db, now);
}

function decisionRow(db: DatabaseSync, id: number): DecisionRow | undefined {
  return db.prepare(`SELECT id, created_at, question, option_a, option_b, status, opened_at, closes_at, closed_at, result_a, result_b
    FROM choice_decisions WHERE id=?`).get(id) as DecisionRow | undefined;
}

function publicDecision(db: DatabaseSync, row: DecisionRow, visitorDigest?: string | null): ChoiceDecision {
  let viewerChoice: 'a' | 'b' | null = null;
  let results: ChoiceResults | null = null;
  if (row.status === 'closed') {
    const optionA = Number(row.result_a ?? 0);
    const optionB = Number(row.result_b ?? 0);
    results = { optionA, optionB, total: optionA + optionB };
  } else if (row.status === 'active' && visitorDigest) {
    const vote = db.prepare(`SELECT choice FROM choice_votes WHERE decision_id=? AND visitor_digest=?`).get(row.id, visitorDigest) as
      { choice: 'a' | 'b' } | undefined;
    viewerChoice = vote?.choice ?? null;
    if (viewerChoice) {
      const counts = db.prepare(`SELECT
          SUM(CASE WHEN choice='a' THEN 1 ELSE 0 END) AS option_a,
          SUM(CASE WHEN choice='b' THEN 1 ELSE 0 END) AS option_b
        FROM choice_votes WHERE decision_id=?`).get(row.id) as { option_a: number | null; option_b: number | null };
      const optionA = Number(counts.option_a ?? 0);
      const optionB = Number(counts.option_b ?? 0);
      results = { optionA, optionB, total: optionA + optionB };
    }
  }
  return {
    id: row.id,
    question: row.question,
    optionA: row.option_a,
    optionB: row.option_b,
    status: row.status,
    createdAt: row.created_at,
    openedAt: row.opened_at,
    closesAt: row.closes_at,
    closedAt: row.closed_at,
    viewerChoice,
    results,
  };
}

export interface ChoiceState {
  readonly active: ChoiceDecision | null;
  readonly queuedCount: number;
}

export function getChoiceState(db: DatabaseSync, visitorDigest?: string | null, now = Date.now()): ChoiceState {
  return immediate(db, () => {
    cleanup(db, now);
    advanceWithinTransaction(db, now);
    const row = db.prepare(`SELECT id, created_at, question, option_a, option_b, status, opened_at, closes_at, closed_at, result_a, result_b
      FROM choice_decisions WHERE status='active'`).get() as DecisionRow | undefined;
    const queuedCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM choice_decisions WHERE status='queued'`).get() as { count: number }).count);
    return { active: row ? publicDecision(db, row, visitorDigest) : null, queuedCount };
  });
}

export interface ChoiceArchivePage {
  readonly decisions: readonly ChoiceDecision[];
  readonly nextBefore: number | null;
}

export function readChoiceArchive(db: DatabaseSync, before: number | null = null): ChoiceArchivePage {
  return deferred(db, () => {
    const rows = db.prepare(`SELECT id, created_at, question, option_a, option_b, status, opened_at, closes_at, closed_at, result_a, result_b
      FROM choice_decisions WHERE status='closed' ${before === null ? '' : 'AND id < ?'}
      ORDER BY id DESC LIMIT ?`).all(
      ...(before === null ? [11] : [before, 11]),
    ) as unknown as DecisionRow[];
    const hasOlder = rows.length > 10;
    const decisions = rows.slice(0, 10).map(row => publicDecision(db, row));
    return { decisions, nextBefore: hasOlder ? decisions.at(-1)?.id ?? null : null };
  });
}

export type ProposeChoiceResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly decision: ChoiceDecision; readonly queuedCount: number }
  | { readonly ok: false; readonly reason: 'cooldown' | 'queue-full' | 'capacity' | 'idempotency-conflict'; readonly retryAfterMs?: number };

export function proposeChoice(db: DatabaseSync, visitorDigest: string, proposal: ChoiceProposal, now = Date.now()): ProposeChoiceResult {
  const hash = payloadHash([proposal.question, proposal.optionA, proposal.optionB]);
  return immediate(db, () => {
    cleanup(db, now);
    advanceWithinTransaction(db, now);
    const previous = db.prepare(`SELECT i.payload_hash, d.id, d.created_at, d.question, d.option_a, d.option_b, d.status,
        d.opened_at, d.closes_at, d.closed_at, d.result_a, d.result_b
      FROM choice_proposal_idempotency i JOIN choice_decisions d ON d.id=i.decision_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, proposal.requestId) as
      ({ payload_hash: string } & DecisionRow) | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      const queuedCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM choice_decisions WHERE status='queued'`).get() as { count: number }).count);
      return { ok: true, duplicate: true, decision: publicDecision(db, previous), queuedCount } as const;
    }
    const cooldown = db.prepare('SELECT proposed_at FROM choice_proposal_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { proposed_at: number } | undefined;
    if (cooldown && cooldown.proposed_at + CHOICE_PROPOSAL_COOLDOWN_MS > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldown.proposed_at + CHOICE_PROPOSAL_COOLDOWN_MS - now } as const;
    }
    const queuedCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM choice_decisions WHERE status='queued'`).get() as { count: number }).count);
    if (queuedCount >= CHOICE_QUEUE_CAP) return { ok: false, reason: 'queue-full' } as const;
    const requestCount = Number((db.prepare('SELECT COUNT(*) AS count FROM choice_proposal_idempotency').get() as { count: number }).count);
    const cooldownCount = Number((db.prepare('SELECT COUNT(*) AS count FROM choice_proposal_cooldowns').get() as { count: number }).count);
    if (requestCount >= CHOICE_IDEMPOTENCY_CAP || cooldownCount >= CHOICE_IDEMPOTENCY_CAP) return { ok: false, reason: 'capacity' } as const;

    const active = db.prepare(`SELECT id FROM choice_decisions WHERE status='active'`).get();
    const id = Number(db.prepare(`INSERT INTO choice_decisions(created_at, question, option_a, option_b, status, opened_at, closes_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      now,
      proposal.question,
      proposal.optionA,
      proposal.optionB,
      active ? 'queued' : 'active',
      active ? null : now,
      active ? null : now + CHOICE_OPEN_MS,
    )!.id);
    db.prepare(`INSERT INTO choice_proposal_cooldowns(visitor_digest, proposed_at) VALUES (?, ?)
      ON CONFLICT(visitor_digest) DO UPDATE SET proposed_at=excluded.proposed_at`).run(visitorDigest, now);
    db.prepare(`INSERT INTO choice_proposal_idempotency(visitor_digest, request_id, payload_hash, created_at, decision_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, proposal.requestId, hash, now, id);
    const row = decisionRow(db, id)!;
    const currentQueuedCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM choice_decisions WHERE status='queued'`).get() as { count: number }).count);
    return { ok: true, duplicate: false, decision: publicDecision(db, row), queuedCount: currentQueuedCount } as const;
  });
}

export type VoteChoiceResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly decision: ChoiceDecision }
  | { readonly ok: false; readonly reason: 'not-found' | 'closed' | 'capacity' | 'idempotency-conflict' };

export function voteChoice(
  db: DatabaseSync,
  visitorDigest: string,
  decisionId: number,
  requestId: string,
  choice: 'a' | 'b',
  now = Date.now(),
): VoteChoiceResult {
  const hash = payloadHash([decisionId, choice]);
  return immediate(db, () => {
    cleanup(db, now);
    advanceWithinTransaction(db, now);
    const previous = db.prepare('SELECT payload_hash FROM choice_vote_idempotency WHERE visitor_digest=? AND request_id=?')
      .get(visitorDigest, requestId) as { payload_hash: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      const row = decisionRow(db, decisionId);
      if (!row) return { ok: false, reason: 'not-found' } as const;
      return { ok: true, duplicate: true, decision: publicDecision(db, row, visitorDigest) } as const;
    }
    const row = decisionRow(db, decisionId);
    if (!row) return { ok: false, reason: 'not-found' } as const;
    if (row.status !== 'active' || row.closes_at === null || row.closes_at <= now) return { ok: false, reason: 'closed' } as const;

    const requestCount = Number((db.prepare('SELECT COUNT(*) AS count FROM choice_vote_idempotency').get() as { count: number }).count);
    if (requestCount >= CHOICE_IDEMPOTENCY_CAP) return { ok: false, reason: 'capacity' } as const;
    const existing = db.prepare('SELECT choice FROM choice_votes WHERE decision_id=? AND visitor_digest=?')
      .get(decisionId, visitorDigest) as { choice: 'a' | 'b' } | undefined;
    const totalVotes = Number((db.prepare('SELECT COUNT(*) AS count FROM choice_votes WHERE decision_id=?').get(decisionId) as { count: number }).count);
    if (!existing && totalVotes >= CHOICE_ACTIVE_VOTE_CAP) return { ok: false, reason: 'capacity' } as const;

    db.prepare(`INSERT INTO choice_votes(decision_id, visitor_digest, choice, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(decision_id, visitor_digest) DO UPDATE SET choice=excluded.choice, updated_at=excluded.updated_at`)
      .run(decisionId, visitorDigest, choice, now);
    db.prepare(`INSERT INTO choice_vote_idempotency(visitor_digest, request_id, payload_hash, created_at, decision_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, requestId, hash, now, decisionId);
    return { ok: true, duplicate: false, decision: publicDecision(db, decisionRow(db, decisionId)!, visitorDigest) } as const;
  });
}

export function cleanupChoiceState(db: DatabaseSync, now = Date.now()): void {
  immediate(db, () => {
    cleanup(db, now);
    advanceWithinTransaction(db, now);
  });
}

export function removeChoiceDecision(db: DatabaseSync, id: number, now = Date.now()): boolean {
  return immediate(db, () => {
    const row = decisionRow(db, id);
    if (!row) return false;
    db.prepare('DELETE FROM choice_decisions WHERE id=?').run(id);
    if (row.status === 'active') advanceWithinTransaction(db, now);
    return true;
  });
}
