import { describe, expect, it } from 'vitest';
import { callProvider, providerProblem } from './errors.js';
import { DnsProviderError } from './providers/types.js';

describe('provider error mapping', () => {
  it.each([
    ['unauthorized', 'upstream-failed', 502],
    ['forbidden', 'upstream-failed', 502],
    ['rate-limited', 'rate-limited', 429],
    ['not-found', 'not-found', 404],
    ['conflict', 'conflict', 409],
    ['invalid', 'bad-request', 400],
    ['unavailable', 'upstream-failed', 502],
  ] as const)('maps %s to %s', (reason, type, status) => {
    const problem = providerProblem(new DnsProviderError(reason, 'msg'));
    expect(problem).toMatchObject({ type, status });
    expect(problem.detail).toContain('msg');
  });

  it('passes Retry-After on', () => {
    const problem = providerProblem(
      new DnsProviderError('rate-limited', 'slow down', { retryAfter: 12 }),
    );
    expect(problem.headers).toEqual({ 'Retry-After': '12' });
  });

  it('rethrows other errors unchanged', async () => {
    const error = new Error('boom');
    await expect(callProvider(() => Promise.reject(error))).rejects.toBe(error);
    await expect(callProvider(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
