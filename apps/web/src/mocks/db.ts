import type {
  Deployment,
  DnsRecord,
  EnvVar,
  EventAction,
  EventTopic,
  LogLine,
  PlatformEvent,
  User,
  UserRole,
} from '@launchway/contracts';
import {
  createApps,
  createAuditEvents,
  createConnections,
  createDeployments,
  createDnsAccounts,
  createDomains,
  createEnv,
  createInvitations,
  createNodes,
  createPasskeys,
  createRecords,
  createRoutes,
  createSessions,
  createSettings,
  createTokens,
  createUsers,
  createZones,
  deploymentLog,
  OWNER_ID,
} from './fixtures';

/**
 * Scenario of the mock API, chosen with `localStorage['launchway-mock-scenario']` before the page
 * loads (e2e tests use `page.addInitScript`): `default` (signed in as owner), `fresh` (no owner
 * yet), `signed-out`, `viewer` (signed in as a viewer).
 */
export type MockScenario = 'default' | 'fresh' | 'signed-out' | 'viewer';

export const SCENARIO_STORAGE_KEY = 'launchway-mock-scenario';

function readScenario(): MockScenario {
  try {
    const value = localStorage.getItem(SCENARIO_STORAGE_KEY);
    if (value === 'fresh' || value === 'signed-out' || value === 'viewer') return value;
  } catch {
    // Storage unavailable: default scenario.
  }
  return 'default';
}

type Listener<T> = (value: T) => void;

/** In-memory state of the mock API; mutated by the handlers like a real backend would. */
export class MockDb {
  scenario = readScenario();
  users: User[] = this.scenario === 'fresh' ? [] : createUsers();
  /** Signed-in user id, or null. */
  sessionUserId: string | null =
    this.scenario === 'default'
      ? OWNER_ID
      : this.scenario === 'viewer'
        ? (this.users[3]?.id ?? null)
        : null;
  sessions = createSessions();
  passkeys = createPasskeys();
  tokens = createTokens();
  invitations = createInvitations();
  nodes = createNodes();
  connections = createConnections();
  apps = createApps();
  deployments = createDeployments();
  logs = new Map<string, LogLine[]>(this.deployments.map((d) => [d.id, deploymentLog(d)]));
  env = createEnv();
  dnsAccounts = createDnsAccounts();
  zones = createZones();
  records = createRecords();
  domains = createDomains();
  routes = createRoutes();
  settings = createSettings();
  audit = createAuditEvents();
  ddnsLastRun: Record<string, unknown> | null = {
    startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 2 * 60_000 + 800).toISOString(),
    outcome: 'unchanged',
    message: 'Public IPv4 203.0.113.45 unchanged; the anchor record is current.',
    detectedIpv4: '203.0.113.45',
    previousIpv4: '203.0.113.45',
    recordUpdated: false,
    sources: [],
  };
  edgeLoadedAt = new Date().toISOString();
  edgeAppliedCaddyfile: string | null = null;

  private eventSeq = 0;
  private platformListeners = new Set<Listener<PlatformEvent>>();
  private logListeners = new Map<string, Set<Listener<LogLine | Deployment>>>();

  currentUser(): User | undefined {
    return this.users.find((user) => user.id === this.sessionUserId);
  }

  role(): UserRole | null {
    return this.currentUser()?.role ?? null;
  }

  /** Publishes a change-feed event to every `/events` subscriber. */
  emit(topic: EventTopic, action: EventAction, resourceId: string | null): void {
    this.eventSeq += 1;
    const event: PlatformEvent = {
      id: String(this.eventSeq),
      topic,
      action,
      resourceId,
      at: new Date().toISOString(),
    };
    for (const listener of this.platformListeners) listener(event);
  }

  onPlatformEvent(listener: Listener<PlatformEvent>): () => void {
    this.platformListeners.add(listener);
    return () => this.platformListeners.delete(listener);
  }

  /** Follows one deployment: new log lines and deployment updates. */
  onDeployment(id: string, listener: Listener<LogLine | Deployment>): () => void {
    const listeners = this.logListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.logListeners.set(id, listeners);
    return () => listeners.delete(listener);
  }

  appendLog(deploymentId: string, stream: LogLine['stream'], line: string): void {
    const lines = this.logs.get(deploymentId) ?? [];
    const entry: LogLine = { seq: lines.length, stream, line, timestamp: new Date().toISOString() };
    lines.push(entry);
    this.logs.set(deploymentId, lines);
    for (const listener of this.logListeners.get(deploymentId) ?? []) listener(entry);
  }

  updateDeployment(id: string, patch: Partial<Deployment>): Deployment | undefined {
    const deployment = this.deployments.find((item) => item.id === id);
    if (!deployment) return undefined;
    Object.assign(deployment, patch, { updatedAt: new Date().toISOString() });
    for (const listener of this.logListeners.get(id) ?? []) listener(deployment);
    this.emit('deployments', 'updated', id);
    return deployment;
  }

  envOf(appId: string): EnvVar[] {
    const list = this.env.get(appId) ?? [];
    this.env.set(appId, list);
    return list;
  }

  recordsOf(zoneId: string): DnsRecord[] {
    const list = this.records.get(zoneId) ?? [];
    this.records.set(zoneId, list);
    return list;
  }
}

export const db = new MockDb();
