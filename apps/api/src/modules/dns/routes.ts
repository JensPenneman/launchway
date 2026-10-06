import { createRoute } from '@hono/zod-openapi';
import {
  CreateDnsProviderAccountInput,
  DdnsRun,
  DdnsStatus,
  DnsProviderAccount,
  DnsProviderAccountId,
  DnsProviderAccountList,
  DnsProviderInfoList,
  DnsRecord,
  DnsRecordInput,
  DnsRecordList,
  DnsZoneId,
  DnsZoneList,
  DnsZoneListQuery,
  UpdateDnsProviderAccountInput,
} from '@slipway/contracts';
import { z } from 'zod';
import type { Api, Deps } from '../../deps.js';
import { requestActor, requireRole } from '../../lib/auth-context.js';
import { startJob } from '../../lib/jobs.js';
import { AUTHENTICATED, jsonBody, jsonResponse, problemResponses } from '../../lib/openapi.js';
import { createSettingsService } from '../settings/service.js';
import { createDdnsService } from './ddns.js';
import { createDnsService } from './service.js';

const DDNS_INTERVAL_MS = 5 * 60_000;
const DDNS_FIRST_RUN_MS = 15_000;

const AccountParams = z.object({ id: DnsProviderAccountId });
const ZoneParams = z.object({ id: DnsZoneId });
const RecordParams = z.object({
  id: DnsZoneId,
  recordId: z
    .string()
    .regex(/^[A-Za-z0-9:._-]{1,256}$/, 'Malformed record id')
    .openapi({ description: 'Provider record id (DnsRecord.externalId)' }),
});

const tags = ['DNS'];
const noContent = { 204: { description: 'Done' } };

const listProviders = createRoute({
  method: 'get',
  path: '/dns/providers',
  operationId: 'listDnsProviders',
  tags,
  summary: 'List the available DNS provider kinds',
  description: 'Includes the JSON Schema of each kind’s credentials for the "add account" form.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(DnsProviderInfoList, 'Provider kinds'),
    ...problemResponses(401, 403),
  },
});

const listAccounts = createRoute({
  method: 'get',
  path: '/dns/accounts',
  operationId: 'listDnsAccounts',
  tags,
  summary: 'List DNS provider accounts',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: {
    200: jsonResponse(DnsProviderAccountList, 'Accounts (credentials are never returned)'),
    ...problemResponses(401, 403),
  },
});

const createAccount = createRoute({
  method: 'post',
  path: '/dns/accounts',
  operationId: 'createDnsAccount',
  tags,
  summary: 'Add a DNS provider account',
  description:
    'Validates the credentials against the provider’s schema and verifies them with the provider before storing them encrypted. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { body: jsonBody(CreateDnsProviderAccountInput) },
  responses: {
    201: jsonResponse(DnsProviderAccount, 'The new account'),
    ...problemResponses(400, 401, 403, 429, 502),
  },
});

const getAccount = createRoute({
  method: 'get',
  path: '/dns/accounts/{id}',
  operationId: 'getDnsAccount',
  tags,
  summary: 'Get a DNS provider account',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: AccountParams },
  responses: {
    200: jsonResponse(DnsProviderAccount, 'The account'),
    ...problemResponses(400, 401, 403, 404),
  },
});

