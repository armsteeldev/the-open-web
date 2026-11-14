import type { SpaceModule } from '../types.js';
import {
  bottleCount,
  cleanupBottleState,
  findRandomBottle,
  releaseBottle,
} from './database.js';
import { validateBottleExclusions, validateBottleSubmission } from './validation.js';

export const bottleSpace: SpaceModule = {
  id: 'bottle',
  register(app, context) {
    const releaseNetworkBudget = context.rateLimits.tokenBucket({ capacity: 20, refillMs: 3_000, maxEntries: 10_000 });
    const globalReleaseBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 1 });
    const discoveryBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });

    app.get('/api/bottle/random', async (request, reply) => {
      const query = request.query as { seen?: unknown };
      const exclusions = validateBottleExclusions(query.seen);
      if (!exclusions.ok) return reply.code(400).send({ error: 'invalid input' });

      const wait = discoveryBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      const bottle = findRandomBottle(context.db, exclusions.ids);
      return { bottle, exhausted: bottle === null && bottleCount(context.db) > 0 };
    });

    app.post('/api/bottle/messages', async (request, reply) => {
      const validated = validateBottleSubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });

      const visitor = context.identity.ensure(request, reply);
      const globalWait = globalReleaseBudget.take('global', performance.now());
      if (globalWait) return reply.code(429).send({ error: 'busy', retryAfterMs: globalWait });
      const networkWait = releaseNetworkBudget.take(request.ip, performance.now());
      if (networkWait) {
        globalReleaseBudget.refund('global');
        return reply.code(429).send({ error: 'network limit', retryAfterMs: networkWait });
      }

      let result: ReturnType<typeof releaseBottle>;
      try {
        result = releaseBottle(context.db, visitor, validated.value);
      } catch (error) {
        globalReleaseBudget.refund('global');
        releaseNetworkBudget.refund(request.ip);
        throw error;
      }
      if (!result.ok) {
        globalReleaseBudget.refund('global');
        releaseNetworkBudget.refund(request.ip);
        return reply.code(429).send({ error: result.reason, retryAfterMs: result.retryAfterMs });
      }
      if (result.duplicate) {
        globalReleaseBudget.refund('global');
        releaseNetworkBudget.refund(request.ip);
      }
      return { ok: true, duplicate: result.duplicate, bottle: result.bottle, cooldownMs: result.cooldownMs };
    });
  },
  maintenance(context, now) {
    cleanupBottleState(context.db, now);
  },
};
