import type {
  ApiToken,
  App,
  AuditEvent,
  Deployment,
  DnsProviderAccount,
  DnsProviderInfo,
  DnsRecord,
  DnsZone,
  Domain,
  EnvVar,
  GitHubConnection,
  GitHubRelease,
  GitHubRepo,
  IdPrefix,
  Invitation,
  LogLine,
  Node,
  Passkey,
  Route,
  Session,
  Settings,
  TypeId,
  User,
} from '@launchway/contracts';

/** Deterministic type IDs for fixtures (`app_01k7000…0001`), so e2e tests can deep-link. */
export function fixedId<P extends IdPrefix>(prefix: P, n: number): TypeId<P> {
  return `${prefix}_01k7${String(n).padStart(22, '0')}` as TypeId<P>;
}

const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
export const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

export function sha(seed: number): string {
  let value = '';
  let state = seed * 2_654_435_761;
  while (value.length < 40) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    value += state.toString(16).padStart(8, '0');
  }
  return value.slice(0, 40);
}

// --- People ------------------------------------------------------------------------------------

export const OWNER_ID = fixedId('user', 1);

export function createUsers(): User[] {
  const base = { hasPassword: true, updatedAt: ago(60 * 24) };
  return [
    {
      ...base,
      id: OWNER_ID,
      email: 'alex@example.com',
      name: 'Alex Morgan',
      role: 'owner',
      passkeyCount: 2,
      lastLoginAt: ago(5),
      createdAt: ago(60 * 24 * 40),
    },
    {
      ...base,
      id: fixedId('user', 2),
      email: 'sam@example.com',
      name: 'Sam Rivera',
      role: 'admin',
      passkeyCount: 1,
      lastLoginAt: ago(60 * 26),
      createdAt: ago(60 * 24 * 30),
    },
    {
      ...base,
      id: fixedId('user', 3),
      email: 'kim@example.com',
      name: 'Kim Laurent',
      role: 'member',
      passkeyCount: 0,
      lastLoginAt: ago(60 * 24 * 3),
      createdAt: ago(60 * 24 * 20),
    },
    {
      ...base,
      id: fixedId('user', 4),
      email: 'robin@example.com',
      name: 'Robin Peeters',
      role: 'viewer',
      hasPassword: false,
      passkeyCount: 1,
      lastLoginAt: null,
      createdAt: ago(60 * 24 * 2),
    },
  ];
}

export function createSessions(): Session[] {
  return [
    {
      id: fixedId('sess', 1),
      current: true,
      ipAddress: '192.168.1.24',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      createdAt: ago(60 * 24 * 3),
      lastUsedAt: ago(1),
      expiresAt: later(60 * 24 * 30),
    },
    {
      id: fixedId('sess', 2),
      current: false,
      ipAddress: '81.164.20.7',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      createdAt: ago(60 * 24 * 9),
      lastUsedAt: ago(60 * 5),
      expiresAt: later(60 * 24 * 25),
    },
  ];
}

export function createPasskeys(): Passkey[] {
  return [
    {
      id: fixedId('pk', 1),
      name: 'MacBook Touch ID',
      deviceType: 'multiDevice',
      backedUp: true,
      transports: ['internal', 'hybrid'],
      createdAt: ago(60 * 24 * 40),
      lastUsedAt: ago(60 * 24 * 3),
    },
    {
      id: fixedId('pk', 2),
      name: 'YubiKey 5C',
      deviceType: 'singleDevice',
      backedUp: false,
      transports: ['usb', 'nfc'],
      createdAt: ago(60 * 24 * 39),
      lastUsedAt: null,
    },
  ];
}

export function createTokens(): ApiToken[] {
  return [
    {
      id: fixedId('tok', 1),
      name: 'GitHub Actions deploy',
      scopes: ['write'],
      tokenHint: 'lwy_8Hq2',
      expiresAt: later(60 * 24 * 60),
      lastUsedAt: ago(60 * 8),
      createdAt: ago(60 * 24 * 30),
    },
    {
      id: fixedId('tok', 2),
      name: 'Grafana read-only',
      scopes: ['read'],
      tokenHint: 'lwy_Zt71',
      expiresAt: null,
      lastUsedAt: ago(3),
      createdAt: ago(60 * 24 * 12),
    },
  ];
}

