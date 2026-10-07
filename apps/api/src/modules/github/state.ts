import type { GitHubConnectionCapabilities, GitHubConnectionId } from '@launchway/contracts';
import type { EventBus } from '../../lib/event-bus.js';

/** Capabilities as checked on GitHub; `lastDeniedAt` is added live from the denials below. */
export type CheckedCapabilities = Omit<GitHubConnectionCapabilities, 'lastDeniedAt'>;

/** A refusal is logged and announced at most once per connection per hour. */
export const DENIAL_LOG_INTERVAL_MS = 60 * 60 * 1000;

export interface Denial {
  /** Epoch milliseconds of the last refused request. */
  readonly at: number;
  readonly status: number;
}

/**
 * In-process state shared by the deployment mirror and the capabilities endpoint of one platform
 * instance (keyed by its event bus, like the deployment log hub): GitHub's refusals per connection
 * and the 5-minute capability cache.
 */
export interface GitHubConnectionState {
  readonly denials: Map<GitHubConnectionId, Denial>;
  /** When a refusal of a connection was last logged and announced (once per hour). */
  readonly denialAnnouncedAt: Map<GitHubConnectionId, number>;
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
  state.capabilities.delete(id);
}
