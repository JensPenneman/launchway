import { describe, expect, it } from 'vitest';
import {
  capabilitiesComplete,
  capabilityHint,
  capabilitySummary,
  capabilityTitle,
} from './github-capabilities';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ALL_GOOD = {
  kind: 'app' as const,
  deployments: true,
  pullRequests: true,
  statuses: true,
  missing: [],
  pendingApproval: false,
  lastDeniedAt: null,
  lastStatusDeniedAt: null,
};

describe('GitHub connection capabilities', () => {
  it('sums up what a complete connection does, checks included', () => {
    expect(capabilitiesComplete(ALL_GOOD)).toBe(true);
    expect(capabilitySummary(ALL_GOOD)).toBe(
      'Deployments show on GitHub; pull requests can be previewed; checks report to GitHub as commit statuses.',
    );
    expect(capabilitySummary({ ...ALL_GOOD, pullRequests: false, statuses: false })).toBe(
      'Deployments show on GitHub.',
    );
  });

  it('asks an old GitHub App for every permission and the pull request event', () => {
    const caps = {
      ...ALL_GOOD,
      deployments: false,
      pullRequests: false,
      statuses: false,
      missing: [
        'deployments: write',
        'pull_requests: read',
        'statuses: write',
        'event: pull_request',
      ],
    };
    expect(capabilitiesComplete(caps)).toBe(false);
    expect(capabilityTitle(caps)).toBe(
      'Grant in GitHub to show deployments and check results there',
    );
    expect(capabilityHint(caps, NOW)).toBe(
      'This app was created before Launchway needed these permissions. In its permissions, set Deployments to Read and write, Pull requests to Read-only and Commit statuses to Read and write, subscribe to Pull request events, save, then approve the change on the installation.',
    );
  });

  it('asks a GitHub App for commit statuses alone when only checks are affected', () => {
    const caps = { ...ALL_GOOD, statuses: false, missing: ['statuses: write'] };
    expect(capabilityTitle(caps)).toBe('Grant in GitHub to show check results there');
    expect(capabilityHint(caps, NOW)).toBe(
      'This app was created before Launchway needed these permissions. In its permissions, set Commit statuses to Read and write, save, then approve the change on the installation.',
    );
  });

  it('names refused commit statuses and deployments of tokens', () => {
    const statusDenied = {
      ...ALL_GOOD,
      kind: 'pat' as const,
      statuses: false,
      lastStatusDeniedAt: '2026-10-27T10:00:00.000Z',
    };
    expect(capabilitiesComplete(statusDenied)).toBe(false);
    expect(capabilityTitle(statusDenied)).toBe('Grant in GitHub to show check results there');
    expect(capabilityHint(statusDenied, NOW)).toBe(
      'GitHub refused a commit status of a check (2 hours ago). Give the token Commit statuses: Read and write on the repositories of its apps.',
    );
    const bothDenied = { ...statusDenied, lastDeniedAt: '2026-10-27T11:00:00.000Z' };
    expect(capabilityHint(bothDenied, NOW)).toBe(
      'GitHub refused to record a deployment (1 hour ago) and a commit status of a check (2 hours ago). Give the token Deployments: Read and write and Commit statuses: Read and write on the repositories of its apps.',
    );
    const pullRequests = { ...ALL_GOOD, kind: 'pat' as const, missing: ['pull_requests: read'] };
    expect(capabilityTitle(pullRequests)).toBe(
      'Grant in GitHub to preview and check pull requests',
    );
    expect(capabilityHint(pullRequests, NOW)).toBe(
      'Give the token Pull requests: Read-only on the repositories of its apps.',
    );
  });

  it('points at the installation when a complete app was refused, or still awaits approval', () => {
    const refused = { ...ALL_GOOD, lastStatusDeniedAt: '2026-10-27T11:57:00.000Z' };
    expect(capabilityHint(refused, NOW)).toBe(
      'GitHub refused a commit status of a check (3 minutes ago). Check that the installation includes the repository.',
    );
    expect(
      capabilityHint({ ...ALL_GOOD, pendingApproval: true, missing: ['statuses: write'] }, NOW),
    ).toBe(
      'The app requests the new permissions; the account it is installed on still has to approve them.',
    );
  });
});
