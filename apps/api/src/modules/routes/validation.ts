import { type RouteTarget, serviceAlias } from '@slipway/contracts';
import { invalidField } from '../../lib/problem.js';

/** A routed service of another app, as stored. */
export interface RoutedService {
  readonly slug: string;
  readonly service: string | null;
}

/** Redirect targets must be absolute https URLs (the contract also allows http). */
export function assertRedirectTarget(target: RouteTarget, path: string): void {
  if (target.kind === 'redirect' && new URL(target.to).protocol !== 'https:') {
    throw invalidField(`${path}.to`, 'Redirects must point to an absolute https URL');
  }
}

/** `<slug>-<service>`; a 400 for `<path>.service` when the alias exceeds 63 characters. */
export function routeAlias(slug: string, service: string, path: string): string {
  try {
    return serviceAlias(slug, service);
  } catch {
    throw invalidField(
      `${path}.service`,
      `The network alias "${slug}-${service}" would exceed 63 characters`,
    );
  }
}

/**
 * The routed service of another app that yields the same network alias, if any. Aliases are
 * ambiguous across apps: `shop` + `api-db` and `shop-api` + `db` both give `shop-api-db`.
 */
export function findAliasClash(
  alias: string,
  others: readonly RoutedService[],
): RoutedService | undefined {
  return others.find(
    (other) => other.service !== null && `${other.slug}-${other.service}` === alias,
  );
}
