import { describe, expect, it, vi } from 'vitest';
import { createFakeCloudflare } from '../../../../test/support/fake-cloudflare.js';
import { cloudflareProvider } from './cloudflare.js';
import { DnsProviderError } from './types.js';

const TOKEN = 'valid-token-0123456789abcdef';

function client(fetchFn: typeof fetch) {
  return cloudflareProvider.create({ apiToken: TOKEN }, { fetch: fetchFn });
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );

describe('cloudflare provider', () => {
  it('validates the credentials shape', () => {
    const schema = cloudflareProvider.credentialsSchema;
    expect(schema.safeParse({ apiToken: TOKEN }).success).toBe(true);
    expect(schema.safeParse({ apiToken: 'short' }).success).toBe(false);
    expect(schema.safeParse({ apiToken: `${TOKEN} x` }).success).toBe(false);
    expect(schema.safeParse({ apiToken: TOKEN, extra: 1 }).success).toBe(false);
  });

  it('sends the token as a bearer header and verifies via /user/tokens/verify', async () => {
    const api = createFakeCloudflare({ token: TOKEN });
    await client(api.fetch).verifyCredentials();
    expect(api.calls[0]).toBe('GET /user/tokens/verify');
    expect(api.authorizations.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('rejects a token that is not active', async () => {
    const fetchFn = respond(200, {
      success: true,
      errors: [],
      result: { id: 't', status: 'disabled' },
    });
    await expect(client(fetchFn).verifyCredentials()).rejects.toMatchObject({
      reason: 'unauthorized',
      message: 'The Cloudflare API token is disabled',
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [400, 'invalid'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, reason) => {
    const fetchFn = respond(status, {
      success: false,
      errors: [{ code: 1234, message: 'Something went wrong' }],
    });
    const error = await client(fetchFn)
      .listZones()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DnsProviderError);
    expect(error).toMatchObject({ reason });
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('maps 429 to rate-limited with the Retry-After delay', async () => {
    const fetchFn = respond(429, { success: false, errors: [] }, { 'retry-after': '30' });
    await expect(client(fetchFn).listZones()).rejects.toMatchObject({
      reason: 'rate-limited',
      retryAfter: 30,
    });
  });

  it('maps "record already exists" errors to conflict', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, errors: [], result: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 81053, message: 'exists' }] }),
          { status: 400 },
        ),
      );
    await expect(
      client(fetchFn).upsertRecord('z', { type: 'A', name: 'a.example.com', content: '192.0.2.1' }),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });

  it('treats network failures, non-JSON and unexpected shapes as unavailable', async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(offline).listZones()).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(client(respond(200, '<html>')).listZones()).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(
      client(respond(200, { success: true, errors: [], result: [{ nope: 1 }] })).listZones(),
    ).rejects.toMatchObject({
      reason: 'unavailable',
      message: 'Cloudflare sent an unexpected response',
    });
    await expect(
      client(
        respond(200, { success: false, errors: [{ code: 1, message: 'bad' }], result: [] }),
      ).listZones(),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('follows pagination for zones and records and skips unsupported record types', async () => {
    const api = createFakeCloudflare({
      token: TOKEN,
      zones: [
        { id: 'z1', name: 'Example.com' },
        { id: 'z2', name: 'example.net' },
        { id: 'z3', name: 'example.org' },
      ],
      maxPerPage: 2,
    });
    const provider = client(api.fetch);
    expect(await provider.listZones()).toEqual([
      { externalId: 'z1', name: 'example.com' },
      { externalId: 'z2', name: 'example.net' },
      { externalId: 'z3', name: 'example.org' },
    ]);
    api.records.set('z1', [
      {
        id: 'r1',
        type: 'A',
        name: 'a.example.com',
        content: '192.0.2.1',
        ttl: 1,
        proxied: true,
        proxiable: true,
      },
      {
        id: 'r2',
        type: 'MX',
        name: 'example.com',
        content: 'mx.example.com',
        ttl: 300,
        proxiable: false,
      },
      {
        id: 'r3',
        type: 'TXT',
        name: 'example.com',
        content: 'v=spf1 -all',
        ttl: 300,
        proxiable: false,
      },
    ]);
    expect(await provider.listRecords('z1')).toEqual([
      {
        externalId: 'r1',
        type: 'A',
        name: 'a.example.com',
        content: '192.0.2.1',
        ttl: 1,
        proxied: true,
      },
      {
        externalId: 'r3',
        type: 'TXT',
        name: 'example.com',
        content: 'v=spf1 -all',
        ttl: 300,
        proxied: null,
      },
    ]);
    expect(api.calls.filter((call) => call.startsWith('GET /zones?'))).toHaveLength(2);
  });

  it('creates with POST, updates with PATCH, sends ttl 1 (auto) by default and no proxied for TXT', async () => {
    const api = createFakeCloudflare({ token: TOKEN, zones: [{ id: 'z1', name: 'example.com' }] });
    const bodies: unknown[] = [];
    const spy: typeof fetch = async (input, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return api.fetch(input, init);
    };
    const provider = client(spy);
    await provider.upsertRecord('z1', { type: 'TXT', name: 'example.com', content: 'hello' });
    await provider.upsertRecord('z1', {
      type: 'A',
      name: 'a.example.com',
      content: '192.0.2.1',
      ttl: 120,
    });
    await provider.upsertRecord('z1', { type: 'A', name: 'a.example.com', content: '192.0.2.2' });
    expect(bodies).toEqual([
      { type: 'TXT', name: 'example.com', content: 'hello', ttl: 1 },
      { type: 'A', name: 'a.example.com', content: '192.0.2.1', ttl: 120, proxied: false },
      { type: 'A', name: 'a.example.com', content: '192.0.2.2', ttl: 1, proxied: false },
    ]);
    const writes = api.calls.filter((call) => !call.startsWith('GET'));
    expect(writes.map((call) => call.split(' ')[0])).toEqual(['POST', 'POST', 'PATCH']);
  });

  it('escapes ids in paths', async () => {
    const fetchFn = respond(200, { success: true, errors: [], result: { id: 'x' } });
    await client(fetchFn).deleteRecord('zone/../x', 'rec?id');
    const [url] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone%2F..%2Fx/dns_records/rec%3Fid',
    );
  });
});
