import type { DeploymentId, DeploymentStatus, LogLine } from '@slipway/contracts';
import type { EventBus } from '../../lib/event-bus.js';

export type DeploymentStreamItem =
  | { readonly kind: 'log'; readonly line: LogLine }
  | { readonly kind: 'status'; readonly status: DeploymentStatus }
  | { readonly kind: 'end'; readonly status: DeploymentStatus };

type Listener = (item: DeploymentStreamItem) => void;

/**
 * In-process fan-out of live deployment output (log lines and status changes) from the
 * deployment sink to `GET /deployments/{id}/logs?follow=true` subscribers. Persisted lines are
 * the source of truth; this only carries what happens while a client is connected.
 */
export interface DeploymentLogHub {
  publish(deploymentId: DeploymentId, item: DeploymentStreamItem): void;
  subscribe(deploymentId: DeploymentId, listener: Listener): () => void;
}

function createDeploymentLogHub(): DeploymentLogHub {
  const listeners = new Map<DeploymentId, Set<Listener>>();
  return {
    publish(deploymentId, item) {
      for (const listener of listeners.get(deploymentId) ?? []) {
        try {
          listener(item);
        } catch {
          // A failing subscriber must not break the sink.
        }
      }
    },
    subscribe(deploymentId, listener) {
      let set = listeners.get(deploymentId);
      if (!set) {
        set = new Set();
        listeners.set(deploymentId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(deploymentId);
      };
    },
  };
}

const hubs = new WeakMap<EventBus, DeploymentLogHub>();

/**
 * The hub shared by the sink and the routes of one process. It is keyed by the event bus so that
 * every holder of the same `Deps` (or of a copy with the same bus) sees the same hub.
 */
export function logHubFor(events: EventBus): DeploymentLogHub {
  let hub = hubs.get(events);
  if (!hub) {
    hub = createDeploymentLogHub();
    hubs.set(events, hub);
  }
  return hub;
}
