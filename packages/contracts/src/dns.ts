import { DisplayName, DnsName, Hostname, JsonObject, Timestamp } from './common.js';
import { DnsProviderAccountId, DnsZoneId } from './ids.js';
import { list } from './pagination.js';
import { z } from './zod.js';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT'] as const;
export const DnsRecordType = z.enum(DNS_RECORD_TYPES).openapi('DnsRecordType');
export type DnsRecordType = z.infer<typeof DnsRecordType>;

/** Registry key of a provider implementation (`cloudflare`, `manual`, ...). */
export const DnsProviderKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/)
  .openapi({ example: 'cloudflare' });
export type DnsProviderKind = z.infer<typeof DnsProviderKind>;

export const DnsProviderCapabilities = z
  .object({
    proxied: z.boolean().openapi({ description: 'Supports the per-record proxied flag' }),
    ttl: z.boolean().openapi({ description: 'Supports custom TTLs' }),
  })
  .openapi('DnsProviderCapabilities');
export type DnsProviderCapabilities = z.infer<typeof DnsProviderCapabilities>;

/** Registry entry exposed by `GET /dns/providers`; the UI renders the credentials form from JSON Schema. */
export const DnsProviderInfo = z
  .object({
    kind: DnsProviderKind,
    label: z.string(),
    docsUrl: z.url().nullable(),
    capabilities: DnsProviderCapabilities,
    credentialsSchema: JsonObject.openapi({
      description: 'JSON Schema (draft 2020-12) of the credentials',
    }),
  })
  .openapi('DnsProviderInfo');
export type DnsProviderInfo = z.infer<typeof DnsProviderInfo>;

export const DnsProviderInfoList = list(DnsProviderInfo).openapi('DnsProviderInfoList');
export type DnsProviderInfoList = z.infer<typeof DnsProviderInfoList>;

