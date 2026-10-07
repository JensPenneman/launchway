import { createRoute } from '@hono/zod-openapi';
import {
  CreateDomainInput,
  Domain,
  DomainId,
  DomainListQuery,
  DomainPage,
  DomainVerification,
  UpdateDomainInput,
} from '@launchway/contracts';
import { z } from 'zod';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { startJob } from '../../lib/jobs.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createDomainsService } from './service.js';

const RECHECK_INTERVAL_MS = 2 * 60_000;
const RECHECK_FIRST_RUN_MS = 30_000;

const DomainParams = z.object({ id: DomainId });
const tags = ['Domains'];

const listDomains = createRoute({
  method: 'get',
  path: '/domains',
  operationId: 'listDomains',
  tags,
  summary: 'List domains',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { query: DomainListQuery },
  responses: {
    200: jsonResponse(DomainPage, 'Domains, oldest first'),
    ...problemResponses(400, 401, 403),
  },
});

const createDomain = createRoute({
  method: 'post',
  path: '/domains',
  operationId: 'createDomain',
  tags,
  summary: 'Add a domain',
  description:
    'With a zone (given or matched automatically), Launchway creates the record at the provider: a CNAME to the anchor hostname, or an A record with the public IPv4 when no anchor is set (or the domain is the anchor). Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { body: jsonBody(CreateDomainInput) },
  responses: {
    201: jsonResponse(Domain, 'The new domain (status pending)'),
    ...problemResponses(400, 401, 403, 409, 429, 502),
  },
});

const getDomain = createRoute({
  method: 'get',
  path: '/domains/{id}',
  operationId: 'getDomain',
  tags,
  summary: 'Get a domain',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: DomainParams },
  responses: { 200: jsonResponse(Domain, 'The domain'), ...problemResponses(400, 401, 403, 404) },
});

const updateDomain = createRoute({
  method: 'patch',
  path: '/domains/{id}',
  operationId: 'updateDomain',
  tags,
  summary: 'Change the zone, proxying or force flag of a domain',
  description:
    'Moving to another zone deletes the record Launchway created and creates one in the new zone; `zoneId: null` makes the domain unmanaged. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: DomainParams, body: jsonBody(UpdateDomainInput) },
  responses: {
    200: jsonResponse(Domain, 'The updated domain'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const deleteDomain = createRoute({
  method: 'delete',
  path: '/domains/{id}',
  operationId: 'deleteDomain',
  tags,
  summary: 'Delete a domain',
  description: 'Also deletes the DNS record Launchway created for it and its route. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: DomainParams },
  responses: {
    204: { description: 'Deleted' },
    ...problemResponses(400, 401, 403, 404, 429, 502),
  },
});

const verifyDomain = createRoute({
  method: 'post',
  path: '/domains/{id}/verify',
  operationId: 'verifyDomain',
  tags,
  summary: 'Run the DNS preflight now',
  description:
    'Resolves the name (following CNAME chains) and compares it with the anchor hostname or the public IPv4. Updates the status. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: DomainParams },
  responses: {
    200: jsonResponse(DomainVerification, 'Result of the check'),
    ...problemResponses(400, 401, 403, 404),
  },
});

export function registerDomainsRoutes(api: Api, deps: Deps): void {
  const service = createDomainsService(deps);
  startJob({
    name: 'domain-verify',
    intervalMs: RECHECK_INTERVAL_MS,
    initialDelayMs: RECHECK_FIRST_RUN_MS,
    // Tests drive the service directly; the schedule only runs in a real server.
    schedule: deps.config.env !== 'test',
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: () => service.recheckPending(),
  });

  api.openapi(listDomains, async (c) => c.json(await service.list(c.req.valid('query')), 200));

  api.openapi(createDomain, async (c) =>
    c.json(await service.create(c.req.valid('json'), requestActor(c)), 201),
  );

  api.openapi(getDomain, async (c) => c.json(await service.get(c.req.valid('param').id), 200));

  api.openapi(updateDomain, async (c) =>
    c.json(
      await service.update(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      200,
    ),
  );

  api.openapi(deleteDomain, async (c) => {
    await service.remove(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(verifyDomain, async (c) =>
    c.json(await service.verify(c.req.valid('param').id, requestActor(c)), 200),
  );
}
