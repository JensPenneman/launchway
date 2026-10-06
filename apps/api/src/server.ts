import type { Server } from 'node:http';
import { serve, type WebSocketServerLike } from '@hono/node-server';
import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { createDatabase, createPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type { Deps } from './deps.js';
import { createUnavailableAgentGateway } from './lib/agent-gateway.js';
import { createSecretBox } from './lib/crypto.js';
import { createEventBus } from './lib/event-bus.js';
import { createLifecycle } from './lib/lifecycle.js';
import { createLogger } from './logger.js';
import { createAuthResolver } from './modules/auth/resolver.js';
import { startDeploymentWorker } from './modules/deployments/dispatcher.js';
import { startReleasePoller } from './modules/github/poller.js';
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

/** Composition root: config -> logger -> database + migrations -> app -> HTTP server. */
export async function start(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ level: config.logLevel });
  installProcessHandlers(logger);

  const pool = createPool(config.databaseUrl, logger);
  await runMigrations(pool, logger);

  const lifecycle = createLifecycle();
  const db = createDatabase(pool);
  const deps: Deps = {
    config,
    logger,
    db,
    secrets: createSecretBox(config.secretKey),
    auth: createAuthResolver({ db, logger }),
    events: createEventBus(),
    lifecycle,
    agents: createUnavailableAgentGateway(), // TODO(nodes): replace with the WebSocket gateway.
    version: APP_VERSION,
  };
  const app = createApp(deps);
  // Background jobs; both stop when lifecycle.signal aborts.
  startDeploymentWorker(deps);
  startReleasePoller(deps);

  // WebSocket upgrades (agent socket) are handled by `upgradeWebSocket` from @hono/node-server.
  const wss = new WebSocketServer({ noServer: true });
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
