import { Hostname, Timestamp } from './common.js';
import { DnsRecordInput } from './dns.js';
import { DnsZoneId, DomainId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

export const DOMAIN_STATUSES = ['pending', 'verified', 'misconfigured', 'active'] as const;
export const DomainStatus = z.enum(DOMAIN_STATUSES).openapi('DomainStatus', {
  description:
    'pending: not checked yet; verified: DNS preflight passed, routes are rendered; ' +
    'misconfigured: preflight failed; active: verified and the edge holds a certificate',
});
export type DomainStatus = z.infer<typeof DomainStatus>;

export const Domain = z
  .object({
    id: DomainId,
    hostname: Hostname,
    zoneId: DnsZoneId.nullable().openapi({
      description: 'Zone whose record Slipway manages; null = unmanaged',
    }),
    managed: z.boolean(),
    proxied: z.boolean(),
    force: z.boolean().openapi({ description: 'Render routes even when the DNS preflight fails' }),
    status: DomainStatus,
    statusMessage: z.string().nullable(),
    lastCheckedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Domain');
export type Domain = z.infer<typeof Domain>;

export const DomainPage = page(Domain).openapi('DomainPage');
export type DomainPage = z.infer<typeof DomainPage>;

export const DomainListQuery = PaginationQuery.extend({ status: DomainStatus.optional() });
export type DomainListQuery = z.infer<typeof DomainListQuery>;

export const CreateDomainInput = z
  .strictObject({
    hostname: Hostname,
    zoneId: DnsZoneId.nullable().optional().openapi({
      description: 'Omit to pick the longest matching zone automatically; null = unmanaged',
    }),
    proxied: z.boolean().default(false),
    force: z.boolean().default(false),
  })
  .openapi('CreateDomainInput');
export type CreateDomainInput = z.infer<typeof CreateDomainInput>;

export const UpdateDomainInput = z
  .strictObject({
    zoneId: DnsZoneId.nullable().optional(),
    proxied: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field')
  .openapi('UpdateDomainInput');
export type UpdateDomainInput = z.infer<typeof UpdateDomainInput>;

/** Result of the DNS preflight (`POST /domains/{id}/verify`). */
export const DomainVerification = z
  .object({
    domainId: DomainId,
    hostname: Hostname,
    ok: z.boolean(),
    status: DomainStatus,
    checkedAt: Timestamp,
    expected: z
      .object({ type: z.enum(['A', 'CNAME']), value: z.string() })
      .nullable()
      .openapi({ description: 'null while neither the anchor nor the public IPv4 is known' }),
    observed: z.object({
      a: z.array(z.ipv4()),
      aaaa: z.array(z.ipv6()),
      cname: z.array(z.string()),
    }),
    message: z.string(),
    requiredRecords: z
      .array(DnsRecordInput)
      .openapi({ description: 'Records the user must create for unmanaged domains' }),
  })
  .openapi('DomainVerification');
export type DomainVerification = z.infer<typeof DomainVerification>;
