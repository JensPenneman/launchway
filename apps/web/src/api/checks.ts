import {
  CheckRun,
  CheckRunList,
  type CheckRunListQuery,
  CheckRunPage,
  type CreateCheckRunsInput,
} from '@launchway/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { keys } from './keys';
import { buildUrl, request } from './request';

const appChecksPath = (appId: string) => `/apps/${encodeURIComponent(appId)}/checks`;
const checkPath = (id: string) => `/checks/${encodeURIComponent(id)}`;

/** Filters of `GET /apps/{id}/checks`; omitted ones do not filter. */
export type CheckRunFilters = Partial<Pick<CheckRunListQuery, 'status' | 'name' | 'commitSha'>>;

/** Check runs of an app, newest first, page by page. */
export function checkRunsQuery(appId: string, filters: CheckRunFilters = {}, limit = 20) {
  return infiniteQueryOptions({
    queryKey: [...keys.checks, 'list', appId, filters, limit],
    queryFn: ({ signal, pageParam }) =>
      request(appChecksPath(appId), {
        query: { limit, cursor: pageParam, ...filters },
        schema: CheckRunPage,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function checkRunQuery(id: string) {
  return queryOptions({
    queryKey: [...keys.checks, 'detail', id],
    queryFn: ({ signal }) => request(checkPath(id), { schema: CheckRun, signal }),
  });
}

/** Runs the app's checks (or the named ones) for a ref by hand; answers the queued runs. */
export function createCheckRuns(appId: string, input: CreateCheckRunsInput) {
  return request(appChecksPath(appId), { method: 'POST', body: input, schema: CheckRunList });
}

export function cancelCheckRun(id: string) {
  return request(`${checkPath(id)}/cancel`, { method: 'POST', schema: CheckRun });
}

/** Queues a new run of the same check and commit (with the check's current configuration). */
export function rerunCheckRun(id: string) {
  return request(`${checkPath(id)}/rerun`, { method: 'POST', schema: CheckRun });
}

export function checkLogsUrl(id: string): string {
  return buildUrl(`${checkPath(id)}/logs`, { follow: true });
}