const updateAccount = createRoute({
  method: 'patch',
  path: '/dns/accounts/{id}',
  operationId: 'updateDnsAccount',
  tags,
  summary: 'Rename an account or replace its credentials',
  description: 'New credentials are verified with the provider first. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AccountParams, body: jsonBody(UpdateDnsProviderAccountInput) },
  responses: {
    200: jsonResponse(DnsProviderAccount, 'The updated account'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const deleteAccount = createRoute({
  method: 'delete',
  path: '/dns/accounts/{id}',
  operationId: 'deleteDnsAccount',
  tags,
  summary: 'Delete a DNS provider account',
  description:
    'Removes its zones; domains in those zones become unmanaged. Records at the provider are left as they are. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AccountParams },
  responses: { ...noContent, ...problemResponses(400, 401, 403, 404) },
});

const syncAccount = createRoute({
  method: 'post',
  path: '/dns/accounts/{id}/sync',
  operationId: 'syncDnsAccount',
  tags,
  summary: 'Refresh the zones of an account from the provider',
  description:
    'Adds new zones, renames changed ones and removes zones the provider no longer lists.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: AccountParams },
  responses: {
    200: jsonResponse(DnsZoneList, 'Zones of the account after the sync'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const listZones = createRoute({
  method: 'get',
  path: '/dns/zones',
  operationId: 'listDnsZones',
  tags,
  summary: 'List DNS zones',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { query: DnsZoneListQuery },
  responses: {
    200: jsonResponse(DnsZoneList, 'Zones, by name'),
    ...problemResponses(400, 401, 403),
  },
});

const listRecords = createRoute({
  method: 'get',
  path: '/dns/zones/{id}/records',
  operationId: 'listDnsRecords',
  tags,
  summary: 'List the records of a zone (live from the provider)',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  request: { params: ZoneParams },
  responses: {
    200: jsonResponse(DnsRecordList, 'A, AAAA, CNAME and TXT records'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const createRecord = createRoute({
  method: 'post',
  path: '/dns/zones/{id}/records',
  operationId: 'createDnsRecord',
  tags,
  summary: 'Create or update a record by name and type',
  description:
    'Upsert: an existing record with the same name and type (TXT: same name and content) is updated. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: ZoneParams, body: jsonBody(DnsRecordInput) },
  responses: {
    201: jsonResponse(DnsRecord, 'The record as stored by the provider'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const updateRecord = createRoute({
  method: 'patch',
  path: '/dns/zones/{id}/records/{recordId}',
  operationId: 'updateDnsRecord',
  tags,
  summary: 'Replace a record',
  description: 'The body is the complete record. Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: RecordParams, body: jsonBody(DnsRecordInput) },
  responses: {
    200: jsonResponse(DnsRecord, 'The updated record'),
    ...problemResponses(400, 401, 403, 404, 409, 429, 502),
  },
});

const deleteRecord = createRoute({
  method: 'delete',
  path: '/dns/zones/{id}/records/{recordId}',
  operationId: 'deleteDnsRecord',
  tags,
  summary: 'Delete a record',
  description: 'Audited.',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { params: RecordParams },
  responses: { ...noContent, ...problemResponses(400, 401, 403, 404, 409, 429, 502) },
});

const getDdns = createRoute({
  method: 'get',
  path: '/dns/ddns',
  operationId: 'getDynamicDns',
  tags,
  summary: 'Get the dynamic DNS state',
  description: 'Public IPv4, anchor zone and the result of the last run since the API started.',
  security: AUTHENTICATED,
  middleware: [requireRole('viewer')],
  responses: { 200: jsonResponse(DdnsStatus, 'Dynamic DNS state'), ...problemResponses(401, 403) },
});

const runDdns = createRoute({
  method: 'post',
  path: '/dns/ddns/run',
  operationId: 'runDynamicDns',
  tags,
  summary: 'Detect the public IPv4 and update the anchor record now',
  description: 'Runs after any run in progress. The anchor record is re-read from the provider.',
  security: AUTHENTICATED,
  middleware: [requireRole('admin')],
  responses: { 200: jsonResponse(DdnsRun, 'Result of the run'), ...problemResponses(401, 403) },
});

export function registerDnsRoutes(api: Api, deps: Deps): void {
  const service = createDnsService(deps);
  const ddns = createDdnsService(deps, { dns: service, settings: createSettingsService(deps) });
  const ddnsJob = startJob({
    name: 'ddns',
    intervalMs: DDNS_INTERVAL_MS,
    initialDelayMs: DDNS_FIRST_RUN_MS,
    // Tests drive the services directly; the schedule only runs in a real server.
    schedule: deps.config.env !== 'test',
    signal: deps.lifecycle.signal,
    logger: deps.logger,
    run: (_signal, trigger) => ddns.run({ force: trigger === 'manual' }),
  });

  api.openapi(listProviders, (c) => c.json({ items: service.listProviders() }, 200));

  api.openapi(listAccounts, async (c) => c.json({ items: await service.listAccounts() }, 200));

  api.openapi(createAccount, async (c) =>
    c.json(await service.createAccount(c.req.valid('json'), requestActor(c)), 201),
  );

  api.openapi(getAccount, async (c) =>
    c.json(await service.getAccount(c.req.valid('param').id), 200),
  );

  api.openapi(updateAccount, async (c) =>
    c.json(
      await service.updateAccount(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      200,
    ),
  );

  api.openapi(deleteAccount, async (c) => {
    await service.deleteAccount(c.req.valid('param').id, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(syncAccount, async (c) =>
    c.json({ items: await service.syncAccount(c.req.valid('param').id, requestActor(c)) }, 200),
  );

  api.openapi(listZones, async (c) =>
    c.json({ items: await service.listZones(c.req.valid('query')) }, 200),
  );

  api.openapi(listRecords, async (c) =>
    c.json({ items: await service.listRecords(c.req.valid('param').id) }, 200),
  );

  api.openapi(createRecord, async (c) =>
    c.json(
      await service.createRecord(c.req.valid('param').id, c.req.valid('json'), requestActor(c)),
      201,
    ),
  );

  api.openapi(updateRecord, async (c) => {
    const { id, recordId } = c.req.valid('param');
    return c.json(
      await service.updateRecord(id, recordId, c.req.valid('json'), requestActor(c)),
      200,
    );
  });

  api.openapi(deleteRecord, async (c) => {
    const { id, recordId } = c.req.valid('param');
    await service.deleteRecord(id, recordId, requestActor(c));
    return c.body(null, 204);
  });

  api.openapi(getDdns, async (c) => c.json(await ddns.status(), 200));

  api.openapi(runDdns, async (c) => c.json(await ddnsJob.runNow(), 200));
}
