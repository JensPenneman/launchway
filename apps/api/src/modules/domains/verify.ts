import { getServers, Resolver } from 'node:dns/promises';
import type { DnsRecordInput, DomainVerification } from '@launchway/contracts';

/** The lookups verification needs; `node:dns/promises` Resolver satisfies it. */
export interface DnsLookup {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

/** Public resolvers tried after the system ones. */
export const FALLBACK_RESOLVERS: readonly string[] = ['1.1.1.1', '8.8.8.8'];
const MAX_CNAME_HOPS = 10;
const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/**
 * A resolver asking `servers` in order (default: the system resolvers, then 1.1.1.1 and
 * 8.8.8.8). A server is only skipped when it fails; "no such name" is an answer.
 */
export function createResolver(servers?: readonly string[]): DnsLookup {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  const list = servers ?? [...getServers(), ...FALLBACK_RESOLVERS];
  resolver.setServers([...new Set(list)]);
  return resolver;
}

export type ExpectedRecord = NonNullable<DomainVerification['expected']>;
export type ObservedRecords = DomainVerification['observed'];

export interface DnsTarget {
  readonly anchorHostname: string | null;
  readonly publicIpv4: string | null;
}

/**
 * What `hostname` should resolve to: a CNAME to the anchor when one is configured (and the
 * domain is not the anchor itself), otherwise an A record with the public IPv4.
 */
export function expectedRecordFor(hostname: string, target: DnsTarget): ExpectedRecord | null {
  if (target.anchorHostname && target.anchorHostname !== hostname) {
    return { type: 'CNAME', value: target.anchorHostname };
  }
  return target.publicIpv4 ? { type: 'A', value: target.publicIpv4 } : null;
}

/** The record that makes `hostname` resolve as expected. */
export function recordInputFor(
  hostname: string,
  expected: ExpectedRecord,
  proxied = false,
): DnsRecordInput {
  return expected.type === 'CNAME'
    ? { type: 'CNAME', name: hostname, content: expected.value, proxied }
    : { type: 'A', name: hostname, content: expected.value, proxied };
}

const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

/** Looks a name up; "no such name/data" is an empty answer, other failures are returned. */
async function lookup(
  query: () => Promise<string[]>,
): Promise<{ values: string[]; error: string | null }> {
  try {
    return { values: await query(), error: null };
  } catch (error) {
    const code = errorCode(error);
    return { values: [], error: NO_ANSWER.has(code) ? null : code };
  }
}

/** Resolves the CNAME chain, A and AAAA records of `hostname`. */
export async function observeDns(
  hostname: string,
  resolver: DnsLookup,
): Promise<{ observed: ObservedRecords; error: string | null }> {
  const cname: string[] = [];
  let current = hostname;
  let error: string | null = null;
  for (let hop = 0; hop < MAX_CNAME_HOPS; hop += 1) {
    const result = await lookup(() => resolver.resolveCname(current));
    error ??= result.error;
    const next = result.values[0];
    if (!next || cname.includes(normalize(next))) break;
    current = normalize(next);
    cname.push(current);
  }
  const [a, aaaa] = await Promise.all([
    lookup(() => resolver.resolve4(hostname)),
    lookup(() => resolver.resolve6(hostname)),
  ]);
  error ??= a.error ?? aaaa.error;
  return { observed: { a: a.values, aaaa: aaaa.values, cname }, error };
}

export interface DnsCheckResult {
  readonly ok: boolean;
  readonly message: string;
  /** The lookup itself failed (timeout, SERVFAIL): says nothing about the records. */
  readonly inconclusive?: boolean;
}

function describe(observed: ObservedRecords): string {
  const parts = [
    observed.cname.length > 0 ? `CNAME ${observed.cname.join(' -> ')}` : null,
    observed.a.length > 0 ? `A ${observed.a.join(', ')}` : null,
    observed.aaaa.length > 0 ? `AAAA ${observed.aaaa.join(', ')}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'no records';
}

/** Compares what DNS answered with what Launchway expects (the DNS preflight). */
export function evaluateDns(
  hostname: string,
  expected: ExpectedRecord | null,
  observed: ObservedRecords,
  context: { publicIpv4: string | null; proxied: boolean; lookupError: string | null },
): DnsCheckResult {
  if (!expected) {
    return {
      ok: false,
      message:
        'Neither an anchor hostname nor the public IPv4 is known yet: set the anchor hostname or run dynamic DNS',
    };
  }
  const found = describe(observed);
  const resolvesToPublicIp =
    context.publicIpv4 !== null &&
    observed.a.length > 0 &&
    observed.a.every((address) => address === context.publicIpv4);

  if (expected.type === 'CNAME' && observed.cname.includes(expected.value)) {
    return { ok: true, message: `${hostname} is an alias of ${expected.value}` };
  }
  if (expected.type === 'A' && resolvesToPublicIp) {
    return { ok: true, message: `${hostname} resolves to ${expected.value}` };
  }
  if (expected.type === 'CNAME' && resolvesToPublicIp) {
    return { ok: true, message: `${hostname} resolves to the public IPv4 ${context.publicIpv4}` };
  }
  if (context.proxied && observed.a.length + observed.aaaa.length > 0) {
    return {
      ok: true,
      message: `${hostname} is proxied by the DNS provider (${found}); the origin is not visible`,
    };
  }
  if (context.lookupError && observed.a.length + observed.cname.length === 0) {
    return {
      ok: false,
      inconclusive: true,
      message: `DNS lookup of ${hostname} failed (${context.lookupError})`,
    };
  }
  const want =
    expected.type === 'CNAME' ? `a CNAME to ${expected.value}` : `an A record ${expected.value}`;
  return { ok: false, message: `Expected ${want}; found ${found}` };
}
