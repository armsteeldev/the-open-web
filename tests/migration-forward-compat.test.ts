import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import { bottleSpace } from '../apps/server/src/spaces/bottle/index.js';
import { chatSpace } from '../apps/server/src/spaces/chat/index.js';
import { wallSpace } from '../apps/server/src/spaces/wall/index.js';
import { place } from '../apps/server/src/spaces/wall/database.js';
import { spaces } from '../packages/shared/spaces.js';

const origin = 'http://localhost:4321';
const currentSpaceIds = new Set(['wall', 'chat', 'bottle']);

function migrationsThrough004(directory: string): URL {
  mkdirSync(directory);
  for (const name of [
    '001_initial.sql',
    '002_cooldown_retention.sql',
    '003_chat_messages.sql',
    '004_bottle_messages.sql',
  ]) {
    writeFileSync(join(directory, name), readFileSync(new URL(`../database/migrations/${name}`, import.meta.url)));
  }
  return pathToFileURL(`${directory}/`);
}

const options = (dbPath: string) => ({ dbPath, origin, cooldown: 10_000, writes: true, secure: false });
const bridgeRegistration = (databaseMigrations: URL) => ({
  registry: spaces.filter(space => currentSpaceIds.has(space.id)),
  modules: [wallSpace, chatSpace, bottleSpace],
  databaseMigrations,
});