export function createInvitations(): Invitation[] {
  return [
    {
      id: fixedId('inv', 1),
      email: 'jo@example.com',
      role: 'member',
      status: 'pending',
      invitedBy: { id: OWNER_ID, name: 'Alex Morgan', email: 'alex@example.com' },
      expiresAt: later(60 * 50),
      acceptedAt: null,
      createdAt: ago(60 * 22),
    },
  ];
}

/** Token of the invitation preview page in the mocks (`/invite/<token>`). */
export const MOCK_INVITATION_TOKEN = `lwyi_${'a'.repeat(43)}`;

// --- Nodes -------------------------------------------------------------------------------------

export const EDGE_NODE_ID = fixedId('node', 1);
export const NAS_NODE_ID = fixedId('node', 2);

export function createNodes(): Node[] {
  const docker = (cpus: number, memoryGiB: number, arch: string) => ({
    serverVersion: '28.4.0',
    apiVersion: '1.51',
    composeVersion: '2.39.2',
    operatingSystem: 'Debian GNU/Linux 13 (trixie)',
    osType: 'linux',
    kernelVersion: '6.12.43+deb13-amd64',
    architecture: arch,
    cpus,
    memoryBytes: memoryGiB * 1024 ** 3,
    storageDriver: 'overlayfs',
    rootDir: '/var/lib/docker',
  });
  return [
    {
      id: EDGE_NODE_ID,
      name: 'edge-01',
      status: 'online',
      isEdge: true,
      lanIp: '192.168.1.10',
      hostname: 'edge-01.lan',
      arch: 'x86_64',
      agentVersion: '0.1.0',
      protocolVersion: 1,
      docker: docker(8, 32, 'x86_64'),
      allowedBindRoots: ['/srv/data', '/run/desktop/mnt/host/d/Backups'],
      lastSeenAt: ago(0.2),
      joinedAt: ago(60 * 24 * 40),
      createdAt: ago(60 * 24 * 40),
      updatedAt: ago(0.2),
    },
    {
      id: NAS_NODE_ID,
      name: 'nas',
      status: 'online',
      isEdge: false,
      lanIp: '192.168.1.20',
      hostname: 'nas.lan',
      arch: 'aarch64',
      agentVersion: '0.1.0',
      protocolVersion: 1,
      docker: { ...docker(4, 8, 'aarch64'), kernelVersion: '6.12.43+deb13-arm64' },
      allowedBindRoots: [],
      lastSeenAt: ago(0.3),
      joinedAt: ago(60 * 24 * 20),
      createdAt: ago(60 * 24 * 20),
      updatedAt: ago(0.3),
    },
    {
      id: fixedId('node', 3),
      name: 'pi-garage',
      status: 'offline',
      isEdge: false,
      lanIp: '192.168.1.31',
      hostname: 'pi-garage',
      arch: 'aarch64',
      agentVersion: '0.1.0',
      protocolVersion: 1,
      docker: { ...docker(4, 4, 'aarch64'), operatingSystem: 'Raspberry Pi OS' },
      allowedBindRoots: [],
      lastSeenAt: ago(60 * 7),
      joinedAt: ago(60 * 24 * 10),
      createdAt: ago(60 * 24 * 10),
      updatedAt: ago(60 * 7),
    },
  ];
}

// --- GitHub ------------------------------------------------------------------------------------

export const APP_CONNECTION_ID = fixedId('gh', 1);

export function createConnections(): GitHubConnection[] {
  return [
    {
      id: APP_CONNECTION_ID,
      kind: 'app',
      name: 'Launchway (example-org)',
      account: { login: 'example-org', type: 'Organization' },
      app: {
        appId: 1_204_331,
        slug: 'launchway-example-org',
        htmlUrl: 'https://github.com/apps/launchway-example-org',
        installUrl: 'https://github.com/apps/launchway-example-org/installations/new',
        installationId: 61_234_567,
      },
      webhooksEnabled: true,
      createdAt: ago(60 * 24 * 39),
      updatedAt: ago(60 * 24 * 39),
    },
    {
      id: fixedId('gh', 2),
      kind: 'pat',
      name: 'Personal repositories',
      account: { login: 'alexmorgan', type: 'User' },
      app: null,
      webhooksEnabled: false,
      createdAt: ago(60 * 24 * 10),
      updatedAt: ago(60 * 24 * 10),
    },
  ];
}

