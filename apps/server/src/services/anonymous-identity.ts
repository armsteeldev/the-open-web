import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'ow_id';
const COOKIE_MAX_AGE_SECONDS = 31_536_000;
const COOKIE_PATTERN = /^[a-f0-9]{64}$/;

/** Only the derived digest crosses the shared identity boundary. */
export interface AnonymousIdentity {
  existing(request: FastifyRequest): string | null;
  ensure(request: FastifyRequest, reply: FastifyReply): string;
  clear(reply: FastifyReply): void;
}

export interface AnonymousIdentityMiddleware extends AnonymousIdentity {
  /** Capture and remove the secret cookie before a request reaches space code. */
  capture(request: FastifyRequest): void;
}

export function createAnonymousIdentity(secure: boolean): AnonymousIdentityMiddleware {
  const visitors = new WeakMap<FastifyRequest, string | null>();
  const digest = (cookie: string): string => createHash('sha256').update(cookie).digest('hex');

  return {
    capture(request) {
      const cookie = request.cookies[COOKIE_NAME];
      visitors.set(request, cookie && COOKIE_PATTERN.test(cookie) ? digest(cookie) : null);
      delete request.cookies[COOKIE_NAME];
      delete request.headers.cookie;
      delete request.raw.headers.cookie;
    },
    existing(request) {
      return visitors.get(request) ?? null;
    },
    ensure(request, reply) {
      const visitor = visitors.get(request) ?? null;
      if (visitor) return visitor;

      const cookie = randomBytes(32).toString('hex');
      const visitorDigest = digest(cookie);
      visitors.set(request, visitorDigest);
      reply.setCookie(COOKIE_NAME, cookie, {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'strict',
        maxAge: COOKIE_MAX_AGE_SECONDS,
      });
      return visitorDigest;
    },
    clear(reply) {
      reply.setCookie(COOKIE_NAME, '', {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'strict',
        maxAge: 0,
        expires: new Date(0),
      });
    },
  };
}
