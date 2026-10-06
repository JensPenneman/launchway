import { describe, expect, it } from 'vitest';
import { createTrustedProxyList, normalizeIp, resolveClientIp } from './client-ip.js';

const trusted = createTrustedProxyList(['10.210.0.0/24', 'fd00::/8']);

describe('resolveClientIp', () => {
  it('uses the socket address when the peer is not a trusted proxy', () => {
    expect(resolveClientIp('203.0.113.9', '1.2.3.4', trusted)).toBe('203.0.113.9');
  });

  it('trusts X-Forwarded-For from the proxy network and takes the first untrusted hop from the right', () => {
    expect(resolveClientIp('10.210.0.2', '198.51.100.7', trusted)).toBe('198.51.100.7');
    expect(resolveClientIp('10.210.0.2', '6.6.6.6, 198.51.100.7, 10.210.0.5', trusted)).toBe(
      '198.51.100.7',
    );
    expect(resolveClientIp('::ffff:10.210.0.2', '198.51.100.7', trusted)).toBe('198.51.100.7');
  });

  it('falls back to the peer for malformed headers', () => {
    expect(resolveClientIp('10.210.0.2', 'not-an-ip', trusted)).toBe('10.210.0.2');
    expect(resolveClientIp('10.210.0.2', undefined, trusted)).toBe('10.210.0.2');
    expect(resolveClientIp(undefined, '1.2.3.4', trusted)).toBeNull();
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('fd00::1')).toBe('fd00::1');
  });
});
