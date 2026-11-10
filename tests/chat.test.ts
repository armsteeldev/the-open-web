import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import { CHAT_MESSAGE_CAP, CHAT_RETENTION_MS, cleanupChat, publishPendingRemovals, readRecentMessages, removeChatMessage, submitChatMessage } from '../apps/server/src/spaces/chat/database.js';
import { validateChatSubmission } from '../apps/server/src/spaces/chat/validation.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string, writes = true) => ({ dbPath, origin, cooldown: 10_000, writes, secure: false });
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = (text: string, id = 1, nickname?: string) => ({ requestId: requestId(id), text, ...(nickname === undefined ? {} : { nickname }) });

async function cookieFor(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const response = await app.inject({ url: '/api/chat/history' });
  assert.equal(response.statusCode, 200);
  return (response.headers['set-cookie'] as string).split(';', 1)[0];
}

async function opened(url: string, space: string, baseOrigin = origin): Promise<WebSocket> {
  const socket = new WebSocket(`${url}/api/events?space=${space}`, { origin: baseOrigin });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('chat validation normalizes Unicode and rejects empty, malformed, unsafe, and oversized input', () => {
  assert.deepEqual(validateChatSubmission(body('  e\u0301\t hi  ', 2)), {
    ok: true,
    value: { requestId: requestId(2), nickname: 'Anonymous', text: 'é hi' },
  });
  assert.equal(validateChatSubmission(body('👩‍💻', 3)).ok, true);
  assert.equal(validateChatSubmission(body('é'.repeat(180), 4)).ok, true);
  assert.deepEqual(validateChatSubmission(body('é'.repeat(181), 5)), { ok: false, error: 'message too long' });
  assert.deepEqual(validateChatSubmission(body(' \t\n ', 6)), { ok: false, error: 'empty message' });
  assert.deepEqual(validateChatSubmission(body('bad\u0000text', 7)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateChatSubmission(body('hidden\u202etext', 8)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateChatSubmission({ text: 'hi', requestId: 'arbitrary' }), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateChatSubmission(body('hello', 9, 'bad\u0000name')), { ok: false, error: 'invalid nickname' });
  assert.deepEqual(validateChatSubmission(body('hello', 10, 'n'.repeat(25))), { ok: false, error: 'invalid nickname' });
  assert.equal(validateChatSubmission(body('<script>alert(1)</script>', 11)).ok, true);
});

test('chat HTTP uses shared anonymous identity, authoritative order, idempotency, realtime isolation, and restart persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-'));
  const path = join(directory, 'chat.sqlite');
  let app = await createApp(options(path));
  let chatSocket: WebSocket | undefined;
  let wallSocket: WebSocket | undefined;
  try {
    const missingIdentity = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { origin }, payload: body('hello') });
    assert.equal(missingIdentity.statusCode, 401);

    const cookieA = await cookieFor(app);
    const cookieB = await cookieFor(app);
    assert.match(cookieA, /^ow_id=/);
    const history = await app.inject({ url: '/api/chat/history', headers: { cookie: cookieA } });
    assert.deepEqual(history.json(), { messages: [], latestId: 0, oldestId: null });
    assert.equal(JSON.stringify(history.json()).includes(cookieA), false);
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieA, origin: 'https://attacker.example' }, payload: body('blocked', 1) });
    assert.equal(crossOrigin.statusCode, 403);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const base = `ws://127.0.0.1:${port}`;
    chatSocket = await opened(base, 'chat');
    wallSocket = await opened(base, 'wall');
    const chatEvents: string[] = [];
    const wallEvents: string[] = [];
    chatSocket.on('message', data => chatEvents.push(data.toString()));
    wallSocket.on('message', data => wallEvents.push(data.toString()));

    const input = body(`${'"'.repeat(360)}`, 12, '"'.repeat(24));
    const sent = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieA, origin }, payload: input });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().ok, true);
    assert.equal(sent.json().message.id, 1);
    assert.equal(sent.json().message.nickname, '"'.repeat(24));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(chatEvents.length, 1);
    assert.ok(Buffer.byteLength(chatEvents[0]) <= 1024);
    const event = JSON.parse(chatEvents[0]);
    assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'id', 'nickname', 'space', 'text', 'type', 'v'].sort());
    assert.equal(event.space, 'chat');
    assert.equal(event.text, input.text);
    assert.equal(wallEvents.length, 0);

    const duplicate = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieA, origin }, payload: input });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(chatEvents.length, 1);

    const concurrent = await Promise.all([
      app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieA, origin }, payload: body('Different visitor wins no order claim', 13) }),
      app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieB, origin }, payload: body('Second person', 14, 'Mira') }),
    ]);
    assert.deepEqual(concurrent.map(response => response.statusCode), [429, 200]);
    assert.equal(concurrent[0].json().error, 'cooldown');

    const cookieC = await cookieFor(app);
    const third = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieC, origin }, payload: body('<script>literal text</script>', 15) });
    assert.equal(third.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(chatEvents.map(raw => JSON.parse(raw).id), [1, 2, 3]);
    assert.equal(wallEvents.length, 0);

    const bad = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieC, origin }, payload: body(' \n ', 16) });
    assert.equal(bad.statusCode, 400);
    const repeated = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookieC, origin }, payload: body('<script>literal text</script>', 17) });
    assert.equal(repeated.statusCode, 429);
    assert.equal(repeated.json().error, 'cooldown');
    assert.ok(repeated.json().retryAfterMs > 0);

    const ordered = await app.inject({ url: '/api/chat/history', headers: { cookie: cookieA } });
    assert.deepEqual(ordered.json().messages.map((message: { id: number }) => message.id), [1, 2, 3]);
    assert.equal(ordered.json().messages[2].nickname, 'Anonymous');
    assert.equal(ordered.json().messages[2].text, '<script>literal text</script>');

    chatSocket.close();
    wallSocket.close();
    chatSocket = undefined;
    wallSocket = undefined;
    await app.close();
    app = await createApp(options(path));
    const afterRestart = await app.inject({ url: '/api/chat/history' });
    assert.deepEqual(afterRestart.json().messages.map((message: { id: number }) => message.id), [1, 2, 3]);
  } finally {
    chatSocket?.terminate();
    wallSocket?.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat charges successful-message budgets only and reports retry timing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-limits-'));
  const app = await createApp(options(join(directory, 'chat.sqlite')));
  try {
    const firstCookie = await cookieFor(app);
    const invalid = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: firstCookie, origin }, payload: body('', 20) });
    assert.equal(invalid.statusCode, 400);
    const first = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: firstCookie, origin }, payload: body('first accepted', 21) });
    assert.equal(first.statusCode, 200);
    const tooSoon = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: firstCookie, origin }, payload: body('another message', 22) });
    assert.equal(tooSoon.statusCode, 429);
    assert.equal(tooSoon.json().error, 'cooldown');
    assert.ok(tooSoon.json().retryAfterMs > 0 && tooSoon.json().retryAfterMs <= 3_000);

    const cookies = [firstCookie];
    for (let i = 1; i < 21; i++) cookies.push(await cookieFor(app));
    for (let i = 1; i < 20; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookies[i], origin }, payload: body(`network message ${i}`, 100 + i) });
      assert.equal(response.statusCode, 200);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie: cookies[20], origin }, payload: body('network over limit', 200) });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error, 'network limit');
    assert.ok(limited.json().retryAfterMs > 0);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat mutation uses the shared emergency write gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-gate-'));
  const app = await createApp(options(join(directory, 'chat.sqlite'), false));
  try {
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie, origin }, payload: body('blocked by write gate', 250) });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'writes disabled' });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent visitors can submit concurrently and observe the same database order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-concurrent-'));
  const app = await createApp(options(join(directory, 'chat.sqlite')));
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    socket = await opened(`ws://127.0.0.1:${port}`, 'chat');
    const events: { id: number; text: string }[] = [];
    socket.on('message', data => events.push(JSON.parse(data.toString())));
    const cookies = [await cookieFor(app), await cookieFor(app)];
    const responses = await Promise.all(cookies.map((cookie, index) => app.inject({
      method: 'POST', url: '/api/chat/messages', headers: { cookie, origin },
      payload: body(`parallel ${index}`, 501 + index, `Visitor ${index}`),
    })));
    assert.deepEqual(responses.map(response => response.statusCode), [200, 200]);
    for (let i = 0; i < 50 && events.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 2);
    assert.ok(events[0].id < events[1].id);
    const history = await app.inject({ url: '/api/chat/history' });
    assert.deepEqual(history.json().messages.slice(-2).map((message: { id: number; text: string }) => [message.id, message.text]), events.map(event => [event.id, event.text]));
  } finally {
    socket?.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat persistence enforces ordering, 24-hour expiry, hard cap, idempotency retention, and operator removal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-retention-'));
  const path = join(directory, 'chat.sqlite');
  const db = openDb(path);
  const now = Date.now();
  try {
    const insert = db.prepare('INSERT INTO chat_messages(created_at, visitor_digest, nickname, body) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < CHAT_MESSAGE_CAP + 2; i++) {
      const digest = i.toString(16).padStart(64, '0');
      insert.run(i === 0 ? now - CHAT_RETENTION_MS - 1 : now - 10_000 + i, digest, 'Anonymous', `seed ${i}`);
    }
    db.prepare('INSERT INTO chat_idempotency(visitor_digest, request_id, created_at, message_id) VALUES (?, ?, ?, ?)')
      .run('f'.repeat(64), requestId(99), now - 4_000_000, 1);
    db.exec('COMMIT');

    const removed = cleanupChat(db, now);
    assert.equal(removed.length, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count, CHAT_MESSAGE_CAP);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_idempotency').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM chat_message_removals').get() as { count: number }).count, 2);
    const recent = readRecentMessages(db, now);
    assert.equal(recent.messages.length, 100);
    assert.ok(recent.messages.every((message, index) => index === 0 || recent.messages[index - 1].id < message.id));

    assert.equal(removeChatMessage(db, recent.messages[10].id, now + 1), true);
    assert.equal(readRecentMessages(db, now + 1).messages.some(message => message.id === recent.messages[10].id), false);
    assert.equal(removeChatMessage(db, recent.messages[10].id, now + 1), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat database submission is atomic under concurrent visitors and deduplicates retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-submit-'));
  const db = openDb(join(directory, 'chat.sqlite'));
  try {
    const time = Date.now();
    const first = submitChatMessage(db, 'a'.repeat(64), { requestId: requestId(301), nickname: 'A', text: 'same body' }, time);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const duplicate = submitChatMessage(db, 'a'.repeat(64), { requestId: requestId(301), nickname: 'A', text: 'same body' }, time + 1);
    assert.equal(duplicate.ok && duplicate.duplicate, true);
    const cooldown = submitChatMessage(db, 'a'.repeat(64), { requestId: requestId(302), nickname: 'A', text: 'different' }, time + 1);
    assert.deepEqual(cooldown.ok ? undefined : cooldown.reason, 'cooldown');
    const sameText = submitChatMessage(db, 'a'.repeat(64), { requestId: requestId(303), nickname: 'A', text: 'same body' }, time + 3_001);
    assert.equal(sameText.ok ? undefined : sameText.reason, 'repeated');
    const otherVisitor = submitChatMessage(db, 'b'.repeat(64), { requestId: requestId(304), nickname: 'B', text: 'same body' }, time + 3_001);
    assert.equal(otherVisitor.ok, true);
    assert.equal(readRecentMessages(db).messages.length, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator removal writes a bounded tombstone and refuses unknown IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-web-chat-remove-'));
  const db = openDb(join(directory, 'chat.sqlite'));
  try {
    const result = submitChatMessage(db, 'c'.repeat(64), { requestId: requestId(401), nickname: 'Test', text: 'remove me' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const message = result.message;
    if (!message) throw new Error('accepted chat submission did not return its message');
    assert.equal(removeChatMessage(db, message.id), true);
    assert.equal(removeChatMessage(db, message.id), false);
    assert.equal((db.prepare('SELECT message_id FROM chat_message_removals').get() as { message_id: number }).message_id, message.id);
    const replay = submitChatMessage(db, 'c'.repeat(64), { requestId: requestId(401), nickname: 'Test', text: 'remove me' });
    assert.equal(replay.ok && replay.duplicate, true);
    assert.equal(replay.ok && replay.message, null);
    const removalEvents: number[] = [];
    const cursor = publishPendingRemovals(db, 0, id => removalEvents.push(id));
    assert.deepEqual(removalEvents, [message.id]);
    assert.ok(cursor > 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
