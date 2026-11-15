import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../apps/server/src/db.js';
import {
  CHOICE_ARCHIVE_CAP,
  CHOICE_OPEN_MS,
  CHOICE_PROPOSAL_COOLDOWN_MS,
  CHOICE_QUEUE_CAP,
  getChoiceState,
  proposeChoice,
  readChoiceArchive,
  removeChoiceDecision,
  voteChoice,
} from '../apps/server/src/spaces/choice/database.js';
import { validateChoiceProposal, validateChoiceVote } from '../apps/server/src/spaces/choice/validation.js';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string) => ({ dbPath, origin, cooldown: 10_000, writes: true, secure: false });
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (n: number) => n.toString(16).padStart(64, 'c');
const proposal = (id: number, question = `Question ${id}?`) => ({ requestId: requestId(id), question, optionA: 'Keep it', optionB: 'Change it' });

test('The Choice normalizes bounded proposals, rejects matching options, and validates votes', () => {
  assert.deepEqual(validateChoiceProposal({ requestId: requestId(1), question: '  e\u0301?  ', optionA: '  YES ', optionB: 'No' }), {
    ok: true,
    value: { requestId: requestId(1), question: 'é?', optionA: 'YES', optionB: 'No' },
  });
  assert.deepEqual(validateChoiceProposal({ requestId: requestId(2), question: 'Pick one?', optionA: 'yes', optionB: ' YES  ' }), {
    ok: false, error: 'identical choices',
  });
  assert.deepEqual(validateChoiceProposal({ requestId: requestId(3), question: 'x'.repeat(121), optionA: 'A', optionB: 'B' }), {
    ok: false, error: 'text too long',
  });
  assert.deepEqual(validateChoiceProposal({ requestId: requestId(4), question: 'Question?', optionA: 'A\u202e', optionB: 'B' }), {
    ok: false, error: 'invalid input',
  });
  assert.deepEqual(validateChoiceVote({ requestId: requestId(5), choice: 'a' }), { ok: true, requestId: requestId(5), choice: 'a' });
  assert.deepEqual(validateChoiceVote({ requestId: requestId(6), choice: 'c' }), { ok: false });
  assert.deepEqual(validateChoiceVote({ requestId: requestId(7), choice: 'b', other: true }), { ok: false });
});

