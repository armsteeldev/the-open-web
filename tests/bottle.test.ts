import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import {
  BOTTLE_MESSAGE_CAP,
  bottleCount,
  cleanupBottleState,
  findRandomBottle,
  releaseBottle,
  removeBottle,
} from '../apps/server/src/spaces/bottle/database.js';
import { validateBottleExclusions, validateBottleSubmission } from '../apps/server/src/spaces/bottle/validation.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string, writes = true) => ({ dbPath, origin, cooldown: 10_000, writes, secure: false });
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bottleId = (n: number) => requestId(n);
const submission = (message: string, id = 1, signature?: string) => ({
  requestId: requestId(id),
  message,
  ...(signature === undefined ? {} : { signature }),
});

test('bottle validation uses normalized UTF-8 byte limits and rejects unsafe controls', () => {
  assert.deepEqual(validateBottleSubmission(submission('  e\u0301\r\nhello\tthere  ', 1, '  from\nme  ')), {
    ok: true,
    value: { requestId: requestId(1), message: 'é\nhello there', signature: 'from me' },
  });
  assert.equal(validateBottleSubmission(submission('👩‍💻 🌊 café', 2)).ok, true);
  assert.equal(validateBottleSubmission(submission('a'.repeat(500), 3)).ok, true);
  assert.deepEqual(validateBottleSubmission(submission('a'.repeat(501), 4)), { ok: false, error: 'message too long' });
  assert.equal(validateBottleSubmission(submission('é'.repeat(250), 5)).ok, true);
  assert.deepEqual(validateBottleSubmission(submission('é'.repeat(251), 6)), { ok: false, error: 'message too long' });
  assert.deepEqual(validateBottleSubmission(submission(' \t\r\n ', 7)), { ok: false, error: 'empty message' });
  assert.deepEqual(validateBottleSubmission(submission('bad\u0000text', 8)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateBottleSubmission(submission('hidden\u202etext', 9)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateBottleSubmission(submission('hello', 10, 'x'.repeat(25))), { ok: false, error: 'signature too long' });
  assert.deepEqual(validateBottleSubmission(submission('hello', 12, 'bad\u0000name')), { ok: false, error: 'invalid input' });
  assert.equal(validateBottleSubmission(submission('<script>alert(1)</script>', 11, '<b>still plain text</b>')).ok, true);
  assert.deepEqual(validateBottleSubmission({ requestId: 'not-a-uuid', message: 'hello' }), { ok: false, error: 'invalid input' });
});

test('discovery exclusions are bounded, unique UUIDs and tolerate no history', () => {
  assert.deepEqual(validateBottleExclusions(undefined), { ok: true, ids: [] });
  assert.deepEqual(validateBottleExclusions(`${bottleId(1)},${bottleId(1)},${bottleId(2)}`), {
    ok: true,
    ids: [bottleId(1), bottleId(2)],
  });
  assert.deepEqual(validateBottleExclusions('not-an-id'), { ok: false });
  assert.deepEqual(validateBottleExclusions(Array.from({ length: 21 }, (_, i) => bottleId(i + 1)).join(',')), { ok: false });
});

test('Bottle routes are anonymous, random, persistent and isolated from Wall and Chat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-bottle-'));
  const path = join(directory, 'bottle.sqlite');
  let app = await createApp(options(path));
  try {
    const empty = await app.inject({ url: '/api/bottle/random' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { bottle: null, exhausted: false });
    assert.equal(empty.headers['cache-control'], 'no-store');

    const invalid = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission(' \n ', 1) });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['set-cookie'], undefined);

    const firstResponse = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission('<script>literal text</script> 👋', 1, '<b>Jo</b>') });
    assert.equal(firstResponse.statusCode, 200);
    const cookie = (firstResponse.headers['set-cookie'] as string).split(';', 1)[0];
    assert.match(cookie, /^ow_id=/);
    const digest = (await import('node:crypto')).createHash('sha256').update(cookie.slice('ow_id='.length)).digest('hex');
    const first = firstResponse.json().bottle as { id: string; createdAt: number; message: string; signature: string };
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isSafeInteger(first.createdAt));
    assert.equal(first.message, '<script>literal text</script> 👋');
    assert.equal(first.signature, '<b>Jo</b>');
    assert.equal(JSON.stringify(firstResponse.json()).includes(digest), false);
    assert.equal(JSON.stringify(firstResponse.json()).includes(cookie), false);
    assert.equal(Object.hasOwn(first, 'visitorDigest'), false);

    const duplicate = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { cookie, origin }, payload: submission('<script>literal text</script> 👋', 1, '<b>Jo</b>') });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(duplicate.json().bottle.id, first.id);
    assert.ok(duplicate.json().cooldownMs > 0 && duplicate.json().cooldownMs <= 20_000);
    const persisted = openDb(path);
    assert.equal(bottleCount(persisted), 1);
    persisted.close();

    const cooldown = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { cookie, origin }, payload: submission('too soon', 2) });
    assert.equal(cooldown.statusCode, 429);
    assert.equal(cooldown.json().error, 'cooldown');
    assert.ok(cooldown.json().retryAfterMs > 0 && cooldown.json().retryAfterMs <= 20_000);

    const crossOrigin = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { cookie, origin: 'https://attacker.example' }, payload: submission('blocked', 3) });
    assert.equal(crossOrigin.statusCode, 403);
    const badExclusion = await app.inject({ url: '/api/bottle/random?seen=not-a-uuid' });
    assert.equal(badExclusion.statusCode, 400);

    const secondResponse = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission('A second note, from somewhere else.', 4) });
    assert.equal(secondResponse.statusCode, 200);
    const second = secondResponse.json().bottle as { id: string; message: string; signature: null };
    assert.equal(second.signature, null);
    assert.notEqual(second.id, first.id);

    const discovered = await app.inject({ url: `/api/bottle/random?seen=${first.id}` });
    assert.equal(discovered.statusCode, 200);
    assert.equal(discovered.json().bottle.id, second.id);
    assert.equal(discovered.json().bottle.message, second.message);
    assert.equal(Object.hasOwn(discovered.json().bottle, 'visitorDigest'), false);
    const exhausted = await app.inject({ url: `/api/bottle/random?seen=${first.id},${second.id}` });
    assert.deepEqual(exhausted.json(), { bottle: null, exhausted: true });

    const session = await app.inject({ url: '/api/session' });
    assert.equal(session.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/wall/tile/0/0' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/chat/history' })).statusCode, 200);

    await app.close();
    app = await createApp(options(path));
    const afterRestart = await app.inject({ url: `/api/bottle/random?seen=${first.id}` });
    assert.equal(afterRestart.json().bottle.id, second.id);
    const duplicateAfterRestart = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { cookie, origin }, payload: submission('<script>literal text</script> 👋', 1, '<b>Jo</b>') });
    assert.equal(duplicateAfterRestart.json().bottle.id, first.id);
    assert.equal(duplicateAfterRestart.json().duplicate, true);
    const cooldownAfterRestart = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { cookie, origin }, payload: submission('still cooling down', 5) });
    assert.equal(cooldownAfterRestart.statusCode, 429);
    assert.equal(cooldownAfterRestart.json().error, 'cooldown');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Bottle network write budget and shared emergency write gate reject safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-bottle-limits-'));
  const app = await createApp(options(join(root, 'bottle.sqlite')));
  const gated = await createApp({ ...options(join(root, 'gated.sqlite')), writes: false });
  try {
    for (let i = 1; i <= 20; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission(`network ${i}`, i) });
      assert.equal(response.statusCode, 200);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission('network over limit', 21) });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'network limit');
    assert.ok(limited.json().retryAfterMs > 0);

    const closed = await gated.inject({ method: 'POST', url: '/api/bottle/messages', headers: { origin }, payload: submission('gate closed', 22) });
    assert.equal(closed.statusCode, 503);
    assert.deepEqual(closed.json(), { error: 'writes disabled' });
  } finally {
    await Promise.all([app.close(), gated.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bottle pool prunes the oldest rows at the 10,000-message cap and supports ID removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-bottle-cap-'));
  const db = openDb(join(root, 'bottle.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO bottle_messages(id, created_at, body, signature) VALUES (?, ?, ?, NULL)');
    db.exec('BEGIN');
    for (let i = 1; i <= BOTTLE_MESSAGE_CAP; i++) insert.run(bottleId(i), i, `note ${i}`);
    db.exec('COMMIT');

    const added = releaseBottle(db, 'b'.repeat(64), { requestId: requestId(50_000), message: 'newest', signature: null }, 1_000_000);
    assert.equal(added.ok, true);
    if (!added.ok || !added.bottle) throw new Error('new Bottle was not returned');
    assert.equal(bottleCount(db), BOTTLE_MESSAGE_CAP);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bottle_messages WHERE id=?').get(bottleId(1))!.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bottle_messages WHERE id=?').get(bottleId(2))!.count, 1);
    assert.notEqual(findRandomBottle(db, [bottleId(2)])?.id, bottleId(2));
    assert.equal(removeBottle(db, added.bottle.id), true);
    assert.equal(removeBottle(db, added.bottle.id), false);
    assert.equal(bottleCount(db), BOTTLE_MESSAGE_CAP - 1);

    db.prepare('INSERT INTO bottle_idempotency(visitor_digest, request_id, created_at, bottle_id) VALUES (?, ?, ?, ?)')
      .run('a'.repeat(64), requestId(60_000), 1, bottleId(5));
    assert.equal(cleanupBottleState(db, 24 * 60 * 60 * 1000 + 2), 2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
