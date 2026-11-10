import type { DatabaseSync } from 'node:sqlite';
import type { SpaceModule } from '../types.js';
import {
  cleanupChat,
  latestRemovalId,
  publishPendingRemovals,
  readRecentMessages,
  submitChatMessage,
} from './database.js';
import { validateChatSubmission } from './validation.js';

const removalCursors = new WeakMap<DatabaseSync, number>();

export const chatSpace: SpaceModule = {
  id: 'chat',
  register(app, context) {
    const visitorNetworkBudget = context.rateLimits.tokenBucket({ capacity: 20, refillMs: 3_000, maxEntries: 10_000 });
    const globalMessageBudget = context.rateLimits.tokenBucket({ capacity: 120, refillMs: 200, maxEntries: 1 });

    removalCursors.set(context.db, latestRemovalId(context.db));

    app.get('/api/chat/history', async (request, reply) => {
      // History loads the common cookie session without creating any per-visitor database record.
      context.identity.ensure(request, reply);
      reply.header('Cache-Control', 'no-store');
      const snapshot = readRecentMessages(context.db);
      return { ...snapshot, oldestId: snapshot.messages[0]?.id ?? null };
    });

    app.post('/api/chat/messages', async (request, reply) => {
      const visitor = context.identity.existing(request);
      if (!visitor) return reply.code(401).send({ error: 'session required' });

      const validated = validateChatSubmission(request.body);
      if (!validated.ok) return reply.code(400).send({ error: validated.error });

      const globalWait = globalMessageBudget.take('global', performance.now());
      if (globalWait) return reply.code(429).send({ error: 'busy', retryAfterMs: globalWait });
      const networkWait = visitorNetworkBudget.take(request.ip, performance.now());
      if (networkWait) {
        globalMessageBudget.refund('global');
        return reply.code(429).send({ error: 'network limit', retryAfterMs: networkWait });
      }

      let result: ReturnType<typeof submitChatMessage>;
      try {
        result = submitChatMessage(context.db, visitor, validated.value);
      } catch (error) {
        globalMessageBudget.refund('global');
        visitorNetworkBudget.refund(request.ip);
        throw error;
      }

      if (!result.ok) {
        globalMessageBudget.refund('global');
        visitorNetworkBudget.refund(request.ip);
        return reply.code(429).send({ error: result.reason, retryAfterMs: result.retryAfterMs });
      }

      if (result.duplicate) {
        globalMessageBudget.refund('global');
        visitorNetworkBudget.refund(request.ip);
      } else {
        for (const id of result.removedIds) context.realtime.publish('remove', { id });
        context.realtime.publish('message', { ...result.message });
      }

      return { ok: true, duplicate: result.duplicate, message: result.message };
    });
  },
  maintenance(context, now) {
    cleanupChat(context.db, now);

    let cursor = removalCursors.get(context.db) ?? latestRemovalId(context.db);
    cursor = publishPendingRemovals(context.db, cursor, id => context.realtime.publish('remove', { id }));
    removalCursors.set(context.db, cursor);
  },
};
