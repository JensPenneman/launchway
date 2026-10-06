import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Provides a migrated PostgreSQL database to the integration tests: TEST_DATABASE_URL when set
 * (CI service container), otherwise a throwaway postgres:18-alpine container via Testcontainers.
 */
export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    databaseUrl = container.getConnectionUri();
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool, pino({ level: 'silent' }));
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container?.stop();
  };
}
