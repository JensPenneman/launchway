import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../deps.js';
import { ProblemError } from './problem.js';

export interface TokenBucketOptions {
  /** Maximum burst (bucket size). */
  readonly capacity: number;
  /** Tokens added back per second. */
  readonly refillPerSecond: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until one token is available again (0 when allowed). */
  readonly retryAfterSeconds: number;
}

/** In-memory token buckets keyed by an arbitrary string (single API instance). */
export interface RateLimiter {
  take(key: string, options: TokenBucketOptions, now?: number): RateLimitDecision;
  /** Number of tracked buckets (for tests and diagnostics). */
  readonly size: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** Time at which the bucket is full again; afterwards it can be forgotten. */
  fullAt: number;
}

const MAX_BUCKETS = 50_000;

export function createRateLimiter(clock: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();

  /** Drops buckets that refilled completely; they behave exactly like new ones. */
  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.fullAt <= now) buckets.delete(key);
    }
    // Still too many keys (e.g. a flood of distinct IPs): forget the oldest ones.
    if (buckets.size >= MAX_BUCKETS) {
      const excess = buckets.size - MAX_BUCKETS + 1;
      let removed = 0;
      for (const key of buckets.keys()) {
        if (removed++ >= excess) break;
        buckets.delete(key);
      }
    }
  }

  return {
    take(key, { capacity, refillPerSecond }, now = clock()) {
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= MAX_BUCKETS) sweep(now);
        bucket = { tokens: capacity, updatedAt: now, fullAt: now };
        buckets.set(key, bucket);
      }
      const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
      bucket.updatedAt = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        bucket.fullAt = now + ((capacity - bucket.tokens) / refillPerSecond) * 1000;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
      };
    },
    get size() {
      return buckets.size;
    },
  };
}

export interface RateLimitRule extends TokenBucketOptions {
  /** Route group; requests of one client share a bucket per group. */
  readonly group: string;
  /** Upper-case HTTP methods the rule applies to. */
  readonly methods: readonly string[];
  /** Matched against the full request path (e.g. `/api/v1/auth/login`). */
  readonly path: RegExp;
}

/**
 * Rate limits of the unauthenticated / credential-handling endpoints (spec section 7): setup,
 * sign-in, passkeys, invitation preview/accept and API token creation.
 */
export const AUTH_RATE_LIMITS: readonly RateLimitRule[] = [
  {
    group: 'setup',
    methods: ['POST'],
    path: /^\/api\/v1\/setup$/,
    capacity: 5,
    refillPerSecond: 1 / 60,
  },
  {
    group: 'login',
    methods: ['POST'],
    path: /^\/api\/v1\/auth\/login$/,
    capacity: 10,
    refillPerSecond: 1 / 6,
  },
  {
    group: 'passkey',
    methods: ['POST'],
    path: /^\/api\/v1\/auth\/passkeys\//,
    capacity: 20,
    refillPerSecond: 1 / 3,
  },
  {
    group: 'invitation',
    methods: ['GET', 'POST'],
    path: /^\/api\/v1\/invitations\/slpi_[^/]+(?:\/accept)?$/,
    capacity: 10,
    refillPerSecond: 1 / 6,
  },
  {
    group: 'tokens',
    methods: ['POST'],
    path: /^\/api\/v1\/tokens$/,
    capacity: 10,
    refillPerSecond: 1 / 6,
  },
];

/**
 * Global middleware: applies the first matching rule, keyed by client IP + rule group, and
 * answers `429 rate-limited` with `Retry-After` when the bucket is empty.
 */
export function rateLimit(
  rules: readonly RateLimitRule[] = AUTH_RATE_LIMITS,
  limiter: RateLimiter = createRateLimiter(),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const rule = rules.find((r) => r.methods.includes(method) && r.path.test(c.req.path));
    if (rule) {
      const key = `${rule.group}:${c.get('clientIp') ?? 'unknown'}`;
      const decision = limiter.take(key, rule);
      if (!decision.allowed) {
        c.get('logger')?.warn({ group: rule.group }, 'rate limit exceeded');
        throw new ProblemError('rate-limited', {
          detail: `Too many requests; retry in ${decision.retryAfterSeconds} s`,
          headers: { 'Retry-After': String(decision.retryAfterSeconds) },
        });
      }
    }
    await next();
  };
}
