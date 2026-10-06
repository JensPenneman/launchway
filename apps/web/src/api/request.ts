import type { z } from '@slipway/contracts';
import { PROBLEM_TYPES, Problem, type ProblemType } from '@slipway/contracts';

/** Base path of every Slipway API resource (same origin as the UI). */
export const API_BASE = '/api/v1';

/** Error thrown for every non-2xx response; carries the RFC 9457 problem document. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }

  get type(): ProblemType {
    return this.problem.type;
  }

  /** Validation messages keyed by field path without the `body.` / `query.` prefix. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const issue of this.problem.errors ?? []) {
      const key = issue.path.replace(/^(body|query|params)\.?/, '');
      result[key] ??= issue.message;
    }
    return result;
  }
}

/** The response did not match the contract schema: the UI and the API drifted apart. */
export class ContractDriftError extends Error {
  readonly path: string;
  constructor(path: string, issues: string) {
    super(`Unexpected response from ${path}: ${issues}`);
    this.name = 'ContractDriftError';
    this.path = path;
  }
}

export function isApiError(error: unknown, type?: ProblemType): error is ApiError {
  return error instanceof ApiError && (type === undefined || error.type === type);
}

/** Human-readable message for any error thrown by the data layer. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const first = error.problem.errors?.[0];
    if (error.type === 'validation-failed' && first) return `${error.message}: ${first.message}`;
    return error.message;
  }
  if (error instanceof ContractDriftError) return 'The server sent an unexpected response.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Called once per 401 of a request that expects a signed-in user (wired to the router). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  /** Contract schema for the response body; omit for 204 responses. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal | undefined;
  /** `throw` for endpoints where 401 is an expected answer (sign-in, session probe). */
  onUnauthorized?: 'redirect' | 'throw';
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return `${API_BASE}${path}${search ? `?${search}` : ''}`;
}

function fallbackProblem(status: number, detail?: string): Problem {
  const entry = Object.entries(PROBLEM_TYPES).find(([, value]) => value.status === status);
  const type = (entry?.[0] ?? (status >= 500 ? 'internal-error' : 'bad-request')) as ProblemType;
  return { type, title: PROBLEM_TYPES[type].title, status, ...(detail ? { detail } : {}) };
}

async function readProblem(response: Response): Promise<Problem> {
  try {
    const parsed = Problem.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON (proxy error page, network middlebox): fall through to a generic problem.
  }
  return fallbackProblem(response.status, response.statusText || undefined);
}

/**
 * Calls the Slipway API: JSON in and out, the session cookie included, problem documents turned
 * into `ApiError`, and successful bodies validated against the contract schema.
 */
export async function request<T = undefined>(path: string, options: RequestOptions<T> = {}) {
  const { method = 'GET', query, body, schema, signal, onUnauthorized = 'redirect' } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'include',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(fallbackProblem(503, 'The Slipway API is not reachable.'));
  }

  if (!response.ok) {
    const problem = await readProblem(response);
    if (response.status === 401 && onUnauthorized === 'redirect') unauthorizedHandler?.();
    throw new ApiError(problem);
  }

  if (!schema) return undefined as T;
  const json: unknown = response.status === 204 ? undefined : await response.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    console.error(`[slipway] contract drift on ${method} ${path}`, parsed.error.issues);
    throw new ContractDriftError(`${method} ${path}`, issues);
  }
  return parsed.data;
}
