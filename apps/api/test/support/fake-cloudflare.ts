import { randomUUID } from 'node:crypto';

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  proxiable: boolean;
}

export interface FakeCloudflareOptions {
  token?: string;
  zones?: { id: string; name: string }[];
  /** Page size the fake enforces, to exercise pagination with few items. */
  maxPerPage?: number;
}

export interface FakeCloudflare {
  readonly fetch: typeof fetch;
  readonly records: Map<string, FakeRecord[]>;
  /** `METHOD path?query` of every request, in order. */
  readonly calls: string[];
  /** Authorization header values seen. */
  readonly authorizations: string[];
}

const CONFLICT = {
  code: 81053,
  message: 'An A, AAAA, or CNAME record with that host already exists.',
};

/** A small in-memory Cloudflare v4 API (zones and DNS records) behind an injected fetch. */
export function createFakeCloudflare(options: FakeCloudflareOptions = {}): FakeCloudflare {
  const token = options.token ?? 'fake-cloudflare-token-0123456789';
  const zones = options.zones ?? [{ id: 'zone-1', name: 'example.com' }];
  const maxPerPage = options.maxPerPage ?? 100;
  const records = new Map<string, FakeRecord[]>(zones.map((zone) => [zone.id, []]));
  const calls: string[] = [];
  const authorizations: string[] = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const ok = (result: unknown, resultInfo?: unknown) =>
    json(200, { success: true, errors: [], messages: [], result, result_info: resultInfo });
  const fail = (status: number, errors: { code: number; message: string }[]) =>
    json(status, { success: false, errors, messages: [], result: null });

  function paginate<T>(items: T[], url: URL) {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 20), maxPerPage);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    return ok(slice, {
      page,
      per_page: perPage,
      count: slice.length,
      total_count: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / perPage)),
    });
  }

  function conflicts(list: FakeRecord[], body: FakeRecord, exceptId?: string) {
    return list.some(
      (r) =>
        r.id !== exceptId &&
        r.name === body.name &&
        (r.type === 'CNAME') !== (body.type === 'CNAME') &&
        body.type !== 'TXT' &&
        r.type !== 'TXT',
    );
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/client\/v4/, '');
    calls.push(`${method} ${path}${url.search}`);
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    authorizations.push(authorization);
    if (authorization !== `Bearer ${token}`) {
      return fail(401, [{ code: 10000, message: 'Authentication error' }]);
    }
    if (path === '/user/tokens/verify') return ok({ id: 'tok', status: 'active' });
    if (path === '/zones' && method === 'GET') return paginate(zones, url);

    const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    const list = match?.[1] ? records.get(decodeURIComponent(match[1])) : undefined;
    if (!match || !list) return fail(404, [{ code: 7003, message: 'Could not route' }]);
    const recordId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const body = init?.body ? (JSON.parse(String(init.body)) as FakeRecord) : undefined;

    if (!recordId && method === 'GET') {
      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name');
      return paginate(
        list.filter((r) => (!type || r.type === type) && (!name || r.name === name)),
        url,
      );
    }
    if (!recordId && method === 'POST' && body) {
      if (conflicts(list, body)) return fail(400, [CONFLICT]);
      const proxiable = body.type !== 'TXT';
      const record: FakeRecord = {
        ...body,
        id: randomUUID().replaceAll('-', ''),
        proxiable,
        proxied: proxiable ? (body.proxied ?? false) : false,
      };
      list.push(record);
      return ok(record);
    }
    const index = list.findIndex((r) => r.id === recordId);
    if (index < 0) return fail(404, [{ code: 81044, message: 'Record does not exist.' }]);
    if (method === 'PATCH' && body) {
      const current = list[index] as FakeRecord;
      if (conflicts(list, { ...current, ...body }, current.id)) return fail(400, [CONFLICT]);
      const updated = { ...current, ...body, id: current.id };
      list[index] = updated;
      return ok(updated);
    }
    if (method === 'DELETE') {
      list.splice(index, 1);
      return ok({ id: recordId });
    }
    return fail(405, [{ code: 10405, message: 'Method not allowed' }]);
  };

  return { fetch: fetchFn, records, calls, authorizations };
}
