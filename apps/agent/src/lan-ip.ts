import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

/** Interfaces created by Docker, CNI plugins and VPNs; never a LAN address. */
const IGNORED_INTERFACE =
  /^(?:docker\d*|br-|veth|cni|flannel|cali|virbr|tun|tap|wg|tailscale|zt|utun)/;

/**
 * Best-effort LAN IPv4 of this node: the first non-internal, non-link-local IPv4 of a physical
 * interface. Inside a container this is only meaningful with host networking; set
 * SLIPWAY_NODE_LAN_IP otherwise.
 */
export function detectLanIp(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (IGNORED_INTERFACE.test(name)) continue;
    for (const address of addresses ?? []) {
      if (
        address.family === 'IPv4' &&
        !address.internal &&
        !address.address.startsWith('169.254.')
      ) {
        return address.address;
      }
    }
  }
  return null;
}
