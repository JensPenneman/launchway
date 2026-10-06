import { hostname } from 'node:os';
import { AGENT_PROTOCOL_VERSION } from '@slipway/contracts';
import { AgentConfigError, loadAgentConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { loadCredentials, type StoredCredentials, saveCredentials } from './credentials.js';
import { createDockerClient, normalizeArch, probeDocker } from './docker.js';
import { createRequestHandler } from './handlers.js';
import { detectLanIp } from './lan-ip.js';
import { LIVENESS_INTERVAL_MS, writeLiveness } from './liveness.js';
import { createLogger } from './logger.js';
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

const connection = new AgentConnection({
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
  onRequest: createRequestHandler(logger, (message) => connection.send(message)),
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

const shutdown = (signal: NodeJS.Signals) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(liveness);
  connection.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
