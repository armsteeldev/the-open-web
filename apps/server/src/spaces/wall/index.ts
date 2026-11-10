import type { SpaceModule } from '../types.js';
import { PLACEMENT_COOLDOWN_MS } from '../../config.js';
import { validPixel, TILE } from '../../../../../packages/shared/wall.js';
import { cleanupCooldowns, place, validTile } from './database.js';

export const wallSpace: SpaceModule = {
  id: 'wall',
  compatibilityRoutes: [{ method: 'GET', path: '/api/session' }],
  register(app, context) {
    const networkBudget = context.rateLimits.tokenBucket({
      capacity: 12,
      refillMs: 1_000,
      maxEntries: 10_000,
    });

    // Kept at its original path and response shape for The Wall's current client.
    app.get('/api/session', async (request, reply) => {
      const visitor = context.identity.ensure(request, reply);
      const row = context.db.prepare('SELECT placed_at FROM visitor_cooldowns WHERE visitor=?').get(visitor) as { placed_at: number } | undefined;
      const retryAt = row ? row.placed_at + PLACEMENT_COOLDOWN_MS : 0;
      reply.header('Cache-Control', 'no-store');
      return { retryAt, retryAfterMs: Math.max(0, retryAt - Date.now()) };
    });

    app.get('/api/wall/tile/:x/:y', async (request, reply) => {
      const { x, y } = request.params as { x: string; y: string };
      if (!/^(?:[0-9]|1[0-9])$/.test(x) || !/^(?:[0-9]|1[0-9])$/.test(y)) return reply.code(400).send();
      const row = context.db.prepare('SELECT pixels FROM wall_tiles WHERE x=? AND y=?').get(Number(x), Number(y)) as { pixels: Uint8Array } | undefined;
      if (row && !validTile(row.pixels)) {
        request.log.error('Invalid wall tile data');
        return reply.code(500).send({ error: 'tile unavailable' });
      }
      return reply
        .header('Cache-Control', 'no-store')
        .type('application/octet-stream')
        .send(Buffer.from(row?.pixels ?? new Uint8Array(TILE * TILE)));
    });

    app.post('/api/wall/pixel', async (request, reply) => {
      const visitor = context.identity.existing(request);
      if (!visitor) return reply.code(401).send({ error: 'session required' });

      const pixel = request.body as { x?: unknown; y?: unknown; color?: unknown } | null;
      if (!pixel || !validPixel(pixel.x, pixel.y, pixel.color)) {
        return reply.code(400).send({ error: 'invalid pixel' });
      }
      const x = pixel.x as number;
      const y = pixel.y as number;
      const color = pixel.color as number;

      const networkWait = networkBudget.take(request.ip, performance.now());
      if (networkWait) {
        const retryAt = Date.now() + networkWait;
        return reply.code(429).send({ ok: false, retryAt, retryAfterMs: networkWait });
      }

      let result: ReturnType<typeof place>;
      try {
        result = place(context.db, visitor, x, y, color, Date.now(), PLACEMENT_COOLDOWN_MS);
      } catch (error) {
        networkBudget.refund(request.ip);
        throw error;
      }

      if (!result.ok) {
        networkBudget.refund(request.ip);
        return reply.code(429).send({ ...result, retryAfterMs: Math.max(0, result.retryAt - Date.now()) });
      }

      context.realtime.publish('pixel', { x, y, color });
      return { ...result, retryAfterMs: Math.max(0, result.retryAt - Date.now()) };
    });

    return undefined;
  },
  maintenance(context, now) {
    cleanupCooldowns(context.db, now, PLACEMENT_COOLDOWN_MS);
  },
};
