import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import type { Logger } from 'pino';

/** `apps/api/drizzle`, resolved the same way from src/ (tsx) and dist/ (node). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Arbitrary constant; serializes migrations when several API instances start at once. */
const MIGRATION_LOCK_ID = 7_340_215_017;

/**
 * PostgreSQL errors that waiting does not fix: wrong password or user, unknown database
 * (invalid_password, invalid_authorization_specification, invalid_catalog_name).
 */
const PERMANENT_CONNECT_ERRORS = new Set(['28P01', '28000', '3D000']);

async function connectWithRetry(
  pool: pg.Pool,
  logger: Logger,
  attempts = 10,
): Promise<pg.PoolClient> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (attempt >= attempts || (typeof code === 'string' && PERMANENT_CONNECT_ERRORS.has(code))) {
        throw err;
      }
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
      logger.warn(
        { attempt, delayMs, code, reason: err instanceof Error ? err.message : String(err) },
        'database not reachable yet, retrying',
      );
      await sleep(delayMs);
    }
  }
}

/** Applies pending migrations from `drizzle/` under a PostgreSQL advisory lock. */
export async function runMigrations(pool: pg.Pool, logger: Logger): Promise<void> {
  const client = await connectWithRetry(pool, logger);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
  logger.info('database migrations are up to date');
}
