import type { GitHubConnectionCapabilities, GitHubConnectionId } from '@launchway/contracts';
import type { EventBus } from '../../lib/event-bus.js';
import { forgetInstallationTokens } from '../../lib/git-provider.js';

/**
 * Capabilities as checked on GitHub; `lastDeniedAt` and `lastStatusDeniedAt` are added live from
 * the denials below.
 */
export type CheckedCapabilities = Omit<
  GitHubConnectionCapabilities,
  'lastDeniedAt' | 'lastStatusDeniedAt'
>;

/** A refusal is logged and announced at most once per connection per hour. */
export const DENIAL_LOG_INTERVAL_MS = 60 * 60 * 1000;
/** After a refusal, new requests of the same kind for the connection pause this long. */
export const DENIAL_PAUSE_MS = 5 * 60 * 1000;
/** Cached installation tokens are dropped after a refusal at most this often. */
const TOKEN_FORGET_INTERVAL_MS = 5 * 60 * 1000;

export interface Denial {
  /** Epoch milliseconds of the last refused request. */
  readonly at: number;
  readonly status: number;
}

/**
 * In-process state shared by the GitHub mirrors (deployments, commit statuses) and the
 * capabilities endpoint of one platform instance (keyed by its event bus, like the log hubs):
 * GitHub's refusals per connection and the 5-minute capability cache. Deployment and commit
 * status refusals are kept apart, so one missing permission does not pause the other.
 */
export interface GitHubConnectionState {
  /** Refused deployment mirror requests (`deployments: write`). */
  readonly denials: Map<GitHubConnectionId, Denial>;
  /** When a deployment refusal of a connection was last logged and announced (once per hour). */
  readonly denialAnnouncedAt: Map<GitHubConnectionId, number>;
  /** Refused commit statuses of checks (`statuses: write`). */
  readonly statusDenials: Map<GitHubConnectionId, Denial>;
  /** When a commit status refusal of a connection was last logged and announced. */
  readonly statusDenialAnnouncedAt: Map<GitHubConnectionId, number>;
  /** When the cached installation tokens of a GitHub App were last dropped after a refusal. */
  readonly tokensForgottenAt: Map<number, number>;
  readonly capabilities: Map<
    GitHubConnectionId,
    { readonly value: CheckedCapabilities; readonly expiresAt: number }
  >;
}

const states = new WeakMap<EventBus, GitHubConnectionState>();

export function githubConnectionState(events: EventBus): GitHubConnectionState {
  let state = states.get(events);
  if (!state) {
    state = {
      denials: new Map(),
      denialAnnouncedAt: new Map(),
      statusDenials: new Map(),
      statusDenialAnnouncedAt: new Map(),
      tokensForgottenAt: new Map(),
      capabilities: new Map(),
    };
    states.set(events, state);
  }
  return state;
}

/** Forgets what is known about a connection (deleted, reinstalled, permissions accepted). */
export function resetConnectionState(events: EventBus, id: GitHubConnectionId): void {
  const state = githubConnectionState(events);
  state.denials.delete(id);
  state.denialAnnouncedAt.delete(id);
  state.statusDenials.delete(id);
  state.statusDenialAnnouncedAt.delete(id);
  state.capabilities.delete(id);
}

/**
 * After GitHub refused a request of a connection: drops its cached capabilities (the hint must
 * show the refusal) and, at most every 5 minutes, the cached installation tokens of its GitHub
 * App. Installation tokens carry the permissions of their creation; a fresh one picks up a
 * permission the owner approved in the meantime.
 */
export function forgetAfterDenial(
  state: GitHubConnectionState,
  connection: { readonly id: GitHubConnectionId; readonly appId: number | null },
  at: number,
): void {
  state.capabilities.delete(connection.id);
  if (connection.appId === null) return;
  const forgotten = state.tokensForgottenAt.get(connection.appId) ?? 0;
  if (at - forgotten < TOKEN_FORGET_INTERVAL_MS) return;
  state.tokensForgottenAt.set(connection.appId, at);
  forgetInstallationTokens(connection.appId);
}