const REPO_NAMES: [string, string, string | null, boolean][] = [
  ['example-org', 'trail', 'Hiking trail planner with offline maps', false],
  ['example-org', 'notes', 'Markdown notes with full-text search', true],
  ['example-org', 'mailserver', 'Compose wrapper around a mail server', true],
  ['example-org', 'status-page', 'Public status page', false],
  ['example-org', 'gate', 'oauth2-proxy + Pocket ID forward-auth gate', true],
  ['example-org', 'media', null, true],
  ['alexmorgan', 'homepage', 'Personal homepage', false],
];

export function createRepos(): GitHubRepo[] {
  return REPO_NAMES.map(([owner, name, description, isPrivate], index) => ({
    id: 700_000 + index,
    owner,
    name,
    fullName: `${owner}/${name}`,
    private: isPrivate,
    defaultBranch: 'main',
    description,
    htmlUrl: `https://github.com/${owner}/${name}`,
    pushedAt: ago(60 * (index * 9 + 2)),
  }));
}

export function createReleases(fullName: string): GitHubRelease[] {
  const versions = fullName.endsWith('/trail')
    ? ['v1.5.0-rc.1', 'v1.4.2', 'v1.4.1', 'v1.4.0', 'v1.3.0']
    : fullName.endsWith('/homepage')
      ? []
      : ['v2.1.0', 'v2.0.3', 'v2.0.0'];
  return versions.map((tag, index) => ({
    id: 90_000 + index + fullName.length * 100,
    tagName: tag,
    name: tag,
    draft: false,
    prerelease: tag.includes('-'),
    publishedAt: ago(60 * 24 * (index * 6 + 1)),
    htmlUrl: `https://github.com/${fullName}/releases/tag/${tag}`,
    body: `## What's changed\n\n- Improvements for ${tag}`,
    targetCommitish: 'main',
  }));
}

// --- Apps and deployments ----------------------------------------------------------------------

export const TRAIL_APP_ID = fixedId('app', 1);
export const NOTES_APP_ID = fixedId('app', 2);
export const MAIL_APP_ID = fixedId('app', 3);

export function createApps(): App[] {
  const base = {
    connectionId: APP_CONNECTION_ID,
    context: null,
    autoDeployReleases: false,
    autoDeployPrereleases: false,
    autoDeployBranch: null,
    trustedMounts: false,
    proxyServices: [] as string[],
  };
  return [
    {
      ...base,
      id: TRAIL_APP_ID,
      slug: 'trail',
      name: 'Trail',
      description: 'Hiking trail planner',
      repository: { owner: 'example-org', name: 'trail' },
      composeFiles: ['compose.yaml'],
      dockerfile: null,
      nodeId: EDGE_NODE_ID,
      autoDeployReleases: true,
      trustedMounts: true,
      activeDeploymentId: fixedId('dep', 2),
      createdAt: ago(60 * 24 * 30),
      updatedAt: ago(60 * 24),
    },
    {
      ...base,
      id: NOTES_APP_ID,
      slug: 'notes',
      name: 'Notes',
      description: null,
      repository: { owner: 'example-org', name: 'notes' },
      composeFiles: null,
      dockerfile: 'Dockerfile',
      context: '.',
      nodeId: NAS_NODE_ID,
      activeDeploymentId: fixedId('dep', 4),
      createdAt: ago(60 * 24 * 14),
      updatedAt: ago(60 * 24 * 2),
    },
    {
      ...base,
      id: MAIL_APP_ID,
      slug: 'mailserver',
      name: 'Mail server',
      description: 'SMTP/IMAP for example.dev',
      repository: { owner: 'example-org', name: 'mailserver' },
      composeFiles: ['compose.yaml', 'compose.prod.yaml'],
      dockerfile: null,
      nodeId: EDGE_NODE_ID,
      activeDeploymentId: null,
      createdAt: ago(60 * 24 * 3),
      updatedAt: ago(60 * 5),
    },
  ];
}

