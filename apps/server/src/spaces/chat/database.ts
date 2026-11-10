import type { DatabaseSync } from 'node:sqlite';

export const CHAT_HISTORY_LIMIT = 100;
export const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CHAT_MESSAGE_CAP = 2_000;
const IDEMPOTENCY_RETENTION_MS = 60 * 60 * 1000;
const IDEMPOTENCY_CAP = 10_000;
const REMOVAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const REMOVAL_CAP = 5_000;
const MAINTENANCE_BATCH = 100;

export interface ChatMessage {
  readonly id: number;
  readonly createdAt: number;
  readonly nickname: string;
  readonly text: string;
}

interface ChatMessageRow {
  id: number;
  created_at: number;
  nickname: string;
  body: string;
}

function fromRow(row: ChatMessageRow): ChatMessage {
  return { id: row.id, createdAt: row.created_at, nickname: row.nickname, text: row.body };
}

function rememberRemoval(db: DatabaseSync, messageIds: readonly number[], now: number): number[] {
  const insert = db.prepare('INSERT INTO chat_message_removals(message_id, removed_at) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM chat_messages WHERE id=?');
  const removed: number[] = [];
  for (const id of messageIds) {
    const result = remove.run(id);
    if (Number(result.changes) === 0) continue;
    insert.run(id, now);
    removed.push(id);
  }
  return removed;
}

function trimRemovalHistory(db: DatabaseSync, now: number): void {
  db.prepare(`DELETE FROM chat_message_removals WHERE id IN (
    SELECT id FROM chat_message_removals ORDER BY id DESC LIMIT -1 OFFSET ?
  )`).run(REMOVAL_CAP);
  db.prepare(`DELETE FROM chat_message_removals WHERE id IN (
    SELECT id FROM chat_message_removals WHERE removed_at<? ORDER BY id LIMIT ?
  )`).run(now - REMOVAL_RETENTION_MS, MAINTENANCE_BATCH);
}

