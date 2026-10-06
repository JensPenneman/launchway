import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('settings routes (authorization and validation)', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = createApp(createTestDeps());
    const res = await app.request('/api/v1/settings');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'unauthorized' });
  });

  it('rejects viewers and members on update with 403', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal(role)) }));
      const res = await app.request('/api/v1/settings', patch({ dynamicDnsEnabled: true }));
      expect(res.status).toBe(403);
    }
  });

  it('caps API tokens by scope: a read token of an owner cannot update', async () => {
    const owner = testPrincipal('owner');
    const token = {
      kind: 'token' as const,
      user: owner.user,
      tokenId: 'tok_01ja53wvjvfk1sp7hz5965tvkz' as const,
      scopes: ['read' as const],
    };
    const app = createApp(createTestDeps({ auth: fixedAuth(token) }));
    expect((await app.request('/api/v1/settings', patch({ dynamicDnsEnabled: true }))).status).toBe(
      403,
    );
  });

  it('validates the body for admins before touching the database', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const res = await app.request(
      '/api/v1/settings',
      patch({ publicUrl: 'ftp://x', publicIpv4: '1.2.3.4' }),
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { type: string; errors: { path: string }[] };
    expect(problem.type).toBe('validation-failed');
    expect(problem.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['body.publicUrl']));
  });

  it('rejects malformed JSON with a problem document', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const res = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400 });
  });
});
