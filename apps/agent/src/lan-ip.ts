import { existsSync } from 'node:fs';
import { BlockList, isIPv4 } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import type { Logger } from 'pino';

/** Interfaces created by Docker, CNI plugins and VPNs; never a LAN address. */
const IGNORED_INTERFACE =
  /^(?:docker\d*|br-|veth|cni|flannel|cali|virbr|tun|tap|wg|tailscale|zt|utun)/;

const PRIVATE_IPV4 = new BlockList();
PRIVATE_IPV4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_IPV4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_IPV4.addSubnet('192.168.0.0', 16, 'ipv4');

const IPV4_CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

const NO_LAN_IP_WARNING =
  'No LAN address found for this node. Set LAUNCHWAY_NODE_LAN_IP to the address the edge node ' +
  'reaches this machine on; routes to apps on this node need it, unless this is the edge node itself.';

interface LanIpInputs {
  /** LAUNCHWAY_NODE_LAN_IP. */
  readonly configured: string | null;
  /** Addresses the Docker daemon reports for its host (`DockerProbe.hostAddresses`). */
  readonly dockerHostAddresses: readonly string[];
  /**
   * Subnets (CIDR) of the local Docker bridge networks, the agent's own among them; null when the
   * daemon could not be asked.
   */
  readonly dockerSubnets: readonly string[] | null;
  /** This process's interfaces: the host's with host networking, the container's otherwise. */
  readonly interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

interface LanIp {
  readonly address: string;
  readonly source: 'LAUNCHWAY_NODE_LAN_IP' | 'docker-host' | 'interface';
}

/**
 * The address the edge uses to reach this node, in order of preference: LAUNCHWAY_NODE_LAN_IP, a
 * private IPv4 the Docker daemon reports for its host, then the first non-internal, non-link-local
 * IPv4 of an interface that is not a Docker, CNI or VPN interface. An address inside a Docker
 * bridge network never qualifies: it belongs to a container (the bundled agent's own address on
 * the proxy network, for one), and other machines cannot reach it.
 */
export function selectLanIp(inputs: LanIpInputs): LanIp | null {
  if (inputs.configured) return { address: inputs.configured, source: 'LAUNCHWAY_NODE_LAN_IP' };

  const docker = new BlockList();
  for (const cidr of inputs.dockerSubnets ?? []) {
    const [, network, prefix] = IPV4_CIDR.exec(cidr) ?? [];
    if (network && prefix && isIPv4(network) && Number(prefix) <= 32) {
      docker.addSubnet(network, Number(prefix), 'ipv4');
    }
  }
  const outsideDocker = (address: string) => isIPv4(address) && !docker.check(address, 'ipv4');

  const host = inputs.dockerHostAddresses.find(
    (address) => outsideDocker(address) && PRIVATE_IPV4.check(address, 'ipv4'),
  );
  if (host) return { address: host, source: 'docker-host' };

  // Without the Docker subnets, an agent in a container cannot tell its own address from the
  // machine's.
  if (!inputs.dockerSubnets) return null;
  for (const [name, addresses] of Object.entries(inputs.interfaces)) {
    if (IGNORED_INTERFACE.test(name)) continue;
    for (const { family, internal, address } of addresses ?? []) {
      if (
        family === 'IPv4' &&
        !internal &&
        !address.startsWith('169.254.') &&
        outsideDocker(address)
      ) {
        return { address, source: 'interface' };
      }
    }
  }
  return null;
}

/** The part of the Docker client the detection needs (dockerode's `listNetworks`). */
interface DockerNetworks {
  listNetworks(): Promise<
    readonly {
      readonly Driver: string;
      readonly IPAM?:
        | { readonly Config?: readonly { readonly Subnet?: string | undefined }[] | undefined }
        | undefined;
    }[]
  >;
}

/**
 * Subnets of the local Docker bridge networks; inside one of them an address belongs to a
 * container, not to the machine. Overlay, macvlan and ipvlan networks are left out: their subnets
 * may be the LAN's own.
 */
export async function bridgeSubnets(docker: DockerNetworks): Promise<string[]> {
  const networks = await docker.listNetworks();
  return networks
    .filter((network) => network.Driver === 'bridge')
    .flatMap((network) => network.IPAM?.Config ?? [])
    .flatMap((config) => (config.Subnet ? [config.Subnet] : []));
}

/** What the detection uses from the Docker probe of `hello` (`DockerProbe`). */
interface ProbedDocker {
  readonly docker: { readonly operatingSystem: string } | null;
  readonly hostAddresses: readonly string[];
}

interface LanIpDetector {
  /**
   * The LAN address to report in `hello`, or null. Logs the address and its source, or a warning
   * when there is none, whenever the result changes.
   */
  detect(probe: ProbedDocker): Promise<string | null>;
}

export function createLanIpDetector(deps: {
  readonly configured: string | null;
  readonly docker: DockerNetworks;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /** Defaults to `os.networkInterfaces`. */
  readonly interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Whether the agent runs in a container; defaults to whether `/.dockerenv` exists. */
  readonly inContainer?: boolean;
}): LanIpDetector {
  const inContainer = deps.inContainer ?? existsSync('/.dockerenv');
  let reported: string | null | undefined;
  const subnets = async (): Promise<string[] | null> => {
    if (deps.configured) return [];
    try {
      return await bridgeSubnets(deps.docker);
    } catch (err) {
      deps.logger.debug({ err }, 'could not list the Docker networks for the LAN address');
      return null;
    }
  };
  return {
    async detect(probe) {
      // Docker Desktop runs the daemon in a VM: the addresses it reports for its host, and those a
      // container sees even with host networking, are the VM's, not the machine's.
      const desktop = probe.docker?.operatingSystem.startsWith('Docker Desktop') ?? false;
      const lanIp = selectLanIp({
        configured: deps.configured,
        dockerHostAddresses: desktop ? [] : probe.hostAddresses,
        dockerSubnets: await subnets(),
        interfaces: desktop && inContainer ? {} : (deps.interfaces ?? networkInterfaces)(),
      });
      const address = lanIp?.address ?? null;
      if (address !== reported) {
        reported = address;
        if (lanIp) {
          deps.logger.info(
            { lanIp: lanIp.address, source: lanIp.source },
            'LAN address of this node',
          );
        } else {
          deps.logger.warn(NO_LAN_IP_WARNING);
        }
      }
      return address;
    },
  };
}
