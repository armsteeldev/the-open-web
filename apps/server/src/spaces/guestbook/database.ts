import type { DatabaseSync } from 'node:sqlite';
import { payloadHash } from '../plain-text.js';
import type { GuestbookSubmission } from './validation.js';

export const GUESTBOOK_PAGE_SIZE = 20;
export const GUESTBOOK_ENTRY_CAP = 25_000;
export const GUESTBOOK_RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000;
export const GUESTBOOK_COOLDOWN_MS = 30_000;
export const GUESTBOOK_IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const GUESTBOOK_IDEMPOTENCY_CAP = 50_000;

export interface GuestbookEntry {
  readonly id: number;
  readonly createdAt: number;
  readonly displayName: string | null;
  readonly message: string;
}

interface EntryRow {
  id: number;
  created_at: number;
  display_name: string | null;
  body: string;
}

function entry(row: EntryRow): GuestbookEntry {
  return { id: row.id, createdAt: row.created_at, displayName: row.display_name, message: row.body };
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

function pruneEntries(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM guestbook_entries WHERE created_at < ?').run(now - GUESTBOOK_RETENTION_MS);
  db.prepare(`DELETE FROM guestbook_entries WHERE id IN (
    SELECT id FROM guestbook_entries ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(GUESTBOOK_ENTRY_CAP);
}

function cleanup(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM guestbook_idempotency WHERE created_at < ?').run(now - GUESTBOOK_IDEMPOTENCY_MS);
  db.prepare('DELETE FROM guestbook_visitor_cooldowns WHERE submitted_at <= ?').run(now - GUESTBOOK_COOLDOWN_MS);
  pruneEntries(db, now);
}

export interface GuestbookPage {
  readonly entries: readonly GuestbookEntry[];
  readonly nextBefore: number | null;
}

export function readGuestbook(db: DatabaseSync, before: number | null = null): GuestbookPage {
  const rows = db.prepare(`SELECT id, created_at, display_name, body FROM guestbook_entries
    ${before === null ? '' : 'WHERE id < ?'} ORDER BY id DESC LIMIT ?`)
    .all(...(before === null ? [GUESTBOOK_PAGE_SIZE + 1] : [before, GUESTBOOK_PAGE_SIZE + 1])) as unknown as EntryRow[];
  const hasOlder = rows.length > GUESTBOOK_PAGE_SIZE;
  const entries = rows.slice(0, GUESTBOOK_PAGE_SIZE).map(entry);
  return { entries, nextBefore: hasOlder ? entries.at(-1)?.id ?? null : null };
}

export type CreateGuestbookResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly entry: GuestbookEntry }
  | { readonly ok: false; readonly reason: 'cooldown' | 'capacity' | 'idempotency-conflict'; readonly retryAfterMs?: number };

export function createGuestbookEntry(
  db: DatabaseSync,
  visitorDigest: string,
  submission: GuestbookSubmission,
  now = Date.now(),
): CreateGuestbookResult {
  const hash = payloadHash([submission.displayName, submission.message]);
  return immediate(db, () => {
    cleanup(db, now);
    const previous = db.prepare(`SELECT i.payload_hash, e.id, e.created_at, e.display_name, e.body
      FROM guestbook_idempotency i JOIN guestbook_entries e ON e.id=i.entry_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ payload_hash: string } & EntryRow) | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) return { ok: false, reason: 'idempotency-conflict' } as const;
      return { ok: true, duplicate: true, entry: entry(previous) } as const;
    }

    const cooldown = db.prepare('SELECT submitted_at FROM guestbook_visitor_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { submitted_at: number } | undefined;
    if (cooldown && cooldown.submitted_at + GUESTBOOK_COOLDOWN_MS > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldown.submitted_at + GUESTBOOK_COOLDOWN_MS - now } as const;
    }
    const idempotencyCount = Number((db.prepare('SELECT COUNT(*) AS count FROM guestbook_idempotency').get() as { count: number }).count);
    const cooldownCount = Number((db.prepare('SELECT COUNT(*) AS count FROM guestbook_visitor_cooldowns').get() as { count: number }).count);
    if (idempotencyCount >= GUESTBOOK_IDEMPOTENCY_CAP || cooldownCount >= GUESTBOOK_IDEMPOTENCY_CAP) {
      return { ok: false, reason: 'capacity' } as const;
    }

    const id = Number(db.prepare('INSERT INTO guestbook_entries(created_at, display_name, body) VALUES (?, ?, ?) RETURNING id')
      .get(now, submission.displayName, submission.message)!.id);
    db.prepare('INSERT INTO guestbook_visitor_cooldowns(visitor_digest, submitted_at) VALUES (?, ?)')
      .run(visitorDigest, now);
    db.prepare(`INSERT INTO guestbook_idempotency(visitor_digest, request_id, payload_hash, created_at, entry_id)
      VALUES (?, ?, ?, ?, ?)`).run(visitorDigest, submission.requestId, hash, now, id);
    pruneEntries(db, now);
    return {
      ok: true,
      duplicate: false,
      entry: { id, createdAt: now, displayName: submission.displayName, message: submission.message },
    } as const;
  });
}

export function cleanupGuestbookState(db: DatabaseSync, now = Date.now()): void {
  immediate(db, () => cleanup(db, now));
}

export function removeGuestbookEntry(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM guestbook_entries WHERE id=?').run(id).changes) > 0;
}
