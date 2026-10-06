import { randomUUID } from 'node:crypto';
import type {
  DnsProviderAccount,
  DnsRecord,
  DnsZone,
  Domain,
  DomainId,
  DomainPage,
} from '@slipway/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { auditEvents, dnsProviderAccounts, settings } from '../../src/db/schema.js';
import type { Deps } from '../../src/deps.js';
import { createDdnsService } from '../../src/modules/dns/ddns.js';
import { dnsProviders } from '../../src/modules/dns/providers/registry.js';
import { createDnsService } from '../../src/modules/dns/service.js';
import { createDomainsService } from '../../src/modules/domains/service.js';
import type { DnsLookup } from '../../src/modules/domains/verify.js';
import { createSettingsService } from '../../src/modules/settings/service.js';
import { createTestDeps, fixedAuth, testPrincipal } from '../support/deps.js';
import { createMemoryDnsState, memoryProviderDefinition } from '../support/memory-dns.js';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', 'user-agent': 'integration-test' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const IP = '203.0.113.7';

describe('DNS accounts, zones, records and domains against PostgreSQL', () => {
  let pool: pg.Pool;
  let db: Database;
  let deps: Deps;
  const member = testPrincipal('member');
  // Unique names keep this file independent of other tests' data.
  const suffix = randomUUID().slice(0, 8);
  const zoneName = `t${suffix}.example`;
  const kind = `mem-${suffix}`;
  const state = createMemoryDnsState(
    [
      { externalId: 'z-main', name: zoneName },
      { externalId: 'z-sub', name: `sub.${zoneName}` },
    ],
    'good-token',
  );
  const anchor = `home.${zoneName}`;
  const events: string[] = [];
  let original: Partial<typeof settings.$inferInsert> | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: inject('databaseUrl') });
    db = createDatabase(pool);
    // `active` joined DOMAIN_STATUSES on this branch; the next generated migration adds it.
    await pool.query(`ALTER TYPE domain_status ADD VALUE IF NOT EXISTS 'active'`);
    dnsProviders.register(memoryProviderDefinition(kind, state));
    deps = createTestDeps({ db, auth: fixedAuth(member) });
    deps.events.subscribe((event) => events.push(`${event.topic}.${event.action}`));
    const current = await createSettingsService(deps).get();
    original = {
      anchorHostname: current.anchorHostname,
      publicIpv4: current.publicIpv4,
      publicIpv4CheckedAt: current.publicIpv4CheckedAt
        ? new Date(current.publicIpv4CheckedAt)
        : null,
      dynamicDnsEnabled: current.dynamicDnsEnabled,
    };
    await db
      .update(settings)
      .set({ anchorHostname: anchor, publicIpv4: IP, dynamicDnsEnabled: true });
  });

  afterAll(async () => {
    // The settings row is a singleton shared with other test files: put it back.
    if (original) await db.update(settings).set(original);
    await pool.end();
  });

  const app = () => createApp(deps);
  let account: DnsProviderAccount;
  let zones: DnsZone[];

  it('rejects unknown kinds, malformed and wrong credentials', async () => {
    const unknown = await app().request(
      '/api/v1/dns/accounts',
      json('POST', { kind: 'nope', name: 'x', credentials: {} }),
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ errors: [{ path: 'body.kind' }] });

    const malformed = await app().request(
      '/api/v1/dns/accounts',
      json('POST', { kind, name: 'x', credentials: { token: 1 } }),
    );
    expect(await malformed.json()).toMatchObject({ errors: [{ path: 'body.credentials.token' }] });

    const wrong = await app().request(
      '/api/v1/dns/accounts',
      json('POST', { kind, name: 'x', credentials: { token: 'bad' } }),
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      errors: [{ path: 'body.credentials', message: 'Invalid token' }],
    });
  });

  it('creates an account with encrypted credentials that are never returned', async () => {
    const res = await app().request(
      '/api/v1/dns/accounts',
      json('POST', { kind, name: 'Memory', credentials: { token: 'good-token' } }),
    );
    expect(res.status).toBe(201);
    account = (await res.json()) as DnsProviderAccount;
    expect(account).toMatchObject({ kind, name: 'Memory' });
    expect(JSON.stringify(account)).not.toContain('good-token');

    const [row] = await db
      .select()
      .from(dnsProviderAccounts)
      .where(eq(dnsProviderAccounts.id, account.id));
    expect(row?.credentialsEncrypted).not.toContain('good-token');
    expect(deps.secrets.decrypt(row?.credentialsEncrypted ?? '', `dns-account:${account.id}`)).toBe(
      JSON.stringify({ token: 'good-token' }),
    );

    const list = (await (await app().request('/api/v1/dns/accounts')).json()) as {
      items: DnsProviderAccount[];
    };
    expect(list.items.map((item) => item.id)).toContain(account.id);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'dns-account.create'), eq(auditEvents.targetId, account.id)),
      );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.summary)).not.toContain('good-token');
  });

  it('syncs zones (add, rename, remove) and filters them by account', async () => {
    const res = await app().request(`/api/v1/dns/accounts/${account.id}/sync`, json('POST'));
    expect(res.status).toBe(200);
    zones = ((await res.json()) as { items: DnsZone[] }).items;
    expect(zones.map((zone) => zone.name)).toEqual([`sub.${zoneName}`, zoneName]);

    state.zones.push({ externalId: 'z-gone', name: `gone.${zoneName}` });
    state.records.set('z-gone', []);
    await app().request(`/api/v1/dns/accounts/${account.id}/sync`, json('POST'));
    state.zones.pop();
    const again = await app().request(`/api/v1/dns/accounts/${account.id}/sync`, json('POST'));
    const after = ((await again.json()) as { items: DnsZone[] }).items;
    expect(after.map((zone) => zone.id).sort()).toEqual(zones.map((zone) => zone.id).sort());

    const filtered = await app().request(`/api/v1/dns/zones?accountId=${account.id}`);
    expect(((await filtered.json()) as { items: DnsZone[] }).items).toHaveLength(2);
  });

  it('manages records live at the provider', async () => {
    const main = zones.find((zone) => zone.name === zoneName);
    const base = `/api/v1/dns/zones/${main?.id}/records`;
    const created = await app().request(
      base,
      json('POST', { type: 'TXT', name: `_check.${zoneName}`, content: 'hello' }),
    );
    expect(created.status).toBe(201);
    const record = (await created.json()) as DnsRecord;

    const outside = await app().request(
      base,
      json('POST', { type: 'TXT', name: 'x.other.example', content: 'hello' }),
    );
    expect(outside.status).toBe(400);

    const patched = await app().request(
      `${base}/${record.externalId}`,
      json('PATCH', { type: 'TXT', name: `_check.${zoneName}`, content: 'bye' }),
    );
    expect(await patched.json()).toMatchObject({ externalId: record.externalId, content: 'bye' });
    const listed = (await (await app().request(base)).json()) as { items: DnsRecord[] };
    expect(listed.items.map((r) => r.content)).toContain('bye');

    expect((await app().request(`${base}/${record.externalId}`, json('DELETE'))).status).toBe(204);
    const missing = await app().request(`${base}/${record.externalId}`, json('DELETE'));
    expect(missing.status).toBe(404);
  });

  let domain: Domain;

  it('creates a managed domain as a CNAME to the anchor in the longest matching zone', async () => {
    const hostname = `app.sub.${zoneName}`;
    const res = await app().request('/api/v1/domains', json('POST', { hostname, proxied: true }));
    expect(res.status).toBe(201);
    domain = (await res.json()) as Domain;
    const sub = zones.find((zone) => zone.name === `sub.${zoneName}`);
    expect(domain).toMatchObject({
      hostname,
      zoneId: sub?.id,
      managed: true,
      proxied: true,
      status: 'pending',
    });
    expect(state.records.get('z-sub')).toMatchObject([
      { type: 'CNAME', name: hostname, content: anchor, proxied: true },
    ]);

    const duplicate = await app().request('/api/v1/domains', json('POST', { hostname }));
    expect(duplicate.status).toBe(409);
  });

  it('creates the anchor itself as an A record and unmanaged domains without records', async () => {
    const anchorRes = await app().request('/api/v1/domains', json('POST', { hostname: anchor }));
    expect(anchorRes.status).toBe(201);
    expect(state.records.get('z-main')).toMatchObject([{ type: 'A', name: anchor, content: IP }]);

    const unmanaged = await app().request(
      '/api/v1/domains',
      json('POST', { hostname: `x.unmanaged-${suffix}.example`, zoneId: null }),
    );
    expect(await unmanaged.json()).toMatchObject({ zoneId: null, managed: false });

    const wrongZone = await app().request(
      '/api/v1/domains',
      json('POST', { hostname: `y.unmanaged-${suffix}.example`, zoneId: zones[0]?.id }),
    );
    expect(wrongZone.status).toBe(400);
  });

  it('pages through domains with a cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `limit=1&cursor=${cursor}` : 'limit=1';
      const page = (await (await app().request(`/api/v1/domains?${query}`)).json()) as DomainPage;
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(domain.id);
    const pending = (await (
      await app().request('/api/v1/domains?status=active')
    ).json()) as DomainPage;
    expect(pending.items.map((item) => item.id)).not.toContain(domain.id);
  });

  it('verifies with the resolver, re-checks in the job and is activated by the edge', async () => {
    let answers: Record<string, string[]> = {};
    const resolver: DnsLookup = {
      resolveCname: async (name) => answers[`CNAME ${name}`] ?? [],
      resolve4: async (name) => answers[`A ${name}`] ?? [],
      resolve6: async () => [],
    };
    const service = createDomainsService(deps, { resolver });
    const actor = { principal: member, ipAddress: null, userAgent: null, requestId: 'test' };

    const failing = await service.verify(domain.id, actor);
    expect(failing).toMatchObject({
      ok: false,
      status: 'misconfigured',
      expected: { type: 'CNAME', value: anchor },
      requiredRecords: [],
    });

    answers = { [`CNAME ${domain.hostname}`]: [`${anchor}.`], [`A ${domain.hostname}`]: [IP] };
    expect(await service.recheckPending()).toBeGreaterThanOrEqual(1);
    expect(await service.get(domain.id)).toMatchObject({ status: 'verified' });

    const active = await service.markDomainActive(domain.id as DomainId);
    expect(active.status).toBe('active');
    expect((await service.verify(domain.id, actor)).status).toBe('active');

    const audit = await db
      .select({ action: auditEvents.action, actorType: auditEvents.actorType })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, domain.id));
    expect(audit.map((row) => row.action)).toEqual([
      'domain.create',
      'domain.verify',
      'domain.verify',
      'domain.activate',
      'domain.verify',
    ]);
    expect(events).toContain('domains.updated');
  });

  it('moves a domain to unmanaged and deletes the record it created', async () => {
    const res = await app().request(
      `/api/v1/domains/${domain.id}`,
      json('PATCH', { zoneId: null }),
    );
    expect(await res.json()).toMatchObject({ zoneId: null, managed: false, status: 'pending' });
    expect(state.records.get('z-sub')).toEqual([]);
    expect((await app().request(`/api/v1/domains/${domain.id}`, json('DELETE'))).status).toBe(204);
    expect((await app().request(`/api/v1/domains/${domain.id}`)).status).toBe(404);
  });

  it('runs dynamic DNS: stores the new address and updates the anchor record', async () => {
    const dns = createDnsService(deps);
    const ddns = createDdnsService(deps, {
      dns,
      settings: createSettingsService(deps),
      fetch: async () => new Response('198.51.100.20'),
    });
    const run = await ddns.run();
    expect(run).toMatchObject({ outcome: 'updated', previousIpv4: IP, recordUpdated: true });
    expect(state.records.get('z-main')).toMatchObject([
      { type: 'A', name: anchor, content: '198.51.100.20' },
    ]);
    const status = await ddns.status();
    expect(status).toMatchObject({
      publicIpv4: '198.51.100.20',
      anchorZoneId: zones.find((z) => z.name === zoneName)?.id,
    });
    const [ipAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'settings.public-ipv4'));
    expect(ipAudit?.summary).toMatchObject({ publicIpv4: { from: IP, to: '198.51.100.20' } });

    const viaApi = await createApp({ ...deps, auth: fixedAuth(testPrincipal('admin')) }).request(
      '/api/v1/dns/ddns',
    );
    expect(await viaApi.json()).toMatchObject({ dynamicDnsEnabled: true, anchorHostname: anchor });
  });

  it('deletes the account and its zones; domains become unmanaged', async () => {
    const res = await app().request(`/api/v1/dns/accounts/${account.id}`, json('DELETE'));
    expect(res.status).toBe(204);
    const list = (await (
      await app().request(`/api/v1/dns/zones?accountId=${account.id}`)
    ).json()) as {
      items: DnsZone[];
    };
    expect(list.items).toEqual([]);
    const domains = (await (await app().request('/api/v1/domains?limit=100')).json()) as DomainPage;
    const anchorDomain = domains.items.find((item) => item.hostname === anchor);
    expect(anchorDomain).toMatchObject({ zoneId: null, managed: false });
  });
});
