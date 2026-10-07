import { randomBytes } from 'node:crypto';
import { generateId, type UserRole } from '@launchway/contracts';
import pg from 'pg';
import { pino } from 'pino';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/client.js';
import type { Deps } from '../../src/deps.js';
import { createUnavailableAgentGateway } from '../../src/lib/agent-gateway.js';
import {
  type AuthResolver,
  anonymousAuthResolver,
  type Principal,
} from '../../src/lib/auth-context.js';
import { createSecretBox } from '../../src/lib/crypto.js';
import { createEventBus } from '../../src/lib/event-bus.js';
import { createLifecycle } from '../../src/lib/lifecycle.js';

/**
 * Dependencies for tests. Without an explicit `db`, the database points at a pool that is never
 * connected: fine for routes that fail before reaching a service (auth, validation).
 */
export function createTestDeps(overrides: Partial<Deps> = {}): Deps {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
    LAUNCHWAY_SECRET_KEY: randomBytes(32).toString('base64'),
    LAUNCHWAY_WEB_ROOT: '/nonexistent',
  });
  return {
    config,
    logger: pino({ level: 'silent' }),
    db: createDatabase(new pg.Pool({ connectionString: config.databaseUrl })),
    secrets: createSecretBox(config.secretKey),
    auth: anonymousAuthResolver,
    events: createEventBus(),
    lifecycle: createLifecycle(),
    agents: createUnavailableAgentGateway(),
    version: '0.0.0-test',
    ...overrides,
  };
}

/** A session principal with the given role. */
export function testPrincipal(role: UserRole): Principal {
  return {
    kind: 'session',
    sessionId: generateId('sess'),
    user: { id: generateId('user'), email: `${role}@example.com`, name: `Test ${role}`, role },
  };
}

/** Auth resolver that always returns `principal`. */
export function fixedAuth(principal: Principal | null): AuthResolver {
  return { resolve: () => Promise.resolve(principal) };
}
