import { Email, Hostname, HttpUrl, PublicUrl, Timestamp } from './common.js';
import { NodeId } from './ids.js';
import { z } from './zod.js';

/** Platform settings (a single record). */
export const Settings = z
  .object({
    publicUrl: PublicUrl.nullable().openapi({ description: 'Origin of the platform UI/API' }),
    effectivePublicUrl: PublicUrl.nullable().openapi({
      description: 'publicUrl after applying the SLIPWAY_PUBLIC_URL override (read-only)',
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
      description: 'Forward-auth endpoint used by protected routes (Caddy forward_auth)',
      example: 'http://gate-proxy:4180/oauth2/auth',
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
    edgeNodeId: NodeId.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one setting')
  .openapi('UpdateSettingsInput');
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;
