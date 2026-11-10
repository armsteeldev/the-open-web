import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

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
