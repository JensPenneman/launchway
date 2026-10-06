import {
  DNS_RECORD_TYPES,
  type DnsRecord,
  type DnsRecordInput,
  type DnsRecordType,
  type DnsZoneInfo,
} from '@slipway/contracts';
import { z } from 'zod';
import { type DnsProvider, type DnsProviderDefinition, DnsProviderError } from './types.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;
const ZONES_PER_PAGE = 50;
const RECORDS_PER_PAGE = 100;
/** Guards against a provider that keeps reporting more pages. */
const MAX_PAGES = 200;

/** Cloudflare error codes meaning "a conflicting record already exists". */
const CONFLICT_CODES = new Set([81053, 81054, 81055, 81056, 81057, 81058]);

const CloudflareCredentials = z
  .strictObject({
    apiToken: z
      .string()
      .trim()
      .min(20, 'Must be a Cloudflare API token')
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/, 'Must be a Cloudflare API token')
      .meta({
        title: 'API token',
        description: 'API token with Zone:Read and DNS:Edit permissions for the zones to manage',
        writeOnly: true,
      }),
  })
  .meta({ title: 'Cloudflare credentials' });
type CloudflareCredentials = z.infer<typeof CloudflareCredentials>;

const CloudflareMessage = z.object({ code: z.number(), message: z.string() });

const ResultInfo = z.object({
  page: z.number().int(),
  total_pages: z.number().int().optional(),
});

function envelope<T extends z.ZodType>(result: T) {
  return z.object({
    success: z.boolean(),
    errors: z.array(CloudflareMessage).default([]),
    result,
    result_info: ResultInfo.nullish(),
  });
}

const ErrorEnvelope = z.object({
  success: z.literal(false).optional(),
  errors: z.array(CloudflareMessage).default([]),
});

const TokenStatus = z.object({ id: z.string(), status: z.string() });
const Zone = z.object({ id: z.string().min(1), name: z.string().min(1) });
const CfRecord = z.object({
  id: z.string().min(1),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().int().nullish(),
  proxied: z.boolean().nullish(),
  proxiable: z.boolean().nullish(),
});
type CfRecord = z.infer<typeof CfRecord>;

const SUPPORTED_TYPES: ReadonlySet<string> = new Set(DNS_RECORD_TYPES);
const PROXIABLE_TYPES: ReadonlySet<DnsRecordType> = new Set(['A', 'AAAA', 'CNAME']);

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function describeErrors(errors: readonly { code: number; message: string }[]): string {
  return errors.map((error) => `${error.message} (${error.code})`).join('; ');
}