export function createDeployments(): Deployment[] {
  const deployment = (
    n: number,
    appId: App['id'],
    nodeId: Node['id'],
    ref: string,
    status: Deployment['status'],
    minutesAgo: number,
    extra: Partial<Deployment> = {},
  ): Deployment => ({
    id: fixedId('dep', n),
    appId,
    nodeId,
    ref,
    commitSha: sha(n),
    trigger: 'manual',
    status,
    statusMessage: null,
    triggeredBy: OWNER_ID,
    failureReason: null,
    retryCount: 0,
    nextAttemptAt: null,
    services: [],
    createdAt: ago(minutesAgo),
    startedAt: ago(minutesAgo - 0.1),
    finishedAt: status === 'running' ? null : ago(minutesAgo - 1.5),
    updatedAt: ago(minutesAgo - 1.5),
    ...extra,
  });
  const running = (service: string, port: number | null) => ({
    service,
    containerId: sha(service.length).slice(0, 12),
    state: 'running' as const,
    health: 'healthy' as const,
    publishedPorts:
      port === null
        ? []
        : [{ containerPort: port, hostPort: port, protocol: 'tcp' as const, hostIp: null }],
  });
  return [
    deployment(1, TRAIL_APP_ID, EDGE_NODE_ID, 'v1.4.1', 'superseded', 60 * 24 * 6),
    deployment(2, TRAIL_APP_ID, EDGE_NODE_ID, 'v1.4.2', 'running', 60 * 24, {
      trigger: 'auto',
      triggeredBy: null,
      services: [running('web', null), running('db', null)],
    }),
    deployment(3, NOTES_APP_ID, NAS_NODE_ID, 'v2.0.3', 'superseded', 60 * 24 * 4),
    deployment(4, NOTES_APP_ID, NAS_NODE_ID, 'v2.1.0', 'running', 60 * 24 * 2, {
      services: [running('app', null)],
    }),
    deployment(5, MAIL_APP_ID, EDGE_NODE_ID, 'v2.1.0', 'failed', 60 * 5, {
      statusMessage: 'Policy check failed: service "mail" mounts host path /etc/ssl',
    }),
    deployment(6, MAIL_APP_ID, EDGE_NODE_ID, 'main', 'cancelled', 60 * 4),
  ];
}

export function deploymentLog(deployment: Deployment): LogLine[] {
  const lines: [LogLine['stream'], string][] = [
    ['system', `Cloning example-org at ${deployment.ref} (${deployment.commitSha.slice(0, 7)})`],
    ['stdout', 'Cloning into /var/lib/launchway/apps/…'],
    ['system', 'Checking the Compose policy'],
    ['system', 'Building images'],
    ['stdout', '#1 [internal] load build definition from Dockerfile'],
    ['stdout', '#2 [internal] load metadata for docker.io/library/node:24-alpine'],
    ['stdout', '#5 [build 2/6] RUN pnpm install --frozen-lockfile'],
    ['stdout', '#9 exporting to image'],
    ['system', 'Starting containers'],
    ['stderr', ' Container launchway-app-web-1  Started'],
  ];
  if (deployment.status === 'failed') {
    lines.splice(3, lines.length, ['stderr', deployment.statusMessage ?? 'Deployment failed']);
  } else if (deployment.status === 'running' || deployment.status === 'superseded') {
    lines.push(['system', 'All services are healthy']);
  }
  return lines.map(([stream, line], seq) => ({
    seq,
    stream,
    line,
    timestamp: new Date(Date.parse(deployment.createdAt) + seq * 4_000).toISOString(),
  }));
}

