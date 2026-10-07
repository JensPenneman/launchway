import { describe, expect, it } from 'vitest';
import {
  createResolver,
  type DnsLookup,
  evaluateDns,
  expectedRecordFor,
  observeDns,
  recordInputFor,
} from './verify.js';

const dnsError = (code: string) => Object.assign(new Error(code), { code });

/** Resolver over a static table; missing names answer ENOTFOUND like a real resolver. */
function fakeResolver(table: {
  cname?: Record<string, string>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
  fail?: string;
}): DnsLookup {
  const follow = (name: string): string => {
    const next = table.cname?.[name];
    return next ? follow(next) : name;
  };
  const answer = (values: string[] | undefined) => {
    if (table.fail) return Promise.reject(dnsError(table.fail));
    return values ? Promise.resolve(values) : Promise.reject(dnsError('ENOTFOUND'));
  };
  return {
    resolveCname: (name) => answer(table.cname?.[name] ? [`${table.cname[name]}.`] : undefined),
    resolve4: (name) => answer(table.a?.[follow(name)]),
    resolve6: (name) => answer(table.aaaa?.[follow(name)]),
  };
}

const IP = '203.0.113.7';

describe('expectedRecordFor', () => {
  it('prefers a CNAME to the anchor, except for the anchor itself', () => {
    const target = { anchorHostname: 'home.example.com', publicIpv4: IP };
    expect(expectedRecordFor('app.example.com', target)).toEqual({
      type: 'CNAME',
      value: 'home.example.com',
    });
    expect(expectedRecordFor('home.example.com', target)).toEqual({ type: 'A', value: IP });
    expect(expectedRecordFor('app.example.com', { anchorHostname: null, publicIpv4: IP })).toEqual({
      type: 'A',
      value: IP,
    });
    expect(
      expectedRecordFor('app.example.com', { anchorHostname: null, publicIpv4: null }),
    ).toBeNull();
  });

  it('builds the matching record input', () => {
    expect(recordInputFor('a.example.com', { type: 'A', value: IP }, true)).toEqual({
      type: 'A',
      name: 'a.example.com',
      content: IP,
      proxied: true,
    });
  });
});

describe('observeDns', () => {
  it('follows CNAME chains and resolves the final addresses', async () => {
    const resolver = fakeResolver({
      cname: { 'app.example.com': 'edge.example.com', 'edge.example.com': 'home.example.com' },
      a: { 'home.example.com': [IP] },
    });
    expect(await observeDns('app.example.com', resolver)).toEqual({
      observed: { cname: ['edge.example.com', 'home.example.com'], a: [IP], aaaa: [] },
      error: null,
    });
  });

  it('stops on CNAME loops', async () => {
    const resolver = fakeResolver({
      cname: { 'a.example.com': 'b.example.com', 'b.example.com': 'a.example.com' },
    });
    const loop: DnsLookup = { ...resolver, resolve4: async () => [], resolve6: async () => [] };
    const { observed } = await observeDns('a.example.com', loop);
    expect(observed.cname).toEqual(['b.example.com', 'a.example.com']);
  });

  it('reports resolver failures other than "no such name"', async () => {
    const { observed, error } = await observeDns(
      'app.example.com',
      fakeResolver({ fail: 'ETIMEOUT' }),
    );
    expect(error).toBe('ETIMEOUT');
    expect(observed).toEqual({ a: [], aaaa: [], cname: [] });
  });

  it('creates a node resolver with the given servers', () => {
    expect(createResolver(['192.0.2.53'])).toHaveProperty('resolve4');
  });
});

describe('evaluateDns', () => {
  const cname = { type: 'CNAME', value: 'home.example.com' } as const;
  const context = { publicIpv4: IP, proxied: false, lookupError: null };

  it('passes when the anchor is in the CNAME chain', () => {
    const result = evaluateDns(
      'app.example.com',
      cname,
      { cname: ['home.example.com'], a: [IP], aaaa: [] },
      context,
    );
    expect(result).toEqual({
      ok: true,
      message: 'app.example.com is an alias of home.example.com',
    });
  });

  it('passes a flattened CNAME that resolves to the public IPv4', () => {
    expect(evaluateDns('example.com', cname, { cname: [], a: [IP], aaaa: [] }, context).ok).toBe(
      true,
    );
  });

  it('passes an A expectation only when every address is the public IPv4', () => {
    const a = { type: 'A', value: IP } as const;
    expect(evaluateDns('h.example.com', a, { cname: [], a: [IP], aaaa: [] }, context).ok).toBe(
      true,
    );
    const mixed = evaluateDns(
      'h.example.com',
      a,
      { cname: [], a: [IP, '192.0.2.1'], aaaa: [] },
      context,
    );
    expect(mixed).toEqual({
      ok: false,
      message: `Expected an A record ${IP}; found A ${IP}, 192.0.2.1`,
    });
  });

  it('accepts any answer for proxied domains', () => {
    const observed = { cname: [], a: ['104.16.0.1'], aaaa: ['2606:4700::1'] };
    expect(evaluateDns('app.example.com', cname, observed, { ...context, proxied: true }).ok).toBe(
      true,
    );
    expect(evaluateDns('app.example.com', cname, observed, context).ok).toBe(false);
  });

  it('explains missing records, lookup failures and missing configuration', () => {
    const none = { cname: [], a: [], aaaa: [] };
    expect(evaluateDns('app.example.com', cname, none, context).message).toBe(
      'Expected a CNAME to home.example.com; found no records',
    );
    expect(
      evaluateDns('app.example.com', cname, none, { ...context, lookupError: 'ESERVFAIL' }),
    ).toEqual({
      ok: false,
      inconclusive: true,
      message: 'DNS lookup of app.example.com failed (ESERVFAIL)',
    });
    expect(evaluateDns('app.example.com', null, none, context)).toMatchObject({ ok: false });
  });
});
