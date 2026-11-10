import { NetworkBudget } from './network-budget.js';

export interface FixedWindowPolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxEntries?: number;
}

export interface TokenBucketPolicy {
  readonly capacity: number;
  readonly refillMs: number;
  readonly maxEntries?: number;
}

export interface FixedWindowResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/** Bounded in-memory fixed window for endpoints with steady request patterns. */
export class FixedWindowLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();

  constructor(private readonly policy: Required<FixedWindowPolicy>) {
    if (!Number.isSafeInteger(policy.limit) || policy.limit < 1) throw new Error('Rate limit must be positive');
    if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1) throw new Error('Rate window must be positive');
    if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 1) throw new Error('Rate limit entry bound must be positive');
  }

  take(key: string, now: number): FixedWindowResult {
    let entry = this.entries.get(key);
    if (!entry || entry.until < now) {
      if (!entry && this.entries.size >= this.policy.maxEntries) {
        this.prune(now);
        if (this.entries.size >= this.policy.maxEntries) {
          return { allowed: false, retryAfterMs: this.policy.windowMs };
        }
      }
      entry = { count: 0, until: now + this.policy.windowMs };
      this.entries.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > this.policy.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, entry.until - now) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.until < now) this.entries.delete(key);
  }
}

export interface SpaceRateLimitFactory {
  /** Per-space token bucket, commonly used for network-level mutation budgets. */
  tokenBucket(policy: TokenBucketPolicy): NetworkBudget;
  /** Per-space fixed window, commonly used for bounded action or submission rates. */
  fixedWindow(policy: FixedWindowPolicy): FixedWindowLimiter;
}

/** Owns the process-local limiters and exposes a factory scoped to each module. */
export class RateLimitService {
  private readonly tokenBuckets = new Set<NetworkBudget>();
  private readonly fixedWindows = new Set<FixedWindowLimiter>();

  fixedWindow(policy: FixedWindowPolicy): FixedWindowLimiter {
    const limiter = new FixedWindowLimiter({
      limit: policy.limit,
      windowMs: policy.windowMs,
      maxEntries: policy.maxEntries ?? 10_000,
    });
    this.fixedWindows.add(limiter);
    return limiter;
  }

  forSpace(): SpaceRateLimitFactory {
    return {
      tokenBucket: policy => {
        const limiter = new NetworkBudget(policy.capacity, policy.refillMs, policy.maxEntries ?? 10_000);
        this.tokenBuckets.add(limiter);
        return limiter;
      },
      fixedWindow: policy => this.fixedWindow(policy),
    };
  }

  prune(monotonicNow: number, wallClockNow: number): void {
    for (const limiter of this.tokenBuckets) limiter.prune(monotonicNow);
    for (const limiter of this.fixedWindows) limiter.prune(wallClockNow);
  }
}