export function createEnv(): Map<string, EnvVar[]> {
  const variable = (n: number, key: string, value: string, secret = false): EnvVar => ({
    id: fixedId('env', n),
    key,
    secret,
    value: secret ? null : value,
    createdAt: ago(60 * 24 * 20),
    updatedAt: ago(60 * 24 * 2),
  });
  return new Map([
    [
      TRAIL_APP_ID,
      [
        variable(1, 'NODE_ENV', 'production'),
        variable(2, 'PUBLIC_URL', 'https://trail.example.com'),
        variable(3, 'DATABASE_URL', '', true),
        variable(4, 'SESSION_SECRET', '', true),
      ],
    ],
    [NOTES_APP_ID, [variable(5, 'SEARCH_LANGUAGE', 'nl')]],
    [MAIL_APP_ID, []],
  ]);
}

// --- DNS, domains, routes ----------------------------------------------------------------------

export const ZONE_COM_ID = fixedId('zone', 1);
export const ZONE_DEV_ID = fixedId('zone', 2);
const ACCOUNT_ID = fixedId('prov', 1);

export const PROVIDERS: DnsProviderInfo[] = [
  {
    kind: 'cloudflare',
    label: 'Cloudflare',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    capabilities: { proxied: true, ttl: true },
    credentialsSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        apiToken: {
          type: 'string',
          minLength: 1,
          format: 'password',
          title: 'API token',
          description: 'Token with Zone:Read and DNS:Edit for the zones Launchway may manage',
        },
        accountId: {
          type: 'string',
          title: 'Account ID',
          description: 'Limits zone discovery to one account',
        },
      },
      required: ['apiToken'],
      additionalProperties: false,
    },
  },
  {
    kind: 'manual',
    label: 'Manual (no API)',
    docsUrl: null,
    capabilities: { proxied: false, ttl: false },
    credentialsSchema: {
      type: 'object',
      properties: {
        zones: { type: 'string', title: 'Zones', description: 'Comma-separated zone names' },
      },
      required: ['zones'],
    },
  },
];

export function createDnsAccounts(): DnsProviderAccount[] {
  return [
    {
      id: ACCOUNT_ID,
      kind: 'cloudflare',
      name: 'Cloudflare',
      lastVerifiedAt: ago(30),
      createdAt: ago(60 * 24 * 38),
      updatedAt: ago(30),
    },
  ];
}

export function createZones(): DnsZone[] {
  return [
    {
      id: ZONE_COM_ID,
      accountId: ACCOUNT_ID,
      externalId: 'cf-zone-7d1e',
      name: 'example.com',
      lastSyncedAt: ago(30),
      createdAt: ago(60 * 24 * 38),
      updatedAt: ago(30),
    },
    {
      id: ZONE_DEV_ID,
      accountId: ACCOUNT_ID,
      externalId: 'cf-zone-91aa',
      name: 'example.dev',
      lastSyncedAt: ago(30),
      createdAt: ago(60 * 24 * 38),
      updatedAt: ago(30),
    },
  ];
}

export function createRecords(): Map<string, DnsRecord[]> {
  const record = (
    n: number,
    type: DnsRecord['type'],
    name: string,
    content: string,
    proxied = false,
  ): DnsRecord => ({
    externalId: `rec-${n}`,
    type,
    name,
    content,
    ttl: 1,
    proxied,
  });
  return new Map([
    [
      ZONE_COM_ID,
      [
        record(1, 'A', 'home.example.com', '203.0.113.45'),
        record(2, 'CNAME', 'trail.example.com', 'home.example.com'),
        record(3, 'CNAME', 'notes.example.com', 'home.example.com'),
        record(4, 'TXT', 'example.com', 'v=spf1 mx -all'),
        record(5, 'CNAME', 'www.example.com', 'example.com', true),
      ],
    ],
    [ZONE_DEV_ID, [record(6, 'A', 'mail.example.dev', '198.51.100.7')]],
  ]);
}

