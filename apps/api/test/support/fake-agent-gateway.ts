import type {
  AppLogLine,
  DeploymentId,
  DeployPayload,
  NodeId,
  ServiceStatus,
} from '@slipway/contracts';
import {
  type AgentGateway,
  AgentUnavailableError,
  type AppTarget,
  type LogsRequest,
} from '../../src/lib/agent-gateway.js';

/** In-memory AgentGateway: records commands; nodes are online once `connect`ed. */
export class FakeAgentGateway implements AgentGateway {
  readonly online = new Set<NodeId>();
  readonly deployed: { nodeId: NodeId; payload: DeployPayload }[] = [];
  readonly cancelled: { nodeId: NodeId; deploymentId: DeploymentId }[] = [];
  readonly removed: { nodeId: NodeId; app: AppTarget; removeVolumes: boolean }[] = [];
  readonly stopped: { nodeId: NodeId; app: AppTarget }[] = [];
  services: ServiceStatus[] = [];
  logLines: AppLogLine[] = [];
  /** Error thrown by `deploy` once (e.g. a policy violation reply). */
  deployError: Error | undefined;
  /** Error thrown by `cancelDeployment` once (e.g. a `not-found` reply or a timeout). */
  cancelError: Error | undefined;

  connect(nodeId: NodeId): void {
    this.online.add(nodeId);
  }

  disconnect(nodeId: NodeId): void {
    this.online.delete(nodeId);
  }

  isOnline(nodeId: NodeId): boolean {
    return this.online.has(nodeId);
  }

  private require(nodeId: NodeId): void {
    if (!this.online.has(nodeId)) throw new AgentUnavailableError(nodeId);
  }

  async deploy(nodeId: NodeId, payload: DeployPayload): Promise<void> {
    this.require(nodeId);
    const error = this.deployError;
    this.deployError = undefined;
    if (error) throw error;
    this.deployed.push({ nodeId, payload });
  }

  async cancelDeployment(nodeId: NodeId, deploymentId: DeploymentId): Promise<void> {
    this.require(nodeId);
    const error = this.cancelError;
    this.cancelError = undefined;
    if (error) throw error;
    this.cancelled.push({ nodeId, deploymentId });
  }

  async stopApp(nodeId: NodeId, app: AppTarget): Promise<ServiceStatus[]> {
    this.require(nodeId);
    this.stopped.push({ nodeId, app });
    return this.services.map((s) => ({ ...s, state: 'exited' as const }));
  }

  async removeApp(nodeId: NodeId, app: AppTarget, removeVolumes: boolean): Promise<void> {
    this.require(nodeId);
    this.removed.push({ nodeId, app, removeVolumes });
  }

  async appStatus(nodeId: NodeId, _app: AppTarget): Promise<ServiceStatus[]> {
    this.require(nodeId);
    return this.services;
  }

  async streamLogs(
    nodeId: NodeId,
    request: LogsRequest,
    onLine: (line: AppLogLine) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.require(nodeId);
    for (const line of this.logLines) {
      if (request.service === undefined || line.service === request.service) onLine(line);
    }
    if (!request.follow) return;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}
