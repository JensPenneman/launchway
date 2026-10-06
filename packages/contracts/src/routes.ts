import { Hostname, HttpUrl, Port, ServiceName, Timestamp, UpstreamHost } from './common.js';
import { AppId, DomainId, RouteId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

export const ROUTE_TARGET_KINDS = ['app', 'external', 'redirect'] as const;
export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number];

export const AppRouteTarget = z
  .object({ kind: z.literal('app'), appId: AppId, service: ServiceName, port: Port })
  .openapi('AppRouteTarget', { description: 'A service port of a Slipway app' });

export const ExternalRouteTarget = z
  .object({
    kind: z.literal('external'),
    scheme: z.enum(['http', 'https']),
    host: UpstreamHost,
    port: Port,
  })
  .openapi('ExternalRouteTarget', { description: 'Any host:port reachable from the edge' });

export const RedirectRouteTarget = z
  .object({
    kind: z.literal('redirect'),
    to: HttpUrl,
    permanent: z.boolean().default(false).openapi({ description: '308 when true, 307 otherwise' }),
  })
  .openapi('RedirectRouteTarget');

export const RouteTarget = z
  .discriminatedUnion('kind', [AppRouteTarget, ExternalRouteTarget, RedirectRouteTarget])
  .openapi('RouteTarget');
export type RouteTarget = z.infer<typeof RouteTarget>;

export const ROUTE_OPTION_DEFAULTS = { protected: false, compress: true, hsts: true } as const;

const routeOptions = {
  protected: z.boolean().openapi({ description: 'Require forward auth (Setting.forwardAuthUrl)' }),
  compress: z.boolean().openapi({ description: 'encode zstd gzip' }),
  hsts: z.boolean().openapi({ description: 'Send Strict-Transport-Security' }),
};

export const Route = z
  .object({
    id: RouteId,
    domainId: DomainId,
    hostname: Hostname,
    target: RouteTarget,
    ...routeOptions,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Route', { description: 'What a domain serves (one route per domain)' });
export type Route = z.infer<typeof Route>;

export const RoutePage = page(Route).openapi('RoutePage');
export type RoutePage = z.infer<typeof RoutePage>;

export const RouteListQuery = PaginationQuery.extend({ appId: AppId.optional() });
export type RouteListQuery = z.infer<typeof RouteListQuery>;

export const CreateRouteInput = z
  .strictObject({
    domainId: DomainId,
    target: RouteTarget,
    protected: routeOptions.protected.default(ROUTE_OPTION_DEFAULTS.protected),
    compress: routeOptions.compress.default(ROUTE_OPTION_DEFAULTS.compress),
    hsts: routeOptions.hsts.default(ROUTE_OPTION_DEFAULTS.hsts),
  })
  .openapi('CreateRouteInput');
export type CreateRouteInput = z.infer<typeof CreateRouteInput>;

export const UpdateRouteInput = z
  .strictObject({
    target: RouteTarget.optional(),
    protected: z.boolean().optional(),
    compress: z.boolean().optional(),
    hsts: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field')
  .openapi('UpdateRouteInput');
export type UpdateRouteInput = z.infer<typeof UpdateRouteInput>;

/** Rendered edge configuration (`GET /edge/config`, read-only). */
export const EdgeConfig = z
  .object({
    caddyfile: z.string(),
    renderedAt: Timestamp,
    loadedAt: Timestamp.nullable().openapi({ description: 'Last successful load into Caddy' }),
  })
  .openapi('EdgeConfig');
export type EdgeConfig = z.infer<typeof EdgeConfig>;
