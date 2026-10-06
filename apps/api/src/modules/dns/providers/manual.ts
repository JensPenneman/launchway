import type { DnsRecord } from '@slipway/contracts';
import { z } from 'zod';
import type { DnsProvider, DnsProviderDefinition } from './types.js';

const ManualCredentials = z.strictObject({}).meta({
  title: 'No credentials',
  description: 'Records are created by hand at your DNS host; Slipway only verifies them.',
});
type ManualCredentials = z.infer<typeof ManualCredentials>;

const manualClient: DnsProvider = {
  kind: 'manual',
  capabilities: { proxied: false, ttl: false },
  verifyCredentials: () => Promise.resolve(),
  listZones: () => Promise.resolve([]),
  listRecords: () => Promise.resolve([]),
  /** Nothing is created: the returned record carries the instruction for the user. */
  upsertRecord(_zoneExternalId, input): Promise<DnsRecord> {
    return Promise.resolve({
      externalId: `manual:${input.type}:${input.name}`,
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: null,
      proxied: null,
      instruction: `Create a ${input.type} record named ${input.name} with the value ${input.content} at your DNS host.`,
    });
  },
  deleteRecord: () => Promise.resolve(),
};

/** Provider without an API: Slipway shows the records to create and only verifies them. */
export const manualProvider: DnsProviderDefinition<ManualCredentials> = {
  kind: 'manual',
  label: 'Manual (no API)',
  docsUrl: null,
  capabilities: manualClient.capabilities,
  credentialsSchema: ManualCredentials,
  create: () => manualClient,
};
