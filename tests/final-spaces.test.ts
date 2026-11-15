import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/server/src/app.js';
import { openDb } from '../apps/server/src/db.js';
import {
  cleanupDrawings,
  DRAWING_CAP,
  DRAWING_COOLDOWN_MS,
  DRAWING_PAGE_SIZE,
  DRAWING_RETENTION_MS,
  readDrawings,
  removeDrawing,
  submitDrawing,
} from '../apps/server/src/spaces/draw/database.js';
import { validateDrawing } from '../apps/server/src/spaces/draw/validation.js';
import {
  cleanupGarden,
  GARDEN_GROWTH,
  GARDEN_PLANT_LIFETIME_MS,
  gardenStage,
  readGarden,
  removePlant,
} from '../apps/server/src/spaces/garden/database.js';
import { MAP_CONTRIBUTION_CAP, readMapState, setMapContribution, removeMapContribution } from '../apps/server/src/spaces/map/database.js';
import { isIso3166Alpha2 } from '../packages/shared/countries.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string) => ({ dbPath, origin, cooldown: 10_000, writes: true, secure: false });
const point = { x: 0, y: 0 };
const simpleDrawing = { strokes: [{ tool: 'pen', color: 0, size: 1, points: [[10, 20], [30, 40]] }] };

function temporaryPath(prefix: string): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, path: join(root, 'test.sqlite') };
}

async function visitorCookie(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const response = await app.inject({ url: '/api/session' });
  const cookie = response.headers['set-cookie'];
  assert.equal(typeof cookie, 'string');
  return (cookie as string).split(';', 1)[0]!;
}

async function write(
  app: Awaited<ReturnType<typeof createApp>>,
  url: string,
  payload: unknown,
  cookie?: string,
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      origin,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    payload: JSON.stringify(payload),
  });
}

test('Drawing Board bounds vectors and rejects malformed input', () => {
  assert.equal(validateDrawing(simpleDrawing).ok, true);
  assert.equal(validateDrawing(null).ok, false);
  assert.equal(validateDrawing({ strokes: [] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], color: 99 }] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], size: -1 }] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], points: [[0, 0], [1001, 0]] }] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], points: [[0.5, 1]] }] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], tool: 'image' }] }).ok, false);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], markup: '<svg/>' }] }).ok, false);

  const tooManyStrokes = Array.from({ length: 61 }, () => ({ ...simpleDrawing.strokes[0], points: [[1, 1]] }));
  assert.equal(validateDrawing({ strokes: tooManyStrokes }).ok, false);
  const tooManyPoints = Array.from({ length: 121 }, () => [1, 1]);
  assert.equal(validateDrawing({ strokes: [{ ...simpleDrawing.strokes[0], points: tooManyPoints }] }).ok, false);
  const totalPoints = Array.from({ length: 10 }, () => ({
    ...simpleDrawing.strokes[0],
    points: Array.from({ length: 101 }, () => [1, 1]),
  }));
  assert.equal(validateDrawing({ strokes: totalPoints }).ok, false);
  const largeButValid = Array.from({ length: 10 }, () => ({
    ...simpleDrawing.strokes[0],
    points: Array.from({ length: 100 }, (_value, index) => [index * 10, index * 7]),
  }));
  const accepted = validateDrawing({ strokes: largeButValid });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.ok(Buffer.byteLength(accepted.value.serialized) > 1024);
});

