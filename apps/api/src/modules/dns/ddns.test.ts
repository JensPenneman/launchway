import type { Settings } from '@launchway/contracts';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryDnsState,
  memoryProviderDefinition,
} from '../../../test/support/memory-dns.js';
import type { Database } from '../../db/client.js';
import { createEventBus } from '../../lib/event-bus.js';
import type { SettingsService } from '../settings/service.js';
import { createDdnsService, detectPublicIpv4, type Ipv4Source } from './ddns.js';
import type { DnsService, DnsZoneRow } from './service.js';

const plain = (body: string) => body.trim();
const SOURCES: Ipv4Source[] = [
  { url: 'https://one.test/', extract: plain },
  { url: 'https://two.test/', extract: plain },
  { url: 'https://three.test/', extract: (body) => /^ip=(.+)$/m.exec(body)?.[1] ?? null },
];

/** fetch answering per URL: a string body, a status number, or an Error to throw. */
function fakeFetch(answers: Record<string, string | number | Error>) {
  return vi.fn<typeof fetch>(async (input) => {
    const answer = answers[String(input)];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no route');
    if (typeof answer === 'number') return new Response('', { status: answer });
    return new Response(answer, { status: 200 });
  });
}

describe('detectPublicIpv4 (agree-or-skip)', () => {
  it('accepts an address two services agree on without asking the third', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': '203.0.113.7\n',
      'https://two.test/': '203.0.113.7',
    });
    const result = await detectPublicIpv4(fetchFn, SOURCES);
    expect(result.ipv4).toBe('203.0.113.7');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('asks the third service when one fails and accepts two agreeing answers', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': 500,
      'https://two.test/': '203.0.113.7',
      'https://three.test/': 'fl=1\nip=203.0.113.7\nts=1',
    });
    const result = await detectPublicIpv4(fetchFn, SOURCES);
    expect(result.ipv4).toBe('203.0.113.7');
    expect(result.sources).toEqual([
      { url: 'https://one.test/', ipv4: null, error: 'HTTP 500' },
      { url: 'https://two.test/', ipv4: '203.0.113.7', error: null },
      { url: 'https://three.test/', ipv4: '203.0.113.7', error: null },
    ]);
  });

  it('breaks a disagreement with the third service', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': '203.0.113.7',
      'https://two.test/': '198.51.100.1',
      'https://three.test/': 'ip=198.51.100.1',
    });
    expect((await detectPublicIpv4(fetchFn, SOURCES)).ipv4).toBe('198.51.100.1');
  });

  it('skips when all three disagree', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': '203.0.113.7',
      'https://two.test/': '198.51.100.1',
      'https://three.test/': 'ip=192.0.2.9',
    });
    const result = await detectPublicIpv4(fetchFn, SOURCES);
    expect(result.ipv4).toBeNull();
    expect(result.message).toMatch(/disagree/);
  });

  it('skips when fewer than two services answer with an IPv4', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': '2001:db8::1',
      'https://two.test/': new Error('down'),
      'https://three.test/': 'ip=203.0.113.7',
    });
    const result = await detectPublicIpv4(fetchFn, SOURCES);
    expect(result.ipv4).toBeNull();
    expect(result.message).toMatch(/fewer than two/);
    expect(result.sources.map((s) => s.error)).toEqual([
      'No IPv4 address in answer',
      'Request failed',
      null,
    ]);
  });

  it('passes a timeout signal to every request', async () => {
    const fetchFn = fakeFetch({
      'https://one.test/': '203.0.113.7',
      'https://two.test/': '203.0.113.7',
    });
    await detectPublicIpv4(fetchFn, SOURCES, 1234);
    for (const [, init] of fetchFn.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the default services: plain text and the trace format', async () => {
    const fetchFn = fakeFetch({
      'https://api.ipify.org': '203.0.113.7',
      'https://ipv4.icanhazip.com': 'nonsense',
      'https://1.1.1.1/cdn-cgi/trace': 'h=1.1.1.1\nip=203.0.113.7\n',
    });
    expect((await detectPublicIpv4(fetchFn)).ipv4).toBe('203.0.113.7');
  });
});