export function readRecentMessages(db: DatabaseSync, now = Date.now()): { messages: ChatMessage[]; latestId: number } {
  db.exec('BEGIN');
  try {
    const rows = db.prepare(`SELECT id, created_at, nickname, body FROM chat_messages
      WHERE created_at>=? ORDER BY id DESC LIMIT ?`).all(now - CHAT_RETENTION_MS, CHAT_HISTORY_LIMIT) as unknown as ChatMessageRow[];
    const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE created_at>=?').get(now - CHAT_RETENTION_MS) as { id: number };
    db.exec('COMMIT');
    return { messages: rows.reverse().map(fromRow), latestId: latest.id };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export type ChatSubmitResult =
  | { readonly ok: true; readonly duplicate: false; readonly message: ChatMessage; readonly removedIds: number[] }
  | { readonly ok: true; readonly duplicate: true; readonly message: ChatMessage | null; readonly removedIds: number[] }
  | { readonly ok: false; readonly reason: 'cooldown' | 'repeated'; readonly retryAfterMs: number; readonly removedIds: number[] };

export function submitChatMessage(
  db: DatabaseSync,
  visitorDigest: string,
  submission: { requestId: string; nickname: string; text: string },
  now = Date.now(),
): ChatSubmitResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare(`SELECT i.message_id, m.id, m.created_at, m.nickname, m.body
      FROM chat_idempotency i LEFT JOIN chat_messages m ON m.id=i.message_id
      WHERE i.visitor_digest=? AND i.request_id=?`).get(visitorDigest, submission.requestId) as
      ({ message_id: number } & ChatMessageRow) | { message_id: number; id: null; created_at: null; nickname: null; body: null } | undefined;
    if (duplicate) {
      db.exec('COMMIT');
      return { ok: true, duplicate: true, message: duplicate.id === null ? null : fromRow(duplicate as ChatMessageRow), removedIds: [] };
    }

    const last = db.prepare('SELECT created_at FROM chat_idempotency WHERE visitor_digest=? ORDER BY created_at DESC LIMIT 1').get(visitorDigest) as { created_at: number } | undefined;
    if (last && last.created_at + 3_000 > now) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'cooldown', retryAfterMs: last.created_at + 3_000 - now, removedIds: [] };
    }

    const repeated = db.prepare(`SELECT created_at FROM chat_messages
      WHERE visitor_digest=? AND body=? AND created_at>? ORDER BY id DESC LIMIT 1`).get(visitorDigest, submission.text, now - 30_000) as { created_at: number } | undefined;
    if (repeated) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'repeated', retryAfterMs: Math.max(1, repeated.created_at + 30_000 - now), removedIds: [] };
    }

    const result = db.prepare('INSERT INTO chat_messages(created_at, visitor_digest, nickname, body) VALUES (?, ?, ?, ?)')
      .run(now, visitorDigest, submission.nickname, submission.text);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO chat_idempotency(visitor_digest, request_id, created_at, message_id) VALUES (?, ?, ?, ?)')
      .run(visitorDigest, submission.requestId, now, id);

    const excess = Number((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count) - CHAT_MESSAGE_CAP;
    const toRemove = excess > 0
      ? (db.prepare('SELECT id FROM chat_messages ORDER BY id LIMIT ?').all(Math.min(excess, MAINTENANCE_BATCH)) as { id: number }[]).map(row => row.id)
      : [];
    const removedIds = rememberRemoval(db, toRemove, now);
    if (removedIds.length) trimRemovalHistory(db, now);

    db.prepare(`DELETE FROM chat_idempotency WHERE rowid IN (
      SELECT rowid FROM chat_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(IDEMPOTENCY_CAP);
    db.exec('COMMIT');
    return {
      ok: true,
      duplicate: false,
      message: { id, createdAt: now, nickname: submission.nickname, text: submission.text },
      removedIds,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function cleanupChat(db: DatabaseSync, now: number): number[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const expired = db.prepare(`SELECT id FROM chat_messages WHERE created_at<? ORDER BY id LIMIT ?`)
      .all(now - CHAT_RETENTION_MS, MAINTENANCE_BATCH) as { id: number }[];
    const removedIds = rememberRemoval(db, expired.map(row => row.id), now);

    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count);
    if (count > CHAT_MESSAGE_CAP) {
      const excess = db.prepare('SELECT id FROM chat_messages ORDER BY id LIMIT ?')
        .all(Math.min(count - CHAT_MESSAGE_CAP, MAINTENANCE_BATCH)) as { id: number }[];
      removedIds.push(...rememberRemoval(db, excess.map(row => row.id), now));
    }

    db.prepare(`DELETE FROM chat_idempotency WHERE rowid IN (
      SELECT rowid FROM chat_idempotency WHERE created_at<? ORDER BY created_at LIMIT ?
    )`).run(now - IDEMPOTENCY_RETENTION_MS, 500);
    db.prepare(`DELETE FROM chat_idempotency WHERE rowid IN (
      SELECT rowid FROM chat_idempotency ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(IDEMPOTENCY_CAP);

    db.prepare(`DELETE FROM chat_message_removals WHERE id IN (
      SELECT id FROM chat_message_removals WHERE removed_at<? ORDER BY id LIMIT ?
    )`).run(now - REMOVAL_RETENTION_MS, MAINTENANCE_BATCH);
    trimRemovalHistory(db, now);
    db.exec('COMMIT');
    return removedIds;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function latestRemovalId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM chat_message_removals').get() as { id: number }).id);
}

export function readRemovals(db: DatabaseSync, afterId: number, limit = MAINTENANCE_BATCH): { rows: { id: number; messageId: number }[]; latestId: number } {
  const rows = db.prepare(`SELECT id, message_id FROM chat_message_removals WHERE id>? ORDER BY id LIMIT ?`)
    .all(afterId, limit) as { id: number; message_id: number }[];
  return {
    rows: rows.map(row => ({ id: row.id, messageId: row.message_id })),
    latestId: rows.at(-1)?.id ?? afterId,
  };
}

export function publishPendingRemovals(db: DatabaseSync, afterId: number, publish: (messageId: number) => void): number {
  const batch = readRemovals(db, afterId);
  for (const row of batch.rows) publish(row.messageId);
  return batch.latestId;
}

export function removeChatMessage(db: DatabaseSync, messageId: number, now = Date.now()): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const removed = rememberRemoval(db, [messageId], now).length === 1;
    if (removed) trimRemovalHistory(db, now);
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
