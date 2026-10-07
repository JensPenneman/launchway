import { isIP } from 'node:net';
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
    path: /^\/api\/v1\/invitations\/lwyi_[^/]+(?:\/accept)?$/,
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
 * The part of a client address that identifies one client: the IPv4 address, or the /64 prefix of
 * an IPv6 address (one subscriber usually holds a whole /64, so per-address buckets would be free).
 */
export function clientKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Throws `429 rate-limited` with `Retry-After` when the bucket of `key` is empty. */
export function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  options: TokenBucketOptions,
  log?: { warn: (obj: object, msg: string) => void },
): void {
  const decision = limiter.take(key, options);
  if (decision.allowed) return;
  log?.warn({ group: key.slice(0, key.indexOf(':')) }, 'rate limit exceeded');
  throw new ProblemError('rate-limited', {
    detail: `Too many requests; retry in ${decision.retryAfterSeconds} s`,
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  });
}

/**
 * Global middleware: applies the first matching rule, keyed by client (`clientKey`) + rule group, and
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
      enforceRateLimit(
        limiter,
        `${rule.group}:${clientKey(c.get('clientIp'))}`,
        rule,
        c.get('logger'),
      );
    }
    await next();
  };
}
