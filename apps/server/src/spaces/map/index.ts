import { isIso3166Alpha2 } from '../../../../../packages/shared/countries.js';
import type { SpaceModule } from '../types.js';
import { readMapState, setMapContribution, type CountryCode } from './database.js';

export const mapSpace: SpaceModule = {
  id: 'map',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 40, refillMs: 1_000, maxEntries: 10_000 });
    const writeBudget = context.rateLimits.fixedWindow({ limit: 10, windowMs: 60 * 60 * 1000, maxEntries: 10_000 });

    app.get('/api/map/state', async (request, reply) => {
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readMapState(context.db, context.identity.existing(request));
    });

    app.post('/api/map/contribution', async (request, reply) => {
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
        return reply.code(400).send({ error: 'invalid country' });
      }
      const body = request.body as Record<string, unknown>;
      if (Object.keys(body).length !== 1 || !('countryCode' in body)) return reply.code(400).send({ error: 'invalid country' });
      const countryCode = body.countryCode;
      if (countryCode !== null && !isIso3166Alpha2(countryCode)) return reply.code(400).send({ error: 'invalid country' });

      const visitor = countryCode === null
        ? context.identity.existing(request)
        : context.identity.ensure(request, reply);
      if (!visitor) return reply.code(404).send({ error: 'no contribution for this browser' });
      const limit = writeBudget.take(request.ip, Date.now());
      if (!limit.allowed) return reply.code(429).send({ error: 'network limit', retryAfterMs: limit.retryAfterMs });
      const result = setMapContribution(context.db, visitor, countryCode as CountryCode | null);
      if (!result.ok) {
        return reply.code(409).send({ error: result.reason === 'full' ? 'map at capacity' : 'no contribution for this browser' });
      }
      return { ok: true, removed: result.removed };
    });
  },
};
