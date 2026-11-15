import type { SpaceModule } from '../types.js';
import { cleanupDrawings, readDrawing, readDrawings, submitDrawing, DRAWING_PAGE_SIZE } from './database.js';
import { validateDrawing, validateDrawingCursor, validateDrawingId } from './validation.js';

const DRAWING_REQUEST_BYTES = 24 * 1024;

export const drawSpace: SpaceModule = {
  id: 'draw',
  register(app, context) {
    const readBudget = context.rateLimits.tokenBucket({ capacity: 40, refillMs: 1_000, maxEntries: 10_000 });
    const submitBudget = context.rateLimits.fixedWindow({ limit: 8, windowMs: 60 * 60 * 1000, maxEntries: 10_000 });

    app.get('/api/draw/drawings', async (request, reply) => {
      const query = request.query as { before?: unknown };
      const before = validateDrawingCursor(query.before);
      if (before === false) return reply.code(400).send({ error: 'invalid cursor' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      reply.header('Cache-Control', 'no-store');
      const page = readDrawings(context.db, before);
      return { ...page, pageSize: DRAWING_PAGE_SIZE };
    });

    app.get('/api/draw/drawings/:id', async (request, reply) => {
      const params = request.params as { id?: unknown };
      const id = validateDrawingId(params.id);
      if (id === null) return reply.code(400).send({ error: 'invalid drawing' });
      const wait = readBudget.take(request.ip, performance.now());
      if (wait) return reply.code(429).send({ error: 'network limit', retryAfterMs: wait });
      const drawing = readDrawing(context.db, id);
      if (!drawing) return reply.code(404).send({ error: 'drawing not found' });
      reply.header('Cache-Control', 'no-store');
      return { drawing };
    });

    app.post('/api/draw/drawings', { bodyLimit: DRAWING_REQUEST_BYTES }, async (request, reply) => {
      const validated = validateDrawing(request.body);
      if (!validated.ok) return reply.code(400).send({ error: 'invalid drawing' });
      const visitor = context.identity.ensure(request, reply);
      const limit = submitBudget.take(request.ip, Date.now());
      if (!limit.allowed) return reply.code(429).send({ error: 'network limit', retryAfterMs: limit.retryAfterMs });
      const result = submitDrawing(context.db, visitor, validated.value);
      if (!result.ok) return reply.code(429).send({ error: 'cooldown', retryAfterMs: result.retryAfterMs });
      return reply.code(201).send({ ok: true, drawing: result.drawing });
    });
  },
  maintenance(context, now) {
    cleanupDrawings(context.db, now);
  },
};
