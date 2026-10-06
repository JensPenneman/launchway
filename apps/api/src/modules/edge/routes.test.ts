import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

describe('edge routes (authorization)', () => {
  it('requires the admin role', async () => {
    expect((await createApp(createTestDeps()).request('/api/v1/edge/config')).status).toBe(401);
    const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));
    expect((await app.request('/api/v1/edge/config')).status).toBe(403);
    expect((await app.request('/api/v1/edge/reload', { method: 'POST' })).status).toBe(403);
  });
});