describe('dynamic DNS service', () => {
  const zone: DnsZoneRow = {
    id: 'zone_01ja53wvjvfk1sp7hz5965tvkz',
    accountId: 'prov_01ja53wvjvfk1sp7hz5965tvkz',
    externalId: 'z1',
    name: 'example.com',
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function setup(initial: Partial<Settings> = {}) {
    let current: Settings = {
      publicUrl: null,
      effectivePublicUrl: null,
      acmeEmail: null,
      anchorHostname: 'home.example.com',
      dynamicDnsEnabled: true,
      publicIpv4: null,
      publicIpv4CheckedAt: null,
      forwardAuthUrl: null,
      forwardAuthTarget: null,
      edgeNodeId: null,
      previewBaseDomain: null,
      previewMaxPerApp: 10,
      previewMaxTotal: 20,
      updatedAt: new Date().toISOString(),
      ...initial,
    };
    const settings = {
      get: async () => current,
      update: () => Promise.reject(new Error('unused')),
      recordPublicIpv4: async (ipv4: string, checkedAt: Date) => {
        const previous = current.publicIpv4;
        current = { ...current, publicIpv4: ipv4, publicIpv4CheckedAt: checkedAt.toISOString() };
        return { settings: current, previous, changed: previous !== ipv4 };
      },
    } satisfies SettingsService;
    const state = createMemoryDnsState([{ externalId: 'z1', name: 'example.com' }]);
    const provider = memoryProviderDefinition('memory', state).create(
      { token: state.token },
      { fetch },
    );
    const listRecords = vi.spyOn(provider, 'listRecords');
    const dns = {
      findZoneForHostname: async (hostname: string) =>
        hostname.endsWith('.example.com') ? zone : null,
      providerForZone: async () => ({ zone, provider }),
    } as unknown as DnsService;
    const audits: unknown[] = [];
    const tx = { insert: () => ({ values: async (row: unknown) => audits.push(row) }) };
    const db = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    } as unknown as Database;
    let answer = '203.0.113.7';
    const fetchFn: typeof fetch = async () => new Response(answer);
    const ddns = createDdnsService(
      { db, events: createEventBus(), logger: pino({ level: 'silent' }) },
      { dns, settings, fetch: fetchFn, sources: SOURCES.slice(0, 2) },
    );
    return { ddns, state, audits, listRecords, setAnswer: (ip: string) => (answer = ip) };
  }

  it('stores the address and creates the anchor A record, then leaves it alone', async () => {
    const { ddns, state, audits, listRecords } = setup();
    const first = await ddns.run();
    expect(first).toMatchObject({
      outcome: 'updated',
      detectedIpv4: '203.0.113.7',
      previousIpv4: null,
      recordUpdated: true,
    });
    expect(state.records.get('z1')).toMatchObject([
      { type: 'A', name: 'home.example.com', content: '203.0.113.7', ttl: 60, proxied: false },
    ]);
    expect(audits).toMatchObject([{ action: 'dns-record.create', actorType: 'system' }]);

    const second = await ddns.run();
    expect(second).toMatchObject({ outcome: 'unchanged', recordUpdated: false });
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect((await ddns.status()).lastRun).toEqual(second);
  });

  it('updates the existing record when the address changes, re-reading it when forced', async () => {
    const { ddns, state, setAnswer, listRecords } = setup();
    await ddns.run();
    const recordId = state.records.get('z1')?.[0]?.externalId;
    setAnswer('198.51.100.4');
    const run = await ddns.run();
    expect(run).toMatchObject({
      outcome: 'updated',
      previousIpv4: '203.0.113.7',
      recordUpdated: true,
    });
    expect(state.records.get('z1')).toMatchObject([
      { externalId: recordId, content: '198.51.100.4' },
    ]);
    await ddns.run({ force: true });
    expect(listRecords).toHaveBeenCalledTimes(3);
  });

  it('only stores the address when dynamic DNS is disabled or the zone is unmanaged', async () => {
    const disabled = setup({ dynamicDnsEnabled: false });
    expect(await disabled.ddns.run()).toMatchObject({ outcome: 'updated', recordUpdated: false });
    expect(disabled.state.records.get('z1')).toEqual([]);

    const foreign = setup({ anchorHostname: 'home.elsewhere.net' });
    const run = await foreign.ddns.run();
    expect(run.message).toMatch(/No managed zone contains home.elsewhere.net/);
    expect(foreign.state.records.get('z1')).toEqual([]);
  });

  it('skips without touching anything when detection fails', async () => {
    const { ddns, setAnswer, state } = setup({ publicIpv4: '192.0.2.1' });
    setAnswer('garbage');
    const run = await ddns.run();
    expect(run).toMatchObject({
      outcome: 'skipped',
      previousIpv4: '192.0.2.1',
      detectedIpv4: null,
    });
    expect(state.records.get('z1')).toEqual([]);
    expect((await ddns.status()).publicIpv4).toBe('192.0.2.1');
  });

  it('reports provider failures as a failed run instead of throwing', async () => {
    const { ddns, state } = setup();
    state.token = 'rotated';
    const run = await ddns.run();
    expect(run).toMatchObject({ outcome: 'failed', recordUpdated: false });
    expect(run.message).toContain('Invalid token');
  });

  it('reports the anchor zone in the status', async () => {
    const { ddns } = setup();
    expect(await ddns.status()).toMatchObject({
      dynamicDnsEnabled: true,
      anchorHostname: 'home.example.com',
      anchorZoneId: zone.id,
      lastRun: null,
    });
  });
});
