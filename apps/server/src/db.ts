import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// The rollback bridge deliberately knows just one later additive schema: Bottle migration 004.
// Keep this fingerprint in sync with that exact set of tables, indexes, constraints, and keys.
const BOTTLE_MIGRATION_004_SCHEMA = '990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e';

function hasKnownBottleMigration004Schema(db: DatabaseSync): boolean {
 const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE name GLOB 'bottle_*' OR tbl_name GLOB 'bottle_*' ORDER BY type,name`).all() as
  {type:string;name:string;tbl_name:string;sql:string|null}[];
 const schema = rows.map(row => [
  row.type,
  row.name,
  row.tbl_name,
  row.sql === null ? null : row.sql.replace(/\s+/gu, ' ').trim(),
 ]);
 return createHash('sha256').update(JSON.stringify(schema)).digest('hex') === BOTTLE_MIGRATION_004_SCHEMA;
}

export function openDb(path: string, migrationsDir = new URL('../../../database/migrations/', import.meta.url)) {
 const db = new DatabaseSync(path);
 try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY) STRICT');
  const files = readdirSync(migrationsDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort((a,b)=>Number(a.split('_')[0])-Number(b.split('_')[0]));
  if(files.length===0) throw new Error('No database migrations found');
  const versions = files.map(f => Number(f.split('_')[0]));
  if (versions.some((v,i) => !Number.isSafeInteger(v) || v !== i+1)) throw new Error('Migrations must have unique consecutive versions starting at 1');
  const applied = db.prepare('SELECT version FROM migrations ORDER BY version').all() as {version:number}[];
  if (applied.some((row,i) => row.version !== i+1 || (!versions.includes(row.version) && row.version !== 4))) throw new Error('Database migration history is not supported by this release');
  if (applied.some(row => row.version === 4) && !hasKnownBottleMigration004Schema(db)) {
   throw new Error('Database migration 004 does not match the known Bottle compatibility schema');
  }
  for (let i=applied.length;i<files.length;i++) {
   const file = new URL(files[i], migrationsDir);
   db.exec('BEGIN IMMEDIATE');
   try {
    // Another process may have migrated while this connection waited for the lock.
    if (!db.prepare('SELECT version FROM migrations WHERE version=?').get(versions[i])) {
     db.exec(readFileSync(file,'utf8'));
     if (versions[i] === 4 && !hasKnownBottleMigration004Schema(db)) {
      throw new Error('Migration 004 does not match the known Bottle compatibility schema');
     }
     db.prepare('INSERT INTO migrations(version) VALUES (?)').run(versions[i]);
    }
    db.exec('COMMIT');
   } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
 } catch (e) { db.close(); throw e; }
}
