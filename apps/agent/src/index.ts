import { hostname } from 'node:os';
import { AGENT_PROTOCOL_VERSION } from '@slipway/contracts';
import { AgentConfigError, loadAgentConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { loadCredentials, type StoredCredentials, saveCredentials } from './credentials.js';
import { createDockerClient, normalizeArch, probeDocker } from './docker.js';
import { detectLanIp } from './lan-ip.js';
import { LIVENESS_INTERVAL_MS, writeLiveness } from './liveness.js';
import { createLogger } from './logger.js';
import { createAgentRuntime } from './runtime/agent-runtime.js';
import { AGENT_VERSION } from './version.js';

function readConfig() {
  try {
    return loadAgentConfig(process.env);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const logger = createLogger(config.logLevel);
const docker = createDockerClient(config.dockerHost);
let credentials: StoredCredentials | null = await loadCredentials(config.workspace);

if (!credentials && !config.joinToken) {
  logger.fatal(
    'Not joined yet and SLIPWAY_JOIN_TOKEN is not set. Create a node in the UI to get a join token.',
  );
  process.exit(1);
}

/** Running deployments get this long to finish on SIGTERM before they are reported as failed. */
const SHUTDOWN_GRACE_MS = 20_000;

const runtime = createAgentRuntime({
  logger,
  workspace: config.workspace,
  trySend: (message) => connection.connected && connection.send(message),
});

const connection: AgentConnection = new AgentConnection({
  url: config.socketUrl,
  logger,
  token: () => credentials?.credential ?? config.joinToken,
  hello: async () => {
    const probe = await probeDocker(docker);
    if (probe.dockerError) logger.warn({ error: probe.dockerError }, 'Docker probe failed');
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      hostname: hostname(),
      platform: {
        os: process.platform,
        arch: normalizeArch(probe.docker?.architecture ?? process.arch),
      },
      lanIp: config.lanIp ?? detectLanIp(),
      docker: probe.docker,
      dockerError: probe.dockerError,
    };
  },
  onHelloOk: async (payload) => {
    if (payload.credential) {
      credentials = { nodeId: payload.nodeId, credential: payload.credential };
      await saveCredentials(config.workspace, credentials);
      logger.info({ nodeId: payload.nodeId }, 'joined; node credential stored');
    }
  },
  onReady: () => runtime.onConnected(),
  onRequest: (message) => runtime.handle(message),
  activeDeployments: () => runtime.activeDeploymentIds(),
});

const reportLiveness = () => {
  writeLiveness({ at: new Date().toISOString(), connected: connection.connected }).catch(
    (err: unknown) => {
      logger.warn({ err }, 'failed to write the liveness file');
    },
  );
};
reportLiveness();
const liveness = setInterval(reportLiveness, LIVENESS_INTERVAL_MS);

logger.info({ version: AGENT_VERSION, url: config.socketUrl }, 'Slipway agent starting');
connection.start();

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'uncaught exception');
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  clearInterval(liveness);
  runtime
    .shutdown(SHUTDOWN_GRACE_MS)
    .catch((err: unknown) => logger.error({ err }, 'failed to stop deployments cleanly'))
    .then(() => connection.stop())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
