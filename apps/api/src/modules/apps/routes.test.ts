import { generateId, type UserRole } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDeps, fixedAuth, testPrincipal } from '../../../test/support/deps.js';
import { createApp } from '../../app.js';

const appId = generateId('app');
const depId = generateId('dep');
const ghId = generateId('gh');

/** [method, path, minimum role, valid body] for every route of the apps and deployments modules. */
const ROUTES: [string, string, UserRole, unknown?][] = [
  ['GET', '/api/v1/apps', 'viewer'],
  ['POST', '/api/v1/apps', 'member', {}],
  ['GET', `/api/v1/apps/${appId}`, 'viewer'],
  ['PATCH', `/api/v1/apps/${appId}`, 'member', { name: 'x' }],
  ['DELETE', `/api/v1/apps/${appId}`, 'member'],
  ['GET', `/api/v1/apps/${appId}/env`, 'viewer'],
  ['PUT', `/api/v1/apps/${appId}/env`, 'member', { variables: [] }],
  ['PUT', `/api/v1/apps/${appId}/env/KEY`, 'member', { value: 'x' }],
  ['DELETE', `/api/v1/apps/${appId}/env/KEY`, 'member'],
  ['GET', `/api/v1/apps/${appId}/status`, 'viewer'],
  ['POST', `/api/v1/apps/${appId}/stop`, 'member'],
  ['GET', `/api/v1/apps/${appId}/logs`, 'viewer'],
  ['POST', `/api/v1/apps/${appId}/deployments`, 'member', { ref: 'v1' }],
  ['GET', `/api/v1/apps/${appId}/deployments`, 'viewer'],
  ['GET', `/api/v1/deployments/${depId}`, 'viewer'],
  ['GET', `/api/v1/deployments/${depId}/logs`, 'viewer'],
  ['POST', `/api/v1/deployments/${depId}/cancel`, 'member'],
  ['GET', '/api/v1/github/connections', 'viewer'],
  ['GET', `/api/v1/github/connections/${ghId}`, 'viewer'],
  ['DELETE', `/api/v1/github/connections/${ghId}`, 'admin'],
  [
    'POST',
    '/api/v1/github/connections/pat',
    'admin',
    { name: 'x', token: `ghp_${'a'.repeat(36)}` },
  ],
  ['POST', '/api/v1/github/connections/app-manifest/start', 'admin', {}],
  ['GET', '/api/v1/github/connections/app-manifest/callback?code=c&state=s', 'admin'],
  ['GET', `/api/v1/github/connections/${ghId}/installation-callback?installation_id=1`, 'admin'],
  ['GET', `/api/v1/github/repos?connectionId=${ghId}`, 'member'],
  ['GET', `/api/v1/github/repos/octo/trail/releases?connectionId=${ghId}`, 'viewer'],
  ['GET', `/api/v1/github/repos/octo/trail/refs/v1?connectionId=${ghId}`, 'viewer'],
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

describe('apps, deployments and github routes: authorization', () => {
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
    },
  );
});

describe('apps, deployments and github routes: validation', () => {
  const member = () => createApp(createTestDeps({ auth: fixedAuth(testPrincipal('admin')) }));

  it.each([
    [
      'POST',
      '/api/v1/apps',
      { name: 'x' },
      ['body.connectionId', 'body.repository', 'body.nodeId'],
    ],
    [
      'POST',
      '/api/v1/apps',
      {
        name: 'x',
        slug: 'caddy',
        connectionId: ghId,
        repository: { owner: 'octo', name: 'trail' },
        nodeId: generateId('node'),
        composeFiles: ['compose.yaml'],
        dockerfile: 'Dockerfile',
      },
      ['body.slug', 'body.dockerfile'],
    ],
    ['PATCH', `/api/v1/apps/${appId}`, {}, ['body']],
    ['PATCH', '/api/v1/apps/not-an-id', { name: 'x' }, ['param.id']],
    [
      'PUT',
      `/api/v1/apps/${appId}/env`,
      { variables: [{ key: '1BAD', value: 'x' }] },
      ['body.variables.0.key'],
    ],
    [
      'PUT',
      `/api/v1/apps/${appId}/env`,
      {
        variables: [
          { key: 'A', value: 'x' },
          { key: 'A', value: 'y' },
        ],
      },
      ['body.variables'],
    ],
    ['PUT', `/api/v1/apps/${appId}/env/KEY`, {}, ['body']],
    ['POST', `/api/v1/apps/${appId}/deployments`, { ref: '--upload-pack=x' }, ['body.ref']],
    ['POST', '/api/v1/github/connections/pat', { name: 'x', token: 'nope' }, ['body.token']],
    [
      'POST',
      '/api/v1/github/connections/app-manifest/start',
      { name: 'x'.repeat(40) },
      ['body.name'],
    ],
  ])('%s %s answers 400 validation-failed', async (method, path, body, paths) => {
    const res = await member().request(path, request(method, body));
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { type: string; errors: { path: string }[] };
    expect(problem.type).toBe('validation-failed');
    expect(problem.errors.map((e) => e.path)).toEqual(expect.arrayContaining(paths));
  });

  it.each([
    `/api/v1/apps?limit=1000`,
    `/api/v1/apps/${appId}/logs?tail=-1`,
    `/api/v1/apps/${appId}/deployments?status=bogus`,
    `/api/v1/deployments/${depId}/logs?after=-2`,
    '/api/v1/github/repos',
    '/api/v1/github/connections/app-manifest/callback?state=s',
    `/api/v1/github/connections/${ghId}/installation-callback?installation_id=abc`,
  ])('GET %s answers 400 for an invalid query', async (path) => {
    const res = await member().request(path);
    expect(res.status).toBe(400);
  });
});

describe('github webhook route', () => {
  it('is public but rejects deliveries without GitHub headers', async () => {
    const res = await createApp(createTestDeps()).request('/api/v1/webhooks/github', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'bad-request' });
  });
});
