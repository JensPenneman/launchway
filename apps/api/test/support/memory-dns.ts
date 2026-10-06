import { randomUUID } from 'node:crypto';
import type { DnsRecord, DnsZoneInfo } from '@slipway/contracts';
import { z } from 'zod';
import {
  type DnsProvider,
  type DnsProviderDefinition,
  DnsProviderError,
} from '../../src/modules/dns/providers/types.js';

/** State of an in-memory provider; tests inspect and seed it directly. */
export interface MemoryDnsState {
  zones: DnsZoneInfo[];
  /** Records per zone external id. */
  records: Map<string, DnsRecord[]>;
  /** Token the credentials must carry; anything else is `unauthorized`. */
  token: string;
}

export function createMemoryDnsState(zones: DnsZoneInfo[] = [], token = 'memory-token') {
  const state: MemoryDnsState = { zones, records: new Map(), token };
  for (const zone of zones) state.records.set(zone.externalId, []);
  return state;
}

const MemoryCredentials = z.strictObject({ token: z.string().min(1) });

/**
 * In-memory provider with full capabilities. Not registered by default: tests register it under
 * their own kind to exercise the DNS and domains modules without a real provider.
 */
export function memoryProviderDefinition(
  kind: string,
  state: MemoryDnsState,
): DnsProviderDefinition<z.infer<typeof MemoryCredentials>> {
  const capabilities = { proxied: true, ttl: true };
  return {
    kind,
    label: `In-memory (${kind})`,
    docsUrl: null,
    capabilities,
    credentialsSchema: MemoryCredentials,
    create(credentials): DnsProvider {
      const authorized = () => {
        if (credentials.token !== state.token) {
          throw new DnsProviderError('unauthorized', 'Invalid token');
        }
      };
      const recordsOf = (zoneId: string) => {
        authorized();
        const records = state.records.get(zoneId);
        if (!records) throw new DnsProviderError('not-found', `Unknown zone ${zoneId}`);
        return records;
      };
      return {
        kind,
        capabilities,
        verifyCredentials: async () => authorized(),
        listZones: async () => {
          authorized();
          return state.zones.map((zone) => ({ ...zone }));
        },
        listRecords: async (zoneId) => recordsOf(zoneId).map((record) => ({ ...record })),
        async upsertRecord(zoneId, input, recordExternalId) {
          const records = recordsOf(zoneId);
          const index =
            recordExternalId === undefined
              ? records.findIndex(
                  (r) =>
                    r.type === input.type &&
                    r.name === input.name &&
                    (input.type !== 'TXT' || r.content === input.content),
                )
              : records.findIndex((r) => r.externalId === recordExternalId);
          if (recordExternalId !== undefined && index < 0) {
            throw new DnsProviderError('not-found', 'Record does not exist');
          }
          const clash = records.some(
            (r, i) =>
              i !== index &&
              r.name === input.name &&
              (r.type === 'CNAME') !== (input.type === 'CNAME'),
          );
          if (clash) throw new DnsProviderError('conflict', 'A CNAME cannot coexist with records');
          const record: DnsRecord = {
            externalId: index < 0 ? randomUUID() : (records[index]?.externalId ?? randomUUID()),
            type: input.type,
            name: input.name,
            content: input.content,
            ttl: input.ttl ?? 1,
            proxied: input.type === 'TXT' ? null : (input.proxied ?? false),
          };
          if (index < 0) records.push(record);
          else records[index] = record;
          return { ...record };
        },
        async deleteRecord(zoneId, recordExternalId) {
          const records = recordsOf(zoneId);
          const index = records.findIndex((r) => r.externalId === recordExternalId);
          if (index < 0) throw new DnsProviderError('not-found', 'Record does not exist');
          records.splice(index, 1);
        },
      };
    },
  };
}
