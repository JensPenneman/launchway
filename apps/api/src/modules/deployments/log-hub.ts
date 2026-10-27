import type { DeploymentStatus } from '@launchway/contracts';
import type { EventBus } from '../../lib/event-bus.js';
import { type LogHub, logHubFor as sharedLogHub } from '../../lib/log-stream.js';

/**
 * Live output of deployments (log lines and status changes) from the deployment sink to
 * `GET /deployments/{id}/logs?follow=true` subscribers, shared per event bus.
 */
export function logHubFor(events: EventBus): LogHub<DeploymentStatus> {
  return sharedLogHub<DeploymentStatus>(events, 'deployments');
}
