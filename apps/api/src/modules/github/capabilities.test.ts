import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { appCapabilities, missingGrants } from './capabilities.js';

const id = generateId('gh');
const at = new Date('2026-10-07T10:00:00Z');
const legacy = { contents: 'read', metadata: 'read' };
const full = { ...legacy, deployments: 'write', pull_requests: 'read', statuses: 'write' };
const allEvents = ['release', 'push', 'pull_request'];

describe('missingGrants', () => {
  it('lists permissions below the requested level and missing events', () => {
    expect(missingGrants(legacy, ['release'])).toEqual([
      'deployments: write',
      'pull_requests: read',
      'statuses: write',
      'event: push',
      'event: pull_request',
    ]);
    expect(missingGrants({ ...full, deployments: 'read' }, allEvents)).toEqual([
      'deployments: write',
    ]);
    expect(missingGrants({ ...full, contents: 'write' }, allEvents)).toEqual([]);
  });

  it('asks for statuses: write, the permission commit statuses of checks need', () => {
    const { statuses: _statuses, ...withoutStatuses } = full;
    expect(missingGrants(withoutStatuses, allEvents)).toEqual(['statuses: write']);
    expect(missingGrants({ ...full, statuses: 'read' }, allEvents)).toEqual(['statuses: write']);
  });
});

describe('appCapabilities', () => {
  it('reports an app created before the new permissions with links to grant them', () => {
    const caps = appCapabilities(
      id,
      {
        app: {
          slug: 'launchway-lvj',
          owner: { login: 'jens', type: 'User' },
          permissions: legacy,
          events: ['release'],
        },
        installation: {
          id: 99,
          account: { login: 'acme', type: 'Organization' },
          permissions: legacy,
          events: ['release'],
        },
      },
      at,
    );
    expect(caps).toEqual({
      connectionId: id,
      kind: 'app',
      deployments: false,
      pullRequests: false,
      statuses: false,
      events: ['release'],
      missing: [
        'deployments: write',
        'pull_requests: read',
        'statuses: write',
        'event: push',
        'event: pull_request',
      ],
      pendingApproval: false,
      settingsUrl: 'https://github.com/settings/apps/launchway-lvj/permissions',
      installationSettingsUrl: 'https://github.com/organizations/acme/settings/installations/99',
      probedRepository: null,
      checkedAt: at.toISOString(),
    });
  });

  it('flags an installation that has not approved the updated permissions yet', () => {
    const caps = appCapabilities(
      id,
      {
        app: {
          slug: 'launchway-lvj',
          owner: { login: 'acme', type: 'Organization' },
          permissions: full,
          events: ['release', 'push', 'pull_request'],
        },
        installation: { id: 99, account: null, permissions: legacy, events: ['release'] },
      },
      at,
    );
    expect(caps.pendingApproval).toBe(true);
    expect(caps.deployments).toBe(false);
    expect(caps.settingsUrl).toBe(
      'https://github.com/organizations/acme/settings/apps/launchway-lvj/permissions',
    );
  });

  it('uses the app grants while it is not installed', () => {
    const caps = appCapabilities(
      id,
      {
        app: {
          slug: 'x',
          owner: null,
          permissions: full,
          events: ['pull_request', 'push', 'release'],
        },
        installation: null,
      },
      at,
    );
    expect(caps).toMatchObject({
      deployments: true,
      pullRequests: true,
      statuses: true,
      events: ['pull_request', 'push', 'release'],
      missing: [],
      pendingApproval: false,
      installationSettingsUrl: null,
    });
  });

  it('reports statuses from what the installation approved', () => {
    const caps = appCapabilities(
      id,
      {
        app: { slug: 'x', owner: null, permissions: full, events: allEvents },
        installation: {
          id: 99,
          account: null,
          permissions: { ...full, statuses: 'read' },
          events: allEvents,
        },
      },
      at,
    );
    expect(caps).toMatchObject({
      deployments: true,
      statuses: false,
      missing: ['statuses: write'],
      pendingApproval: true,
    });
  });
});
