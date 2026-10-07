import { describe, expect, it } from 'vitest';
import { DeployPayload } from './agent/messages.js';
import { generateId } from './ids.js';
import { AllowedBindRoots, BindRoot, MAX_ALLOWED_BIND_ROOTS, UpdateNodeInput } from './nodes.js';

describe('allowed bind roots', () => {
  it.each(['/srv/data', '/run/desktop/mnt/host/d/Backups', '/mnt/backups 2026'])(
    'accepts %s',
    (path) => {
      expect(BindRoot.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    ['relative paths', 'srv/data'],
    ['the root directory', '/'],
    ['trailing slashes', '/srv/data/'],
    ['.. segments', '/srv/../etc'],
    ['. segments', '/srv/./data'],
    ['empty segments', '/srv//data'],
    ['control characters', '/srv/da\nta'],
    ['Windows paths', 'D:\\Backups'],
  ])('refuses %s', (_label, path) => {
    expect(BindRoot.safeParse(path).success).toBe(false);
  });

  it('caps the list and refuses duplicates', () => {
    const roots = Array.from({ length: MAX_ALLOWED_BIND_ROOTS + 1 }, (_, i) => `/srv/r${i}`);
    expect(AllowedBindRoots.safeParse(roots.slice(0, -1)).success).toBe(true);
    expect(AllowedBindRoots.safeParse(roots).success).toBe(false);
    expect(AllowedBindRoots.safeParse(['/srv', '/srv']).success).toBe(false);
  });

  it('lets a node update change the name, the roots or both, but not nothing', () => {
    expect(UpdateNodeInput.safeParse({ name: 'nas' }).success).toBe(true);
    expect(UpdateNodeInput.safeParse({ allowedBindRoots: [] }).success).toBe(true);
    expect(UpdateNodeInput.safeParse({}).success).toBe(false);
    expect(UpdateNodeInput.safeParse({ allowedBindRoots: ['/'] }).success).toBe(false);
  });
});

describe('deploy payload policy', () => {
  const payload = {
    deploymentId: generateId('dep'),
    app: { id: generateId('app'), slug: 'trail' },
    source: {
      cloneUrl: 'https://github.com/o/r.git',
      ref: 'v1',
      commitSha: 'a'.repeat(40),
      authorization: null,
    },
    build: { kind: 'compose', composeFiles: ['compose.yaml'] },
    env: {},
    routes: [],
    network: { proxyNetwork: 'launchway-proxy', publishOnIp: null },
  };

  it('is optional (older servers send none) and validated when present', () => {
    expect(DeployPayload.parse(payload).policy).toBeUndefined();
    const policy = { trustedMounts: true, allowedBindRoots: ['/srv/data'] };
    expect(DeployPayload.parse({ ...payload, policy }).policy).toEqual(policy);
    expect(
      DeployPayload.safeParse({
        ...payload,
        policy: { trustedMounts: true, allowedBindRoots: ['/'] },
      }).success,
    ).toBe(false);
  });
});
