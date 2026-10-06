import { EdgeConfig, Hostname, ServiceStatus, Timestamp, z } from '@slipway/contracts';

/*
 * Response shapes that the contracts on `main` do not define yet. They mirror what the API
 * branches publish (AppRuntimeStatus, DdnsStatus/DdnsRun, the EdgeConfig extensions) but are
 * lenient (optional / nullish fields), so small differences do not break the UI. Replace them
 * with the contract schemas once those are merged.
 */

/** `GET /apps/{id}/status`, `POST /apps/{id}/stop`: container state of the app. */
export const AppRuntimeStatus = z.object({
  activeDeploymentId: z.string().nullish(),
  nodeOnline: z.boolean().optional(),
  source: z.enum(['agent', 'last-deployment']).optional(),
  services: z.array(ServiceStatus),
});
export type AppRuntimeStatus = z.infer<typeof AppRuntimeStatus>;

/** `POST /dns/ddns/run` and `DdnsStatus.lastRun`: one public-IPv4 detection + anchor update. */
export const DdnsRun = z.object({
  startedAt: Timestamp,
  finishedAt: Timestamp.nullish(),
  outcome: z.enum(['unchanged', 'updated', 'skipped', 'failed']),
  message: z.string(),
  detectedIpv4: z.ipv4().nullish(),
  previousIpv4: z.ipv4().nullish(),
  recordUpdated: z.boolean().optional(),
});
export type DdnsRun = z.infer<typeof DdnsRun>;

/** `GET /dns/ddns`: state of the anchor record that follows the public IPv4. */
export const DdnsStatus = z.object({
  dynamicDnsEnabled: z.boolean(),
  anchorHostname: Hostname.nullable(),
  anchorZoneId: z.string().nullish(),
  publicIpv4: z.ipv4().nullable(),
  publicIpv4CheckedAt: Timestamp.nullable(),
  lastRun: DdnsRun.nullish(),
});
export type DdnsStatus = z.infer<typeof DdnsStatus>;

/** `GET /edge/config`, `POST /edge/reload` with the load state reported by the edge module. */
export const EdgeStatus = EdgeConfig.extend({
  inSync: z.boolean().optional(),
  lastError: z.object({ message: z.string(), at: Timestamp }).nullish(),
});
export type EdgeStatus = z.infer<typeof EdgeStatus>;
