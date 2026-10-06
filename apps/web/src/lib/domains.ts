import type { DomainStatus } from '@slipway/contracts';

/**
 * Statuses in which the edge serves the domain: `verified` (DNS preflight passed) and `active`
 * (verified and holding a certificate; added by the domains module).
 */
const SERVING: readonly string[] = ['verified', 'active'];

export function isDomainServing(status: DomainStatus | string): boolean {
  return SERVING.includes(status);
}
