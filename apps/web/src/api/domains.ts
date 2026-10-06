import {
  type CreateDnsProviderAccountInput,
  type CreateDomainInput,
  type CreateRouteInput,
  DnsProviderAccount,
  DnsProviderAccountList,
  DnsProviderInfoList,
  DnsRecord,
  type DnsRecordInput,
  DnsRecordList,
  DnsZoneList,
  Domain,
  DomainPage,
  DomainVerification,
  Route,
  RoutePage,
  type UpdateDomainInput,
  type UpdateRouteInput,
  type z,
} from '@slipway/contracts';
import { queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { DdnsRun, DdnsStatus } from './provisional';
import { request } from './request';

const enc = encodeURIComponent;

// --- Domains -----------------------------------------------------------------------------------

export const domainsQuery = queryOptions({
  queryKey: [...keys.domains, 'list'],
  queryFn: ({ signal }) =>
    request('/domains', { query: { limit: 100 }, schema: DomainPage, signal }),
});

export function createDomain(input: z.input<typeof CreateDomainInput>) {
  return request('/domains', { method: 'POST', body: input, schema: Domain });
}

export function updateDomain(id: string, input: UpdateDomainInput) {
  return request(`/domains/${enc(id)}`, { method: 'PATCH', body: input, schema: Domain });
}

export function deleteDomain(id: string) {
  return request(`/domains/${enc(id)}`, { method: 'DELETE' });
}

export function verifyDomain(id: string) {
  return request(`/domains/${enc(id)}/verify`, { method: 'POST', schema: DomainVerification });
}

// --- Routes ------------------------------------------------------------------------------------

export function routesQuery(appId?: string) {
  return queryOptions({
    queryKey: [...keys.routes, 'list', appId ?? 'all'],
    queryFn: ({ signal }) =>
      request('/routes', { query: { appId, limit: 100 }, schema: RoutePage, signal }),
  });
}

export function createRoute(input: z.input<typeof CreateRouteInput>) {
  return request('/routes', { method: 'POST', body: input, schema: Route });
}

export function updateRoute(id: string, input: z.input<typeof UpdateRouteInput>) {
  return request(`/routes/${enc(id)}`, { method: 'PATCH', body: input, schema: Route });
}

export function deleteRoute(id: string) {
  return request(`/routes/${enc(id)}`, { method: 'DELETE' });
}

// --- DNS providers, zones and records ----------------------------------------------------------

export const providersQuery = queryOptions({
  queryKey: [...keys.dns, 'providers'],
  queryFn: ({ signal }) => request('/dns/providers', { schema: DnsProviderInfoList, signal }),
  staleTime: Number.POSITIVE_INFINITY,
});

export const dnsAccountsQuery = queryOptions({
  queryKey: [...keys.dns, 'accounts'],
  queryFn: ({ signal }) => request('/dns/accounts', { schema: DnsProviderAccountList, signal }),
});

export function createDnsAccount(input: CreateDnsProviderAccountInput) {
  return request('/dns/accounts', { method: 'POST', body: input, schema: DnsProviderAccount });
}

export function deleteDnsAccount(id: string) {
  return request(`/dns/accounts/${enc(id)}`, { method: 'DELETE' });
}

export function syncDnsAccount(id: string) {
  return request(`/dns/accounts/${enc(id)}/sync`, { method: 'POST' });
}

export const zonesQuery = queryOptions({
  queryKey: [...keys.dns, 'zones'],
  queryFn: ({ signal }) => request('/dns/zones', { schema: DnsZoneList, signal }),
});

export function recordsQuery(zoneId: string) {
  return queryOptions({
    queryKey: [...keys.dns, 'records', zoneId],
    queryFn: ({ signal }) =>
      request(`/dns/zones/${enc(zoneId)}/records`, { schema: DnsRecordList, signal }),
  });
}

export function createRecord(zoneId: string, input: DnsRecordInput) {
  return request(`/dns/zones/${enc(zoneId)}/records`, {
    method: 'POST',
    body: input,
    schema: DnsRecord,
  });
}

export function updateRecord(zoneId: string, externalId: string, input: DnsRecordInput) {
  return request(`/dns/zones/${enc(zoneId)}/records/${enc(externalId)}`, {
    method: 'PATCH',
    body: input,
    schema: DnsRecord,
  });
}

export function deleteRecord(zoneId: string, externalId: string) {
  return request(`/dns/zones/${enc(zoneId)}/records/${enc(externalId)}`, { method: 'DELETE' });
}

// --- Dynamic DNS -------------------------------------------------------------------------------

export const ddnsQuery = queryOptions({
  queryKey: [...keys.dns, 'ddns'],
  queryFn: ({ signal }) => request('/dns/ddns', { schema: DdnsStatus, signal }),
});

export function runDdns() {
  return request('/dns/ddns/run', { method: 'POST', schema: DdnsRun });
}
