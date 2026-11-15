import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../apps/server/src/db.js';
import {
  GUESTBOOK_COOLDOWN_MS,
  GUESTBOOK_ENTRY_CAP,
  GUESTBOOK_RETENTION_MS,
  cleanupGuestbookState,
  createGuestbookEntry,
  readGuestbook,
  removeGuestbookEntry,
} from '../apps/server/src/spaces/guestbook/database.js';
import { validateGuestbookSubmission } from '../apps/server/src/spaces/guestbook/validation.js';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:4321';
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const submission = (message: string, id = 1, displayName?: string) => ({ requestId: requestId(id), message, ...(displayName === undefined ? {} : { displayName }) });
const options = (dbPath: string, writes = true) => ({ dbPath, origin, cooldown: 10_000, writes, secure: false });

test('Guestbook input is normalized, bounded, plain text, and fits the shared request limit', () => {
  assert.deepEqual(validateGuestbookSubmission(submission('  e\u0301\r\nhello\tthere  ', 1, '  Mira   K.  ')), {
    ok: true,
    value: { requestId: requestId(1), displayName: 'Mira K.', message: 'é\nhello there' },
  });
  assert.equal(validateGuestbookSubmission(submission('<script>literal</script>')).ok, true);
  assert.deepEqual(validateGuestbookSubmission(submission('  \n  ')), { ok: false, error: 'empty message' });
  assert.deepEqual(validateGuestbookSubmission(submission('x'.repeat(221))), { ok: false, error: 'message too long' });
  assert.deepEqual(validateGuestbookSubmission(submission('é'.repeat(251))), { ok: false, error: 'message too long' });
  assert.deepEqual(validateGuestbookSubmission(submission('hidden\u202etext')), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateGuestbookSubmission({ ...submission('valid'), extra: true }), { ok: false, error: 'invalid input' });
  const longest = { requestId: requestId(2), displayName: '"'.repeat(24), message: '"'.repeat(220) };
  assert.equal(validateGuestbookSubmission(longest).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(longest)) < 1024);
});

