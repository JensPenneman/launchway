import { Hostname, HttpUrl, Port, RoutableServiceName, Timestamp, UpstreamHost } from './common.js';
import { AppId, DomainId, RouteId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

export const ROUTE_TARGET_KINDS = ['app', 'external', 'redirect'] as const;
export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number];

export const AppRouteTarget = z
  .object({ kind: z.literal('app'), appId: AppId, service: RoutableServiceName, port: Port })
  .openapi('AppRouteTarget', { description: 'A service port of a Launchway app' });

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

/** Upper bound of `Route.extraDirectives` in UTF-8 bytes. */
export const EXTRA_DIRECTIVES_MAX_BYTES = 4096;

/** UTF-8 length of a string in bytes. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Caddyfile directives rendered verbatim inside the route's site block (admin only; trusted
 * configuration). Validated with Caddy's `/adapt` on save.
 */
export const ExtraDirectives = z
  .string()
  .max(EXTRA_DIRECTIVES_MAX_BYTES)
  .refine(
    (value) => utf8Length(value) <= EXTRA_DIRECTIVES_MAX_BYTES,
    `Must be at most ${EXTRA_DIRECTIVES_MAX_BYTES} bytes`,
  )
  .refine((value) => !value.includes('\0'), 'Must not contain NUL characters')
  .openapi({
    description:
      'Caddyfile directives placed inside the site block after the option directives and before the upstream (admin only)',
    example: 'handle /oauth2/* {\n\treverse_proxy login-oauth2-proxy:4180\n}',
  });

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
    extraDirectives: ExtraDirectives.nullable().openapi({
      description: 'Verbatim Caddyfile directives inside the site block; null when none',
    }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .openapi('Route', { description: 'What a domain serves (one route per domain)' });
export type Route = z.infer<typeof Route>;

export const RoutePage = page(Route).openapi('RoutePage');
export type RoutePage = z.infer<typeof RoutePage>;

export const RouteListQuery = PaginationQuery.extend({
  appId: AppId.optional(),
  domainId: DomainId.optional(),
});
export type RouteListQuery = z.infer<typeof RouteListQuery>;

export const CreateRouteInput = z
  .strictObject({
    domainId: DomainId,
    target: RouteTarget,
    protected: routeOptions.protected.default(ROUTE_OPTION_DEFAULTS.protected),
    compress: routeOptions.compress.default(ROUTE_OPTION_DEFAULTS.compress),
    hsts: routeOptions.hsts.default(ROUTE_OPTION_DEFAULTS.hsts),
    extraDirectives: ExtraDirectives.nullable().optional().openapi({
      description: 'Requires the admin role; empty or null means none',
    }),
  })
  .openapi('CreateRouteInput');
export type CreateRouteInput = z.infer<typeof CreateRouteInput>;

export const UpdateRouteInput = z
  .strictObject({
    target: RouteTarget.optional(),
    protected: z.boolean().optional(),
    compress: z.boolean().optional(),
    hsts: z.boolean().optional(),
    extraDirectives: ExtraDirectives.nullable().optional().openapi({
      description: 'Requires the admin role; empty or null clears them',
    }),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field')
  .openapi('UpdateRouteInput');
export type UpdateRouteInput = z.infer<typeof UpdateRouteInput>;

/** Answer of route create/update: the route plus non-fatal validation warnings. */
export const RouteSaveResult = Route.extend({
  warnings: z.array(z.string()).openapi({
    description:
      'Non-fatal notes, e.g. extra directives only got a structural check because Caddy was unreachable',
  }),
}).openapi('RouteSaveResult');
export type RouteSaveResult = z.infer<typeof RouteSaveResult>;

/** Failure of a load attempt into Caddy (validation or admin API error). */
export const EdgeError = z
  .object({
    message: z.string().openapi({ description: "Caddy's error message or the transport error" }),
    at: Timestamp,
  })
  .openapi('EdgeError');
export type EdgeError = z.infer<typeof EdgeError>;

/** Rendered edge configuration (`GET /edge/config`, read-only). */
export const EdgeConfig = z
  .object({
    caddyfile: z.string(),
    renderedAt: Timestamp,
    loadedAt: Timestamp.nullable().openapi({ description: 'Last successful load into Caddy' }),
    appliedCaddyfile: z
      .string()
      .nullable()
      .openapi({ description: 'Configuration of the last successful load; null before the first' }),
    inSync: z
      .boolean()
      .openapi({ description: 'True when the rendered configuration is the one Caddy runs' }),
    lastError: EdgeError.nullable().openapi({
      description: 'Failure of the most recent load attempt; null once a load succeeded',
    }),
  })
  .openapi('EdgeConfig');
export type EdgeConfig = z.infer<typeof EdgeConfig>;
