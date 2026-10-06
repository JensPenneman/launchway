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

async function connectWithRetry(
  pool: pg.Pool,
  logger: Logger,
  attempts = 10,
): Promise<pg.PoolClient> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (attempt >= attempts) throw err;
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
      logger.warn({ attempt, delayMs }, 'database not reachable yet, retrying');
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
