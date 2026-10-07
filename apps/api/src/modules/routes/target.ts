import type { RouteTarget } from '@launchway/contracts';
import type { routes } from './schema.js';

type RouteRow = typeof routes.$inferSelect;
type TargetColumns = Pick<
  RouteRow,
  | 'targetKind'
  | 'appId'
  | 'appService'
  | 'appPort'
  | 'externalScheme'
  | 'externalHost'
  | 'externalPort'
  | 'redirectTo'
  | 'redirectPermanent'
>;

/** The kind-prefixed columns of a target; the columns of the other kinds are cleared. */
export function targetColumns(target: RouteTarget): TargetColumns {
  return {
    targetKind: target.kind,
    appId: target.kind === 'app' ? target.appId : null,
    appService: target.kind === 'app' ? target.service : null,
    appPort: target.kind === 'app' ? target.port : null,
    externalScheme: target.kind === 'external' ? target.scheme : null,
    externalHost: target.kind === 'external' ? target.host : null,
    externalPort: target.kind === 'external' ? target.port : null,
    redirectTo: target.kind === 'redirect' ? target.to : null,
    redirectPermanent: target.kind === 'redirect' ? target.permanent : null,
  };
}

/** Rebuilds the target union from a row (the routes_target_complete CHECK keeps rows complete). */
export function toRouteTarget(row: TargetColumns): RouteTarget {
  switch (row.targetKind) {
    case 'app':
      if (row.appId && row.appService && row.appPort !== null) {
        return { kind: 'app', appId: row.appId, service: row.appService, port: row.appPort };
      }
      break;
    case 'external':
      if (row.externalScheme && row.externalHost && row.externalPort !== null) {
        return {
          kind: 'external',
          scheme: row.externalScheme,
          host: row.externalHost,
          port: row.externalPort,
        };
      }
      break;
    case 'redirect':
      if (row.redirectTo && row.redirectPermanent !== null) {
        return { kind: 'redirect', to: row.redirectTo, permanent: row.redirectPermanent };
      }
      break;
  }
  throw new Error(`route row has an incomplete ${row.targetKind} target`);
}
