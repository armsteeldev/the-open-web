import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { activeSpaces, spaces, spaceIsCurrentPath, validateSpaceRegistry, type SpaceDefinition } from '../packages/shared/spaces.js';
import { createApp } from '../apps/server/src/app.js';
import { wallSpace } from '../apps/server/src/spaces/wall/index.js';
import { chatSpace } from '../apps/server/src/spaces/chat/index.js';
import { bottleSpace } from '../apps/server/src/spaces/bottle/index.js';
import type { SpaceModule } from '../apps/server/src/spaces/types.js';

const origin = 'http://localhost:4321';
const options = (dbPath: string, writes = true) => ({ dbPath, origin, cooldown: 10_000, writes, secure: false });

test('registry entries are unique, valid and point to real active frontend routes', () => {
  validateSpaceRegistry();
  assert.deepEqual(activeSpaces().map(space => space.id), ['wall', 'chat', 'bottle']);

  for (const space of activeSpaces()) {
    const route = space.path.slice(1);
    assert.ok(
      existsSync(resolve('apps/web/src/pages', `${route}.astro`)) ||
      existsSync(resolve('apps/web/src/pages', route, 'index.astro')),
      `active navigation route is missing: ${space.path}`,
    );
    assert.ok(spaceIsCurrentPath(`${space.path}/`, space.path));
    assert.equal(spaceIsCurrentPath(`${space.path}-other`, space.path), false);
  }

  assert.throws(() => validateSpaceRegistry([
    { id: 'wall', label: 'One', path: '/one', status: 'active' },
    { id: 'wall', label: 'Two', path: '/two', status: 'active' },
  ]), /Duplicate space id/);
  assert.throws(() => validateSpaceRegistry([
    { id: 'one', label: 'One', path: '/same', status: 'active' },
    { id: 'two', label: 'Two', path: '/same', status: 'inactive' },
  ]), /Duplicate space route/);
  assert.throws(() => validateSpaceRegistry([{ id: 'Bad ID', label: 'Bad', path: '/bad', status: 'active' }]), /Invalid space id/);
  assert.throws(() => validateSpaceRegistry([{ id: 'bad', label: 'Bad', path: '/bad/', status: 'active' }]), /Invalid route path/);
  assert.throws(() => validateSpaceRegistry([{ id: 'empty', label: ' ', path: '/empty', status: 'active' }]), /display name/);
});

test('space modules receive shared identity and middleware with namespace-bound routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-space-module-'));
  const fixtureSpace = { id: 'module-fixture', label: 'Test fixture', path: '/module-fixture', status: 'active' } as const satisfies SpaceDefinition;
  const fixtureModule: SpaceModule = {
    id: fixtureSpace.id,
    register(app, context) {
      app.get('/api/module-fixture/identity', request => ({
        visitor: context.identity.existing(request),
        cookieHeader: request.headers.cookie,
        cookieValue: request.cookies.ow_id,
      }));
      app.get('/api/module-fixture/clear', (_request, reply) => {
        context.identity.clear(reply);
        return { ok: true };
      });
      app.post('/api/module-fixture/write', () => ({ ok: true }));
    },
  };
  const coreModules = [wallSpace, chatSpace, bottleSpace];
  const app = await createApp(options(join(root, 'db'), false), {
    registry: [...spaces, fixtureSpace],
    modules: [...coreModules, fixtureModule],
  });

  try {
    const session = await app.inject({ url: '/api/session' });
    const setCookie = session.headers['set-cookie'] as string;
    const cookie = setCookie.split(';', 1)[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Max-Age=31536000/i);
    const identity = await app.inject({ url: '/api/module-fixture/identity', headers: { cookie } });
    const expectedDigest = createHash('sha256').update(cookie.slice('ow_id='.length)).digest('hex');
    assert.equal(identity.statusCode, 200);
    assert.equal(identity.json().visitor, expectedDigest);
    assert.notEqual(identity.json().visitor, cookie.slice('ow_id='.length));
    assert.equal(identity.json().cookieHeader, undefined);
    assert.equal(identity.json().cookieValue, undefined);

    const crossOrigin = await app.inject({
      method: 'POST', url: '/api/module-fixture/write', headers: { origin: 'https://attacker.example' }, payload: {},
    });
    assert.equal(crossOrigin.statusCode, 403);
    const gated = await app.inject({
      method: 'POST', url: '/api/module-fixture/write', headers: { origin }, payload: {},
    });
    assert.equal(gated.statusCode, 503);

    const clear = await app.inject({ url: '/api/module-fixture/clear' });
    assert.equal(clear.statusCode, 200);
    assert.match(clear.headers['set-cookie'] as string, /Max-Age=0/i);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown, duplicate and cross-namespace server modules fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-space-registration-'));
  const emptyModule = (id: string): SpaceModule => ({ id, register() {} });
  try {
    await assert.rejects(
      createApp(options(join(root, 'unknown.sqlite')), { modules: [wallSpace, chatSpace, bottleSpace, emptyModule('unknown')] }),
      /no active registry entry/,
    );
    const inactiveSpace = { id: 'inactive', label: 'Inactive fixture', path: '/inactive', status: 'inactive' } as const satisfies SpaceDefinition;
    await assert.rejects(
      createApp(options(join(root, 'inactive.sqlite')), {
        registry: [...spaces, inactiveSpace],
        modules: [wallSpace, chatSpace, bottleSpace, emptyModule('inactive')],
      }),
      /no active registry entry/,
    );
    const activeFixture = { id: 'active-fixture', label: 'Active fixture', path: '/active-fixture', status: 'active' } as const satisfies SpaceDefinition;
    await assert.rejects(
      createApp(options(join(root, 'missing.sqlite')), { registry: [...spaces, activeFixture], modules: [wallSpace, chatSpace, bottleSpace] }),
      /Active space has no server module/,
    );
    await assert.rejects(
      createApp(options(join(root, 'duplicate.sqlite')), { modules: [wallSpace, wallSpace] }),
      /Duplicate server module/,
    );

    const rogueWall: SpaceModule = {
      id: 'wall',
      register(app) { app.get('/api/module-fixture/escaped', () => ({ ok: true })); },
    };
    await assert.rejects(
      createApp(options(join(root, 'escaped.sqlite')), { modules: [rogueWall, chatSpace, bottleSpace] }),
      /attempted to register an unowned route/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shared emergency write gate blocks mutations in every registered module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-web-space-gate-'));
  const gateDirectory = join(root, 'gate');
  mkdirSync(gateDirectory);
  const gatePath = join(gateDirectory, 'stop-writes');
  writeFileSync(gatePath, '');
  const fixtureSpace = { id: 'module-fixture', label: 'Test fixture', path: '/module-fixture', status: 'active' } as const satisfies SpaceDefinition;
  const fixtureModule: SpaceModule = {
    id: fixtureSpace.id,
    register(app) { app.post('/api/module-fixture/write', () => ({ ok: true })); },
  };
  const app = await createApp({ ...options(join(root, 'db')), writeGatePath: gatePath }, {
    registry: [...spaces, fixtureSpace],
    modules: [wallSpace, chatSpace, bottleSpace, fixtureModule],
  });
  try {
    const read = await app.inject({ url: '/api/module-fixture/health' });
    assert.equal(read.statusCode, 404);
    const mutation = await app.inject({ method: 'POST', url: '/api/module-fixture/write', headers: { origin }, payload: {} });
    assert.equal(mutation.statusCode, 503);
    assert.deepEqual(mutation.json(), { error: 'writes disabled' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