test('Drawing Board accepts bounded submissions above the shared body limit and serves a paginated gallery', async () => {
  const { root, path } = temporaryPath('open-web-draw-api-');
  const app = await createApp(options(path));
  try {
    const empty = await app.inject('/api/draw/drawings');
    assert.deepEqual(empty.json().drawings, []);
    const cookie = await visitorCookie(app);
    const strokes = Array.from({ length: 10 }, () => ({
      tool: 'pen',
      color: 0,
      size: 1,
      points: Array.from({ length: 100 }, (_value, index) => [index * 10, index * 7]),
    }));
    const submitted = await write(app, '/api/draw/drawings', { strokes }, cookie);
    assert.equal(submitted.statusCode, 201, submitted.body);
    const drawing = submitted.json().drawing as { id: number; strokes: unknown[] };
    assert.equal(drawing.strokes.length, 10);
    assert.equal(JSON.stringify(submitted.json()).includes(cookie), false);
    const tooLarge = await write(app, '/api/draw/drawings', {
      strokes: Array.from({ length: 60 }, () => ({
        tool: 'pen', color: 0, size: 1, points: Array.from({ length: 120 }, () => [1, 1]),
      })),
    }, await visitorCookie(app));
    assert.equal(tooLarge.statusCode, 413);
    const invalid = await write(app, '/api/draw/drawings', {
      strokes: [{ tool: 'pen', color: 0, size: 1, points: [[1001, 2]] }],
    }, await visitorCookie(app));
    assert.equal(invalid.statusCode, 400);
    const lookup = await app.inject('/api/draw/drawings/' + drawing.id);
    assert.equal(lookup.statusCode, 200);
    assert.equal(lookup.json().drawing.id, drawing.id);
    assert.equal((await app.inject('/api/draw/drawings/0')).statusCode, 400);
    assert.equal((await write(app, '/api/draw/drawings', simpleDrawing, cookie)).statusCode, 429);

    const concurrentCookie = await visitorCookie(app);
    const concurrent = await Promise.all([
      write(app, '/api/draw/drawings', simpleDrawing, concurrentCookie),
      write(app, '/api/draw/drawings', simpleDrawing, concurrentCookie),
    ]);
    assert.deepEqual(concurrent.map(response => response.statusCode).sort(), [201, 429]);

    const database = new DatabaseSync(path);
    const insert = database.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)');
    for (let index = 0; index < DRAWING_PAGE_SIZE + 1; index++) {
      insert.run(Date.now() + index + 1000, JSON.stringify(simpleDrawing.strokes));
    }
    database.close();
    const page = await app.inject('/api/draw/drawings');
    assert.equal(page.json().drawings.length, DRAWING_PAGE_SIZE);
    assert.notEqual(page.json().nextBefore, null);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Drawing Board retention, cooldown, cap and operator removal are bounded', () => {
  const { root, path } = temporaryPath('open-web-draw-storage-');
  const db = openDb(path);
  const validated = validateDrawing(simpleDrawing);
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error('fixture drawing should validate');
  try {
    assert.equal(submitDrawing(db, 'a'.repeat(64), validated.value, 1_000).ok, true);
    const cooldown = submitDrawing(db, 'a'.repeat(64), validated.value, 1_000 + DRAWING_COOLDOWN_MS - 1);
    assert.deepEqual(cooldown, { ok: false, reason: 'cooldown', retryAfterMs: 1 });
    const row = db.prepare('SELECT id FROM draw_drawings').get() as { id: number };
    assert.equal(removeDrawing(db, row.id), true);
    assert.equal(removeDrawing(db, row.id), false);

    const insert = db.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)');
    for (let index = 0; index < DRAWING_CAP; index++) {
      insert.run(10_000 + index, validated.value.serialized);
    }
    const overflow = submitDrawing(db, 'b'.repeat(64), validated.value, 20_000);
    assert.equal(overflow.ok, true);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM draw_drawings').get() as { count: number }).count, DRAWING_CAP);
    assert.equal((db.prepare('SELECT MIN(id) AS id FROM draw_drawings').get() as { id: number }).id, 3);

    insert.run(0, validated.value.serialized);
    assert.equal(cleanupDrawings(db, DRAWING_RETENTION_MS), 2);
    assert.equal(readDrawings(db, null).drawings.length, DRAWING_PAGE_SIZE);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Drawing Board removes sketches after the documented retention interval', () => {
  const { root, path } = temporaryPath('open-web-draw-expiry-');
  const db = openDb(path);
  try {
    const old = db.prepare('INSERT INTO draw_drawings(created_at, strokes) VALUES (?, ?)')
      .run(Date.now() - DRAWING_RETENTION_MS - 1, JSON.stringify(simpleDrawing.strokes));
    cleanupDrawings(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM draw_drawings WHERE id=?').get(Number(old.lastInsertRowid)) as { count: number }).count, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Garden stages change at deterministic boundaries and expired plants free their plots', () => {
  assert.equal(gardenStage(0, GARDEN_GROWTH.sprout - 1), 'seed');
  assert.equal(gardenStage(0, GARDEN_GROWTH.sprout), 'sprout');
  assert.equal(gardenStage(0, GARDEN_GROWTH.young - 1), 'sprout');
  assert.equal(gardenStage(0, GARDEN_GROWTH.young), 'young');
  assert.equal(gardenStage(0, GARDEN_GROWTH.mature - 1), 'young');
  assert.equal(gardenStage(0, GARDEN_GROWTH.mature), 'mature');
  assert.equal(gardenStage(0, GARDEN_PLANT_LIFETIME_MS), null);

  const { root, path } = temporaryPath('open-web-garden-storage-');
  const db = openDb(path);
  try {
    db.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (0, 0, ?, ?)')
      .run('clover', 100);
    assert.deepEqual(readGarden(db, 100 + GARDEN_PLANT_LIFETIME_MS).plants, []);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM garden_plants').get() as { count: number }).count, 0);
    assert.equal(cleanupGarden(db, 100 + GARDEN_PLANT_LIFETIME_MS), 0);
    assert.equal(removePlant(db, 1), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Garden prevents concurrent occupancy, applies cooldowns and reports a full garden', async () => {
  const { root, path } = temporaryPath('open-web-garden-api-');
  const app = await createApp(options(path));
  try {
    const state = await app.inject('/api/garden/state');
    assert.equal(state.json().plants.length, 0);
    assert.equal(state.headers['set-cookie'], undefined, 'viewing the garden does not create an identity');
    const cookieA = await visitorCookie(app);
    const cookieB = await visitorCookie(app);
    const results = await Promise.all([
      write(app, '/api/garden/plants', { ...point, plantType: 'clover' }, cookieA),
      write(app, '/api/garden/plants', { ...point, plantType: 'sunflower' }, cookieB),
    ]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [201, 409]);
    const planted = await app.inject('/api/garden/state');
    assert.equal(planted.json().plants.length, 1);
    assert.equal(planted.json().plants[0].stage, 'seed');
    assert.equal(JSON.stringify(planted.json()).includes(cookieA), false);
    assert.equal((await write(app, '/api/garden/plants', { x: 18, y: 0, plantType: 'grass' }, await visitorCookie(app))).statusCode, 400);
    const winnerCookie = results[0]!.statusCode === 201 ? cookieA : cookieB;
    const repeat = await write(app, '/api/garden/plants', { x: 1, y: 0, plantType: 'grass' }, winnerCookie);
    assert.equal(repeat.statusCode, 429);

    const database = new DatabaseSync(path);
    const fill = database.prepare('INSERT INTO garden_plants(x, y, plant_type, created_at) VALUES (?, ?, ?, ?)');
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 18; x++) if (x !== 0 || y !== 0) fill.run(x, y, 'grass', Date.now());
    }
    database.close();
    const full = await write(app, '/api/garden/plants', { x: 0, y: 0, plantType: 'grass' }, await visitorCookie(app));
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'garden full');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Visitors Map accepts ISO alpha-2 codes, updates and removes only the current browser mark', async () => {
  assert.equal(isIso3166Alpha2('SE'), true);
  assert.equal(isIso3166Alpha2('ZZ'), false);
  const { root, path } = temporaryPath('open-web-map-api-');
  const app = await createApp(options(path));
  try {
    const empty = await app.inject('/api/map/state');
    assert.deepEqual(empty.json(), { countries: [], total: 0, yourCountry: null });
    assert.equal(empty.headers['set-cookie'], undefined, 'opening the map does not create an identity');
    for (const countryCode of ['zz', 'ZZ', 'US ', 'United States']) {
      assert.equal((await write(app, '/api/map/contribution', { countryCode })).statusCode, 400);
    }
    assert.equal((await write(app, '/api/map/contribution', { countryCode: 'US', cookie: 'extra' })).statusCode, 400);

    const cookieA = await visitorCookie(app);
    const savedA = await write(app, '/api/map/contribution', { countryCode: 'US' }, cookieA);
    assert.equal(savedA.statusCode, 200);
    const own = await app.inject({ url: '/api/map/state', headers: { cookie: cookieA } });
    assert.equal(own.json().yourCountry, 'US');
    assert.deepEqual(own.json().countries, [{ code: 'US', count: 1 }]);
    assert.equal(JSON.stringify(own.json()).includes(cookieA), false);

    const cookieB = await visitorCookie(app);
    await write(app, '/api/map/contribution', { countryCode: 'SE' }, cookieB);
    const changedA = await write(app, '/api/map/contribution', { countryCode: 'NO' }, cookieA);
    assert.equal(changedA.statusCode, 200);
    const aggregate = await app.inject('/api/map/state');
    assert.deepEqual(aggregate.json().countries, [{ code: 'NO', count: 1 }, { code: 'SE', count: 1 }]);
    const removed = await write(app, '/api/map/contribution', { countryCode: null }, cookieA);
    assert.equal(removed.json().removed, true);
    assert.deepEqual((await app.inject('/api/map/state')).json().countries, [{ code: 'SE', count: 1 }]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Visitors Map serializes concurrent country changes for the same browser', async () => {
  const { root, path } = temporaryPath('open-web-map-concurrent-');
  const app = await createApp(options(path));
  try {
    const cookie = await visitorCookie(app);
    const results = await Promise.all([
      write(app, '/api/map/contribution', { countryCode: 'US' }, cookie),
      write(app, '/api/map/contribution', { countryCode: 'SE' }, cookie),
    ]);
    assert.deepEqual(results.map(result => result.statusCode), [200, 200]);
    const state = await app.inject({ url: '/api/map/state', headers: { cookie } });
    assert.equal(state.json().total, 1);
    assert.ok(['US', 'SE'].includes(state.json().yourCountry));
    assert.deepEqual(state.json().countries, [{ code: state.json().yourCountry, count: 1 }]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Visitors Map enforces its bounded private table and its aggregate contains no per-person rows', () => {
  const { root, path } = temporaryPath('open-web-map-storage-');
  const db = openDb(path);
  try {
    assert.equal(setMapContribution(db, 'f'.repeat(64), 'US', 10).ok, true);
    assert.equal(setMapContribution(db, 'f'.repeat(64), null, 11).ok, true);
    assert.equal(removeMapContribution(db, 'f'.repeat(64)), false);
    assert.equal(db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?)')
      .run('a'.repeat(64), 'SE', 12).changes, 1);
    assert.throws(() => db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?)')
      .run('b'.repeat(64), 'ZZ', 13));
    const state = readMapState(db, null);
    assert.deepEqual(state, { countries: [{ code: 'SE', count: 1 }], total: 1, yourCountry: null });
    assert.equal(JSON.stringify(state).includes('visitor_digest'), false);
    assert.equal(MAP_CONTRIBUTION_CAP, 100_000);

    const insert = db.prepare('INSERT INTO map_contributions(visitor_digest, country_code, updated_at) VALUES (?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 1; index < MAP_CONTRIBUTION_CAP; index++) {
        insert.run(index.toString(16).padStart(64, '0'), index % 2 ? 'US' : 'SE', 13);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM map_contributions').get() as { count: number }).count, MAP_CONTRIBUTION_CAP);
    assert.deepEqual(setMapContribution(db, 'f'.repeat(64), 'CA', 14), { ok: false, reason: 'full' });
    assert.deepEqual(setMapContribution(db, 'a'.repeat(64), 'GB', 15), { ok: true, removed: false }, 'existing browser marks can change at capacity');
    assert.equal(removeMapContribution(db, 'a'.repeat(64)), true);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM map_contributions').get() as { count: number }).count, MAP_CONTRIBUTION_CAP - 1);

    const source = readFileSync(new URL('../apps/web/src/spaces/map/client.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /navigator\.geolocation|ip-api|geoip|timezone/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
