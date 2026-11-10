import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { activeSpaces, spaces, validateSpaceRegistry, type SpaceDefinition } from '../../../packages/shared/spaces.js';
import { wallSpace } from './spaces/wall/index.js';
import type { SpaceContext, SpaceModule } from './spaces/types.js';
import type { AppOptions } from './config.js';
import { PLACEMENT_COOLDOWN_MS } from './config.js';
import { openDb } from './db.js';
import { createAnonymousIdentity } from './services/anonymous-identity.js';
import { RateLimitService } from './services/rate-limits.js';
import { writesBlocked } from './services/write-gate.js';
import { SpaceChannels } from './realtime/channels.js';

const defaultModules: readonly SpaceModule[] = [wallSpace];
const COMPATIBILITY_ROUTE_OWNER = new Map([['GET /api/session', 'wall']]);

export interface SpaceRegistrationOptions {
  readonly registry?: readonly SpaceDefinition[];
  readonly modules?: readonly SpaceModule[];
}

function validateModules(registry: readonly SpaceDefinition[], modules: readonly SpaceModule[]): Map<string, SpaceModule> {
  const active = new Map(activeSpaces(registry).map(space => [space.id, space]));
  const byId = new Map<string, SpaceModule>();

  for (const module of modules) {
    const space = active.get(module.id);
    if (!space) throw new Error(`Server module has no active registry entry: ${module.id}`);
    if (byId.has(module.id)) throw new Error(`Duplicate server module: ${module.id}`);
    byId.set(module.id, module);

    for (const route of module.compatibilityRoutes ?? []) {
      if (COMPATIBILITY_ROUTE_OWNER.get(`${route.method} ${route.path}`) !== module.id) {
        throw new Error(`Space ${module.id} cannot claim compatibility route ${route.method} ${route.path}`);
      }
    }
  }

  for (const id of active.keys()) {
    if (!byId.has(id)) throw new Error(`Active space has no server module: ${id}`);
  }
  return byId;
}

function routeMethods(method: string | readonly string[]): readonly string[] {
  return Array.isArray(method) ? method : [method as string];
}

function assertModuleRoute(module: SpaceModule, path: string, method: string | readonly string[]): void {
  const namespace = `/api/${module.id}`;
  const inNamespace = path === namespace || path.startsWith(`${namespace}/`);
  if (inNamespace) return;

  const methods = routeMethods(method);
  const allowed = (module.compatibilityRoutes ?? []).some(route =>
    route.path === path && (methods.includes(route.method) || (route.method === 'GET' && methods.includes('HEAD'))),
  );
  if (!allowed) throw new Error(`Space ${module.id} attempted to register an unowned route: ${methods.join(',')} ${path}`);
}

