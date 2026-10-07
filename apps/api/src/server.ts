import type { Server } from 'node:http';
import { serve, type WebSocketServerLike } from '@hono/node-server';
import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { createDatabase, createPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type { Deps } from './deps.js';
import { createDeferredDeploymentSink } from './lib/agent-gateway.js';
import { createSecretBox } from './lib/crypto.js';
import { createEventBus } from './lib/event-bus.js';
import { createLifecycle } from './lib/lifecycle.js';
import { createLogger } from './logger.js';
import { createAuthResolver } from './modules/auth/resolver.js';
import { createAuthService } from './modules/auth/service.js';
import { startDeploymentWorker } from './modules/deployments/dispatcher.js';
import { createDeploymentSink } from './modules/deployments/sink.js';
import { createDomainsService } from './modules/domains/service.js';
import { edgeReconciler } from './modules/edge/reconciler.js';
import { startReleasePoller } from './modules/github/poller.js';
import { createAgentGateway } from './modules/nodes/gateway.js';
import { ensureLocalNode } from './modules/nodes/service.js';
import { createSettingsService } from './modules/settings/service.js';
import { APP_VERSION } from './version.js';

const SHUTDOWN_GRACE_MS = 10_000;

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** Tells the operator which URL serves the platform and whether the owner still has to be set up. */
async function logStartupState(deps: Deps, port: number): Promise<void> {
  const [settings, setup] = await Promise.all([
    createSettingsService(deps).get(),
    createAuthService(deps).setupStatus(),
  ]);
  deps.logger.info(
    { publicUrl: settings.effectivePublicUrl },
    settings.effectivePublicUrl ? 'platform URL' : 'no platform URL set yet',
  );
  if (setup.setupRequired) {
    deps.logger.warn(
      { setupTokenRequired: setup.setupTokenRequired },
      `setup required: open http://<this host>:${port}/setup to create the owner account`,
    );
  }
}

/** Composition root: config -> logger -> database + migrations -> app -> HTTP server. */
export async function start(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ level: config.logLevel });
  installProcessHandlers(logger);

  const pool = createPool(config.databaseUrl, logger);
  await runMigrations(pool, logger);

  const lifecycle = createLifecycle();
  const db = createDatabase(pool);
  const core = {
    config,
    logger,
    db,
    secrets: createSecretBox(config.secretKey),
    auth: createAuthResolver({ db, logger }),
    events: createEventBus(),
    lifecycle,
    version: APP_VERSION,
  };
  // The deployment sink dispatches through the gateway and the gateway reports to the sink: the
  // gateway gets a forwarder that is bound to the real sink once `deps` exists. The sink shares
  // `deps.events` with the routes (live deployment logs), so it must be built from `deps`.
  const sink = createDeferredDeploymentSink();
  const agents = createAgentGateway({ deps: core, sink: sink.sink });
  const deps: Deps = { ...core, agents };
  sink.bind(createDeploymentSink(deps));
  const app = createApp(deps);

  await ensureLocalNode(deps);
  // Marks nodes a previous process left online offline (through the sink), then sweeps heartbeats.
  await agents.start();
  const domains = createDomainsService(deps);
  edgeReconciler(deps).start({
    markDomainActive: async (domainId) => {
      await domains.markDomainActive(domainId);
    },
  });
  // Background jobs; they stop when lifecycle.signal aborts.
  startDeploymentWorker(deps);
  startReleasePoller(deps);

  // WebSocket upgrades (agent socket) are handled by `upgradeWebSocket` from @hono/node-server.
  // Agent frames are at most 500 log lines of 16 KiB each.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  // `ws` declares `noServer?: boolean | undefined`; the adapter type omits `| undefined`, which
  // only matters under exactOptionalPropertyTypes. The runtime shapes are identical.
  const websocketServer = wss as unknown as WebSocketServerLike;
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.listen.host,
      port: config.listen.port,
      websocket: { server: websocketServer },
    },
    (info) => {
      logger.info(
        { address: info.address, port: info.port, version: APP_VERSION },
        'Slipway API listening',
      );
      logStartupState(deps, info.port).catch((error: unknown) => {
        logger.warn({ err: error }, 'could not read the platform state');
      });
    },
  ) as Server;

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    lifecycle.beginShutdown();
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    const force = setTimeout(() => {
      logger.warn('closing remaining connections');
      server.closeAllConnections();
      for (const client of wss.clients) client.terminate();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close((error) => {
      clearTimeout(force);
      pool.end().then(
        () => {
          logger.info('shutdown complete');
          process.exit(error ? 1 : 0);
        },
        (poolError: unknown) => {
          logger.error({ err: poolError }, 'failed to close the database pool');
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

function installProcessHandlers(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}
