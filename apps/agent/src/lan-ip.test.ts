import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectLanIp } from './lan-ip.js';

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('detectLanIp', () => {
  it('skips loopback, Docker bridges and link-local addresses', () => {
    expect(
      detectLanIp({
        lo: [ipv4('127.0.0.1', true)],
        docker0: [ipv4('172.17.0.1')],
        'br-1a2b': [ipv4('10.210.0.1')],
        eth0: [ipv4('169.254.10.2'), ipv4('192.168.1.20')],
      }),
    ).toBe('192.168.1.20');
  });

  it('returns null when nothing qualifies', () => {
    expect(detectLanIp({ lo: [ipv4('127.0.0.1', true)] })).toBeNull();
  });
});