/** Maps a failed Cloudflare response to a provider error; never includes request headers. */
async function toProviderError(response: Response): Promise<DnsProviderError> {
  let errors: { code: number; message: string }[] = [];
  try {
    errors = ErrorEnvelope.parse(await response.json()).errors;
  } catch {
    // Non-JSON error body (proxy error page): fall back to the status.
  }
  const detail = errors.length > 0 ? `: ${describeErrors(errors)}` : '';
  const status = response.status;
  if (status === 401) {
    return new DnsProviderError('unauthorized', `Cloudflare rejected the API token${detail}`);
  }
  if (status === 403) {
    return new DnsProviderError(
      'forbidden',
      `The Cloudflare API token lacks a required permission${detail}`,
    );
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return new DnsProviderError('rate-limited', 'Cloudflare rate limit reached; try again later', {
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  if (status === 404) return new DnsProviderError('not-found', `Not found at Cloudflare${detail}`);
  if (errors.some((error) => CONFLICT_CODES.has(error.code))) {
    return new DnsProviderError('conflict', `Cloudflare reports a conflicting record${detail}`);
  }
  if (status >= 400 && status < 500) {
    return new DnsProviderError('invalid', `Cloudflare rejected the request${detail}`);
  }
  return new DnsProviderError('unavailable', `Cloudflare answered with HTTP ${status}${detail}`);
}

function toRecord(record: CfRecord): DnsRecord | null {
  if (!SUPPORTED_TYPES.has(record.type)) return null;
  const type = record.type as DnsRecordType;
  return {
    externalId: record.id,
    type,
    name: record.name.toLowerCase(),
    content: record.content,
    ttl: record.ttl ?? null,
    proxied: PROXIABLE_TYPES.has(type) ? (record.proxied ?? false) : null,
  };
}

function recordBody(input: DnsRecordInput) {
  return {
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: input.ttl ?? 1,
    ...(PROXIABLE_TYPES.has(input.type) ? { proxied: input.proxied ?? false } : {}),
  };
}

function createCloudflareClient(
  credentials: CloudflareCredentials,
  fetchFn: typeof fetch,
): DnsProvider {
  async function request<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<ReturnType<typeof envelope<T>>>> {
    let response: Response;
    try {
      response = await fetchFn(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credentials.apiToken}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DnsProviderError('unavailable', 'Cloudflare is unreachable', { cause: error });
    }
    if (!response.ok) throw await toProviderError(response);
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new DnsProviderError('unavailable', 'Cloudflare sent an invalid response', {
        cause: error,
      });
    }
    const parsed = envelope(schema).safeParse(json);
    if (!parsed.success) {
      throw new DnsProviderError('unavailable', 'Cloudflare sent an unexpected response', {
        cause: parsed.error,
      });
    }
    if (!parsed.data.success) {
      throw new DnsProviderError(
        'invalid',
        `Cloudflare rejected the request: ${describeErrors(parsed.data.errors)}`,
      );
    }
    return parsed.data as z.infer<ReturnType<typeof envelope<T>>>;
  }

  async function paginate<T extends z.ZodType>(
    path: string,
    perPage: number,
    item: T,
  ): Promise<z.infer<T>[]> {
    const items: z.infer<T>[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const response = await request(
        'GET',
        `${path}${separator}page=${pageNumber}&per_page=${perPage}`,
        z.array(item),
      );
      const result = response.result as z.infer<T>[];
      items.push(...result);
      const totalPages = response.result_info?.total_pages;
      const done = totalPages === undefined ? result.length < perPage : pageNumber >= totalPages;
      if (done) return items;
    }
    throw new DnsProviderError('unavailable', 'Cloudflare reported too many pages');
  }

  const zonePath = (zoneId: string) => `/zones/${encodeURIComponent(zoneId)}/dns_records`;

  return {
    kind: 'cloudflare',
    capabilities: cloudflareProvider.capabilities,

    async verifyCredentials() {
      const { result } = await request('GET', '/user/tokens/verify', TokenStatus);
      if (result.status !== 'active') {
        throw new DnsProviderError('unauthorized', `The Cloudflare API token is ${result.status}`);
      }
      // The token may be valid but unable to read zones; surface that now, not on first use.
      await request('GET', '/zones?per_page=5', z.array(Zone));
    },

    async listZones(): Promise<DnsZoneInfo[]> {
      const zones = await paginate('/zones', ZONES_PER_PAGE, Zone);
      return zones.map((zone) => ({ externalId: zone.id, name: zone.name.toLowerCase() }));
    },

    async listRecords(zoneExternalId) {
      const records = await paginate(zonePath(zoneExternalId), RECORDS_PER_PAGE, CfRecord);
      return records.map(toRecord).filter((record): record is DnsRecord => record !== null);
    },

    async upsertRecord(zoneExternalId, input, recordExternalId) {
      let targetId = recordExternalId;
      if (targetId === undefined) {
        const query = new URLSearchParams({ type: input.type, name: input.name });
        const { result } = await request(
          'GET',
          `${zonePath(zoneExternalId)}?${query.toString()}`,
          z.array(CfRecord),
        );
        const existing = result.find(
          (record) =>
            record.type === input.type &&
            record.name.toLowerCase() === input.name &&
            (input.type !== 'TXT' || record.content === input.content),
        );
        targetId = existing?.id;
      }
      const { result } =
        targetId === undefined
          ? await request('POST', zonePath(zoneExternalId), CfRecord, recordBody(input))
          : await request(
              'PATCH',
              `${zonePath(zoneExternalId)}/${encodeURIComponent(targetId)}`,
              CfRecord,
              recordBody(input),
            );
      const record = toRecord(result);
      if (!record) throw new DnsProviderError('unavailable', 'Cloudflare returned another type');
      return record;
    },

    async deleteRecord(zoneExternalId, recordExternalId) {
      await request(
        'DELETE',
        `${zonePath(zoneExternalId)}/${encodeURIComponent(recordExternalId)}`,
        z.object({ id: z.string() }),
      );
    },
  };
}

export const cloudflareProvider: DnsProviderDefinition<CloudflareCredentials> = {
  kind: 'cloudflare',
  label: 'Cloudflare',
  docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  capabilities: { proxied: true, ttl: true },
  credentialsSchema: CloudflareCredentials,
  create: (credentials, context) => createCloudflareClient(credentials, context.fetch),
};
