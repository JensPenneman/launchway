import { generateId, type UserRole } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { tokenPrincipal } from '../../../test/support/requests.js';
import { createApp } from '../../app.js';

const appId = generateId('app');
const runId = generateId('chk');
const sha = 'a'.repeat(40);

/** [method, path, minimum role, valid body] for every route of the checks module. */
const ROUTES: [string, string, UserRole, unknown?][] = [
  ['GET', `/api/v1/apps/${appId}/checks`, 'viewer'],
  ['POST', `/api/v1/apps/${appId}/checks`, 'member', { ref: 'main' }],
  ['GET', `/api/v1/checks/${runId}`, 'viewer'],
  ['GET', `/api/v1/checks/${runId}/logs`, 'viewer'],
  ['POST', `/api/v1/checks/${runId}/cancel`, 'member'],
  ['POST', `/api/v1/checks/${runId}/rerun`, 'member'],
];

const BELOW: Record<UserRole, UserRole | null> = {
  viewer: null,
  member: 'viewer',
  admin: 'member',
  owner: 'admin',
};

const request = (method: string, body?: unknown) =>
  body === undefined
    ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

describe('checks routes: authorization', () => {
  it.each(ROUTES)('%s %s rejects anonymous callers', async (method, path, _role, body) => {
    const res = await createApp(createTestDeps()).request(path, request(method, body));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'unauthorized' });
  });

  it.each(ROUTES.filter(([, , role]) => BELOW[role] !== null))(
    '%s %s rejects roles below %s',
    async (method, path, role, body) => {
      const below = BELOW[role] as UserRole;
      const app = createApp(createTestDeps({ auth: fixedAuth(testPrincipal(below)) }));
      const res = await app.request(path, request(method, body));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ type: 'forbidden' });
    },
  );

  it.each(ROUTES.filter(([, , role]) => role === 'member'))(
    '%s %s refuses read-scoped tokens',
    async (method, path, _role, body) => {
      const app = createApp(createTestDeps({ auth: fixedAuth(tokenPrincipal('owner', ['read'])) }));
      expect((await app.request(path, request(method, body))).status).toBe(403);
    },
  );
});

describe('checks routes: validation', () => {
  const member = () => createApp(createTestDeps({ auth: fixedAuth(testPrincipal('member')) }));

  it.each([
    ['POST', `/api/v1/apps/${appId}/checks`, {}, ['body.ref']],
    ['POST', `/api/v1/apps/${appId}/checks`, { ref: '--upload-pack=x' }, ['body.ref']],
    ['POST', `/api/v1/apps/${appId}/checks`, { ref: 'main', names: [] }, ['body.names']],
    [
      'POST',
      `/api/v1/apps/${appId}/checks`,
      { ref: 'main', names: ['lint', 'lint'] },
      ['body.names'],
    ],
    [
      'POST',
      `/api/v1/apps/${appId}/checks`,
      { ref: 'main', names: ['Not_A_Name'] },
      ['body.names.0'],
    ],
    ['POST', `/api/v1/apps/${appId}/checks`, { ref: 'main', extra: true }, ['body']],
    ['POST', '/api/v1/apps/not-an-id/checks', { ref: 'main' }, ['param.id']],
    ['POST', `/api/v1/checks/${generateId('dep')}/cancel`, undefined, ['param.id']],
    ['POST', '/api/v1/checks/chk_nope/rerun', undefined, ['param.id']],
  ])('%s %s answers 400 validation-failed', async (method, path, body, paths) => {
    const res = await member().request(path, request(method, body));
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { type: string; errors: { path: string }[] };
    expect(problem.type).toBe('validation-failed');
    expect(problem.errors.map((e) => e.path)).toEqual(expect.arrayContaining(paths));
  });

  it.each([
    `/api/v1/apps/${appId}/checks?status=bogus`,
    `/api/v1/apps/${appId}/checks?limit=1000`,
    `/api/v1/apps/${appId}/checks?name=Bad_Name`,
    `/api/v1/apps/${appId}/checks?commitSha=abc123`,
    `/api/v1/apps/${appId}/checks?commitSha=${sha.toUpperCase()}`,
    `/api/v1/apps/not-an-id/checks`,
    `/api/v1/checks/${generateId('app')}`,
    `/api/v1/checks/${runId}/logs?after=-1`,
    `/api/v1/checks/${runId}/logs?follow=maybe`,
  ])('GET %s answers 400 for an invalid query or id', async (path) => {
    const res = await member().request(path);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});
