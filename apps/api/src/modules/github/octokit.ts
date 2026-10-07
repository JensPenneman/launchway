import type { Deps } from '../../deps.js';
import { githubClient, installationAccessToken } from '../../lib/git-provider.js';
import { appCredentials, type ConnectionRow, secretContext } from './providers.js';

/** The part of Octokit the deployment mirror and the capability checks use (fakeable in tests). */
export interface OctokitResponse {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Readonly<Record<string, string | number | undefined>>;
}

export interface OctokitLike {
  request(route: string, params?: Record<string, unknown>): Promise<OctokitResponse>;
}

export function toOctokitLike(token: string): OctokitLike {
  const octokit = githubClient(token);
  const request = octokit.request as unknown as OctokitLike['request'];
  return { request: (route, params) => request(route, params) };
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Retries of a rate-limited request (429, or 403 with an exhausted quota). */
export const MAX_RATE_LIMIT_RETRIES = 3;
const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;

function responseHeaders(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null || !('response' in error)) return {};
  const response = (error as { response?: { headers?: unknown } }).response;
  return typeof response?.headers === 'object' && response.headers !== null
    ? (response.headers as Record<string, unknown>)
    : {};
}

/** HTTP status of a failed GitHub request; null for network errors and timeouts. */
export function errorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  const status = Number((error as { status: unknown }).status);
  return Number.isInteger(status) && status > 0 ? status : null;
}

/** 429, or a 403 caused by the primary (quota exhausted) or secondary (Retry-After) rate limit. */
export function isRateLimited(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers = responseHeaders(error);
  return String(headers['x-ratelimit-remaining']) === '0' || headers['retry-after'] !== undefined;
}

/** Delay before the next attempt: Retry-After, the quota reset, or exponential backoff. */
export function retryDelayMs(error: unknown, attempt: number, now: number): number {
  const headers = responseHeaders(error);
  const retryAfter = Number(headers['retry-after']);
  const reset = Number(headers['x-ratelimit-reset']);
  let delay: number;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) delay = retryAfter * 1000;
  else if (Number.isFinite(reset) && reset > 0) delay = reset * 1000 - now;
  else delay = 1000 * 2 ** attempt;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, delay));
}

export interface RetryOptions {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** One GitHub request with a timeout; rate-limited answers are retried up to 3 times. */
export async function requestWithRetry(
  client: OctokitLike,
  route: string,
  params: Record<string, unknown>,
  options: RetryOptions,
): Promise<OctokitResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.request(route, {
        ...params,
        request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch (error) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES || !isRateLimited(error)) throw error;
      await options.sleep(retryDelayMs(error, attempt, options.now()));
    }
  }
}

/**
 * Client acting as the connection itself: the installation-wide token of a GitHub App (never sent
 * to a node) or the stored personal access token. Null for an app that is not installed.
 */
export async function connectionOctokit(
  deps: Pick<Deps, 'secrets'>,
  row: ConnectionRow,
): Promise<OctokitLike | null> {
  if (row.kind === 'pat') {
    if (row.tokenEncrypted === null) return null;
    return toOctokitLike(deps.secrets.decrypt(row.tokenEncrypted, secretContext.token(row.id)));
  }
  if (row.installationId === null) return null;
  return toOctokitLike(
    await installationAccessToken(appCredentials(deps, row), row.installationId),
  );
}