export async function createApp(opts: AppOptions, registration: SpaceRegistrationOptions = {}) {
  if (opts.cooldown !== PLACEMENT_COOLDOWN_MS) {
    throw new Error(`cooldown is fixed at ${PLACEMENT_COOLDOWN_MS} ms`);
  }

  const registry = registration.registry ?? spaces;
  validateSpaceRegistry(registry);
  const modules = registration.modules ?? defaultModules;
  const modulesById = validateModules(registry, modules);
  const registeredSpaces = activeSpaces(registry);
  const allowedOrigins = new Set([opts.origin]);
  if (!opts.secure && opts.origin === 'http://localhost:4321') allowedOrigins.add('http://127.0.0.1:4321');

  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024,
    trustProxy: '127.0.0.1',
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });

  const db = openDb(opts.dbPath);
  const identity = createAnonymousIdentity(opts.secure);
  const channels = new SpaceChannels(registeredSpaces.map(space => space.id));
  const rateLimits = new RateLimitService();
  const requestLimit = rateLimits.fixedWindow({ limit: 600, windowMs: 60_000, maxEntries: 10_000 });
  const writeLimit = rateLimits.fixedWindow({ limit: 180, windowMs: 60_000, maxEntries: 10_000 });
  const connectionCounts = new Map<string, number>();
  const heartbeat: { timer?: NodeJS.Timeout } = {};
  let databaseOpen = true;
  let maintenanceRunning = false;

  const closeDatabase = (): void => {
    if (!databaseOpen) return;
    databaseOpen = false;
    db.close();
  };

  app.addHook('onRequest', async (request, reply) => {
    identity.capture(request);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    const now = Date.now();
    if (!requestLimit.take(request.ip, now).allowed) return reply.code(429).send({ error: 'rate limited' });
    if ((request.method === 'POST' || request.url === '/api/session') && !writeLimit.take(request.ip, now).allowed) {
      return reply.code(429).send({ error: 'rate limited' });
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !allowedOrigins.has(request.headers.origin ?? '')) {
      return reply.code(403).send({ error: 'origin' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (!opts.writes || writesBlocked(opts.writeGatePath))) {
      return reply.code(503).send({ error: 'writes disabled' });
    }
  });

  let healthCheckedAt = Number.NEGATIVE_INFINITY;
  let integrityHealthy = false;
  app.get('/api/health', async (_request, reply) => {
    try {
      if (!db.prepare('SELECT version FROM migrations ORDER BY version DESC LIMIT 1').get()) throw new Error('missing migration');
    } catch {
      return reply.code(503).send({ ok: false });
    }

    const now = performance.now();
    if (now - healthCheckedAt >= 30_000) {
      healthCheckedAt = now;
      try {
        const check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string } | undefined;
        integrityHealthy = check?.quick_check === 'ok';
      } catch {
        integrityHealthy = false;
      }
    }
    return integrityHealthy ? { ok: true } : reply.code(503).send({ ok: false });
  });

  app.get('/api/events', { websocket: true }, (socket, request) => {
    socket.on('error', () => {});
    const { space } = request.query as { space?: unknown };
    if (
      typeof space !== 'string' ||
      !modulesById.has(space) ||
      !allowedOrigins.has(request.headers.origin ?? '') ||
      channels.size >= 500 ||
      (connectionCounts.get(request.ip) ?? 0) >= 10 ||
      !channels.add(socket, space)
    ) {
      socket.close(1008);
      return;
    }

    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    socket.on('pong', () => { (socket as WebSocket & { isAlive?: boolean }).isAlive = true; });
    connectionCounts.set(request.ip, (connectionCounts.get(request.ip) ?? 0) + 1);
    socket.on('message', () => socket.close(1008));
    socket.on('close', () => {
      channels.delete(socket);
      const count = (connectionCounts.get(request.ip) ?? 1) - 1;
      if (count) connectionCounts.set(request.ip, count);
      else connectionCounts.delete(request.ip);
    });
  });

  const configuredContexts = new Map<string, SpaceContext>();
  app.addHook('onClose', async () => {
    if (heartbeat.timer) clearInterval(heartbeat.timer);
    for (const socket of channels.sockets()) socket.terminate();
    closeDatabase();
  });

  try {
    for (const space of registeredSpaces) {
      const module = modulesById.get(space.id)!;
      const context: SpaceContext = {
        space,
        db,
        config: { origin: opts.origin, secure: opts.secure },
        identity,
        realtime: channels.forSpace(space.id),
        rateLimits: rateLimits.forSpace(),
      };
      configuredContexts.set(space.id, context);

      await app.register(async scopedApp => {
        scopedApp.addHook('onRoute', route => assertModuleRoute(module, route.url, route.method));
        await module.register(scopedApp, context);
      });
    }
    await app.ready();
  } catch (error) {
    try { await app.close(); } catch { closeDatabase(); }
    throw error;
  }

  const timer = setInterval(() => {
    const now = Date.now();
    rateLimits.prune(performance.now(), now);
    if (!maintenanceRunning) {
      maintenanceRunning = true;
      void Promise.all(modules.map(async module => {
        const context = configuredContexts.get(module.id)!;
        try {
          await module.maintenance?.(context, now);
        } catch (error) {
          app.log.error({ err: error, space: module.id }, 'Space maintenance failed');
        }
      })).finally(() => { maintenanceRunning = false; });
    }

    for (const socket of channels.sockets()) {
      const alive = socket as WebSocket & { isAlive?: boolean };
      if (alive.isAlive === false) {
        socket.terminate();
        channels.delete(socket);
        continue;
      }
      if (socket.readyState !== 1) {
        channels.delete(socket);
        continue;
      }
      alive.isAlive = false;
      try { socket.ping(); } catch {
        socket.terminate();
        channels.delete(socket);
      }
    }
  }, 30_000);
  heartbeat.timer = timer;
  timer.unref();

  return app;
}