test('the three-space bridge, ten-space candidate migration, and bridge rollback preserve data safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-expansion-forward-'));
  const path = join(root, 'release-sequence.sqlite');
  const bridgeMigrations = migrationsThrough004(join(root, 'bridge-migrations'));
  const now = Date.now();
  const preCandidate = openDb(path, bridgeMigrations);
  assert.deepEqual(
    (preCandidate.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]).map(row => row.version),
    [1, 2, 3, 4],
  );
  assert.equal(place(preCandidate, 'rollback-visitor', 2, 3, 4, now, 10_000).ok, true);
  preCandidate.prepare('INSERT INTO chat_messages(created_at, visitor_digest, nickname, body) VALUES (?, ?, ?, ?)')
    .run(now, 'a'.repeat(64), 'Kept', 'chat data survives both switches');
  preCandidate.prepare('INSERT INTO bottle_messages(id, created_at, body, signature) VALUES (?, ?, ?, ?)')
    .run('00000000-0000-4000-8000-000000000004', now, 'Bottle data survives both switches', 'Kept');
  preCandidate.close();

  let bridge = await createApp(options(path), bridgeRegistration(bridgeMigrations));
  try {
    assert.equal((await bridge.inject('/api/health')).statusCode, 200);
    assert.equal((await bridge.inject('/api/wall/tile/0/0')).rawPayload[302], 4);
    assert.equal((await bridge.inject('/api/chat/history')).json().messages[0].text, 'chat data survives both switches');
    assert.equal((await bridge.inject('/api/bottle/random')).json().bottle.message, 'Bottle data survives both switches');
    assert.equal((await bridge.inject('/api/guestbook/entries')).statusCode, 404, 'the bridge does not register unfinished spaces');
    assert.equal((await bridge.inject('/api/draw/drawings')).statusCode, 404, 'the bridge does not expose Drawing Board');
    const database = openDb(path, bridgeMigrations);
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version, 4);
    database.close();
  } finally {
    await bridge.close();
  }

  const candidate = await createApp(options(path));
  let cookie = '';
  let questionId: number;
  let decisionId: number;
  let drawingId: number;
  let plantPosition: { x: number; y: number };
  try {
    assert.equal((await candidate.inject('/api/health')).statusCode, 200);
    const session = await candidate.inject('/api/session');
    cookie = String(session.headers['set-cookie']).split(';', 1)[0]!;
    assert.deepEqual(spaces.map(space => space.id), ['wall', 'chat', 'bottle', 'guestbook', 'story', 'questions', 'choice', 'draw', 'garden', 'map']);
    const write = (url: string, payload: unknown) => candidate.inject({
      method: 'POST', url, headers: { origin, cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload),
    });

    assert.deepEqual((await candidate.inject('/api/guestbook/entries')).json().entries, []);
    assert.equal((await write('/api/guestbook/entries', {
      requestId: '00000000-0000-4000-8000-000000000101', displayName: 'Reader', message: 'Guestbook data survives rollback',
    })).statusCode, 200);
    const story = await write('/api/story/contributions', {
      requestId: '00000000-0000-4000-8000-000000000102', chapterNo: null, revision: 0, passage: 'The story survives a release switch.',
    });
    assert.equal(story.statusCode, 200, story.body);
    const question = await write('/api/questions', {
      requestId: '00000000-0000-4000-8000-000000000103', text: 'Which details do strangers remember?',
    });
    assert.equal(question.statusCode, 200, question.body);
    questionId = question.json().question.id as number;
    const answer = await write(`/api/questions/${questionId}/answers`, {
      requestId: '00000000-0000-4000-8000-000000000104', text: 'Small, ordinary ones.',
    });
    assert.equal(answer.statusCode, 200, answer.body);
    const proposal = await write('/api/choice/proposals', {
      requestId: '00000000-0000-4000-8000-000000000105', question: 'Which way home?', optionA: 'By the water', optionB: 'Through the trees',
    });
    assert.equal(proposal.statusCode, 200, proposal.body);
    decisionId = proposal.json().decision.id as number;
    const vote = await write(`/api/choice/decisions/${decisionId}/vote`, {
      requestId: '00000000-0000-4000-8000-000000000106', choice: 'a',
    });
    assert.equal(vote.statusCode, 200, vote.body);
    assert.deepEqual(vote.json().decision.results, { optionA: 1, optionB: 0, total: 1 });

    assert.deepEqual((await candidate.inject('/api/draw/drawings')).json().drawings, []);
    const strokes = Array.from({ length: 8 }, (_, strokeIndex) => ({
      tool: 'pen', color: strokeIndex % 6, size: strokeIndex % 3,
      points: Array.from({ length: 70 }, (_, pointIndex) => [pointIndex * 13, (pointIndex * 7 + strokeIndex) % 700]),
    }));
    const drawingRequestId = '595008c2-7bbf-4ced-8d47-3a0df06c3d24';
    const drawing = await write('/api/draw/drawings', { requestId: drawingRequestId, strokes });
    assert.equal(drawing.statusCode, 201, drawing.body);
    drawingId = drawing.json().drawing.id as number;
    assert.ok(Buffer.byteLength(drawing.body) > 1_024, 'the drawing submission exercises the bounded route exception');
    assert.equal((await candidate.inject(`/api/draw/drawings/${drawingId}`)).json().drawing.strokes.length, 8);
    const drawingRetry = await write('/api/draw/drawings', { requestId: drawingRequestId, strokes });
    assert.equal(drawingRetry.statusCode, 200, drawingRetry.body);
    assert.equal(drawingRetry.json().drawing.id, drawingId);
    assert.equal(drawingRetry.json().replayed, true);

    const garden = await candidate.inject('/api/garden/state');
    assert.deepEqual(garden.json().plants, []);
    const planted = await write('/api/garden/plants', { x: 0, y: 0, plantType: 'wildflower' });
    assert.equal(planted.statusCode, 201, planted.body);
    plantPosition = planted.json().plant;

    const map = await write('/api/map/contribution', { countryCode: 'SE' });
    assert.equal(map.statusCode, 200, map.body);
    const mapState = await candidate.inject({ url: '/api/map/state', headers: { cookie } });
    assert.deepEqual(mapState.json().countries, [{ code: 'SE', count: 1 }]);
    assert.equal(mapState.json().yourCountry, 'SE');
    for (const route of [
      '/api/guestbook/entries', '/api/story/state', '/api/questions', `/api/questions/${questionId}`, '/api/choice/state', '/api/choice/archive',
      '/api/draw/drawings', `/api/draw/drawings/${drawingId}`, '/api/garden/state', '/api/map/state',
    ]) assert.equal((await candidate.inject(route)).statusCode, 200, route);
  } finally {
    await candidate.close();
  }

  const migrated = openDb(path);
  assert.deepEqual(
    (migrated.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]).map(row => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(migrated.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((migrated.prepare('SELECT body FROM guestbook_entries').get() as { body: string }).body, 'Guestbook data survives rollback');
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM story_contributions').get() as { count: number }).count, 1);
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM questions_answers WHERE question_id=?').get(questionId) as { count: number }).count, 1);
  assert.equal((migrated.prepare('SELECT choice FROM choice_votes WHERE decision_id=?').get(decisionId) as { choice: string }).choice, 'a');
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM draw_drawings WHERE id=?').get(drawingId) as { count: number }).count, 1);
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM draw_submission_idempotency WHERE drawing_id=?').get(drawingId) as { count: number }).count, 1);
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM garden_plants WHERE x=? AND y=?').get(plantPosition.x, plantPosition.y) as { count: number }).count, 1);
  assert.equal((migrated.prepare('SELECT country_code FROM map_contributions').get() as { country_code: string }).country_code, 'SE');
  migrated.close();

  bridge = await createApp(options(path), bridgeRegistration(bridgeMigrations));
  try {
    assert.equal((await bridge.inject('/api/health')).statusCode, 200, 'bridge startup accepts the exact known 007 schema');
    assert.equal((await bridge.inject('/api/wall/tile/0/0')).rawPayload[302], 4);
    assert.equal((await bridge.inject('/api/chat/history')).json().messages[0].text, 'chat data survives both switches');
    assert.equal((await bridge.inject('/api/bottle/random')).json().bottle.message, 'Bottle data survives both switches');
    assert.equal((await bridge.inject('/api/guestbook/entries')).statusCode, 404, 'bridge rollback keeps new spaces inactive');
    assert.equal((await bridge.inject('/api/draw/drawings')).statusCode, 404, 'bridge rollback does not expose Drawing Board');
    const retained = openDb(path, bridgeMigrations);
    assert.equal(retained.prepare('SELECT MAX(version) AS version FROM migrations').get()!.version, 7);
    assert.equal((retained.prepare('SELECT body FROM guestbook_entries').get() as { body: string }).body, 'Guestbook data survives rollback');
    assert.equal((retained.prepare('SELECT COUNT(*) AS count FROM draw_drawings WHERE id=?').get(drawingId) as { count: number }).count, 1);
    assert.equal((retained.prepare('SELECT COUNT(*) AS count FROM draw_submission_idempotency WHERE drawing_id=?').get(drawingId) as { count: number }).count, 1);
    assert.equal((retained.prepare('SELECT COUNT(*) AS count FROM garden_plants WHERE x=? AND y=?').get(plantPosition.x, plantPosition.y) as { count: number }).count, 1);
    assert.equal((retained.prepare('SELECT country_code FROM map_contributions').get() as { country_code: string }).country_code, 'SE');
    assert.equal(retained.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(retained.prepare('PRAGMA foreign_key_check').all(), []);
    retained.close();
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge rejects unexpected versions and altered migration 005, 006, and 007 schemas', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-expansion-invalid-'));
  const migrations = migrationsThrough004(join(root, 'bridge-migrations'));
  try {
    const unexpectedPath = join(root, 'unexpected.sqlite');
    const unexpected = openDb(unexpectedPath);
    unexpected.prepare('INSERT INTO migrations(version) VALUES (8)').run();
    unexpected.close();
    assert.throws(() => openDb(unexpectedPath, migrations), /not supported/);

    const alteredPath = join(root, 'altered.sqlite');
    const altered = openDb(alteredPath);
    altered.exec('DROP INDEX guestbook_entries_created_id');
    altered.close();
    assert.throws(() => openDb(alteredPath, migrations), /does not match its known compatibility schema/);

    const alteredFinalPath = join(root, 'altered-final.sqlite');
    const alteredFinal = openDb(alteredFinalPath);
    alteredFinal.exec('DROP INDEX draw_drawings_created_id');
    alteredFinal.close();
    assert.throws(() => openDb(alteredFinalPath, migrations), /does not match its known compatibility schema/);

    const alteredQualityPath = join(root, 'altered-quality.sqlite');
    const alteredQuality = openDb(alteredQualityPath);
    alteredQuality.exec('DROP INDEX questions_answers_updated_id_idx');
    alteredQuality.close();
    assert.throws(() => openDb(alteredQualityPath, migrations), /does not match its known compatibility schema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
