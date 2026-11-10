import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppId, generateId, type NodeId } from '@launchway/contracts';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { pino } from 'pino';
import { describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from '../../src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.js';
import {
  apps,
  automationRuns,
  checkRuns,
  githubConnections,
  nodes,
  settings,
} from '../../src/db/schema.js';
import { insertApp, unique } from '../support/edge-fixtures.js';

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

/** A node row as a database before 0009 takes it (the schema now has a column that lacks there). */
async function insertNodeBefore0009(db: Database, name: string): Promise<NodeId> {
  const id = generateId('node');
  await db.execute(sql`INSERT INTO nodes (id, name) VALUES (${id}, ${name})`);
  return id;
}

/** An app row as a database before 0012 takes it (the schema now has a column that lacks there). */
async function insertAppBefore0012(db: Database, nodeId: NodeId, slug: string): Promise<AppId> {
  const [connection] = await db
    .insert(githubConnections)
    .values({ kind: 'pat', name: unique('conn-'), tokenEncrypted: 'not-a-real-ciphertext' })
    .returning({ id: githubConnections.id });
  if (!connection) throw new Error('connection insert failed');
  const id = generateId('app');
  await db.execute(
    sql`INSERT INTO apps (id, slug, name, connection_id, repo_owner, repo_name, compose_files, node_id)
        VALUES (${id}, ${slug}, ${slug}, ${connection.id}, 'example', ${slug}, ARRAY['compose.yaml'], ${nodeId})`,
  );
  return id;
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
      const node = { id: await insertNodeBefore0009(db, 'busy') };
      const appId = await insertAppBefore0012(db, node.id, 'migrated');
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

  it('0009 adds the per-node check concurrency and keeps the checks of existing apps', async () => {
    const url = new URL(inject('databaseUrl'));
    const name = `launchway_migrate_${randomBytes(4).toString('hex')}`;
    const admin = trackedPool(url.toString());
    await admin.pool.query(`CREATE DATABASE ${name}`);
    url.pathname = `/${name}`;
    const { pool, close } = trackedPool(url.toString());
    const folder = await migrationsBefore('0009_check_node');
    try {
      await migrate(drizzle(pool), { migrationsFolder: folder });
      const db = createDatabase(pool);
      const node = { id: await insertNodeBefore0009(db, 'edge') };
      const appId = await insertAppBefore0012(db, node.id, 'before-0009');
      await db.execute(sql`UPDATE apps SET checks = '{"enabled":true,"items":[]}'::jsonb`);

      await runMigrations(pool, pino({ level: 'silent' }));

      const [before] = await db.select().from(nodes).where(eq(nodes.id, node.id));
      expect(before?.checkConcurrency).toBeNull();
      const [app] = await db.select({ checks: apps.checks }).from(apps).where(eq(apps.id, appId));
      expect(app?.checks).toMatchObject({ enabled: true });
      expect(app?.checks.nodeId ?? null).toBeNull();
      await db.update(nodes).set({ checkConcurrency: 4 }).where(eq(nodes.id, node.id));
      await expect(
        db.update(nodes).set({ checkConcurrency: 17 }).where(eq(nodes.id, node.id)),
      ).rejects.toThrow();
      await expect(
        db.update(nodes).set({ checkConcurrency: 0 }).where(eq(nodes.id, node.id)),
      ).rejects.toThrow();
      const freshId = await insertApp(db, node.id, 'after-0009');
      const [fresh] = await db
        .select({ checks: apps.checks })
        .from(apps)
        .where(eq(apps.id, freshId));
      expect(fresh?.checks.nodeId).toBeNull();
    } finally {
      await close();
      await admin.pool.query(`DROP DATABASE ${name}`);
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('0012 gives an existing app the automation defaults (merge off, not paused) and cascades its runs', async () => {
    const url = new URL(inject('databaseUrl'));
    const name = `launchway_migrate_${randomBytes(4).toString('hex')}`;
    const admin = trackedPool(url.toString());
    await admin.pool.query(`CREATE DATABASE ${name}`);
    url.pathname = `/${name}`;
    const { pool, close } = trackedPool(url.toString());
    const folder = await migrationsBefore('0012_automation');
    try {
      await migrate(drizzle(pool), { migrationsFolder: folder });
      const db = createDatabase(pool);
      const node = { id: await insertNodeBefore0009(db, 'automation') };
      const appId = await insertAppBefore0012(db, node.id, 'before-0012');

      await runMigrations(pool, pino({ level: 'silent' }));

      const [app] = await db
        .select({ automation: apps.automation })
        .from(apps)
        .where(eq(apps.id, appId));
      expect(app?.automation).toMatchObject({
        merge: 'off',
        train: 'off',
        paused: false,
        trainSchedule: null,
        verify: { baseUrl: null },
        holdPaths: [],
        dependabotUserId: 49699333,
      });
      expect(app?.automation.allowedPaths).toContain('package.json');
      expect(app?.automation.holdImages).toContain('postgres');

      await db.insert(automationRuns).values({
        appId,
        kind: 'pr',
        key: 'pr-1',
        state: 'new',
        snapshot: {},
        actions: [],
      });
      await db.delete(apps).where(eq(apps.id, appId));
      expect(await db.select().from(automationRuns).where(eq(automationRuns.appId, appId))).toEqual(
        [],
      );
    } finally {
      await close();
      await admin.pool.query(`DROP DATABASE ${name}`);
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
