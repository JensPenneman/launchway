import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { pino } from 'pino';
import { describe, expect, inject, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.js';
import { checkRuns, nodes, settings } from '../../src/db/schema.js';
import { insertApp } from '../support/edge-fixtures.js';

/** A migrations folder that ends before `tag`, as an installation of an older version has it. */
async function migrationsBefore(tag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'launchway-migrations-'));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const path = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`no migration ${tag}`);
  journal.entries = journal.entries.slice(0, index);
  await writeFile(path, JSON.stringify(journal));
  return folder;
}

/**
 * A pool whose `close()` resolves once every connection it opened is closed. `pool.end()` resolves
 * as soon as the pool has let go of its clients, before their connections are gone; a database
 * dropped then would terminate them under the pool (57P01, an error event nobody listens to).
 */
function trackedPool(connectionString: string): { pool: pg.Pool; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString });
  const open = new Set<pg.PoolClient>();
  pool.on('connect', (client) => open.add(client));
  pool.on('remove', (client) => open.delete(client));
  return {
    pool,
    close: async () => {
      await pool.end();
      while (open.size > 0) await new Promise((resolve) => pool.once('remove', resolve));
    },
  };
}

describe('migrations', () => {
  it('0008 applies on a database with running check runs and lets a node run several', async () => {
    const url = new URL(inject('databaseUrl'));
    const name = `launchway_migrate_${randomBytes(4).toString('hex')}`;
    const admin = trackedPool(url.toString());
    await admin.pool.query(`CREATE DATABASE ${name}`);
    url.pathname = `/${name}`;
    const { pool, close } = trackedPool(url.toString());
    const folder = await migrationsBefore('0008_check_concurrency');
    try {
      await migrate(drizzle(pool), { migrationsFolder: folder });
      const db = createDatabase(pool);
      const [node] = await db.insert(nodes).values({ name: 'busy' }).returning({ id: nodes.id });
      if (!node) throw new Error('node insert failed');
      const appId = await insertApp(db, node.id, 'migrated');
      const run = (status: 'queued' | 'running') => ({
        appId,
        nodeId: node.id,
        name: 'quality',
        command: 'npm test',
        service: 'dev',
        composeFiles: ['.devcontainer/compose.yaml'],
        timeoutMinutes: 30,
        commitSha: randomBytes(20).toString('hex'),
        trigger: 'manual' as const,
        status,
        ...(status === 'running' ? { startedAt: new Date() } : {}),
      });
      const [running] = await db.insert(checkRuns).values(run('running')).returning();
      await db.insert(checkRuns).values(run('queued'));
      // Before: one running run per node.
      await expect(db.insert(checkRuns).values(run('running'))).rejects.toThrow();
      await db.execute(sql`INSERT INTO settings (id) VALUES (1)`);

      await runMigrations(pool, pino({ level: 'silent' }));

      const rows = await db.select().from(checkRuns);
      expect(rows.map((row) => row.status).sort()).toEqual(['queued', 'running']);
      expect(rows.find((row) => row.status === 'running')?.id).toBe(running?.id);
      await db.insert(checkRuns).values(run('running'));
      const indexes = await db.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes WHERE tablename = 'check_runs'`,
      );
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).not.toContain('check_runs_one_running_per_node');
      expect(names).toContain('check_runs_node_id_status_idx');
      const [row] = await db.select({ checkConcurrency: settings.checkConcurrency }).from(settings);
      expect(row?.checkConcurrency).toBe(1);
    } finally {
      // Every connection to the database is closed first; without FORCE, one left open fails here.
      await close();
      await admin.pool.query(`DROP DATABASE ${name}`);
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
