import type { SpaceModule } from '../types.js';
import { createOrEditAnswer, createQuestion, readQuestion, readQuestionList, cleanupQuestionsState } from './database.js';
import { validateAnswerSubmission, validateQuestionCursor, validateQuestionId, validateQuestionSubmission } from './validation.js';

export const questionsSpace: SpaceModule = {
  id: 'questions',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 60, refillMs: 1_000, maxEntries: 10_000 });
    const questionBudget = context.rateLimits.tokenBucket({ capacity: 5, refillMs: 12 * 60 * 60 * 1000, maxEntries: 10_000 });
    const answerBudget = context.rateLimits.tokenBucket({ capacity: 20, refillMs: 5_000, maxEntries: 10_000 });

    app.get('/api/questions', async (request, reply) => {
      const query = request.query as { before?: unknown };
      const before = validateQuestionCursor(query.before);
      if (before === false) return reply.code(400).send({ error: 'invalid cursor' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      return readQuestionList(context.db, before);
    });

    app.get('/api/questions/:id', async (request, reply) => {
      const params = request.params as { id?: unknown };
      const id = validateQuestionId(params.id);
      if (!id) return reply.code(400).send({ error: 'invalid question' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const visitor = context.identity.existing(request);
      const detail = readQuestion(context.db, id, visitor);
      if (!detail) return reply.code(404).send({ error: 'question not found' });
      reply.header('Cache-Control', 'no-store');
      return detail;
    });

    app.post('/api/questions', async (request, reply) => {
      const validated = validateQuestionSubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });
      const visitor = context.identity.ensure(request, reply);
      const wait = questionBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const result = createQuestion(context.db, visitor, validated.value);
      if (!result.ok) {
        questionBudget.refund(request.ip);
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      if (result.duplicate) questionBudget.refund(request.ip);
      return { ok: true, duplicate: result.duplicate, question: result.question };
    });

    app.post('/api/questions/:id/answers', async (request, reply) => {
      const params = request.params as { id?: unknown };
      const id = validateQuestionId(params.id);
      if (!id) return reply.code(400).send({ error: 'invalid question' });
      const validated = validateAnswerSubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });
      const visitor = context.identity.ensure(request, reply);
      const wait = answerBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const result = createOrEditAnswer(context.db, visitor, id, validated.value);
      if (!result.ok) {
        answerBudget.refund(request.ip);
        if (result.reason === 'not-found') return reply.code(404).send({ error: 'question not found' });
        if (result.reason === 'cooldown') return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
        if (result.reason === 'idempotency-conflict') return reply.code(409).send({ error: 'request key reused' });
        return reply.code(503).send({ error: 'space busy' });
      }
      if (result.duplicate) answerBudget.refund(request.ip);
      return { ok: true, duplicate: result.duplicate, answer: result.answer };
    });
  },
  maintenance(context, now) {
    cleanupQuestionsState(context.db, now);
  },
};
