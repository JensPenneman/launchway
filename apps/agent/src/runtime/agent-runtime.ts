import type {
  AgentToServerMessage,
  CheckRunId,
  DeploymentId,
  ServerToAgentMessage,
} from '@launchway/contracts';
import type { Logger } from 'pino';
import { createRequestHandler } from '../handlers.js';
import { AppOps } from './app-ops.js';
import { CheckManager } from './checks.js';
import { DeploymentManager, Semaphore } from './deployments.js';
import { childEnv, type Runner } from './exec.js';
import type { GitConfig } from './git.js';
import { LogStreamManager } from './log-streams.js';
import { Outbox } from './outbox.js';
import { Workspace } from './workspace.js';

export interface AgentRuntimeOptions {
  logger: Logger;
  /** LAUNCHWAY_WORKSPACE. */
  workspace: string;
  /** Sends one frame; false when not connected (the outbox keeps it for later). */
  trySend: (message: AgentToServerMessage) => boolean;
  run?: Runner;
  /** Base environment for git/docker; defaults to the allow-listed agent environment. */
  env?: NodeJS.ProcessEnv;
  gitConfig?: GitConfig;
  /** Values no deployment or check log may show: the node credential and the join token. */
  secrets?: () => readonly (string | null | undefined)[];
  /** Build/pull phases at once on this node, deployments and check runs together (default 2). */
  maxConcurrentBuilds?: number;
  maxLogStreams?: number;
}

export interface AgentRuntime {
  handle: (message: Exclude<ServerToAgentMessage, { type: 'hello.ok' }>) => void;
  /** Call after every completed handshake: delivers results kept while disconnected. */
  onConnected: () => void;
  activeDeploymentIds: () => DeploymentId[];
  /** Check runs queued or running (heartbeat `activeCheckRunIds`). */
  activeCheckRunIds: () => CheckRunId[];
  /**
   * Clears leftovers of earlier check runs; call once at start (check runs wait for it). A slug
   * limits it to that app's runs on the shared Docker daemon.
   */
  sweepChecks: (scope?: { slug?: string }) => void;
  /**
   * Ends log streams, interrupts check runs, lets deployments finish within `graceMs`, then
   * fails the rest; check cleanup gets the same grace period.
   */
  shutdown: (graceMs: number) => Promise<void>;
}

/** Wires the request handlers (deploy, cancel, stop, remove, status, logs, checks) for one agent. */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const { logger } = options;
  const env = options.env ?? childEnv();
  const outbox = new Outbox(options.trySend);
  const workspace = new Workspace(options.workspace);
  const shared = { logger, send: outbox.send, env, ...(options.run ? { run: options.run } : {}) };
  const git = options.gitConfig ? { gitConfig: options.gitConfig } : {};
  // One set of build slots for the node: deployments and check runs build through it.
  const builds = new Semaphore(options.maxConcurrentBuilds ?? 2);
  const secrets = options.secrets ? { secrets: options.secrets } : {};
  const deployments = new DeploymentManager({ ...shared, ...git, ...secrets, workspace, builds });
  const checks = new CheckManager({ ...shared, ...git, ...secrets, workspace, builds });
  const logStreams = new LogStreamManager({
    ...shared,
    neutralDir: () => workspace.neutralDir(),
    ...(options.maxLogStreams ? { maxStreams: options.maxLogStreams } : {}),
  });
  const apps = new AppOps({ ...shared, workspace });
  const handle = createRequestHandler({
    logger,
    send: outbox.send,
    deployments,
    checks,
    logStreams,
    apps,
  });
  return {
    handle,
    onConnected: () => outbox.flush(),
    activeDeploymentIds: () => deployments.activeDeploymentIds(),
    activeCheckRunIds: () => checks.activeCheckRunIds(),
    sweepChecks: (scope) => checks.sweep(scope),
    shutdown: async (graceMs) => {
      logStreams.stopAll();
      await Promise.all([deployments.shutdown(graceMs), checks.shutdown(graceMs)]);
      outbox.flush();
    },
  };
}