test('The Choice activates FIFO proposals, replaces votes, withholds totals, and closes exactly at its deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-choice-life-'));
  const db = openDb(join(root, 'choice.sqlite'));
  try {
    const now = 100_000;
    const first = proposeChoice(db, digest(1), proposal(1, 'Which route should the ferry take?'), now);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('first proposal not activated');
    assert.equal(first.decision.status, 'active');
    assert.equal(first.decision.openedAt, now);
    assert.equal(first.decision.closesAt, now + CHOICE_OPEN_MS);
    assert.equal(first.decision.results, null);

    const second = proposeChoice(db, digest(2), proposal(2), now + 1);
    const third = proposeChoice(db, digest(3), proposal(3), now + 2);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);
    if (!second.ok || !third.ok) throw new Error('queued proposal rejected');
    assert.equal(second.decision.status, 'queued');
    assert.equal(getChoiceState(db, null, now + 3).queuedCount, 2);
    assert.deepEqual(proposeChoice(db, digest(1), proposal(4), now + 4), {
      ok: false, reason: 'cooldown', retryAfterMs: CHOICE_PROPOSAL_COOLDOWN_MS - 4,
    });
    assert.equal(getChoiceState(db, null, now + CHOICE_OPEN_MS - 1).active?.id, first.decision.id);
    const firstVote = voteChoice(db, digest(20), first.decision.id, requestId(20), 'a', now + 100);
    assert.equal(firstVote.ok, true);
    if (!firstVote.ok) throw new Error('vote not recorded');
    assert.equal(firstVote.decision.viewerChoice, 'a');
    assert.deepEqual(firstVote.decision.results, { optionA: 1, optionB: 0, total: 1 });
    assert.equal(getChoiceState(db, null, now + 101).active?.results, null);
    const repeatedVote = voteChoice(db, digest(20), first.decision.id, requestId(20), 'a', now + 102);
    assert.equal(repeatedVote.ok, true);
    if (!repeatedVote.ok) throw new Error('vote retry failed');
    assert.equal(repeatedVote.duplicate, true);
    const changedVote = voteChoice(db, digest(20), first.decision.id, requestId(21), 'b', now + 103);
    assert.equal(changedVote.ok, true);
    if (!changedVote.ok) throw new Error('vote change failed');
    assert.equal(changedVote.decision.viewerChoice, 'b');
    assert.deepEqual(changedVote.decision.results, { optionA: 0, optionB: 1, total: 1 });
    const secondVoter = voteChoice(db, digest(21), first.decision.id, requestId(22), 'b', now + 104);
    assert.equal(secondVoter.ok, true);

    const next = getChoiceState(db, null, now + CHOICE_OPEN_MS);
    assert.equal(next.active?.id, second.decision.id);
    assert.equal(next.active?.openedAt, now + CHOICE_OPEN_MS);
    assert.equal(next.active?.closesAt, now + 2 * CHOICE_OPEN_MS);
    const archive = readChoiceArchive(db);
    assert.equal(archive.decisions[0].id, first.decision.id);
    assert.deepEqual(archive.decisions[0].results, { optionA: 0, optionB: 2, total: 2 });
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM choice_votes').get() as { count: number }).count), 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

    const afterNoVotes = getChoiceState(db, null, now + 2 * CHOICE_OPEN_MS);
    assert.equal(afterNoVotes.active?.id, third.decision.id);
    const closed = readChoiceArchive(db);
    assert.deepEqual(closed.decisions[0].results, { optionA: 0, optionB: 0, total: 0 });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('The Choice advances after an operator removes the active proposal and limits its pending queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-choice-queue-'));
  const db = openDb(join(root, 'choice.sqlite'));
  try {
    const active = proposeChoice(db, digest(1), proposal(1), 100_000);
    const queued = proposeChoice(db, digest(2), proposal(2), 100_001);
    assert.equal(active.ok && queued.ok, true);
    if (!active.ok || !queued.ok) throw new Error('proposal failed');
    assert.equal(removeChoiceDecision(db, active.decision.id, 100_002), true);
    assert.equal(getChoiceState(db, null, 100_002).active?.id, queued.decision.id);
    assert.equal(removeChoiceDecision(db, queued.decision.id, 100_003), true);
    assert.equal(getChoiceState(db, null, 100_003).active, null);

    const first = proposeChoice(db, digest(100), proposal(100), 200_000);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('queue fixture failed');
    for (let i = 1; i <= CHOICE_QUEUE_CAP; i += 1) {
      const result = proposeChoice(db, digest(100 + i), proposal(100 + i), 200_000 + i);
      assert.equal(result.ok, true, `queued proposal ${i}`);
    }
    assert.deepEqual(proposeChoice(db, digest(100 + CHOICE_QUEUE_CAP + 1), proposal(500), 200_100), {
      ok: false, reason: 'queue-full',
    });
    assert.equal(getChoiceState(db, null, 200_101).queuedCount, CHOICE_QUEUE_CAP);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('The Choice archive retains only its newest completed decisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-choice-archive-'));
  const db = openDb(join(root, 'choice.sqlite'));
  try {
    const insert = db.prepare(`INSERT INTO choice_decisions(created_at, question, option_a, option_b, status, opened_at, closes_at, closed_at, result_a, result_b)
      VALUES (?, ?, 'A', 'B', 'closed', ?, ?, ?, 0, 0)`);
    db.exec('BEGIN');
    for (let i = 1; i <= CHOICE_ARCHIVE_CAP + 1; i += 1) {
      const closesAt = i + CHOICE_OPEN_MS;
      insert.run(i, `Archive ${i}?`, i, closesAt, closesAt);
    }
    db.exec('COMMIT');
    getChoiceState(db, null, 1_000_000_000);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM choice_decisions WHERE status='closed'").get() as { count: number }).count), CHOICE_ARCHIVE_CAP);
    assert.equal(db.prepare("SELECT id FROM choice_decisions WHERE question='Archive 1?'").get(), undefined);
    assert.equal(readChoiceArchive(db).decisions.length, 10);
    assert.notEqual(readChoiceArchive(db).decisions[0].question, 'Archive 1?');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('The Choice API preserves proposals and votes across restart without exposing cookie material', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-choice-api-'));
  const path = join(root, 'choice.sqlite');
  let app = await createApp(options(path));
  try {
    const empty = await app.inject('/api/choice/state');
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().active, null);
    const suggestion = await app.inject({ method: 'POST', url: '/api/choice/proposals', headers: { origin }, payload: proposal(900, 'Should windows face east or west?') });
    assert.equal(suggestion.statusCode, 200);
    assert.equal(suggestion.json().decision.status, 'active');
    const cookie = (suggestion.headers['set-cookie'] as string).split(';', 1)[0];
    const digestValue = (await import('node:crypto')).createHash('sha256').update(cookie.slice('ow_id='.length)).digest('hex');
    assert.equal(JSON.stringify(suggestion.json()).includes(digestValue), false);
    const id = suggestion.json().decision.id;
    const hidden = await app.inject('/api/choice/state');
    assert.equal(hidden.json().active.results, null);
    const vote = await app.inject({ method: 'POST', url: `/api/choice/decisions/${id}/vote`, headers: { origin, cookie }, payload: { requestId: requestId(901), choice: 'a' } });
    assert.equal(vote.statusCode, 200);
    assert.deepEqual(vote.json().decision.results, { optionA: 1, optionB: 0, total: 1 });
    const changed = await app.inject({ method: 'POST', url: `/api/choice/decisions/${id}/vote`, headers: { origin, cookie }, payload: { requestId: requestId(902), choice: 'b' } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().decision.viewerChoice, 'b');

    await app.close();
    app = await createApp(options(path));
    const persisted = await app.inject('/api/choice/state');
    assert.equal(persisted.json().active.id, id);
    assert.equal(persisted.json().active.results, null);
    const myState = await app.inject({ url: '/api/choice/state', headers: { cookie } });
    assert.equal(myState.json().active.viewerChoice, 'b');
    assert.deepEqual(myState.json().active.results, { optionA: 0, optionB: 1, total: 1 });
    assert.equal((await app.inject({ method: 'POST', url: `/api/choice/decisions/${id}/vote`, headers: { origin }, payload: {} })).statusCode, 400);
    assert.equal((await app.inject('/api/session')).statusCode, 200);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
