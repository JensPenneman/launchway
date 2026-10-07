import {
  type AppLogLine,
  CONTAINER_HEALTH,
  CONTAINER_STATES,
  IpAddress,
  type PublishedPort,
  ServiceName,
  type ServiceStatus,
} from '@launchway/contracts';
import { z } from 'zod';

const Publisher = z.looseObject({
  URL: z.string().nullish(),
  TargetPort: z.number().int(),
  PublishedPort: z.number().int(),
  Protocol: z.string().nullish(),
});

const PsEntry = z.looseObject({
  ID: z.string().nullish(),
  Name: z.string().nullish(),
  Service: z.string(),
  State: z.string().nullish(),
  Health: z.string().nullish(),
  Publishers: z.array(Publisher).nullish(),
});
type PsEntry = z.infer<typeof PsEntry>;

/** `docker compose ps --format json` prints one object per line (older versions: one array). */
function parsePsEntries(stdout: string): PsEntry[] {
  const text = stdout.trim();
  if (!text) return [];
  const values: unknown[] = text.startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  return values.flatMap((value) => {
    const parsed = PsEntry.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Published host ports of one container; unpublished (`PublishedPort: 0`) entries are dropped. */
export function toPublishedPorts(publishers: PsEntry['Publishers']): PublishedPort[] {
  const seen = new Set<string>();
  const ports: PublishedPort[] = [];
  for (const publisher of publishers ?? []) {
    if (publisher.PublishedPort < 1 || publisher.PublishedPort > 65_535) continue;
    if (publisher.TargetPort < 1 || publisher.TargetPort > 65_535) continue;
    const protocol = publisher.Protocol === 'udp' ? 'udp' : 'tcp';
    const ip = IpAddress.safeParse(publisher.URL ?? '');
    const hostIp = ip.success ? ip.data : null;
    const key = `${hostIp}|${publisher.PublishedPort}|${publisher.TargetPort}|${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({
      containerPort: publisher.TargetPort,
      hostPort: publisher.PublishedPort,
      protocol,
      hostIp,
    });
  }
  return ports;
}

const STATES: readonly string[] = CONTAINER_STATES;
const HEALTH: readonly string[] = CONTAINER_HEALTH;

/** Maps `docker compose ps --all --format json` output to `ServiceStatus[]` (sorted by service). */
export function parseComposePs(stdout: string): ServiceStatus[] {
  return parsePsEntries(stdout)
    .map((entry): ServiceStatus => {
      const state = (entry.State ?? '').toLowerCase();
      const health = (entry.Health ?? '').toLowerCase();
      return {
        service: entry.Service.slice(0, 128),
        containerId: entry.ID || null,
        state: (STATES.includes(state) ? state : 'exited') as ServiceStatus['state'],
        health: (HEALTH.includes(health) ? health : null) as ServiceStatus['health'],
        publishedPorts: toPublishedPorts(entry.Publishers),
      };
    })
    .sort(
      (a, b) =>
        a.service.localeCompare(b.service) ||
        (a.containerId ?? '').localeCompare(b.containerId ?? ''),
    );
}

/** Container names (`launchway-trail-web-1` and Compose's log prefix `web-1`) -> service. */
export function containerServiceMap(stdout: string, projectName: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parsePsEntries(stdout)) {
    if (!entry.Name) continue;
    map.set(entry.Name, entry.Service);
    if (entry.Name.startsWith(`${projectName}-`)) {
      map.set(entry.Name.slice(projectName.length + 1), entry.Service);
    }
  }
  return map;
}

/** Docker's RFC 3339 timestamps carry nanoseconds; the protocol uses `toISOString()` precision. */
export function normalizeTimestamp(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  const date = new Date(`${match[1]}.${fraction}${match[3]}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const LOG_LINE = /^(\S+)\s+\|\s(\S+)(?: (.*))?$/;

/**
 * Parses one line of `docker compose logs --no-color -t`: `<container>  | <timestamp> <text>`.
 * Returns null for lines that are not container output (Compose's own messages).
 */
export function parseComposeLogLine(
  raw: string,
  services: ReadonlyMap<string, string>,
  stream: AppLogLine['stream'] = 'stdout',
): AppLogLine | null {
  const match = LOG_LINE.exec(raw);
  if (!match) return null;
  const [, prefix = '', stamp = '', text = ''] = match;
  const timestamp = normalizeTimestamp(stamp);
  if (!timestamp) return null;
  const service = services.get(prefix) ?? prefix.replace(/-\d+$/, '');
  const parsed = ServiceName.safeParse(service);
  if (!parsed.success) return null;
  return { service: parsed.data, timestamp, stream, line: text.slice(0, 16_384) };
}
