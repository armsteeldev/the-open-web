import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { DrawingStroke, ValidatedDrawing } from './validation.js';

export const DRAWING_CAP = 1500;
export const DRAWING_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const DRAWING_COOLDOWN_MS = 5 * 60 * 1000;
export const DRAWING_IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
export const DRAWING_VISITOR_CAP = 50_000;
export const DRAWING_PAGE_SIZE = 12;

export interface Drawing {
  readonly id: number;
  readonly createdAt: number;
  readonly strokes: readonly DrawingStroke[];
}

interface DrawingRow {
  id: number;
  created_at: number;
  strokes: string;
}

function fromRow(row: DrawingRow): Drawing {
  return { id: row.id, createdAt: row.created_at, strokes: JSON.parse(row.strokes) as DrawingStroke[] };
}

export function readDrawings(db: DatabaseSync, before: number | null): { readonly drawings: readonly Drawing[]; readonly nextBefore: number | null } {
  const rows = (before === null
    ? db.prepare('SELECT id, created_at, strokes FROM draw_drawings ORDER BY id DESC LIMIT ?').all(DRAWING_PAGE_SIZE + 1)
      : db.prepare('SELECT id, created_at, strokes FROM draw_drawings WHERE id<? ORDER BY id DESC LIMIT ?').all(before, DRAWING_PAGE_SIZE + 1)) as unknown as DrawingRow[];
  const hasOlder = rows.length > DRAWING_PAGE_SIZE;
  const drawings = rows.slice(0, DRAWING_PAGE_SIZE).map(fromRow);
  return { drawings, nextBefore: hasOlder ? drawings.at(-1)!.id : null };
}

export function readDrawing(db: DatabaseSync, id: number): Drawing | null {
  const row = db.prepare('SELECT id, created_at, strokes FROM draw_drawings WHERE id=?').get(id) as DrawingRow | undefined;
  return row ? fromRow(row) : null;
}

export type SubmitDrawingResult =
  | { readonly ok: true; readonly drawing: Drawing; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: 'cooldown'; readonly retryAfterMs: number }
  | { readonly ok: false; readonly reason: 'idempotency-conflict' };

export function submitDrawing(
  db: DatabaseSync,
  visitorDigest: string,
  drawing: ValidatedDrawing,
  now = Date.now(),
): SubmitDrawingResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM draw_drawings WHERE created_at<?').run(now - DRAWING_RETENTION_MS);
    db.prepare('DELETE FROM draw_submission_idempotency WHERE created_at<=?').run(now - DRAWING_IDEMPOTENCY_MS);
    if (drawing.requestId) {
      const payloadHash = createHash('sha256').update(drawing.serialized).digest('hex');
      const previous = db.prepare(`SELECT d.id, d.created_at, d.strokes, retry.payload_hash
        FROM draw_submission_idempotency AS retry
        JOIN draw_drawings AS d ON d.id=retry.drawing_id
        WHERE retry.request_id=?`).get(drawing.requestId) as
          (DrawingRow & { payload_hash: string }) | undefined;
      if (previous) {
        if (previous.payload_hash !== payloadHash) {
          db.exec('ROLLBACK');
          return { ok: false, reason: 'idempotency-conflict' };
        }
        db.exec('COMMIT');
        return { ok: true, drawing: fromRow(previous), replayed: true };
      }
    }
    const last = db.prepare('SELECT submitted_at FROM draw_visitor_cooldowns WHERE visitor_digest=?')
      .get(visitorDigest) as { submitted_at: number } | undefined;
    if (last && last.submitted_at + DRAWING_COOLDOWN_MS > now) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'cooldown', retryAfterMs: last.submitted_at + DRAWING_COOLDOWN_MS - now };
    }

    const result = db.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)')
      .run(now, drawing.serialized);
    if (drawing.requestId) {
      db.prepare('INSERT INTO draw_submission_idempotency(request_id, payload_hash, drawing_id, created_at) VALUES (?, ?, ?, ?)')
        .run(drawing.requestId, createHash('sha256').update(drawing.serialized).digest('hex'), Number(result.lastInsertRowid), now);
    }
    db.prepare('INSERT INTO draw_visitor_cooldowns(visitor_digest, submitted_at) VALUES (?, ?) ON CONFLICT(visitor_digest) DO UPDATE SET submitted_at=excluded.submitted_at')
      .run(visitorDigest, now);
    db.prepare('DELETE FROM draw_visitor_cooldowns WHERE submitted_at<=?').run(now - DRAWING_COOLDOWN_MS);
    db.prepare('DELETE FROM draw_visitor_cooldowns WHERE rowid IN (SELECT rowid FROM draw_visitor_cooldowns ORDER BY submitted_at DESC, rowid DESC LIMIT -1 OFFSET ?)')
      .run(DRAWING_VISITOR_CAP);
    db.prepare('DELETE FROM draw_drawings WHERE id IN (SELECT id FROM draw_drawings ORDER BY id DESC LIMIT -1 OFFSET ?)')
      .run(DRAWING_CAP);
    db.exec('COMMIT');
    return { ok: true, drawing: { id: Number(result.lastInsertRowid), createdAt: now, strokes: JSON.parse(drawing.serialized) as DrawingStroke[] }, replayed: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function cleanupDrawings(db: DatabaseSync, now = Date.now()): number {
  const drawings = db.prepare('DELETE FROM draw_drawings WHERE created_at<?').run(now - DRAWING_RETENTION_MS);
  const retries = db.prepare('DELETE FROM draw_submission_idempotency WHERE created_at<=?').run(now - DRAWING_IDEMPOTENCY_MS);
  const cooldowns = db.prepare('DELETE FROM draw_visitor_cooldowns WHERE submitted_at<=?').run(now - DRAWING_COOLDOWN_MS);
  return Number(drawings.changes) + Number(retries.changes) + Number(cooldowns.changes);
}

export function removeDrawing(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM draw_drawings WHERE id=?').run(id).changes) > 0;
}
