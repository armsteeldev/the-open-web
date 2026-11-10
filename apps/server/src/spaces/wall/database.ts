import type { DatabaseSync } from 'node:sqlite';
import { PALETTE, TILE } from '../../../../../packages/shared/wall.js';

export function validTile(pixels: Uint8Array): boolean {
  if (pixels.length !== TILE * TILE) return false;
  for (const pixel of pixels) if (pixel >= PALETTE.length) return false;
  return true;
}

export function cleanupCooldowns(db: DatabaseSync, now: number, cooldown: number): number {
  return Number(db.prepare(
    'DELETE FROM visitor_cooldowns WHERE visitor IN (SELECT visitor FROM visitor_cooldowns WHERE placed_at<=? ORDER BY placed_at LIMIT 500)',
  ).run(now - cooldown).changes);
}

export function place(
  db: DatabaseSync,
  visitor: string,
  x: number,
  y: number,
  color: number,
  now: number,
  cooldown: number,
): { ok: true; retryAt: number } | { ok: false; retryAt: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Cooldown digests are useful only while they are needed to enforce the cooldown.
    cleanupCooldowns(db, now, cooldown);
    const last = db.prepare('SELECT placed_at FROM visitor_cooldowns WHERE visitor=?').get(visitor) as { placed_at: number } | undefined;
    if (last && last.placed_at + cooldown > now) {
      db.exec('ROLLBACK');
      return { ok: false, retryAt: last.placed_at + cooldown };
    }

    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const row = db.prepare('SELECT pixels FROM wall_tiles WHERE x=? AND y=?').get(tx, ty) as { pixels: Uint8Array } | undefined;
    if (row && !validTile(row.pixels)) throw new Error('Invalid wall tile data');
    const pixels = row ? new Uint8Array(row.pixels) : new Uint8Array(TILE * TILE);
    pixels[(y % TILE) * TILE + x % TILE] = color;

    db.prepare('INSERT INTO wall_tiles VALUES (?,?,?) ON CONFLICT(x,y) DO UPDATE SET pixels=excluded.pixels').run(tx, ty, pixels);
    db.prepare('INSERT INTO visitor_cooldowns VALUES (?,?) ON CONFLICT(visitor) DO UPDATE SET placed_at=excluded.placed_at').run(visitor, now);
    db.exec('COMMIT');
    return { ok: true, retryAt: now + cooldown };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
