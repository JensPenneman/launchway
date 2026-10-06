import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { Api, Deps } from '../../deps.js';
import { jsonResponse, PUBLIC } from '../../lib/openapi.js';

const Liveness = z.object({ status: z.literal('ok'), version: z.string() }).openapi('Liveness');

const Readiness = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    checks: z.object({ database: z.enum(['ok', 'unavailable']) }),
  })
  .openapi('Readiness');

const live = createRoute({
  method: 'get',
  path: '/health/live',
  operationId: 'getLiveness',
  tags: ['Health'],
  summary: 'Liveness: the process is up',
  security: PUBLIC,
  responses: { 200: jsonResponse(Liveness, 'The process is up') },
});

const ready = createRoute({
  method: 'get',
  path: '/health/ready',
  operationId: 'getReadiness',
  tags: ['Health'],
  summary: 'Readiness: the database is reachable',
  security: PUBLIC,
  responses: {
    200: jsonResponse(Readiness, 'Ready to serve traffic'),
    503: jsonResponse(Readiness, 'Not ready (database unreachable or shutting down)'),
  },
});

const DATABASE_TIMEOUT_MS = 2_000;

export function registerHealthRoutes(api: Api, deps: Deps): void {
  api.openapi(live, (c) => c.json({ status: 'ok' as const, version: deps.version }, 200));

  api.openapi(ready, async (c) => {
    const database = deps.lifecycle.shuttingDown ? 'unavailable' : await pingDatabase(deps);
    if (database === 'ok') return c.json({ status: 'ok' as const, checks: { database } }, 200);
    return c.json({ status: 'unavailable' as const, checks: { database } }, 503);
  });
}

async function pingDatabase(deps: Deps): Promise<'ok' | 'unavailable'> {
  try {
    await Promise.race([
      deps.db.execute(sql`select 1`),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('database ping timed out')), DATABASE_TIMEOUT_MS).unref();
      }),
    ]);
    return 'ok';
  } catch (err) {
    deps.logger.warn({ err }, 'readiness check: database unavailable');
    return 'unavailable';
  }
}