test('Guestbook persists, paginates, enforces cooldown and idempotency, prunes by age and tombstones no public identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-guestbook-db-'));
  const db = openDb(join(root, 'guestbook.sqlite'));
  const digest = 'a'.repeat(64);
  try {
    const now = GUESTBOOK_RETENTION_MS + 1_000_000;
    const first = createGuestbookEntry(db, digest, { requestId: requestId(1), displayName: 'Mira', message: 'A quiet hello.' }, now);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('entry not created');
    assert.equal(first.entry.displayName, 'Mira');
    assert.deepEqual(createGuestbookEntry(db, digest, { requestId: requestId(1), displayName: 'Mira', message: 'A quiet hello.' }, now + 1), {
      ok: true, duplicate: true, entry: first.entry,
    });
    assert.deepEqual(createGuestbookEntry(db, digest, { requestId: requestId(1), displayName: 'Mira', message: 'Changed body' }, now + 2), {
      ok: false, reason: 'idempotency-conflict',
    });
    assert.deepEqual(createGuestbookEntry(db, digest, { requestId: requestId(2), displayName: null, message: 'Too soon.' }, now + 2), {
      ok: false, reason: 'cooldown', retryAfterMs: GUESTBOOK_COOLDOWN_MS - 2,
    });
    const second = createGuestbookEntry(db, digest, { requestId: requestId(2), displayName: null, message: 'A later hello.' }, now + GUESTBOOK_COOLDOWN_MS);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('second entry not created');

    const insert = db.prepare('INSERT INTO guestbook_entries(created_at, display_name, body) VALUES (?, NULL, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 21; i += 1) insert.run(now + 50_000 + i, `page entry ${i}`);
    db.exec('COMMIT');
    const newest = readGuestbook(db);
    assert.equal(newest.entries.length, 20);
    assert.ok(newest.nextBefore !== null);
    const older = readGuestbook(db, newest.nextBefore);
    assert.equal(older.entries.length, 3);
    assert.equal(older.nextBefore, null);

    const old = Number(db.prepare('INSERT INTO guestbook_entries(created_at, display_name, body) VALUES (?, NULL, ?) RETURNING id')
      .get(now + GUESTBOOK_COOLDOWN_MS + 1 - GUESTBOOK_RETENTION_MS - 10, 'old record')!.id);
    cleanupGuestbookState(db, now + GUESTBOOK_COOLDOWN_MS + 1);
    assert.equal(db.prepare('SELECT id FROM guestbook_entries WHERE id=?').get(old), undefined);
    assert.equal(removeGuestbookEntry(db, first.entry.id), true);
    assert.equal(removeGuestbookEntry(db, first.entry.id), false);
    assert.equal(JSON.stringify(readGuestbook(db)).includes(digest), false);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Guestbook enforces its long-lived row cap and keeps the newest visitor marks', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-guestbook-cap-'));
  const db = openDb(join(root, 'guestbook.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO guestbook_entries(created_at, display_name, body) VALUES (?, NULL, ?)');
    db.exec('BEGIN');
    for (let i = 1; i <= GUESTBOOK_ENTRY_CAP; i += 1) insert.run(i, `seed ${i}`);
    db.exec('COMMIT');
    const result = createGuestbookEntry(db, 'b'.repeat(64), { requestId: requestId(3), displayName: null, message: 'Newest entry.' }, 1_000_000);
    assert.equal(result.ok, true);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM guestbook_entries').get() as { count: number }).count), GUESTBOOK_ENTRY_CAP);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM guestbook_entries WHERE body=?').get('seed 1') as { count: number }).count), 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Guestbook API keeps retries across restart, uses the shared cookie privately, and honors write protections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-guestbook-api-'));
  const path = join(root, 'guestbook.sqlite');
  let app = await createApp(options(path));
  try {
    const empty = await app.inject('/api/guestbook/entries');
    assert.deepEqual(empty.json(), { entries: [], nextBefore: null });
    const invalid = await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { origin }, payload: submission('') });
    assert.equal(invalid.statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { origin }, payload: submission('<b>still plain text</b>', 4, '<i>visitor</i>') });
    assert.equal(response.statusCode, 200);
    const cookie = (response.headers['set-cookie'] as string).split(';', 1)[0];
    const digest = (await import('node:crypto')).createHash('sha256').update(cookie.slice('ow_id='.length)).digest('hex');
    assert.equal(JSON.stringify(response.json()).includes(digest), false);
    assert.equal(response.json().entry.message, '<b>still plain text</b>');
    assert.equal((await app.inject('/api/guestbook/entries')).json().entries[0].displayName, '<i>visitor</i>');
    const duplicate = await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { cookie, origin }, payload: submission('<b>still plain text</b>', 4, '<i>visitor</i>') });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(duplicate.json().entry.id, response.json().entry.id);
    const cooldown = await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { cookie, origin }, payload: submission('another one', 5) });
    assert.equal(cooldown.statusCode, 429);
    assert.equal((await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { origin: 'https://attacker.example' }, payload: submission('blocked') })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { origin }, payload: submission('x'.repeat(2_000)) })).statusCode, 413);

    await app.close();
    app = await createApp(options(path));
    const retried = await app.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { cookie, origin }, payload: submission('<b>still plain text</b>', 4, '<i>visitor</i>') });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().duplicate, true);
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/api/session')).statusCode, 200);
  } finally {
    await app.close();
    const gated = await createApp(options(join(root, 'gated.sqlite'), false));
    try {
      const response = await gated.inject({ method: 'POST', url: '/api/guestbook/entries', headers: { origin }, payload: submission('closed') });
      assert.equal(response.statusCode, 503);
    } finally {
      await gated.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});
