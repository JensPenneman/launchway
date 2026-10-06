import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import type { Deps } from './deps.js';
import { anonymousAuthResolver } from './lib/auth-context.js';
import { createSecretBox } from './lib/crypto.js';
import { createEventBus } from './lib/event-bus.js';
import { createLifecycle } from './lib/lifecycle.js';
import { openApiObject } from './lib/openapi.js';
import { APP_VERSION } from './version.js';

/**
 * Builds the OpenAPI document without starting anything: route registration needs no database
 * connection (the pool below is never queried).
 */
export function buildOpenApiDocument() {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://openapi@localhost/openapi',
    SLIPWAY_SECRET_KEY: randomBytes(32).toString('base64'),
    SLIPWAY_WEB_ROOT: '/nonexistent',
  });
  const deps: Deps = {
    config,
    logger: pino({ level: 'silent' }),
    db: createDatabase(new pg.Pool({ connectionString: config.databaseUrl })),
    secrets: createSecretBox(config.secretKey),
    auth: anonymousAuthResolver,
    events: createEventBus(),
    lifecycle: createLifecycle(),
    version: APP_VERSION,
  };
  return createApp(deps).getOpenAPI31Document(openApiObject(APP_VERSION));
}
