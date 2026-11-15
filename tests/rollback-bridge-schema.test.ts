import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import { bottleSpace } from '../apps/server/src/spaces/bottle/index.js';
import { chatSpace } from '../apps/server/src/spaces/chat/index.js';
import { place } from '../apps/server/src/spaces/wall/database.js';
import { wallSpace } from '../apps/server/src/spaces/wall/index.js';
import { spaces } from '../packages/shared/spaces.js';

const origin = 'http://localhost:4321';
const activeIds = new Set(['wall', 'chat', 'bottle']);
const currentRegistration = (databaseMigrations: URL) => ({
  registry: spaces.filter(space => activeIds.has(space.id)),
  modules: [wallSpace, chatSpace, bottleSpace],
  databaseMigrations,
});

function migrationsThrough004(directory: string): URL {
  mkdirSync(directory);
  for (const name of [
    '001_initial.sql',
    '002_cooldown_retention.sql',
    '003_chat_messages.sql',
    '004_bottle_messages.sql',
  ]) writeFileSync(join(directory, name), readFileSync(new URL(`../database/migrations/${name}`, import.meta.url)));
  return pathToFileURL(`${directory}/`);
}

function addLaterSchema(db: ReturnType<typeof openDb>, version: number): void {
  for (let migration = 5; migration <= version; migration += 1) {
    const filename = migration === 5 ? '005_expansion_phase_one.sql' : '006_final_spaces.sql';
    db.exec(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8'));
    db.prepare('INSERT INTO migrations(version) VALUES (?)').run(migration);
  }
}

for (const version of [4, 5, 6]) {
  test(`the three-space rollback bridge starts on exact schema ${version} and leaves later data intact`, async () => {
    const root = join(tmpdir(), `open-web-bridge-schema-${version}-${process.pid}-${Date.now()}`);
    mkdirSync(root);
    const migrations = migrationsThrough004(join(root, 'migrations'));
    const dbPath = join(root, 'bridge.sqlite');
    const now = Date.now();
    const db = openDb(dbPath, migrations);
    place(db, `bridge-${version}`, 2, 3, 4, now, 10_000);
    db.prepare('INSERT INTO chat_messages(created_at, visitor_digest, nickname, body) VALUES (?, ?, ?, ?)')
      .run(now, 'a'.repeat(64), 'Kept', 'chat remains available during rollback');
    db.prepare('INSERT INTO bottle_messages(id, created_at, body, signature) VALUES (?, ?, ?, ?)')
      .run('00000000-0000-4000-8000-000000000004', now, 'Bottle remains available during rollback', 'Kept');
    if (version >= 5) addLaterSchema(db, version);
    if (version >= 5) db.prepare('INSERT INTO guestbook_entries(created_at, body) VALUES (?, ?)').run(now, 'Guestbook data remains stored');
    if (version >= 6) {
      db.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)').run(now, '[{"tool":"pen","color":0,"size":1,"points":[[20,30],[40,50]]}]');
      db.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (?, ?, ?, ?)').run(1, 2, 'clover', now);
      db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?)').run('b'.repeat(64), 'SE', now);
    }
    db.close();

    const app = await createApp({ dbPath, origin, cooldown: 10_000, writes: true, secure: false }, currentRegistration(migrations));
    try {
      assert.equal((await app.inject('/api/health')).statusCode, 200);
      assert.equal((await app.inject('/api/wall/tile/0/0')).statusCode, 200);
      assert.equal((await app.inject('/api/chat/history')).json().messages[0].text, 'chat remains available during rollback');
      assert.equal((await app.inject('/api/bottle/random')).json().bottle.message, 'Bottle remains available during rollback');
      for (const route of [
        '/api/guestbook/entries', '/api/story/state', '/api/questions', '/api/choice/state',
        '/api/draw/drawings', '/api/garden/state', '/api/map/state',
      ]) assert.equal((await app.inject(route)).statusCode, 404, `${route} remains inactive on the bridge`);
    } finally {
      await app.close();
    }

    const retained = openDb(dbPath, migrations);
    try {
      assert.equal(retained.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version, version);
      if (version >= 5) {
        assert.equal(retained.prepare('SELECT body FROM guestbook_entries').get()!.body, 'Guestbook data remains stored');
      }
      if (version >= 6) {
        assert.equal(retained.prepare('SELECT COUNT(*) AS count FROM draw_drawings').get()!.count, 1);
        assert.equal(retained.prepare('SELECT COUNT(*) AS count FROM garden_plants').get()!.count, 1);
        assert.equal(retained.prepare('SELECT country_code FROM map_contributions').get()!.country_code, 'SE');
      }
      assert.equal(retained.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(retained.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      retained.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the rollback bridge rejects altered later schemas and unknown migration versions', () => {
  const root = join(tmpdir(), `open-web-bridge-invalid-${process.pid}-${Date.now()}`);
  mkdirSync(root);
  const migrations = migrationsThrough004(join(root, 'migrations'));
  try {
    const alteredPath = join(root, 'altered.sqlite');
    const altered = openDb(alteredPath);
    addLaterSchema(altered, 6);
    altered.exec('DROP INDEX draw_drawings_created_id');
    altered.close();
    assert.throws(() => openDb(alteredPath, migrations), /does not match its known compatibility schema/);

    const unknownPath = join(root, 'unknown.sqlite');
    const unknown = openDb(unknownPath);
    unknown.prepare('INSERT INTO migrations(version) VALUES (7)').run();
    unknown.close();
    assert.throws(() => openDb(unknownPath, migrations), /not supported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
