import {
  Email,
  Hostname,
  HttpUrl,
  Port,
  PublicUrl,
  RoutableServiceName,
  Timestamp,
} from './common.js';
import { AppId, NodeId } from './ids.js';
import { z } from './zod.js';

/** Request URI sent to a forward-auth target: an absolute path with an optional query. */
export const ForwardAuthUri = z
  .string()
  .max(2048)
  .regex(
    /^\/[^\s"'`{}#\\]*$/,
    'Must be an absolute path such as /oauth2/auth (no spaces or braces)',
  )
  .openapi({ example: '/oauth2/auth' });

/**
 * Forward-auth gate run as a service of a Launchway app. The edge reaches it by its network alias
 * (`<slug>-<service>`) on the proxy network: `http://<alias>:<port>` with `uri`.
 */
export const ForwardAuthTarget = z
  .strictObject({
    appId: AppId,
    service: RoutableServiceName,
    port: Port,
    uri: ForwardAuthUri.default('/'),
  })
  .openapi('ForwardAuthTarget', {
    description: 'A service of a Launchway app that answers forward-auth requests',
  });
export type ForwardAuthTarget = z.infer<typeof ForwardAuthTarget>;

/** Platform settings (a single record). */
export const Settings = z
  .object({
    publicUrl: PublicUrl.nullable().openapi({ description: 'Origin of the platform UI/API' }),
    effectivePublicUrl: PublicUrl.nullable().openapi({
      description: 'publicUrl after applying the LAUNCHWAY_PUBLIC_URL override (read-only)',
    }),
    acmeEmail: Email.nullable().openapi({ description: "Let's Encrypt account e-mail" }),
    anchorHostname: Hostname.nullable().openapi({
      description: 'Host name whose A record tracks the public IPv4 (dynamic DNS)',
    }),
    dynamicDnsEnabled: z.boolean(),
    publicIpv4: z
      .ipv4()
      .nullable()
      .openapi({ description: 'Last detected public IPv4 (read-only)' }),
    publicIpv4CheckedAt: Timestamp.nullable(),
    forwardAuthUrl: HttpUrl.nullable().openapi({
      description:
        'External forward-auth endpoint used by protected routes (Caddy forward_auth). At most one of forwardAuthUrl and forwardAuthTarget is set.',
      example: 'http://gate-proxy:4180/oauth2/auth',
    }),
    forwardAuthTarget: ForwardAuthTarget.nullable().openapi({
      description:
        'Forward-auth gate run as a Launchway app service. At most one of forwardAuthUrl and forwardAuthTarget is set.',
    }),
    edgeNodeId: NodeId.nullable().openapi({ description: 'Node that runs Caddy' }),
    updatedAt: Timestamp,
  })
  .openapi('Settings');
export type Settings = z.infer<typeof Settings>;

/** Partial update; `null` clears a value. Read-only fields are rejected. */
export const UpdateSettingsInput = z
  .strictObject({
    publicUrl: PublicUrl.nullable().optional(),
    acmeEmail: Email.nullable().optional(),
    anchorHostname: Hostname.nullable().optional(),
    dynamicDnsEnabled: z.boolean().optional(),
    forwardAuthUrl: HttpUrl.nullable().optional(),
    forwardAuthTarget: ForwardAuthTarget.nullable().optional(),
    edgeNodeId: NodeId.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one setting')
  .refine((v) => !(v.forwardAuthUrl && v.forwardAuthTarget), {
    message: 'Set either forwardAuthUrl or forwardAuthTarget, not both',
    path: ['forwardAuthTarget'],
  })
  .openapi('UpdateSettingsInput');
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

export const SETTINGS_HINT_CODES = ['redeploy-required', 'gate-unreachable'] as const;

/** Follow-up the caller has to take after a settings change. */
export const SettingsHint = z
  .object({
    code: z.enum(SETTINGS_HINT_CODES).openapi({
      description:
        'redeploy-required: the app must be (re)deployed before the edge can reach the gate service; gate-unreachable: the edge cannot reach the gate as configured',
    }),
    appId: AppId.nullable(),
    message: z.string(),
  })
  .openapi('SettingsHint');
export type SettingsHint = z.infer<typeof SettingsHint>;

/** `PATCH /settings` answer: the settings plus follow-up hints. */
export const UpdateSettingsResult = Settings.extend({
  hints: z.array(SettingsHint),
}).openapi('UpdateSettingsResult');
export type UpdateSettingsResult = z.infer<typeof UpdateSettingsResult>;
