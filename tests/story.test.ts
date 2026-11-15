import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../apps/server/src/db.js';
import {
  STORY_CHAPTER_CAP,
  STORY_CONTRIBUTIONS_PER_CHAPTER,
  STORY_COOLDOWN_MS,
  STORY_CONTRIBUTION_CAP,
  appendStoryContribution,
  readStoryState,
  removeStoryContribution,
} from '../apps/server/src/spaces/story/database.js';
import { validateStorySubmission } from '../apps/server/src/spaces/story/validation.js';
import { createApp } from '../apps/server/src/app.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string) => ({ dbPath, origin, cooldown: 10_000, writes: true, secure: false });
const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (n: number) => n.toString(16).padStart(64, 'a');
const input = (chapterNo: number | null, revision: number, passage: string, id: number) => ({ requestId: requestId(id), chapterNo, revision, passage });

test('Story passages normalize safely, remain short, and bound revisions and chapters', () => {
  assert.deepEqual(validateStorySubmission(input(null, 0, '  first\r\nline\tcontinues  ', 1)), {
    ok: true,
    value: { requestId: requestId(1), chapterNo: null, revision: 0, passage: 'first\nline continues' },
  });
  assert.equal(validateStorySubmission(input(1, 0, '<script>literal</script>', 2)).ok, true);
  assert.deepEqual(validateStorySubmission(input(1, 0, ' ', 3)), { ok: false, error: 'empty passage' });
  assert.deepEqual(validateStorySubmission(input(1, 0, 'x'.repeat(221), 4)), { ok: false, error: 'passage too long' });
  assert.deepEqual(validateStorySubmission(input(1, 0, 'hidden\u202etext', 5)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateStorySubmission(input(101, 0, 'too far', 6)), { ok: false, error: 'invalid input' });
  assert.deepEqual(validateStorySubmission(input(1, -1, 'bad revision', 7)), { ok: false, error: 'invalid input' });
});

test('Story revisions serialize concurrent starts and reject stale continuations without consuming a draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-story-race-'));
  const path = join(root, 'story.sqlite');
  const firstDb = openDb(path);
  const secondDb = openDb(path);
  try {
    const contenders = [
      Promise.resolve().then(() => appendStoryContribution(firstDb, digest(1), input(null, 0, 'A door stood open.', 1), 10_000)),
      Promise.resolve().then(() => appendStoryContribution(secondDb, digest(2), input(null, 0, 'Rain began at noon.', 2), 10_000)),
    ];
    const results = await Promise.all(contenders);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => !result.ok && result.reason === 'stale').length, 1);
    const accepted = results.find(result => result.ok);
    assert.ok(accepted?.ok);
    if (!accepted?.ok) throw new Error('no starting passage accepted');
    const latest = readStoryState(firstDb);
    assert.equal(latest.currentRevision, 1);
    assert.equal(latest.chapter?.contributions.length, 1);
    assert.match(latest.chapter?.contributions[0].passage ?? '', /door stood open|Rain began at noon/);

    const retry = appendStoryContribution(firstDb, digest(accepted.contribution.id === 1 ? 1 : 2),
      input(null, 0, accepted.contribution.passage, accepted.contribution.passage === 'A door stood open.' ? 1 : 2), 10_001);
    assert.equal(retry.ok, true);
    if (!retry.ok) throw new Error('idempotent retry failed');
    assert.equal(retry.duplicate, true);
    const changedKey = appendStoryContribution(firstDb, digest(1), input(null, 0, 'A different beginning.', 1), 10_002);
    assert.deepEqual(changedKey, { ok: false, reason: 'idempotency-conflict' });

    const stale = appendStoryContribution(firstDb, digest(3), input(1, 0, 'My draft remains.', 3), 10_001);
    assert.equal(stale.ok, false);
    if (stale.ok || stale.reason !== 'stale') throw new Error('a stale revision was accepted');
    assert.equal(stale.state?.chapter?.contributions.length, 1);
    const sameVisitorCooldown = appendStoryContribution(firstDb, digest(accepted.contribution.passage === 'A door stood open.' ? 1 : 2),
      input(1, 1, 'A later line.', 4), 10_001);
    assert.deepEqual(sameVisitorCooldown, { ok: false, reason: 'cooldown', retryAfterMs: STORY_COOLDOWN_MS - 1 });
    const continuation = appendStoryContribution(firstDb, digest(4), input(1, 1, 'A later line.', 5), 20_000);
    assert.equal(continuation.ok, true);
    if (!continuation.ok) throw new Error('current revision was not accepted');
    assert.equal(continuation.state.currentRevision, 2);
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Story starts chapters at 40 contributions and archives every earlier passage', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-story-chapters-'));
  const db = openDb(join(root, 'story.sqlite'));
  try {
    let chapterNo: number | null = null;
    let revision = 0;
    for (let index = 1; index <= STORY_CONTRIBUTIONS_PER_CHAPTER; index += 1) {
      const result = appendStoryContribution(db, digest(index + 100), input(chapterNo, revision, `Part ${index}.`, index + 100), 1_000_000 + index * STORY_COOLDOWN_MS);
      if (!result.ok) throw new Error(`contribution ${index} failed: ${result.reason}`);
      chapterNo = result.state.currentChapterNo;
      revision = result.state.currentRevision;
    }
    assert.equal(chapterNo, 2);
    assert.equal(revision, 0);
    const chapterOne = readStoryState(db, 1);
    assert.equal(chapterOne.chapter?.status, 'archived');
    assert.equal(chapterOne.chapter?.contributions.length, STORY_CONTRIBUTIONS_PER_CHAPTER);
    assert.equal(chapterOne.chapter?.contributions.at(-1)?.passage, 'Part 40.');
    assert.equal(readStoryState(db).chapter?.number, 2);
    const stale = appendStoryContribution(db, digest(999), input(1, 40, 'The stale ending.', 999), 2_000_000);
    assert.equal(stale.ok, false);
    if (stale.ok) throw new Error('archived chapter accepted a continuation');
    assert.equal(stale.reason, 'stale');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Story moderation replaces prose with a tombstone and invalidates the current revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-story-redact-'));
  const db = openDb(join(root, 'story.sqlite'));
  try {
    const result = appendStoryContribution(db, digest(1), input(null, 0, 'Sensitive passage.', 1), 50_000);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('passage was not created');
    assert.equal(removeStoryContribution(db, result.contribution.id, 50_001), true);
    assert.equal(removeStoryContribution(db, result.contribution.id, 50_002), false);
    const state = readStoryState(db);
    assert.equal(state.chapter?.contributions.length, 1);
    assert.equal(state.chapter?.contributions[0].passage, 'A passage was removed.');
    assert.equal(state.chapter?.contributions[0].removed, true);
    assert.equal(state.currentRevision, 2);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Story fails closed at its bounded archive size without deleting earlier chapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-story-cap-'));
  const db = openDb(join(root, 'story.sqlite'));
  try {
    db.exec('BEGIN');
    const chapter = db.prepare(`INSERT INTO story_chapters(chapter_no, status, opened_at, closed_at, revision) VALUES (?, 'archived', ?, ?, ?)`);
    const passage = db.prepare(`INSERT INTO story_contributions(chapter_id, ordinal, created_at, body) VALUES (?, ?, ?, 'kept')`);
    for (let number = 1; number <= STORY_CHAPTER_CAP; number += 1) {
      const id = Number(chapter.run(number, number, number, STORY_CONTRIBUTIONS_PER_CHAPTER).lastInsertRowid);
      for (let ordinal = 1; ordinal <= STORY_CONTRIBUTIONS_PER_CHAPTER; ordinal += 1) passage.run(id, ordinal, number * 100 + ordinal);
    }
    db.exec('COMMIT');
    assert.equal(STORY_CONTRIBUTION_CAP, 4_000);
    const full = readStoryState(db);
    assert.equal(full.full, true);
    assert.equal(full.chapterCount, STORY_CHAPTER_CAP);
    assert.equal(full.chapter?.number, STORY_CHAPTER_CAP);
    assert.equal(full.chapter?.contributions.length, STORY_CONTRIBUTIONS_PER_CHAPTER);
    assert.deepEqual(appendStoryContribution(db, digest(1), input(null, 0, 'One more.', 1), 1_000_000), { ok: false, reason: 'full' });
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM story_contributions').get() as { count: number }).count), STORY_CONTRIBUTION_CAP);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Story API retains its first passage and retry across server restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-story-api-'));
  const path = join(root, 'story.sqlite');
  let app = await createApp(options(path));
  try {
    const empty = await app.inject('/api/story/state');
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().chapter, null);
    const payload = input(null, 0, 'The lighthouse was dark.', 44);
    const created = await app.inject({ method: 'POST', url: '/api/story/contributions', headers: { origin }, payload });
    assert.equal(created.statusCode, 200);
    const cookie = (created.headers['set-cookie'] as string).split(';', 1)[0];
    assert.equal(created.json().state.chapter.number, 1);
    assert.equal(JSON.stringify(created.json()).includes(cookie.slice('ow_id='.length)), false);
    await app.close();
    app = await createApp(options(path));
    const state = await app.inject('/api/story/state');
    assert.equal(state.json().chapter.contributions[0].passage, 'The lighthouse was dark.');
    const retry = await app.inject({ method: 'POST', url: '/api/story/contributions', headers: { origin, cookie }, payload });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().duplicate, true);
    assert.equal((await app.inject('/api/story/chapters/1')).statusCode, 200);
    assert.equal((await app.inject('/api/story/chapters/101')).statusCode, 400);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
