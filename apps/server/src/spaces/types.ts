import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { SpaceDefinition } from '../../../../packages/shared/spaces.js';
import type { AnonymousIdentity } from '../services/anonymous-identity.js';
import type { SpacePublisher } from '../realtime/channels.js';
import type { SpaceRateLimitFactory } from '../services/rate-limits.js';
import type { AppOptions } from '../config.js';

export interface SpaceContext {
  readonly space: SpaceDefinition;
  readonly db: DatabaseSync;
  readonly config: Readonly<Pick<AppOptions, 'origin' | 'secure'>>;
  readonly identity: AnonymousIdentity;
  /** Publisher bound to this module's space identifier. */
  readonly realtime: SpacePublisher;
  /** New policies are local to this space and share bounded platform primitives. */
  readonly rateLimits: SpaceRateLimitFactory;
}

export interface SpaceCompatibilityRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export interface SpaceModule {
  readonly id: string;
  /** Explicitly declared compatibility routes outside `/api/{id}/...`. */
  readonly compatibilityRoutes?: readonly SpaceCompatibilityRoute[];
  register(app: FastifyInstance, context: SpaceContext): void | Promise<void>;
  /** Optional bounded maintenance work owned by this space. */
  maintenance?(context: SpaceContext, now: number): void | Promise<void>;
}
