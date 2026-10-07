import type { DdnsRun, DdnsSourceResult, DdnsStatus, DnsRecordInput } from '@launchway/contracts';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import { recordAudit } from '../audit/service.js';
import type { SettingsService } from '../settings/service.js';
import { DnsProviderError } from './providers/types.js';
import type { DnsService } from './service.js';

/** A public-IPv4 echo service and how to read its answer. */
export interface Ipv4Source {
  readonly url: string;
  /** Returns the address text from the response body, or null when it is not in there. */
  readonly extract: (body: string) => string | null;
}

const firstLine = (body: string) => body.trim().split(/\s+/)[0] ?? null;

export const DEFAULT_IPV4_SOURCES: readonly Ipv4Source[] = [
  { url: 'https://api.ipify.org', extract: firstLine },
  { url: 'https://ipv4.icanhazip.com', extract: firstLine },
  {
    url: 'https://1.1.1.1/cdn-cgi/trace',
    extract: (body) => /^ip=(.+)$/m.exec(body)?.[1]?.trim() ?? null,
  },
];

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_CHARS = 4_096;
/** TTL of the anchor record when the provider supports custom TTLs. */
const ANCHOR_TTL_SECONDS = 60;
const Ipv4 = z.ipv4();

export interface Ipv4Detection {
  /** The address at least two services agreed on; null = skip this run. */
  readonly ipv4: string | null;
  readonly sources: DdnsSourceResult[];
  readonly message: string;
}

