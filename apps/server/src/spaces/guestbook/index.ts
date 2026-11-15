import type { SpaceModule } from '../types.js';
import { cleanupGuestbookState, createGuestbookEntry, readGuestbook } from './database.js';
import { validateGuestbookCursor, validateGuestbookSubmission } from './validation.js';

export const guestbookSpace: SpaceModule = {
  id: 'guestbook',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });
    const writeBudget = context.rateLimits.tokenBucket({ capacity: 8, refillMs: 15_000, maxEntries: 10_000 });

    app.get('/api/guestbook/entries', async (request, reply) => {
      const query = request.query as { before?: unknown };
      const before = validateGuestbookCursor(query.before);
      if (before === false) return reply.code(400).send({ error: 'invalid cursor' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readGuestbook(context.db, before);
    });

    app.post('/api/guestbook/entries', async (request, reply) => {
      const validated = validateGuestbookSubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });
      const visitor = context.identity.ensure(request, reply);
      const wait = writeBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const result = createGuestbookEntry(context.db, visitor, validated.value);
      if (!result.ok) {
        writeBudget.refund(request.ip);
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      if (result.duplicate) writeBudget.refund(request.ip);
      return { ok: true, duplicate: result.duplicate, entry: result.entry, cooldownMs: 30_000 };
    });
  },
  maintenance(context, now) {
    cleanupGuestbookState(context.db, now);
  },
};
