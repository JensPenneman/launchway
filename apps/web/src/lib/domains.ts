import type { DomainStatus } from '@launchway/contracts';

/**
 * Statuses in which the edge renders the domain: `verified` (DNS preflight passed) and `active`
 * (Caddy loaded its site and manages the certificate).
 */
const SERVING: readonly DomainStatus[] = ['verified', 'active'];

export function isDomainServing(status: DomainStatus): boolean {
  return SERVING.includes(status);
}
