import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const id = generateId('node');

describe('nodes routes (authorization and validation)', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = createApp(createTestDeps());
    for (const [path, init] of [
      ['/api/v1/nodes', undefined],
      [`/api/v1/nodes/${id}`, undefined],
      ['/api/v1/nodes', json('POST', { name: 'nuc' })],
      [`/api/v1/nodes/${id}/join-token`, json('POST')],
    ] as const) {
      expect((await app.request(path, init)).status).toBe(401);
    }
  });

  it('requires the admin role for mutations', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal(role)) }));
      for (const [path, init] of [
        ['/api/v1/nodes', json('POST', { name: 'nuc' })],
        [`/api/v1/nodes/${id}`, json('PATCH', { name: 'nuc' })],
        [`/api/v1/nodes/${id}`, json('PATCH', { allowedBindRoots: ['/srv/data'] })],
        [`/api/v1/nodes/${id}`, json('DELETE')],
        [`/api/v1/nodes/${id}/join-token`, json('POST')],
        [`/api/v1/nodes/${id}/credential/rotate`, json('POST')],
        [`/api/v1/nodes/${id}/credential/revoke`, json('POST')],
      ] as const) {
        expect((await app.request(path, init)).status, `${role} ${init.method} ${path}`).toBe(403);
      }
    }
  });

  it('validates ids and bodies', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const badId = await app.request('/api/v1/nodes/app_01jbh8m4x2f8k9z0a1b2c3d4e5');
    expect(badId.status).toBe(400);
    const res = await app.request('/api/v1/nodes', json('POST', { name: '', extra: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'validation-failed' });
  });

  it.each([
    [['/'], 'body.allowedBindRoots.0'],
    [['srv/data'], 'body.allowedBindRoots.0'],
    [['/srv/../etc'], 'body.allowedBindRoots.0'],
    [['/srv/data/'], 'body.allowedBindRoots.0'],
    [['/srv', '/srv'], 'body.allowedBindRoots'],
    [Array.from({ length: 33 }, (_, i) => `/srv/r${i}`), 'body.allowedBindRoots'],
  ])('refuses allowed bind roots %j', async (roots, path) => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));
    const res = await app.request(
      `/api/v1/nodes/${id}`,
      json('PATCH', { allowedBindRoots: roots }),
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { errors: { path: string }[] };
    expect(problem.errors.map((e) => e.path)).toContain(path);
  });
});

describe('agent socket route', () => {
  it('answers 503 while the gateway placeholder is installed', async () => {
    const app = createApp(createTestDeps());
    const res = await app.request('/api/agent/ws', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(503);
  });
});
