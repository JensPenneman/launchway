import { DnsRecord, DnsZoneInfo } from '@slipway/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeCloudflare } from '../../../../test/support/fake-cloudflare.js';
import {
  createMemoryDnsState,
  memoryProviderDefinition,
} from '../../../../test/support/memory-dns.js';
import { cloudflareProvider } from './cloudflare.js';
import { manualProvider } from './manual.js';
import { dnsProviders } from './registry.js';
import { type DnsProvider, DnsProviderError } from './types.js';

interface ContractSubject {
  /** A provider with valid credentials and one zone named example.com. */
  provider: DnsProvider;
  /** The same provider with wrong credentials. */
  rejected: DnsProvider;
}

/**
 * The behaviour every DNS provider with an API must show. Run it against a new provider with a
 * fake of its API (see README.md).
 */
function describeDnsProviderContract(name: string, setup: () => ContractSubject) {
  describe(`DNS provider contract: ${name}`, () => {
    const zoneOf = async (provider: DnsProvider) => {
      const zones = await provider.listZones();
      const zone = zones.find((z) => z.name === 'example.com');
      if (!zone) throw new Error('fixture zone example.com is missing');
      return zone.externalId;
    };

    it('verifies valid credentials and rejects invalid ones as unauthorized', async () => {
      const { provider, rejected } = setup();
      await expect(provider.verifyCredentials()).resolves.toBeUndefined();
      await expect(rejected.verifyCredentials()).rejects.toMatchObject({
        name: 'DnsProviderError',
        reason: 'unauthorized',
      });
    });

    it('lists zones in the contract shape', async () => {
      const { provider } = setup();
      const zones = await provider.listZones();
      expect(zones.length).toBeGreaterThan(0);
      for (const zone of zones) expect(DnsZoneInfo.parse(zone)).toEqual(zone);
    });

    it('creates a record, lists it and updates it in place on the next upsert', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      const created = await provider.upsertRecord(zone, {
        type: 'A',
        name: 'home.example.com',
        content: '203.0.113.10',
      });
      expect(DnsRecord.parse(created)).toEqual(created);
      expect(created).toMatchObject({
        type: 'A',
        name: 'home.example.com',
        content: '203.0.113.10',
      });

      const again = await provider.upsertRecord(zone, {
        type: 'A',
        name: 'home.example.com',
        content: '203.0.113.11',
      });
      expect(again.externalId).toBe(created.externalId);
      const records = (await provider.listRecords(zone)).filter(
        (r) => r.name === 'home.example.com',
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ content: '203.0.113.11' });
    });

    it('updates the record named by its id', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      const created = await provider.upsertRecord(zone, {
        type: 'CNAME',
        name: 'app.example.com',
        content: 'home.example.com',
      });
      const updated = await provider.upsertRecord(
        zone,
        { type: 'CNAME', name: 'app.example.com', content: 'other.example.com' },
        created.externalId,
      );
      expect(updated).toMatchObject({
        externalId: created.externalId,
        content: 'other.example.com',
      });
    });

    it('keeps several TXT records with the same name apart', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      const name = '_acme-challenge.example.com';
      await provider.upsertRecord(zone, { type: 'TXT', name, content: 'one' });
      await provider.upsertRecord(zone, { type: 'TXT', name, content: 'two' });
      const txt = (await provider.listRecords(zone)).filter((r) => r.name === name);
      expect(txt.map((r) => r.content).sort()).toEqual(['one', 'two']);
      expect(txt.every((r) => r.proxied === null)).toBe(true);
    });

    it('honours proxied when the provider supports it', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      const record = await provider.upsertRecord(zone, {
        type: 'CNAME',
        name: 'proxied.example.com',
        content: 'home.example.com',
        proxied: true,
      });
      expect(record.proxied).toBe(provider.capabilities.proxied ? true : null);
    });

    it('reports a conflicting record as conflict', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      await provider.upsertRecord(zone, {
        type: 'A',
        name: 'clash.example.com',
        content: '192.0.2.1',
      });
      await expect(
        provider.upsertRecord(zone, {
          type: 'CNAME',
          name: 'clash.example.com',
          content: 'home.example.com',
        }),
      ).rejects.toMatchObject({ reason: 'conflict' });
    });

    it('deletes a record and reports a missing one as not-found', async () => {
      const { provider } = setup();
      const zone = await zoneOf(provider);
      const record = await provider.upsertRecord(zone, {
        type: 'AAAA',
        name: 'v6.example.com',
        content: '2001:db8::1',
      });
      await provider.deleteRecord(zone, record.externalId);
      expect(
        (await provider.listRecords(zone)).some((r) => r.externalId === record.externalId),
      ).toBe(false);
      const error = await provider.deleteRecord(zone, record.externalId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DnsProviderError);
      expect(error).toMatchObject({ reason: 'not-found' });
    });
  });
}

describeDnsProviderContract('in-memory fake', () => {
  const state = createMemoryDnsState([{ externalId: 'z1', name: 'example.com' }], 'secret');
  const definition = memoryProviderDefinition('memory', state);
  return {
    provider: definition.create({ token: 'secret' }, { fetch }),
    rejected: definition.create({ token: 'wrong' }, { fetch }),
  };
});

describeDnsProviderContract('cloudflare (mocked API)', () => {
  // A page size of 1 makes every list call paginate.
  const api = createFakeCloudflare({
    token: 'valid-token-0123456789abcdef',
    zones: [
      { id: 'zone-a', name: 'example.org' },
      { id: 'zone-b', name: 'example.com' },
    ],
    maxPerPage: 1,
  });
  return {
    provider: cloudflareProvider.create(
      cloudflareProvider.credentialsSchema.parse({ apiToken: 'valid-token-0123456789abcdef' }),
      { fetch: api.fetch },
    ),
    rejected: cloudflareProvider.create(
      cloudflareProvider.credentialsSchema.parse({ apiToken: 'wrong-token-0123456789abcdef' }),
      { fetch: api.fetch },
    ),
  };
});

describe('manual provider', () => {
  const provider = manualProvider.create({}, { fetch });

  it('has no API: no zones, no records, credentials always work', async () => {
    await expect(provider.verifyCredentials()).resolves.toBeUndefined();
    expect(await provider.listZones()).toEqual([]);
    expect(await provider.listRecords('any')).toEqual([]);
    await expect(provider.deleteRecord('any', 'any')).resolves.toBeUndefined();
  });

  it('answers an upsert with the instruction for the user', async () => {
    const record = await provider.upsertRecord('any', {
      type: 'CNAME',
      name: 'app.example.com',
      content: 'home.example.com',
      proxied: true,
    });
    expect(DnsRecord.parse(record)).toEqual(record);
    expect(record).toMatchObject({ proxied: null, ttl: null });
    expect(record.instruction).toContain('CNAME record named app.example.com');
    expect(record.instruction).toContain('home.example.com');
  });

  it('accepts only empty credentials', () => {
    expect(manualProvider.credentialsSchema.safeParse({}).success).toBe(true);
    expect(manualProvider.credentialsSchema.safeParse({ token: 'x' }).success).toBe(false);
  });
});

describe('provider registry', () => {
  it('ships cloudflare and manual and refuses duplicate kinds', () => {
    expect(dnsProviders.list().map((d) => d.kind)).toEqual(['cloudflare', 'manual']);
    expect(dnsProviders.get('cloudflare')).toBe(cloudflareProvider);
    expect(() => dnsProviders.register(manualProvider)).toThrow(/already registered/);
  });
});
