import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedWindowLimiter, RateLimitService } from '../apps/server/src/services/rate-limits.js';

test('fixed windows have independent keys, exact limits and bounded fail-closed storage', () => {
  const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000, maxEntries: 2 });
  assert.equal(limiter.take('one', 0).allowed, true);
  assert.equal(limiter.take('one', 1).allowed, true);
  assert.deepEqual(limiter.take('one', 2), { allowed: false, retryAfterMs: 998 });
  assert.equal(limiter.take('two', 2).allowed, true);
  assert.equal(limiter.take('three', 2).allowed, false);
  assert.equal(limiter.take('one', 1_001).allowed, true);
});

test('each space can select independent policies from shared rate-limit primitives', () => {
  const service = new RateLimitService();
  const firstSpace = service.forSpace();
  const secondSpace = service.forSpace();
  const first = firstSpace.fixedWindow({ limit: 1, windowMs: 100 });
  const second = secondSpace.fixedWindow({ limit: 2, windowMs: 100 });

  assert.equal(first.take('visitor', 0).allowed, true);
  assert.equal(first.take('visitor', 1).allowed, false);
  assert.equal(second.take('visitor', 1).allowed, true);
  assert.equal(second.take('visitor', 2).allowed, true);
  assert.equal(second.take('visitor', 3).allowed, false);
});
