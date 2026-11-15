import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// Rollback bridges recognize only the exact later additive schemas listed here.
// Keep each fingerprint in sync with that migration's tables, indexes, constraints, and keys.
const BOTTLE_MIGRATION_004_SCHEMA = '990f41588a6c25778e5d2f1d5ba475da8797298021b429e354929c6b509be47e';
const EXPANSION_MIGRATION_005_SCHEMA = 'de82a92961340220f02c40369d87637ffd1b65f9a890fa3537905ad987b9e229';
const FINAL_SPACES_MIGRATION_006_SCHEMA = '718a3c10db4694071153003263cd695a6d322b6bf5bbce45d8bc379dabb8a046';
const QUALITY_MIGRATION_007_SCHEMA = '194b28a6db6fe50aa6046346ce72a6d0c721e86ead70f340935ca32d9f4a8d36';
const QUALITY_MIGRATION_007_INDEXES = [
 'guestbook_idempotency_entry_id_idx',
 'story_idempotency_contribution_id_idx',
 'questions_item_idempotency_question_id_idx',
 'questions_answer_idempotency_answer_id_idx',
 'choice_proposal_idempotency_decision_id_idx',
 'choice_vote_idempotency_decision_id_idx',
 'questions_answers_question_updated_id_idx',
 'questions_answers_updated_id_idx',
 'draw_submission_idempotency_created',
] as const;

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

function hasKnownExpansionMigration005Schema(db: DatabaseSync): boolean {
 const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE (name GLOB 'guestbook_*' OR name GLOB 'story_*' OR name GLOB 'questions_*' OR name GLOB 'choice_*'
     OR tbl_name GLOB 'guestbook_*' OR tbl_name GLOB 'story_*' OR tbl_name GLOB 'questions_*' OR tbl_name GLOB 'choice_*')
    AND name NOT IN ('guestbook_idempotency_entry_id_idx', 'story_idempotency_contribution_id_idx',
      'questions_item_idempotency_question_id_idx', 'questions_answer_idempotency_answer_id_idx',
      'choice_proposal_idempotency_decision_id_idx', 'choice_vote_idempotency_decision_id_idx',
      'questions_answers_question_updated_id_idx', 'questions_answers_updated_id_idx')
  ORDER BY type,name`).all() as
  {type:string;name:string;tbl_name:string;sql:string|null}[];
 const schema = rows.map(row => [
  row.type,
  row.name,
  row.tbl_name,
  row.sql === null ? null : row.sql.replace(/\s+/gu, ' ').trim(),
 ]);
 return createHash('sha256').update(JSON.stringify(schema)).digest('hex') === EXPANSION_MIGRATION_005_SCHEMA;
}

function hasKnownFinalSpacesMigration006Schema(db: DatabaseSync): boolean {
 const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (name GLOB 'draw_*' OR name GLOB 'garden_*' OR name GLOB 'map_*' OR tbl_name GLOB 'draw_*' OR tbl_name GLOB 'garden_*' OR tbl_name GLOB 'map_*') AND name NOT IN ('draw_submission_idempotency', 'draw_submission_idempotency_created') AND tbl_name <> 'draw_submission_idempotency' ORDER BY type,name").all() as
  {type:string;name:string;tbl_name:string;sql:string|null}[];
 const schema = rows.map(row => [
  row.type,
  row.name,
  row.tbl_name,
  row.sql === null ? null : row.sql.replace(/\s+/gu, ' ').trim(),
 ]);
 return createHash('sha256').update(JSON.stringify(schema)).digest('hex') === FINAL_SPACES_MIGRATION_006_SCHEMA;
}

function hasKnownQualityMigration007Schema(db: DatabaseSync): boolean {
 const placeholders = QUALITY_MIGRATION_007_INDEXES.map(() => '?').join(',');
 const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE name IN (${placeholders}) OR tbl_name='draw_submission_idempotency' ORDER BY type,name`)
  .all(...QUALITY_MIGRATION_007_INDEXES) as
  {type:string;name:string;tbl_name:string;sql:string|null}[];
 const schema = rows.map(row => [
  row.type,
  row.name,
  row.tbl_name,
  row.sql === null ? null : row.sql.replace(/\s+/gu, ' ').trim(),
 ]);
 return createHash('sha256').update(JSON.stringify(schema)).digest('hex') === QUALITY_MIGRATION_007_SCHEMA;
}

function hasKnownMigrationSchema(db: DatabaseSync, version: number): boolean {
 if (version === 4) return hasKnownBottleMigration004Schema(db);
 if (version === 5) return hasKnownExpansionMigration005Schema(db);
 if (version === 6) return hasKnownFinalSpacesMigration006Schema(db);
 if (version === 7) return hasKnownQualityMigration007Schema(db);
 return false;
}

export function openDb(path: string, migrationsDir = new URL('../../../database/migrations/', import.meta.url)) {
 const db = new DatabaseSync(path);
 try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY) STRICT');
  const files = readdirSync(migrationsDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort((a,b)=>Number(a.split('_')[0])-Number(b.split('_')[0]));
  if(files.length===0) throw new Error('No database migrations found');
  const versions = files.map(f => Number(f.split('_')[0]));
  if (versions.some((v,i) => !Number.isSafeInteger(v) || v !== i+1)) throw new Error('Migrations must have unique consecutive versions starting at 1');
  const applied = db.prepare('SELECT version FROM migrations ORDER BY version').all() as {version:number}[];
  if (applied.some((row,i) => row.version !== i+1 || (!versions.includes(row.version) && ![4, 5, 6, 7].includes(row.version)))) throw new Error('Database migration history is not supported by this release');
  for (const row of applied) {
   if ([4, 5, 6, 7].includes(row.version) && !hasKnownMigrationSchema(db, row.version)) {
    throw new Error(`Database migration ${String(row.version).padStart(3, '0')} does not match its known compatibility schema`);
   }
  }
  for (let i=applied.length;i<files.length;i++) {
   const file = new URL(files[i], migrationsDir);
   db.exec('BEGIN IMMEDIATE');
   try {
    // Another process may have migrated while this connection waited for the lock.
    if (!db.prepare('SELECT version FROM migrations WHERE version=?').get(versions[i])) {
     db.exec(readFileSync(file,'utf8'));
     if ([4, 5, 6, 7].includes(versions[i]) && !hasKnownMigrationSchema(db, versions[i])) {
      throw new Error(`Migration ${String(versions[i]).padStart(3, '0')} does not match its known compatibility schema`);
     }
     db.prepare('INSERT INTO migrations(version) VALUES (?)').run(versions[i]);
    }
    db.exec('COMMIT');
   } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
 } catch (e) { db.close(); throw e; }
}
