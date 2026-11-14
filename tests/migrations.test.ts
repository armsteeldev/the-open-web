import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../apps/server/src/db.js';
import { place } from '../apps/server/src/spaces/wall/database.js';

test('ordered migrations upgrade existing data and fail closed on newer schemas',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-migrate-')); const path=join(root,'wall.sqlite'); const dir=join(root,'migrations'); mkdirSync(dir);
 const url=pathToFileURL(dir+'/'); writeFileSync(join(dir,'001_initial.sql'),readFileSync(new URL('../database/migrations/001_initial.sql',import.meta.url)));
 try {
  let db=openDb(path,url);place(db,'visitor',1,2,3,1000,5000);db.close();
  db=openDb(path,new URL('../database/migrations/',import.meta.url));
  assert.deepEqual(db.prepare('SELECT version FROM migrations ORDER BY version').all().map(r=>r.version),[1,2,3,4]);
  assert.equal((db.prepare('SELECT pixels FROM wall_tiles').get()!.pixels as Uint8Array)[201],3);db.close();
  const advanced=join(root,'advanced');mkdirSync(advanced);
  for(const name of ['001_initial.sql','002_cooldown_retention.sql','003_chat_messages.sql'])writeFileSync(join(advanced,name),readFileSync(new URL(`../database/migrations/${name}`,import.meta.url)));
  writeFileSync(join(advanced,'004_bottle_messages.sql'),readFileSync(new URL('./fixtures/004_bottle_messages.sql',import.meta.url)));
  for(let version=5;version<=10;version++)writeFileSync(join(advanced,`${String(version).padStart(3,'0')}_extra.sql`),'SELECT 1;');
  db=openDb(path,pathToFileURL(advanced+'/'));assert.equal(db.prepare('SELECT MAX(version) version FROM migrations').get()!.version,10);db.close();
  assert.throws(()=>openDb(path,new URL('../database/migrations/',import.meta.url)),/not supported/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('failed migrations roll back and malformed tiles cannot be overwritten',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-migrate-'));const path=join(root,'wall.sqlite');const dir=join(root,'migrations');mkdirSync(dir);const url=pathToFileURL(dir+'/');
 writeFileSync(join(dir,'001_initial.sql'),readFileSync(new URL('../database/migrations/001_initial.sql',import.meta.url)));
 try {let db=openDb(path,url);db.prepare('INSERT INTO wall_tiles VALUES (0,0,?)').run(new Uint8Array([1]));assert.throws(()=>place(db,'visitor',0,0,3,1000,5000),/tile data/);assert.equal(db.prepare('SELECT COUNT(*) n FROM visitor_cooldowns').get()!.n,0);const invalid=new Uint8Array(10000);invalid[500]=16;db.prepare('UPDATE wall_tiles SET pixels=? WHERE x=0 AND y=0').run(invalid);assert.throws(()=>place(db,'visitor',0,0,3,1000,5000),/tile data/);db.close();
 writeFileSync(join(dir,'002_fail.sql'),'CREATE TABLE should_rollback (id INTEGER); INVALID SQL;');assert.throws(()=>openDb(path,url));db=new DatabaseSync(path);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='should_rollback'").get()!.n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM migrations').get()!.n,1);db.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing migration files fail startup',()=>{const root=mkdtempSync(join(tmpdir(),'open-web-empty-'));try{assert.throws(()=>openDb(join(root,'db'),pathToFileURL(root+'/')),/No database migrations/);}finally{rmSync(root,{recursive:true,force:true});}});

test('cooldown rows are indexed and expired identity digests are removed during writes',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-retention-'));const db=openDb(join(root,'wall.sqlite'));
 try {
  const index=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='visitor_cooldowns_placed_at_idx'").get();assert.ok(index);
  place(db,'expired-visitor',1,2,3,1000,5000);
  place(db,'active-visitor',4,5,6,10000,5000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM visitor_cooldowns WHERE visitor=?').get('expired-visitor')!.count,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM visitor_cooldowns WHERE visitor=?').get('active-visitor')!.count,1);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('a new space-owned migration is consecutive, transactional and leaves Wall tables intact',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-space-migration-'));const path=join(root,'space.sqlite');const dir=join(root,'migrations');mkdirSync(dir);
 try {
  for(const name of ['001_initial.sql','002_cooldown_retention.sql'])writeFileSync(join(dir,name),readFileSync(new URL(`../database/migrations/${name}`,import.meta.url)));
  writeFileSync(join(dir,'003_module_fixture_records.sql'),'CREATE TABLE module_fixture_records (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;');
  let db=openDb(path,pathToFileURL(dir+'/'));
  assert.deepEqual(db.prepare('SELECT version FROM migrations ORDER BY version').all().map(row=>row.version),[1,2,3]);
  db.prepare('INSERT INTO module_fixture_records(body) VALUES (?)').run('kept');
  assert.equal(db.prepare('SELECT body FROM module_fixture_records').get()!.body,'kept');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wall_tiles'").get()!.name,'wall_tiles');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visitor_cooldowns'").get()!.name,'visitor_cooldowns');
  db.close();

  writeFileSync(join(dir,'004_module_fixture_failed.sql'),'CREATE TABLE module_fixture_rollback (id INTEGER); INVALID SQL;');
  assert.throws(()=>openDb(path,pathToFileURL(dir+'/')));
  db=new DatabaseSync(path);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='module_fixture_rollback'").get()!.count,0);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version,3);
  db.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('failed Global Chat migration rolls back its complete schema and version record',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-chat-migration-'));const path=join(root,'chat.sqlite');const dir=join(root,'migrations');mkdirSync(dir);
 try {
  for(const name of ['001_initial.sql','002_cooldown_retention.sql'])writeFileSync(join(dir,name),readFileSync(new URL(`../database/migrations/${name}`,import.meta.url)));
  const chatSql=readFileSync(new URL('../database/migrations/003_chat_messages.sql',import.meta.url),'utf8');
  writeFileSync(join(dir,'003_chat_messages.sql'),`${chatSql}\nINVALID SQL;`);
  assert.throws(()=>openDb(path,pathToFileURL(dir+'/')));
  const db=new DatabaseSync(path);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'chat_%'").get()!.count,0);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='wall_tiles'").get()!.count,1);
  db.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('failed Message in a Bottle migration rolls back its complete schema and preserves Wall and Chat tables',()=>{
 const root=mkdtempSync(join(tmpdir(),'open-web-bottle-migration-'));const path=join(root,'bottle.sqlite');const dir=join(root,'migrations');mkdirSync(dir);
 try {
  for(const name of ['001_initial.sql','002_cooldown_retention.sql','003_chat_messages.sql'])writeFileSync(join(dir,name),readFileSync(new URL(`../database/migrations/${name}`,import.meta.url)));
  const bottleSql=readFileSync(new URL('../database/migrations/004_bottle_messages.sql',import.meta.url),'utf8');
  writeFileSync(join(dir,'004_bottle_messages.sql'),`${bottleSql}\nINVALID SQL;`);
  assert.throws(()=>openDb(path,pathToFileURL(dir+'/')));
  const db=new DatabaseSync(path);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'bottle_%'").get()!.count,0);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version,3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('wall_tiles','visitor_cooldowns','chat_messages')").get()!.count,3);
  db.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
