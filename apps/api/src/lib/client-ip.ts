import { BlockList, isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../deps.js';

/** Builds a matcher for LAUNCHWAY_TRUSTED_PROXIES (validated CIDRs). */
export function createTrustedProxyList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix = ''] = cidr.split('/');
    list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** Strips the IPv4-mapped IPv6 prefix (`::ffff:10.0.0.1` -> `10.0.0.1`). */
export function normalizeIp(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Client IP of a request: the socket peer, unless that peer is a trusted proxy, in which case
 * `X-Forwarded-For` is walked from right to left and the first untrusted hop wins.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trusted: BlockList,
): string | null {
  if (!remoteAddress) return null;
  const remote = normalizeIp(remoteAddress);
  if (!forwardedFor || !isTrusted(trusted, remote)) return remote;
  const hops = forwardedFor.split(',').map((hop) => normalizeIp(hop.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] ?? '';
    if (isIP(hop) === 0) return remote;
    if (!isTrusted(trusted, hop)) return hop;
  }
  return hops[0] ?? remote;
}

/** Sets `c.var.clientIp` (null when the request did not come through a socket, e.g. in tests). */
export function clientIp(trusted: BlockList): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined;
    }
    c.set('clientIp', resolveClientIp(remote, c.req.header('x-forwarded-for'), trusted));
    await next();
  };
}
