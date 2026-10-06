import { describe, expect, it } from 'vitest';
import { createTestDeps } from '../../test/support/deps.js';
import { createApp } from '../app.js';
import { createRateLimiter } from './rate-limit.js';

const bucket = { capacity: 3, refillPerSecond: 1 };

describe('createRateLimiter', () => {
  it('allows a burst up to the capacity, then refuses with Retry-After', () => {
    const limiter = createRateLimiter(() => 0);
    for (let i = 0; i < 3; i++) expect(limiter.take('k', bucket, 0).allowed).toBe(true);
    expect(limiter.take('k', bucket, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('refills over time and never above the capacity', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) limiter.take('k', bucket, 0);
    expect(limiter.take('k', bucket, 999).allowed).toBe(false);
    expect(limiter.take('k', bucket, 1_000).allowed).toBe(true);
    // A long pause refills to the capacity only.
    for (let i = 0; i < 3; i++) expect(limiter.take('k', bucket, 60_000).allowed).toBe(true);
    expect(limiter.take('k', bucket, 60_000).allowed).toBe(false);
  });

  it('keeps separate buckets per key', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) limiter.take('a', bucket, 0);
    expect(limiter.take('a', bucket, 0).allowed).toBe(false);
    expect(limiter.take('b', bucket, 0).allowed).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it('computes Retry-After from the refill rate', () => {
    const slow = { capacity: 1, refillPerSecond: 1 / 60 };
    const limiter = createRateLimiter();
    limiter.take('k', slow, 0);
    expect(limiter.take('k', slow, 0).retryAfterSeconds).toBe(60);
    expect(limiter.take('k', slow, 30_000).retryAfterSeconds).toBe(30);
  });
});

describe('rate limit middleware', () => {
  it('answers 429 rate-limited with Retry-After once the setup bucket is empty', async () => {
    const app = createApp(createTestDeps());
    const post = () =>
      app.request('/api/v1/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    // Invalid bodies still consume tokens (they are rejected after the limiter).
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(400);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(limited.headers.get('content-type')).toBe('application/problem+json');
    expect(await limited.json()).toMatchObject({ type: 'rate-limited', status: 429 });
  });

  it('does not limit unrelated routes', async () => {
    const app = createApp(createTestDeps());
    for (let i = 0; i < 20; i++) {
      expect((await app.request('/api/v1/settings')).status).toBe(401);
    }
  });
});
