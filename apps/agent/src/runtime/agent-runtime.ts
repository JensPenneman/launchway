import type { AgentToServerMessage, DeploymentId, ServerToAgentMessage } from '@slipway/contracts';
import type { Logger } from 'pino';
import { createRequestHandler } from '../handlers.js';
import { AppOps } from './app-ops.js';
import { DeploymentManager } from './deployments.js';
import { childEnv, type Runner } from './exec.js';
import type { GitConfig } from './git.js';
import { LogStreamManager } from './log-streams.js';
import { Outbox } from './outbox.js';
import { Workspace } from './workspace.js';

export interface AgentRuntimeOptions {
  logger: Logger;
  /** SLIPWAY_WORKSPACE. */
  workspace: string;
  /** Sends one frame; false when not connected (the outbox keeps it for later). */
  trySend: (message: AgentToServerMessage) => boolean;
  run?: Runner;
  /** Base environment for git/docker; defaults to the allow-listed agent environment. */
  env?: NodeJS.ProcessEnv;
  gitConfig?: GitConfig;
  maxConcurrentBuilds?: number;
  maxLogStreams?: number;
}

export interface AgentRuntime {
  handle: (message: Exclude<ServerToAgentMessage, { type: 'hello.ok' }>) => void;
  /** Call after every completed handshake: delivers results kept while disconnected. */
  onConnected: () => void;
  activeDeploymentIds: () => DeploymentId[];
  /** Ends log streams, lets deployments finish within `graceMs`, then fails the rest. */
  shutdown: (graceMs: number) => Promise<void>;
}

/** Wires the request handlers (deploy, cancel, stop, remove, status, logs) for one agent. */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const { logger } = options;
  const env = options.env ?? childEnv();
  const outbox = new Outbox(options.trySend);
  const workspace = new Workspace(options.workspace);
  const shared = { logger, send: outbox.send, env, ...(options.run ? { run: options.run } : {}) };
  const deployments = new DeploymentManager({
    ...shared,
    workspace,
    ...(options.gitConfig ? { gitConfig: options.gitConfig } : {}),
    ...(options.maxConcurrentBuilds ? { maxConcurrentBuilds: options.maxConcurrentBuilds } : {}),
  });
  const logStreams = new LogStreamManager({
    ...shared,
    neutralDir: () => workspace.neutralDir(),
    ...(options.maxLogStreams ? { maxStreams: options.maxLogStreams } : {}),
  });
  const apps = new AppOps({ ...shared, workspace });
  const handle = createRequestHandler({ logger, send: outbox.send, deployments, logStreams, apps });
  return {
    handle,
    onConnected: () => outbox.flush(),
    activeDeploymentIds: () => deployments.activeDeploymentIds(),
    shutdown: async (graceMs) => {
      logStreams.stopAll();
      await deployments.shutdown(graceMs);
      outbox.flush();
    },
  };
}
