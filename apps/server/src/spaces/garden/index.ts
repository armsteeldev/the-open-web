import type { SpaceModule } from '../types.js';
import { cleanupGarden, plantAt, readGarden, GARDEN_PLANT_COOLDOWN_MS } from './database.js';
import { validatePlanting } from './validation.js';

export const gardenSpace: SpaceModule = {
  id: 'garden',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 40, refillMs: 1_000, maxEntries: 10_000 });
    const plantBudget = context.rateLimits.tokenBucket({ capacity: 5, refillMs: 60_000, maxEntries: 10_000 });

    app.get('/api/garden/state', async (request, reply) => {
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readGarden(context.db);
    });

    app.post('/api/garden/plants', async (request, reply) => {
      const planting = validatePlanting(request.body);
      if (!planting) return reply.code(400).send({ error: 'invalid planting' });
      const visitor = context.identity.ensure(request, reply);
      const wait = plantBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const result = plantAt(context.db, visitor, planting);
      if (!result.ok) {
        plantBudget.refund(request.ip);
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs, cooldownMs: GARDEN_PLANT_COOLDOWN_MS });
        if (result.reason === 'occupied') return reply.code(409).send({ error: 'plot occupied' });
        return reply.code(409).send({ error: 'garden full' });
      }
      return reply.code(201).send({ ok: true, plant: result.plant });
    });
  },
  maintenance(context, now) {
    cleanupGarden(context.db, now);
  },
};