async function querySource(
  source: Ipv4Source,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DdnsSourceResult> {
  try {
    const response = await fetchFn(source.url, {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { url: source.url, ipv4: null, error: `HTTP ${response.status}` };
    const text = (await response.text()).slice(0, MAX_BODY_CHARS);
    const candidate = source.extract(text);
    const parsed = Ipv4.safeParse(candidate);
    if (!parsed.success) return { url: source.url, ipv4: null, error: 'No IPv4 address in answer' };
    return { url: source.url, ipv4: parsed.data, error: null };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { url: source.url, ipv4: null, error: timedOut ? 'Timed out' : 'Request failed' };
  }
}

function agreedAddress(results: readonly DdnsSourceResult[]): string | null {
  const votes = new Map<string, number>();
  for (const result of results) {
    if (result.ipv4) votes.set(result.ipv4, (votes.get(result.ipv4) ?? 0) + 1);
  }
  for (const [address, count] of votes) if (count >= 2) return address;
  return null;
}

/**
 * Agree-or-skip detection: asks two services; when they disagree or one fails, asks the next.
 * An address is accepted only when two independent services report it.
 */
export async function detectPublicIpv4(
  fetchFn: typeof fetch,
  sources: readonly Ipv4Source[] = DEFAULT_IPV4_SOURCES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Ipv4Detection> {
  const results = await Promise.all(
    sources.slice(0, 2).map((source) => querySource(source, fetchFn, timeoutMs)),
  );
  for (const source of sources.slice(2)) {
    if (agreedAddress(results)) break;
    results.push(await querySource(source, fetchFn, timeoutMs));
  }
  const ipv4 = agreedAddress(results);
  if (ipv4) return { ipv4, sources: results, message: `Public IPv4 is ${ipv4}` };
  const answers = results.filter((result) => result.ipv4 !== null);
  const message =
    answers.length >= 2
      ? `Skipped: the services disagree (${answers.map((r) => r.ipv4).join(', ')})`
      : 'Skipped: fewer than two services answered';
  return { ipv4: null, sources: results, message };
}

export interface DdnsServiceOptions {
  readonly dns: DnsService;
  readonly settings: SettingsService;
  readonly fetch?: typeof fetch;
  readonly sources?: readonly Ipv4Source[];
  readonly timeoutMs?: number;
}

export interface DdnsService {
  /**
   * Detects the public IPv4, stores it and, with dynamic DNS enabled and the anchor's zone
   * managed, points the anchor A record at it. Never throws: failures are a `failed` run.
   * `force` re-reads the anchor record even when nothing changed since the last run.
   */
  run(options?: { force?: boolean }): Promise<DdnsRun>;
  status(): Promise<DdnsStatus>;
}

export function createDdnsService(
  deps: Pick<Deps, 'db' | 'events' | 'logger'>,
  options: DdnsServiceOptions,
): DdnsService {
  const { dns, settings } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const actor = systemActor('ddns');
  let lastRun: DdnsRun | null = null;
  /** Anchor record last seen pointing at `ipv4`: skips provider calls while nothing changes. */
  let confirmed: { hostname: string; ipv4: string } | null = null;

  async function syncAnchorRecord(
    hostname: string,
    ipv4: string,
    force: boolean,
  ): Promise<{ updated: boolean; message: string }> {
    const zone = await dns.findZoneForHostname(hostname);
    if (!zone) {
      return {
        updated: false,
        message: `No managed zone contains ${hostname}; record not updated`,
      };
    }
    if (!force && confirmed?.hostname === hostname && confirmed.ipv4 === ipv4) {
      return { updated: false, message: `${hostname} already points at ${ipv4}` };
    }
    const { provider } = await dns.providerForZone(zone.id);
    const existing = (await provider.listRecords(zone.externalId)).filter(
      (record) => record.type === 'A' && record.name === hostname,
    );
    if (existing.length === 1 && existing[0]?.content === ipv4) {
      confirmed = { hostname, ipv4 };
      return { updated: false, message: `${hostname} already points at ${ipv4}` };
    }
    const input: DnsRecordInput = {
      type: 'A',
      name: hostname,
      content: ipv4,
      proxied: false,
      ...(provider.capabilities.ttl ? { ttl: ANCHOR_TTL_SECONDS } : {}),
    };
    const previous = existing[0];
    const record = await provider.upsertRecord(zone.externalId, input, previous?.externalId);
    await deps.db.transaction(async (tx) => {
      await recordAudit(tx, actor, {
        action: previous ? 'dns-record.update' : 'dns-record.create',
        target: { type: 'dns-zone', id: zone.id },
        summary: {
          zone: zone.name,
          recordId: record.externalId,
          type: 'A',
          name: hostname,
          content: { from: previous?.content ?? null, to: ipv4 },
        },
      });
    });
    deps.events.publish({ topic: 'dns', action: 'updated', resourceId: zone.id });
    confirmed = { hostname, ipv4 };
    const extra = existing.length > 1 ? ` (${existing.length - 1} other A records left as is)` : '';
    return { updated: true, message: `${hostname} now points at ${ipv4}${extra}` };
  }

  async function run({ force = false }: { force?: boolean } = {}): Promise<DdnsRun> {
    const startedAt = new Date();
    const finish = (run: Omit<DdnsRun, 'startedAt' | 'finishedAt'>): DdnsRun => {
      lastRun = {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        ...run,
      };
      const level = run.outcome === 'failed' ? 'warn' : 'info';
      if (run.outcome !== 'unchanged') {
        deps.logger[level]({ outcome: run.outcome, ipv4: run.detectedIpv4 }, run.message);
      }
      return lastRun;
    };

    const detection = await detectPublicIpv4(fetchFn, options.sources, options.timeoutMs);
    const base = { sources: detection.sources, detectedIpv4: detection.ipv4 };
    if (!detection.ipv4) {
      const current = await settings.get().catch(() => null);
      return finish({
        ...base,
        outcome: 'skipped',
        message: detection.message,
        previousIpv4: current?.publicIpv4 ?? null,
        recordUpdated: false,
      });
    }

    let previous: string | null = null;
    try {
      const stored = await settings.recordPublicIpv4(detection.ipv4, startedAt, actor);
      previous = stored.previous;
      const { anchorHostname, dynamicDnsEnabled } = stored.settings;
      const messages = [
        stored.changed
          ? `Public IPv4 changed from ${previous ?? 'unknown'} to ${detection.ipv4}`
          : `Public IPv4 is still ${detection.ipv4}`,
      ];
      let recordUpdated = false;
      if (dynamicDnsEnabled && anchorHostname) {
        const anchor = await syncAnchorRecord(anchorHostname, detection.ipv4, force);
        recordUpdated = anchor.updated;
        messages.push(anchor.message);
      } else {
        messages.push(
          anchorHostname ? 'Dynamic DNS is disabled' : 'No anchor hostname is configured',
        );
      }
      return finish({
        ...base,
        outcome: stored.changed || recordUpdated ? 'updated' : 'unchanged',
        message: messages.join('. '),
        previousIpv4: previous,
        recordUpdated,
      });
    } catch (error) {
      deps.logger.error({ err: error }, 'dynamic DNS run failed');
      return finish({
        ...base,
        outcome: 'failed',
        message: `Dynamic DNS failed: ${
          error instanceof DnsProviderError ? error.message : 'internal error (see the server log)'
        }`,
        previousIpv4: previous,
        recordUpdated: false,
      });
    }
  }

  return {
    run,
    async status() {
      const current = await settings.get();
      const zone = current.anchorHostname
        ? await dns.findZoneForHostname(current.anchorHostname)
        : null;
      return {
        dynamicDnsEnabled: current.dynamicDnsEnabled,
        anchorHostname: current.anchorHostname,
        anchorZoneId: zone?.id ?? null,
        publicIpv4: current.publicIpv4,
        publicIpv4CheckedAt: current.publicIpv4CheckedAt,
        lastRun,
      };
    },
  };
}
