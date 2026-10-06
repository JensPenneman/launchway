import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { jsonRequest, tokenPrincipal } from '../../../test/support/requests.js';
import { createApp } from '../../app.js';
import type { Principal } from '../../lib/auth-context.js';

const appFor = (principal: Principal | null) =>
  createApp(createTestDeps({ auth: fixedAuth(principal) }));

describe('tokens routes (authorization and validation)', () => {
  it('requires authentication (401)', async () => {
    const app = appFor(null);
    expect((await app.request('/api/v1/tokens')).status).toBe(401);
    expect(
      (await app.request('/api/v1/tokens', jsonRequest('POST', { name: 'ci', scopes: ['read'] })))
        .status,
    ).toBe(401);
    expect(
      (await app.request('/api/v1/tokens/tok_01ja53wvjvfk1sp7hz5965tvkz', jsonRequest('DELETE')))
        .status,
    ).toBe(401);
  });

  it('caps scopes by the creator role and refuses token-created tokens (403)', async () => {
    const viewer = appFor(testPrincipal('viewer'));
    const res = await viewer.request(
      '/api/v1/tokens',
      jsonRequest('POST', { name: 'ci', scopes: ['read', 'write'] }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ detail: expect.stringContaining('write') });

    const member = appFor(testPrincipal('member'));
    expect(
      (
        await member.request(
          '/api/v1/tokens',
          jsonRequest('POST', { name: 'ci', scopes: ['admin'] }),
        )
      ).status,
    ).toBe(403);

    const token = appFor(tokenPrincipal('owner', ['admin']));
    expect(
      (await token.request('/api/v1/tokens', jsonRequest('POST', { name: 'ci', scopes: ['read'] })))
        .status,
    ).toBe(403);
  });

  it('validates bodies and ids (400)', async () => {
    const app = appFor(testPrincipal('admin'));
    const bodies = [
      { name: 'ci', scopes: [] },
      { name: 'ci', scopes: ['read', 'read'] },
      { name: '', scopes: ['read'] },
      { name: 'ci', scopes: ['root'] },
      { name: 'ci', scopes: ['read'], expiresAt: '2000-01-01T00:00:00.000Z' },
    ];
    for (const body of bodies) {
      expect((await app.request('/api/v1/tokens', jsonRequest('POST', body))).status).toBe(400);
    }
    expect((await app.request('/api/v1/tokens/nope', jsonRequest('DELETE'))).status).toBe(400);
  });
});
