import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { TILE, PALETTE } from '../../../packages/shared/wall.js';

export function validTile(pixels:Uint8Array) {if(pixels.length!==TILE*TILE)return false;for(const pixel of pixels)if(pixel>=PALETTE.length)return false;return true;}

export function openDb(path: string, migrationsDir = new URL('../../../database/migrations/', import.meta.url)) {
 const db = new DatabaseSync(path);
 try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY) STRICT');
  const files = readdirSync(migrationsDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort((a,b)=>Number(a.split('_')[0])-Number(b.split('_')[0]));
  if(files.length===0) throw new Error('No database migrations found');
  const versions = files.map(f => Number(f.split('_')[0]));
  if (versions.some((v,i) => !Number.isSafeInteger(v) || v !== i+1)) throw new Error('Migrations must have unique consecutive versions starting at 1');
  const applied = db.prepare('SELECT version FROM migrations ORDER BY version').all() as {version:number}[];
  if (applied.some((row,i) => row.version !== i+1 || !versions.includes(row.version))) throw new Error('Database migration history is not supported by this release');
  for (let i=applied.length;i<files.length;i++) {
   const file = new URL(files[i], migrationsDir);
   db.exec('BEGIN IMMEDIATE');
   try {
    // Another process may have migrated while this connection waited for the lock.
    if (!db.prepare('SELECT version FROM migrations WHERE version=?').get(versions[i])) {
     db.exec(readFileSync(file,'utf8'));
     db.prepare('INSERT INTO migrations(version) VALUES (?)').run(versions[i]);
    }
    db.exec('COMMIT');
   } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
 } catch (e) { db.close(); throw e; }
}
export function cleanupCooldowns(db:DatabaseSync,now:number,cooldown:number) {
 return db.prepare('DELETE FROM visitor_cooldowns WHERE visitor IN (SELECT visitor FROM visitor_cooldowns WHERE placed_at<=? ORDER BY placed_at LIMIT 500)').run(now-cooldown).changes;
}
export function place(db: DatabaseSync, visitor: string, x: number, y: number, color: number, now: number, cooldown: number) {
 db.exec('BEGIN IMMEDIATE'); try {
  // Cooldown identity digests are useful only while the cooldown is active.
  cleanupCooldowns(db,now,cooldown);
  const last = db.prepare('SELECT placed_at FROM visitor_cooldowns WHERE visitor=?').get(visitor) as {placed_at:number}|undefined;
  if(last && last.placed_at+cooldown>now) { db.exec('ROLLBACK'); return {ok:false, retryAt:last.placed_at+cooldown}; }
  const tx=Math.floor(x/TILE), ty=Math.floor(y/TILE); const row=db.prepare('SELECT pixels FROM wall_tiles WHERE x=? AND y=?').get(tx,ty) as {pixels:Uint8Array}|undefined;
  if(row && !validTile(row.pixels)) throw new Error('Invalid wall tile data');
  const pixels=row ? new Uint8Array(row.pixels) : new Uint8Array(TILE*TILE); pixels[(y%TILE)*TILE+x%TILE]=color;
  db.prepare('INSERT INTO wall_tiles VALUES (?,?,?) ON CONFLICT(x,y) DO UPDATE SET pixels=excluded.pixels').run(tx,ty,pixels);
  db.prepare('INSERT INTO visitor_cooldowns VALUES (?,?) ON CONFLICT(visitor) DO UPDATE SET placed_at=excluded.placed_at').run(visitor,now);
  db.exec('COMMIT'); return {ok:true,retryAt:now+cooldown};
 } catch(e) { db.exec('ROLLBACK'); throw e; }
}
