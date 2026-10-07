import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { bridgeSubnets, createLanIpDetector, selectLanIp } from './lan-ip.js';

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

/** The bundled agent: a container on the proxy network only. */
const bundledAgent = { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('10.210.0.130')] };
/** An agent with host networking on a Linux node. */
const hostNetwork = {
  lo: [ipv4('127.0.0.1', true)],
  docker0: [ipv4('172.17.0.1')],
  'br-1a2b': [ipv4('10.210.0.1')],
  eth0: [ipv4('169.254.10.2'), ipv4('192.168.1.20')],
};
const dockerSubnets = ['172.17.0.0/16', '10.210.0.0/24', 'fd00:dead:beef::/48'];
const nothingElse = { configured: null, dockerHostAddresses: [], dockerSubnets };

describe('selectLanIp', () => {
  it('prefers LAUNCHWAY_NODE_LAN_IP over everything else', () => {
    expect(
      selectLanIp({
        configured: '192.168.1.99',
        dockerHostAddresses: ['192.168.1.20'],
        dockerSubnets: null,
        interfaces: hostNetwork,
      }),
    ).toEqual({ address: '192.168.1.99', source: 'LAUNCHWAY_NODE_LAN_IP' });
  });

  it('never reports the address of a container on a Docker network', () => {
    expect(selectLanIp({ ...nothingElse, interfaces: bundledAgent })).toBeNull();
  });

  it('uses a private IPv4 the Docker daemon reports for its host', () => {
    expect(
      selectLanIp({
        ...nothingElse,
        dockerHostAddresses: ['192.168.1.20'],
        interfaces: bundledAgent,
      }),
    ).toEqual({ address: '192.168.1.20', source: 'docker-host' });
  });

  it('ignores daemon addresses that are public or inside a Docker network', () => {
    expect(
      selectLanIp({
        ...nothingElse,
        dockerHostAddresses: ['203.0.113.7', '10.210.0.1', 'fe80::1'],
        interfaces: hostNetwork,
      }),
    ).toEqual({ address: '192.168.1.20', source: 'interface' });
  });

  it('skips loopback, link-local, Docker bridge and VPN interfaces with host networking', () => {
    expect(
      selectLanIp({
        ...nothingElse,
        interfaces: { tailscale0: [ipv4('100.64.0.5')], ...hostNetwork },
      }),
    ).toEqual({ address: '192.168.1.20', source: 'interface' });
  });

  it('skips addresses inside a Docker subnet whatever the interface is called', () => {
    expect(
      selectLanIp({
        ...nothingElse,
        interfaces: { ens3: [ipv4('172.17.0.1')], ens4: [ipv4('192.168.1.30')] },
      }),
    ).toEqual({ address: '192.168.1.30', source: 'interface' });
  });

  it('does not trust the interfaces when the Docker networks are unknown', () => {
    expect(
      selectLanIp({ ...nothingElse, dockerSubnets: null, interfaces: bundledAgent }),
    ).toBeNull();
  });

  it('returns null when nothing qualifies', () => {
    expect(
      selectLanIp({ ...nothingElse, interfaces: { lo: [ipv4('127.0.0.1', true)] } }),
    ).toBeNull();
  });
});

describe('bridgeSubnets', () => {
  it('lists the subnets of bridge networks only', async () => {
    const docker = {
      listNetworks: async () => [
        {
          Driver: 'bridge',
          IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
        },
        {
          Driver: 'bridge',
          IPAM: { Config: [{ Subnet: '10.210.0.0/24' }, { Subnet: 'fd00::/64' }] },
        },
        { Driver: 'macvlan', IPAM: { Config: [{ Subnet: '192.168.1.0/24' }] } },
        { Driver: 'overlay', IPAM: { Config: [{ Subnet: '10.0.0.0/24' }] } },
        { Driver: 'host', IPAM: { Config: [] } },
        { Driver: 'null' },
      ],
    };
    expect(await bridgeSubnets(docker)).toEqual(['172.17.0.0/16', '10.210.0.0/24', 'fd00::/64']);
  });
});

describe('createLanIpDetector', () => {
  const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });
  const proxyNetwork = async () => [
    { Driver: 'bridge', IPAM: { Config: [{ Subnet: '10.210.0.0/24' }] } },
  ];
  const linux = (hostAddresses: string[] = []) => ({
    docker: { operatingSystem: 'Ubuntu 24.04.3 LTS' },
    hostAddresses,
  });

  it('warns once that LAUNCHWAY_NODE_LAN_IP is needed when nothing qualifies', async () => {
    const log = logger();
    const detector = createLanIpDetector({
      configured: null,
      docker: { listNetworks: proxyNetwork },
      logger: log,
      interfaces: () => bundledAgent,
      inContainer: true,
    });
    expect(await detector.detect(linux())).toBeNull();
    expect(await detector.detect(linux())).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/LAUNCHWAY_NODE_LAN_IP/);

    expect(await detector.detect(linux(['192.168.1.20']))).toBe('192.168.1.20');
    expect(log.info).toHaveBeenCalledWith(
      { lanIp: '192.168.1.20', source: 'docker-host' },
      'LAN address of this node',
    );
  });

  it('does not ask Docker when LAUNCHWAY_NODE_LAN_IP is set', async () => {
    const listNetworks = vi.fn(proxyNetwork);
    const detector = createLanIpDetector({
      configured: '192.168.1.99',
      docker: { listNetworks },
      logger: logger(),
      interfaces: () => bundledAgent,
      inContainer: true,
    });
    expect(await detector.detect(linux())).toBe('192.168.1.99');
    expect(listNetworks).not.toHaveBeenCalled();
  });

  it('reports no interface address when the Docker networks cannot be listed', async () => {
    const log = logger();
    const detector = createLanIpDetector({
      configured: null,
      docker: { listNetworks: () => Promise.reject(new Error('connect ENOENT')) },
      logger: log,
      interfaces: () => bundledAgent,
      inContainer: true,
    });
    expect(await detector.detect(linux())).toBeNull();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores the addresses of the Docker Desktop VM', async () => {
    const desktop = {
      docker: { operatingSystem: 'Docker Desktop' },
      hostAddresses: ['192.168.65.3'],
    };
    const detector = (inContainer: boolean, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) =>
      createLanIpDetector({
        configured: null,
        docker: { listNetworks: proxyNetwork },
        logger: logger(),
        interfaces: () => interfaces,
        inContainer,
      });
    // In a container, even with host networking, the interfaces are the VM's.
    expect(await detector(true, { eth0: [ipv4('192.168.65.3')] }).detect(desktop)).toBeNull();
    // An agent started on the machine itself (development) sees the machine's interfaces.
    expect(await detector(false, { en0: [ipv4('192.168.1.40')] }).detect(desktop)).toBe(
      '192.168.1.40',
    );
  });
});
