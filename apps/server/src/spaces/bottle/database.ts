import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ValidatedBottleSubmission } from './validation.js';

export const BOTTLE_MESSAGE_CAP = 10_000;
export const BOTTLE_COOLDOWN_MS = 20_000;
export const BOTTLE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const BOTTLE_IDEMPOTENCY_CAP = 10_000;
export const BOTTLE_VISITOR_CAP = 10_000;

export interface Bottle {
  readonly id: string;
  /** Unix epoch milliseconds; interpreted and stored as UTC. */
  readonly createdAt: number;
  readonly message: string;
  readonly signature: string | null;
}

interface BottleRow {
  id: string;
  created_at: number;
  body: string;
  signature: string | null;
}

function fromRow(row: BottleRow): Bottle {
  return { id: row.id, createdAt: row.created_at, message: row.body, signature: row.signature };
}

export function findRandomBottle(db: DatabaseSync, excludedIds: readonly string[] = []): Bottle | null {
  const ids = [...new Set(excludedIds)];
  const excluded = ids.length ? `WHERE id NOT IN (${ids.map(() => '?').join(',')})` : '';
  const row = db.prepare(`SELECT id, created_at, body, signature FROM bottle_messages ${excluded} ORDER BY random() LIMIT 1`)
    .get(...ids) as BottleRow | undefined;
  return row ? fromRow(row) : null;
}

export type SubmitBottleResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly bottle: Bottle | null; readonly cooldownMs: number }
  | { readonly ok: false; readonly reason: 'cooldown'; readonly retryAfterMs: number };

export function releaseBottle(
  db: DatabaseSync,
  visitorDigest: string,
  submission: ValidatedBottleSubmission,
  now = Date.now(),
): SubmitBottleResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare(`SELECT i.bottle_id, i.created_at AS submitted_at, m.id, m.created_at, m.body, m.signature
      FROM bottle_idempotency i LEFT JOIN bottle_messages m ON m.id=i.bottle_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ bottle_id: string; submitted_at: number } & BottleRow) | { bottle_id: string; submitted_at: number; id: null; created_at: null; body: null; signature: null } | undefined;
    if (duplicate) {
      db.exec('COMMIT');
      return {
        ok: true,
        duplicate: true,
        bottle: duplicate.id === null ? null : fromRow(duplicate as BottleRow),
        cooldownMs: Math.max(0, duplicate.submitted_at + BOTTLE_COOLDOWN_MS - now),
      };
    }

    const last = db.prepare('SELECT released_at FROM bottle_visitor_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { released_at: number } | undefined;
    if (last && last.released_at + BOTTLE_COOLDOWN_MS > now) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'cooldown', retryAfterMs: last.released_at + BOTTLE_COOLDOWN_MS - now };
    }

    const id = randomUUID();
    db.prepare('INSERT INTO bottle_messages(id, created_at, body, signature) VALUES (?, ?, ?, ?)')
      .run(id, now, submission.message, submission.signature);
    db.prepare(`INSERT INTO bottle_visitor_cooldowns(visitor_digest, released_at) VALUES (?, ?)
      ON CONFLICT(visitor_digest) DO UPDATE SET released_at=excluded.released_at`).run(visitorDigest, now);
    db.prepare('INSERT INTO bottle_idempotency(visitor_digest, request_id, created_at, bottle_id) VALUES (?, ?, ?, ?)')
      .run(visitorDigest, submission.requestId, now, id);

    const excess = Number((db.prepare('SELECT COUNT(*) AS count FROM bottle_messages').get() as { count: number }).count) - BOTTLE_MESSAGE_CAP;
    if (excess > 0) {
      db.prepare(`DELETE FROM bottle_messages WHERE id IN (
        SELECT id FROM bottle_messages ORDER BY created_at ASC, rowid ASC LIMIT ?
      )`).run(excess);
    }
    trimBottleCooldowns(db, now);
    trimBottleIdempotency(db, now);
    db.exec('COMMIT');
    return {
      ok: true,
      duplicate: false,
      bottle: { id, createdAt: now, message: submission.message, signature: submission.signature },
      cooldownMs: BOTTLE_COOLDOWN_MS,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function trimBottleIdempotency(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM bottle_idempotency WHERE created_at<?').run(now - BOTTLE_IDEMPOTENCY_RETENTION_MS);
  db.prepare(`DELETE FROM bottle_idempotency WHERE rowid IN (
    SELECT rowid FROM bottle_idempotency ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
  )`).run(BOTTLE_IDEMPOTENCY_CAP);
}

export function cleanupBottleState(db: DatabaseSync, now = Date.now()): number {
  const result = db.prepare('DELETE FROM bottle_idempotency WHERE created_at<?').run(now - BOTTLE_IDEMPOTENCY_RETENTION_MS);
  const cooldowns = db.prepare('DELETE FROM bottle_visitor_cooldowns WHERE released_at<=?').run(now - BOTTLE_COOLDOWN_MS);
  return Number(result.changes) + Number(cooldowns.changes);
}

function trimBottleCooldowns(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM bottle_visitor_cooldowns WHERE released_at<=?').run(now - BOTTLE_COOLDOWN_MS);
  db.prepare(`DELETE FROM bottle_visitor_cooldowns WHERE rowid IN (
    SELECT rowid FROM bottle_visitor_cooldowns ORDER BY released_at DESC, rowid DESC LIMIT -1 OFFSET ?
  )`).run(BOTTLE_VISITOR_CAP);
}

export function removeBottle(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM bottle_messages WHERE id=?').run(id);
  return Number(result.changes) > 0;
}

export function bottleCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS count FROM bottle_messages').get() as { count: number }).count);
}
