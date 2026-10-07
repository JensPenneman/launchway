import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const appId = generateId('app');
const previewId = generateId('prv');

describe('previews routes (authorization and validation)', () => {
  it('rejects anonymous callers with 401', async () => {
    const app = createApp(createTestDeps());
    expect((await app.request('/api/v1/previews')).status).toBe(401);
    expect((await app.request(`/api/v1/apps/${appId}/previews`)).status).toBe(401);
    expect((await app.request(`/api/v1/previews/${previewId}`)).status).toBe(401);
    expect(
      (await app.request(`/api/v1/apps/${appId}/previews`, json('POST', { prNumber: 1 }))).status,
    ).toBe(401);
    expect((await app.request(`/api/v1/previews/${previewId}/redeploy`, json('POST'))).status).toBe(
      401,
    );
    expect((await app.request(`/api/v1/previews/${previewId}`, json('DELETE'))).status).toBe(401);
  });

  it('rejects viewers on mutations with 403', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('viewer')) }));
    expect(
      (await app.request(`/api/v1/apps/${appId}/previews`, json('POST', { prNumber: 1 }))).status,
    ).toBe(403);
    expect((await app.request(`/api/v1/previews/${previewId}/redeploy`, json('POST'))).status).toBe(
      403,
    );
    expect((await app.request(`/api/v1/previews/${previewId}`, json('DELETE'))).status).toBe(403);
  });

  it('validates ids, bodies and queries with 400', async () => {
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    expect((await app.request('/api/v1/apps/not-an-id/previews')).status).toBe(400);
    expect((await app.request('/api/v1/previews/dep_123')).status).toBe(400);
    expect((await app.request('/api/v1/previews?status=gone')).status).toBe(400);
    for (const body of [{}, { prNumber: 0 }, { prNumber: 1.5 }, { prNumber: 1, extra: true }]) {
      const response = await app.request(`/api/v1/apps/${appId}/previews`, json('POST', body));
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
  });
});
