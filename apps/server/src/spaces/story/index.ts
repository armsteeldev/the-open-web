import type { SpaceModule } from '../types.js';
import { appendStoryContribution, cleanupStoryState, readStoryState } from './database.js';
import { validateChapterNumber, validateStorySubmission } from './validation.js';

export const storySpace: SpaceModule = {
  id: 'story',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });
    const writeBudget = context.rateLimits.tokenBucket({ capacity: 12, refillMs: 5_000, maxEntries: 10_000 });

    app.get('/api/story/state', async (request, reply) => {
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readStoryState(context.db);
    });

    app.get('/api/story/chapters/:number', async (request, reply) => {
      const params = request.params as { number?: unknown };
      const chapterNo = validateChapterNumber(params.number);
      if (chapterNo === false || chapterNo === null) return reply.code(400).send({ error: 'invalid chapter' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const state = readStoryState(context.db, chapterNo);
      if (!state.chapter) return reply.code(404).send({ error: 'chapter not found' });
      reply.header('Cache-Control', 'no-store');
      return state;
    });

    app.post('/api/story/contributions', async (request, reply) => {
      const validated = validateStorySubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });
      const visitor = context.identity.ensure(request, reply);
      const wait = writeBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const result = appendStoryContribution(context.db, visitor, validated.value);
      if (!result.ok) {
        writeBudget.refund(request.ip);
        if (result.reason === 'stale') return reply.code(409).send({ error: 'story changed', state: result.state });
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
        if (result.reason === 'full') return reply.code(409).send({ error: 'story complete' });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      if (result.duplicate) writeBudget.refund(request.ip);
      return { ok: true, duplicate: result.duplicate, contribution: result.contribution, state: result.state };
    });
  },
  maintenance(context, now) {
    cleanupStoryState(context.db, now);
  },
};
