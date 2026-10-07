import {
  CreateDnsProviderAccountInput,
  CreateDomainInput,
  CreateRouteInput,
  type DnsProviderAccount,
  DnsRecordInput,
  type Domain,
  type DomainVerification,
  generateId,
  type Route,
  UpdateDomainInput,
  UpdateRouteInput,
} from '@launchway/contracts';
import { HttpResponse, http } from 'msw';
import { db } from '../db';
import { PROVIDERS } from '../fixtures';
import { API, guard, now, paginate, parseBody, problem, recordAudit } from '../util';

function matchingZone(hostname: string) {
  return db.zones
    .filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

function verify(domain: Domain): DomainVerification {
  const anchor = db.settings.anchorHostname;
  const zoneRecords = domain.zoneId ? db.recordsOf(domain.zoneId) : [];
  const record = zoneRecords.find((item) => item.name === domain.hostname);
  const ok = domain.zoneId !== null && record?.type === 'CNAME' && record.content === anchor;
  Object.assign(domain, {
    status: ok ? 'verified' : 'misconfigured',
    statusMessage: ok
      ? null
      : record
        ? `Resolves to ${record.content}, expected CNAME ${anchor ?? 'the anchor'}`
        : 'No DNS record found',
    lastCheckedAt: now(),
    updatedAt: now(),
  });
  return {
    domainId: domain.id,
    hostname: domain.hostname,
    ok,
    status: domain.status,
    checkedAt: now(),
    expected: anchor ? { type: 'CNAME', value: anchor } : null,
    observed: {
      a: record?.type === 'A' ? [record.content] : [],
      aaaa: [],
      cname: record?.type === 'CNAME' ? [record.content] : [],
    },
    message: ok
      ? `${domain.hostname} is a CNAME to ${anchor}.`
      : `${domain.hostname} does not point at ${anchor ?? 'Launchway'} yet.`,
    requiredRecords:
      domain.zoneId === null && anchor
        ? [{ type: 'CNAME', name: domain.hostname, content: anchor }]
        : [],
  };
}

export const dnsHandlers = [
  // --- Domains -----------------------------------------------------------------------------------
  http.get(`${API}/domains`, ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    return HttpResponse.json(
      paginate(
        db.domains.filter((domain) => !status || domain.status === status),
        url,
      ),
    );
  }),
  http.post(`${API}/domains`, async ({ request }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateDomainInput);
    if (error) return error;
    if (db.domains.some((domain) => domain.hostname === data.hostname)) {
      return problem('conflict', `${data.hostname} already exists.`);
    }
    const zoneId =
      data.zoneId === undefined ? (matchingZone(data.hostname)?.id ?? null) : data.zoneId;
    const domain: Domain = {
      id: generateId('dom'),
      hostname: data.hostname,
      zoneId,
      managed: zoneId !== null,
      proxied: data.proxied,
      force: data.force,
      status: 'pending',
      statusMessage: null,
      lastCheckedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (zoneId && db.settings.anchorHostname) {
      db.recordsOf(zoneId).push({
        externalId: `rec-${Date.now()}`,
        type: 'CNAME',
        name: data.hostname,
        content: db.settings.anchorHostname,
        ttl: 1,
        proxied: data.proxied,
      });
      domain.status = 'verified';
      domain.lastCheckedAt = now();
    }
    db.domains.push(domain);
    recordAudit('domain.create', 'domain', domain.id, { hostname: domain.hostname });
    db.emit('domains', 'created', domain.id);
    return HttpResponse.json(domain, { status: 201 });
  }),
  http.patch(`${API}/domains/:id`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateDomainInput);
    if (error) return error;
    const domain = db.domains.find((item) => item.id === params.id);
    if (!domain) return problem('not-found');
    Object.assign(domain, data, {
      managed: (data.zoneId ?? domain.zoneId) !== null,
      updatedAt: now(),
    });
    db.emit('domains', 'updated', domain.id);
    return HttpResponse.json(domain);
  }),
  http.delete(`${API}/domains/:id`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    db.domains = db.domains.filter((item) => item.id !== params.id);
    db.routes = db.routes.filter((route) => route.domainId !== params.id);
    recordAudit('domain.delete', 'domain', String(params.id));
    db.emit('domains', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/domains/:id/verify`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const domain = db.domains.find((item) => item.id === params.id);
    if (!domain) return problem('not-found');
    const result = verify(domain);
    recordAudit('domain.verify', 'domain', domain.id, { ok: result.ok });
    db.emit('domains', 'updated', domain.id);
    return HttpResponse.json(result);
  }),

  // --- Routes ------------------------------------------------------------------------------------
  http.get(`${API}/routes`, ({ request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const url = new URL(request.url);
    const appId = url.searchParams.get('appId');
    const routes = db.routes.filter(
      (route) => !appId || (route.target.kind === 'app' && route.target.appId === appId),
    );
    return HttpResponse.json(paginate(routes, url));
  }),
  http.post(`${API}/routes`, async ({ request }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateRouteInput);
    if (error) return error;
    const domain = db.domains.find((item) => item.id === data.domainId);
    if (!domain) return problem('not-found', 'Unknown domain.');
    if (db.routes.some((route) => route.domainId === domain.id)) {
      return problem('conflict', `${domain.hostname} already has a route.`);
    }
    const route: Route = {
      id: generateId('rt'),
      hostname: domain.hostname,
      ...data,
      createdAt: now(),
      updatedAt: now(),
    };
    db.routes.push(route);
    recordAudit('route.create', 'route', route.id, { hostname: route.hostname });
    db.emit('routes', 'created', route.id);
    return HttpResponse.json(route, { status: 201 });
  }),
  http.patch(`${API}/routes/:id`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, UpdateRouteInput);
    if (error) return error;
    const route = db.routes.find((item) => item.id === params.id);
    if (!route) return problem('not-found');
    Object.assign(route, data, { updatedAt: now() });
    recordAudit('route.update', 'route', route.id, { fields: Object.keys(data) });
    db.emit('routes', 'updated', route.id);
    return HttpResponse.json(route);
  }),
  http.delete(`${API}/routes/:id`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    db.routes = db.routes.filter((item) => item.id !== params.id);
    recordAudit('route.delete', 'route', String(params.id));
    db.emit('routes', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

  // --- DNS providers, zones, records ---------------------------------------------------------------
  http.get(
    `${API}/dns/providers`,
    () => guard('viewer') ?? HttpResponse.json({ items: PROVIDERS }),
  ),
  http.get(
    `${API}/dns/accounts`,
    () => guard('viewer') ?? HttpResponse.json({ items: db.dnsAccounts }),
  ),
  http.post(`${API}/dns/accounts`, async ({ request }) => {
    const denied = guard('admin');
    if (denied) return denied;
    const { data, error } = await parseBody(request, CreateDnsProviderAccountInput);
    if (error) return error;
    if (!PROVIDERS.some((provider) => provider.kind === data.kind)) {
      return problem('validation-failed', undefined, [
        { path: 'body.kind', message: 'Unknown provider', code: 'custom' },
      ]);
    }
    const account: DnsProviderAccount = {
      id: generateId('prov'),
      kind: data.kind,
      name: data.name,
      lastVerifiedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    db.dnsAccounts.push(account);
    recordAudit('dns.account.create', 'dns', account.id, {
      kind: account.kind,
      credentials: '[redacted]',
    });
    db.emit('dns', 'created', account.id);
    return HttpResponse.json(account, { status: 201 });
  }),
  http.delete(`${API}/dns/accounts/:id`, ({ params }) => {
    const denied = guard('admin');
    if (denied) return denied;
    db.dnsAccounts = db.dnsAccounts.filter((item) => item.id !== params.id);
    db.zones = db.zones.filter((zone) => zone.accountId !== params.id);
    db.emit('dns', 'deleted', String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/dns/accounts/:id/sync`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const account = db.dnsAccounts.find((item) => item.id === params.id);
    if (!account) return problem('not-found');
    account.lastVerifiedAt = now();
    for (const zone of db.zones) if (zone.accountId === account.id) zone.lastSyncedAt = now();
    db.emit('dns', 'updated', account.id);
    return HttpResponse.json({ items: db.zones.filter((zone) => zone.accountId === account.id) });
  }),
  http.get(`${API}/dns/zones`, () => guard('viewer') ?? HttpResponse.json({ items: db.zones })),
  http.get(`${API}/dns/zones/:id/records`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    if (!db.zones.some((zone) => zone.id === params.id)) return problem('not-found');
    return HttpResponse.json({ items: db.recordsOf(String(params.id)) });
  }),
  http.post(`${API}/dns/zones/:id/records`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, DnsRecordInput);
    if (error) return error;
    const record = {
      externalId: `rec-${Date.now()}`,
      type: data.type,
      name: data.name,
      content: data.content,
      ttl: data.ttl ?? 1,
      proxied: data.proxied ?? false,
    };
    db.recordsOf(String(params.id)).push(record);
    recordAudit('dns.record.create', 'dns', String(params.id), {
      name: data.name,
      type: data.type,
    });
    db.emit('dns', 'updated', String(params.id));
    return HttpResponse.json(record, { status: 201 });
  }),
  http.patch(`${API}/dns/zones/:id/records/:recordId`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const { data, error } = await parseBody(request, DnsRecordInput);
    if (error) return error;
    const record = db
      .recordsOf(String(params.id))
      .find((item) => item.externalId === params.recordId);
    if (!record) return problem('not-found');
    Object.assign(record, {
      ...data,
      ttl: data.ttl ?? record.ttl,
      proxied: data.proxied ?? record.proxied,
    });
    db.emit('dns', 'updated', String(params.id));
    return HttpResponse.json(record);
  }),
  http.delete(`${API}/dns/zones/:id/records/:recordId`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const zoneId = String(params.id);
    db.records.set(
      zoneId,
      db.recordsOf(zoneId).filter((item) => item.externalId !== params.recordId),
    );
    db.emit('dns', 'deleted', zoneId);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/dns/ddns`, () => {
    const denied = guard('viewer');
    if (denied) return denied;
    const anchor = db.settings.anchorHostname;
    return HttpResponse.json({
      dynamicDnsEnabled: db.settings.dynamicDnsEnabled,
      anchorHostname: anchor,
      anchorZoneId: anchor ? (matchingZone(anchor)?.id ?? null) : null,
      publicIpv4: db.settings.publicIpv4,
      publicIpv4CheckedAt: db.settings.publicIpv4CheckedAt,
      lastRun: db.ddnsLastRun,
    });
  }),
  http.post(`${API}/dns/ddns/run`, () => {
    const denied = guard('admin');
    if (denied) return denied;
    const startedAt = now();
    db.settings.publicIpv4CheckedAt = startedAt;
    db.ddnsLastRun = {
      startedAt,
      finishedAt: now(),
      outcome: 'unchanged',
      message: `Public IPv4 ${db.settings.publicIpv4} unchanged; the anchor record is current.`,
      detectedIpv4: db.settings.publicIpv4,
      previousIpv4: db.settings.publicIpv4,
      recordUpdated: false,
      sources: [
        { url: 'https://api.ipify.org', ipv4: db.settings.publicIpv4, error: null },
        { url: 'https://ipv4.icanhazip.com', ipv4: db.settings.publicIpv4, error: null },
      ],
    };
    db.emit('settings', 'updated', null);
    return HttpResponse.json(db.ddnsLastRun);
  }),
];
