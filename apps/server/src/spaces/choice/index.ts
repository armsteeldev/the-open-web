import type { SpaceModule } from '../types.js';
import { cleanupChoiceState, getChoiceState, proposeChoice, readChoiceArchive, voteChoice } from './database.js';
import { validateChoiceProposal, validateChoiceVote, validateDecisionCursor, validateDecisionId } from './validation.js';

export const choiceSpace: SpaceModule = {
  id: 'choice',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });
    const proposalBudget = context.rateLimits.fixedWindow({ limit: 10, windowMs: 60 * 60 * 1000, maxEntries: 10_000 });
    const voteNetworkBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });
    const voteVisitorBudget = context.rateLimits.fixedWindow({ limit: 60, windowMs: 60 * 60 * 1000, maxEntries: 50_000 });

    app.get('/api/choice/state', async (request, reply) => {
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return getChoiceState(context.db, context.identity.existing(request));
    });

    app.get('/api/choice/archive', async (request, reply) => {
      const query = request.query as { before?: unknown };
      const before = validateDecisionCursor(query.before);
      if (before === false) return reply.code(400).send({ error: 'invalid cursor' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readChoiceArchive(context.db, before);
    });

    app.post('/api/choice/proposals', async (request, reply) => {
      const validated = validateChoiceProposal(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });
      const visitor = context.identity.ensure(request, reply);
      const limit = proposalBudget.take(request.ip, Date.now());
      if (!limit.allowed) return reply.code(429).send({ error: 'network limit', retryAfterMs: limit.retryAfterMs });
      const result = proposeChoice(context.db, visitor, validated.value);
      if (!result.ok) {
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
        if (result.reason === 'queue-full') return reply.code(409).send({ error: 'queue full' });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      return { ok: true, duplicate: result.duplicate, decision: result.decision, queuedCount: result.queuedCount };
    });

    app.post('/api/choice/decisions/:id/vote', async (request, reply) => {
      const params = request.params as { id?: unknown };
      const decisionId = validateDecisionId(params.id);
      if (!decisionId) return reply.code(400).send({ error: 'invalid decision' });
      const validated = validateChoiceVote(request.body);
      if (!validated.ok) return reply.code(400).send({ error: 'invalid input' });
      const visitor = context.identity.ensure(request, reply);
      const networkWait = voteNetworkBudget.take(request.ip, performance.now());
      if (networkWait) return reply.code(429).send({ error: 'network limit', retryAfterMs: networkWait });
      const visitorLimit = voteVisitorBudget.take(visitor, Date.now());
      if (!visitorLimit.allowed) {
        voteNetworkBudget.refund(request.ip);
        return reply.code(429).send({ error: 'visitor limit', retryAfterMs: visitorLimit.retryAfterMs });
      }
      const result = voteChoice(context.db, visitor, decisionId, validated.requestId, validated.choice);
      if (!result.ok) {
        voteNetworkBudget.refund(request.ip);
        if (result.reason === 'not-found') return reply.code(404).send({ error: 'decision not found' });
        if (result.reason === 'closed') return reply.code(409).send({ error: 'decision closed' });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      if (result.duplicate) {
        voteNetworkBudget.refund(request.ip);
      }
      return { ok: true, duplicate: result.duplicate, decision: result.decision };
    });
  },
  maintenance(context, now) {
    cleanupChoiceState(context.db, now);
  },
};