export function createDomains(): Domain[] {
  const domain = (
    n: number,
    hostname: string,
    zoneId: Domain['zoneId'],
    status: Domain['status'],
    statusMessage: string | null = null,
  ): Domain => ({
    id: fixedId('dom', n),
    hostname,
    zoneId,
    managed: zoneId !== null,
    proxied: false,
    force: false,
    status,
    statusMessage,
    lastCheckedAt: ago(4),
    createdAt: ago(60 * 24 * 20),
    updatedAt: ago(4),
  });
  return [
    domain(1, 'trail.example.com', ZONE_COM_ID, 'verified'),
    domain(2, 'notes.example.com', ZONE_COM_ID, 'verified'),
    domain(
      3,
      'mail.example.dev',
      ZONE_DEV_ID,
      'misconfigured',
      'Resolves to 198.51.100.7, expected CNAME home.example.com',
    ),
    domain(4, 'status.example.org', null, 'pending', 'Not checked yet'),
  ];
}

export function createRoutes(): Route[] {
  const base = {
    protected: false,
    compress: true,
    hsts: true,
    extraDirectives: null,
    createdAt: ago(60 * 24 * 20),
    updatedAt: ago(60 * 24 * 2),
  };
  return [
    {
      ...base,
      id: fixedId('rt', 1),
      domainId: fixedId('dom', 1),
      hostname: 'trail.example.com',
      target: { kind: 'app', appId: TRAIL_APP_ID, service: 'web', port: 8080 },
    },
    {
      ...base,
      id: fixedId('rt', 2),
      domainId: fixedId('dom', 2),
      hostname: 'notes.example.com',
      protected: true,
      target: { kind: 'app', appId: NOTES_APP_ID, service: 'app', port: 3000 },
    },
    {
      ...base,
      id: fixedId('rt', 3),
      domainId: fixedId('dom', 4),
      hostname: 'status.example.org',
      target: { kind: 'external', scheme: 'http', host: 'host.docker.internal', port: 7878 },
    },
  ];
}

export function createSettings(): Settings {
  return {
    publicUrl: 'https://deploy.example.com',
    effectivePublicUrl: 'https://deploy.example.com',
    acmeEmail: 'alex@example.com',
    anchorHostname: 'home.example.com',
    dynamicDnsEnabled: true,
    publicIpv4: '203.0.113.45',
    publicIpv4CheckedAt: ago(2),
    forwardAuthUrl: 'http://gate-proxy:4180/oauth2/auth',
    forwardAuthTarget: null,
    edgeNodeId: EDGE_NODE_ID,
    updatedAt: ago(60 * 24),
  };
}

const AUDIT_ACTIONS: [string, string, string][] = [
  ['deployment.create', 'deployment', 'dep'],
  ['app.update', 'app', 'app'],
  ['env.set', 'app', 'app'],
  ['domain.verify', 'domain', 'dom'],
  ['route.create', 'route', 'rt'],
  ['settings.update', 'settings', ''],
  ['token.create', 'token', 'tok'],
  ['user.update', 'user', 'user'],
  ['session.create', 'user', 'user'],
];

export function createAuditEvents(): AuditEvent[] {
  return Array.from({ length: 64 }, (_, index) => {
    const [action, targetType, prefix] = AUDIT_ACTIONS[index % AUDIT_ACTIONS.length] ?? [
      'app.update',
      'app',
      'app',
    ];
    const byToken = index % 7 === 3;
    return {
      id: fixedId('aud', 1000 - index),
      action,
      actor: byToken
        ? { type: 'token' as const, id: fixedId('tok', 1), label: 'GitHub Actions deploy' }
        : index % 11 === 5
          ? { type: 'system' as const, id: null, label: 'ddns' }
          : { type: 'user' as const, id: OWNER_ID, label: 'alex@example.com' },
      target: {
        type: targetType,
        id: prefix ? `${prefix}_01k7${String((index % 4) + 1).padStart(22, '0')}` : null,
      },
      ipAddress: byToken ? '140.82.112.4' : '192.168.1.24',
      userAgent: byToken ? 'curl/8.9.1' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      summary:
        action === 'settings.update'
          ? { acmeEmail: { from: null, to: 'alex@example.com' } }
          : action === 'env.set'
            ? { keys: ['DATABASE_URL'], values: '[redacted]' }
            : null,
      createdAt: ago(index * 47 + 3),
    };
  });
}