export const DnsProviderAccount = z
  .object({
    id: DnsProviderAccountId,
    kind: DnsProviderKind,
    name: DisplayName,
    lastVerifiedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('DnsProviderAccount', { description: 'Credentials are write-only and never returned' });
export type DnsProviderAccount = z.infer<typeof DnsProviderAccount>;

export const DnsProviderAccountList = list(DnsProviderAccount).openapi('DnsProviderAccountList');
export type DnsProviderAccountList = z.infer<typeof DnsProviderAccountList>;

export const CreateDnsProviderAccountInput = z
  .strictObject({
    kind: DnsProviderKind,
    name: DisplayName,
    credentials: JsonObject.openapi({
      description: "Validated against the provider's credentialsSchema",
    }),
  })
  .openapi('CreateDnsProviderAccountInput');
export type CreateDnsProviderAccountInput = z.infer<typeof CreateDnsProviderAccountInput>;

export const UpdateDnsProviderAccountInput = z
  .strictObject({ name: DisplayName.optional(), credentials: JsonObject.optional() })
  .refine((v) => v.name !== undefined || v.credentials !== undefined, 'Provide at least one field')
  .openapi('UpdateDnsProviderAccountInput');
export type UpdateDnsProviderAccountInput = z.infer<typeof UpdateDnsProviderAccountInput>;

/** Zone as reported by a provider (`DnsProvider.listZones`). */
export const DnsZoneInfo = z.object({ externalId: z.string().min(1), name: Hostname });
export type DnsZoneInfo = z.infer<typeof DnsZoneInfo>;

export const DnsZone = z
  .object({
    id: DnsZoneId,
    accountId: DnsProviderAccountId,
    externalId: z.string(),
    name: Hostname,
    lastSyncedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('DnsZone');
export type DnsZone = z.infer<typeof DnsZone>;

export const DnsZoneList = list(DnsZone).openapi('DnsZoneList');

export const DnsZoneListQuery = z.object({ accountId: DnsProviderAccountId.optional() });
export type DnsZoneListQuery = z.infer<typeof DnsZoneListQuery>;
export type DnsZoneList = z.infer<typeof DnsZoneList>;

/** Record as reported by a provider (`DnsProvider.listRecords` / `upsertRecord`). */
export const DnsRecord = z
  .object({
    externalId: z.string(),
    type: DnsRecordType,
    name: DnsName,
    content: z.string(),
    ttl: z.number().int().nullable().openapi({ description: '1 = automatic; null when unknown' }),
    proxied: z.boolean().nullable().openapi({ description: 'null when the provider has no proxy' }),
    instruction: z.string().optional().openapi({
      description:
        'Set by providers without an API (manual): what the user must create at their DNS host',
    }),
  })
  .openapi('DnsRecord');
export type DnsRecord = z.infer<typeof DnsRecord>;

export const DnsRecordList = list(DnsRecord).openapi('DnsRecordList');
export type DnsRecordList = z.infer<typeof DnsRecordList>;

const recordInputBase = {
  name: DnsName,
  ttl: z.number().int().min(1).max(86_400).optional().openapi({ description: '1 = automatic' }),
  proxied: z
    .boolean()
    .optional()
    .openapi({ description: 'Ignored by providers without proxy support' }),
};

/** Record to create or update; `content` is validated per type. */
export const DnsRecordInput = z
  .discriminatedUnion('type', [
    z.strictObject({ ...recordInputBase, type: z.literal('A'), content: z.ipv4() }),
    z.strictObject({ ...recordInputBase, type: z.literal('AAAA'), content: z.ipv6() }),
    z.strictObject({ ...recordInputBase, type: z.literal('CNAME'), content: Hostname }),
    z.strictObject({
      ...recordInputBase,
      type: z.literal('TXT'),
      content: z.string().min(1).max(2048),
    }),
  ])
  .openapi('DnsRecordInput');
export type DnsRecordInput = z.infer<typeof DnsRecordInput>;

export const DDNS_OUTCOMES = ['unchanged', 'updated', 'skipped', 'failed'] as const;
export const DdnsOutcome = z.enum(DDNS_OUTCOMES).openapi('DdnsOutcome', {
  description:
    'unchanged: IPv4 and anchor record already current; updated: the stored IPv4 or the anchor ' +
    'record changed; skipped: the detection services disagreed or failed; failed: an error occurred',
});
export type DdnsOutcome = z.infer<typeof DdnsOutcome>;

/** Answer of one public-IPv4 detection service. */
export const DdnsSourceResult = z
  .object({
    url: z.url(),
    ipv4: z.ipv4().nullable(),
    error: z.string().nullable(),
  })
  .openapi('DdnsSourceResult');
export type DdnsSourceResult = z.infer<typeof DdnsSourceResult>;

/** Result of one public-IPv4 detection + anchor record update. */
export const DdnsRun = z
  .object({
    startedAt: Timestamp,
    finishedAt: Timestamp,
    outcome: DdnsOutcome,
    message: z.string(),
    detectedIpv4: z.ipv4().nullable(),
    previousIpv4: z.ipv4().nullable(),
    recordUpdated: z
      .boolean()
      .openapi({ description: 'The anchor A record was created or changed at the provider' }),
    sources: z.array(DdnsSourceResult),
  })
  .openapi('DdnsRun');
export type DdnsRun = z.infer<typeof DdnsRun>;

export const DdnsStatus = z
  .object({
    dynamicDnsEnabled: z.boolean(),
    anchorHostname: Hostname.nullable(),
    anchorZoneId: DnsZoneId.nullable().openapi({
      description: 'Managed zone that contains the anchor; null = the record is not managed',
    }),
    publicIpv4: z.ipv4().nullable(),
    publicIpv4CheckedAt: Timestamp.nullable(),
    lastRun: DdnsRun.nullable().openapi({ description: 'null until the first run since start' }),
  })
  .openapi('DdnsStatus');
export type DdnsStatus = z.infer<typeof DdnsStatus>;
