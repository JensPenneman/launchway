import type { GitHubConnectionCapabilities } from '@launchway/contracts';
import { formatRelative } from '@/lib/format';

type Capabilities = Pick<
  GitHubConnectionCapabilities,
  | 'kind'
  | 'deployments'
  | 'pullRequests'
  | 'statuses'
  | 'missing'
  | 'pendingApproval'
  | 'lastDeniedAt'
  | 'lastStatusDeniedAt'
>;

/** Names of the permissions in `missing`, as GitHub shows them for tokens and for apps. */
const PERMISSIONS: Record<string, { token: string; app: string }> = {
  'deployments: write': {
    token: 'Deployments: Read and write',
    app: 'Deployments to Read and write',
  },
  'statuses: write': {
    token: 'Commit statuses: Read and write',
    app: 'Commit statuses to Read and write',
  },
  'pull_requests: read': { token: 'Pull requests: Read-only', app: 'Pull requests to Read-only' },
};
const PULL_REQUEST_EVENT = 'event: pull_request';

function sentenceList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Whether GitHub refused (or lacks the permission for) deployments and commit statuses. */
function gaps(caps: Capabilities) {
  return {
    deployments: caps.lastDeniedAt !== null || caps.missing.includes('deployments: write'),
    statuses: statusesBlocked(caps),
  };
}

/** GitHub refuses (or would refuse) the commit statuses of checks on this connection. */
export function statusesBlocked(
  caps: Pick<Capabilities, 'missing' | 'lastStatusDeniedAt'>,
): boolean {
  return caps.lastStatusDeniedAt !== null || caps.missing.includes('statuses: write');
}

/** Nothing to grant and no refusal on record. */
export function capabilitiesComplete(caps: Capabilities): boolean {
  return (
    caps.missing.length === 0 && caps.lastDeniedAt === null && caps.lastStatusDeniedAt === null
  );
}

/** What the connection does on GitHub, e.g. "Deployments show on GitHub; ...". */
export function capabilitySummary(caps: Capabilities): string {
  const parts = [
    caps.deployments && 'deployments show on GitHub',
    caps.pullRequests && 'pull requests can be previewed',
    caps.statuses && 'checks report to GitHub as commit statuses',
  ].filter((part) => typeof part === 'string');
  const text = parts.length > 0 ? parts.join('; ') : 'Launchway can read the repositories';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Heading of the warning: what granting the missing permissions brings. */
export function capabilityTitle(caps: Capabilities): string {
  const { deployments, statuses } = gaps(caps);
  const shown = [deployments && 'deployments', statuses && 'check results'].filter(
    (part) => typeof part === 'string',
  );
  return shown.length > 0
    ? `Grant in GitHub to show ${shown.join(' and ')} there`
    : 'Grant in GitHub to preview and check pull requests';
}

/** How to grant what is missing: tokens and GitHub Apps are set up differently. */
export function capabilityHint(caps: Capabilities, now = Date.now()): string {
  const refusals = [
    caps.lastDeniedAt && `to record a deployment (${formatRelative(caps.lastDeniedAt, now)})`,
    caps.lastStatusDeniedAt &&
      `a commit status of a check (${formatRelative(caps.lastStatusDeniedAt, now)})`,
  ].filter((part) => typeof part === 'string');
  const refused = refusals.length > 0 ? `GitHub refused ${refusals.join(' and ')}. ` : '';
  const { deployments, statuses } = gaps(caps);
  const permissions = [
    ...(deployments ? ['deployments: write'] : []),
    ...(statuses ? ['statuses: write'] : []),
    ...caps.missing.filter(
      (item) =>
        item !== PULL_REQUEST_EVENT && item !== 'deployments: write' && item !== 'statuses: write',
    ),
  ];

  if (caps.kind === 'pat') {
    const names = permissions.map((item) => PERMISSIONS[item]?.token ?? item);
    return names.length > 0
      ? `${refused}Give the token ${sentenceList(names)} on the repositories of its apps.`
      : `${refused}Check that the token can access the repositories of its apps.`;
  }
  if (caps.pendingApproval) {
    return 'The app requests the new permissions; the account it is installed on still has to approve them.';
  }
  if (caps.missing.length === 0) {
    return `${refused}Check that the installation includes the repository.`;
  }
  const steps = caps.missing
    .filter((item) => item !== PULL_REQUEST_EVENT)
    .map((item) => PERMISSIONS[item]?.app ?? item);
  const settings = [
    ...(steps.length > 0 ? [`set ${sentenceList(steps)}`] : []),
    ...(caps.missing.includes(PULL_REQUEST_EVENT) ? ['subscribe to Pull request events'] : []),
  ];
  return `This app was created before Launchway needed these permissions. In its permissions, ${settings.join(', ')}, save, then approve the change on the installation.`;
}
