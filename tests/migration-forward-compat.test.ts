import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import { chatSpace } from '../apps/server/src/spaces/chat/index.js';
import { wallSpace } from '../apps/server/src/spaces/wall/index.js';
import { place } from '../apps/server/src/spaces/wall/database.js';
import { spaces } from '../packages/shared/spaces.js';

const origin = 'http://localhost:4321';

function migrationsThrough003(directory: string): URL {
  mkdirSync(directory);
  for (const name of ['001_initial.sql', '002_cooldown_retention.sql', '003_chat_messages.sql']) {
    writeFileSync(join(directory, name), readFileSync(new URL(`../database/migrations/${name}`, import.meta.url)));
  }
  return pathToFileURL(`${directory}/`);
}

test('pre-Bottle Wall and Chat release opens exact migration 004 and preserves all space data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-forward-migration-'));
  const path = join(root, 'rollback.sqlite');
  const migrationsDirectory = join(root, 'migrations');
  const migrationsUrl = migrationsThrough003(migrationsDirectory);
  const bottleSql = readFileSync(new URL('./fixtures/004_bottle_messages.sql', import.meta.url), 'utf8');
  const releasedBottleSql = new URL('../database/migrations/004_bottle_messages.sql', import.meta.url);
  if (existsSync(fileURLToPath(releasedBottleSql))) {
    assert.equal(readFileSync(releasedBottleSql, 'utf8'), bottleSql, 'compatibility fixture matches the released migration');
  }
  const now = Date.now();
  let db = openDb(path, migrationsUrl);
  const placed = place(db, 'rollback-visitor', 2, 3, 4, now, 10_000);
  assert.equal(placed.ok, true);
  db.prepare('INSERT INTO chat_messages(created_at, visitor_digest, nickname, body) VALUES (?, ?, ?, ?)')
    .run(now, 'a'.repeat(64), 'Kept', 'chat data survives rollback');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(bottleSql);
    db.prepare('INSERT INTO migrations(version) VALUES (4)').run();
    db.prepare('INSERT INTO bottle_messages(id, created_at, body, signature) VALUES (?, ?, ?, ?)')
      .run('00000000-0000-4000-8000-000000000004', now, 'Bottle data survives rollback', 'Kept');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.close();

  const previousRegistry = spaces.filter(space => (space.id as string) !== 'bottle');
  const app = await createApp({ dbPath: path, origin, cooldown: 10_000, writes: true, secure: false }, {
    registry: previousRegistry,
    modules: [wallSpace, chatSpace],
  });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    const tile = await app.inject('/api/wall/tile/0/0');
    assert.equal(tile.statusCode, 200);
    assert.equal(tile.body.charCodeAt(3 * 100 + 2), 4);
    const history = await app.inject('/api/chat/history');
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().messages[0].text, 'chat data survives rollback');
    assert.equal((await app.inject('/api/bottle/random')).statusCode, 404);

    const retained = openDb(path, migrationsUrl);
    assert.deepEqual((retained.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]).map(row => row.version), [1, 2, 3, 4]);
    assert.equal((retained.prepare('SELECT body FROM bottle_messages').get() as { body: string }).body, 'Bottle data survives rollback');
    assert.equal((retained.prepare('SELECT body FROM chat_messages').get() as { body: string }).body, 'chat data survives rollback');
    assert.equal((retained.prepare('SELECT pixels FROM wall_tiles').get() as { pixels: Uint8Array }).pixels[302], 4);
    retained.close();
  } finally {
    await app.close();
  }

  db = openDb(path, migrationsUrl);
  db.prepare('INSERT INTO migrations(version) VALUES (5)').run();
  db.close();
  assert.throws(() => openDb(path, migrationsUrl), /not supported/);
  rmSync(root, { recursive: true, force: true });
});

test('compatibility release rejects a malformed version 004 schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-forward-invalid-'));
  const path = join(root, 'invalid.sqlite');
  const migrationsUrl = migrationsThrough003(join(root, 'migrations'));
  try {
    const db = openDb(path, migrationsUrl);
    const alteredBottleSql = readFileSync(new URL('./fixtures/004_bottle_messages.sql', import.meta.url), 'utf8')
      .replace('BETWEEN 1 AND 500', 'BETWEEN 1 AND 501');
    db.exec(alteredBottleSql);
    db.prepare('INSERT INTO migrations(version) VALUES (4)').run();
    db.close();
    assert.throws(() => openDb(path, migrationsUrl), /does not match the known Bottle compatibility schema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
