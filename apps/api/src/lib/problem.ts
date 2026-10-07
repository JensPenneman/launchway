import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  type Problem,
  type ProblemType,
  type ValidationIssue,
} from '@launchway/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export interface ProblemOptions {
  detail?: string;
  errors?: ValidationIssue[];
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * Throw from handlers/services to answer with an RFC 9457 problem document. The global error
 * handler renders it; everything else becomes a generic 500 without internal details.
 */
export class ProblemError extends Error {
  readonly type: ProblemType;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: ValidationIssue[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(type: ProblemType, options: ProblemOptions = {}) {
    super(options.detail ?? PROBLEM_TYPES[type].title, { cause: options.cause });
    this.name = 'ProblemError';
    this.type = type;
    this.status = PROBLEM_TYPES[type].status;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
  }
}

export const badRequest = (detail?: string) => new ProblemError('bad-request', withDetail(detail));
export const unauthorized = (detail?: string) =>
  new ProblemError('unauthorized', withDetail(detail));
export const forbidden = (detail?: string) => new ProblemError('forbidden', withDetail(detail));
export const notFound = (detail?: string) => new ProblemError('not-found', withDetail(detail));
/** @public */
export const conflict = (detail?: string) => new ProblemError('conflict', withDetail(detail));

/** 400 validation-failed for a single field, e.g. a reference that does not exist. */
export function invalidField(path: string, message: string): ProblemError {
  return new ProblemError('validation-failed', {
    errors: [{ path, message, code: 'invalid_value' }],
  });
}

function withDetail(detail: string | undefined): ProblemOptions {
  return detail === undefined ? {} : { detail };
}

/** Converts Zod issues to the `errors` member; `prefix` is the request part (body, query, ...). */
export function toValidationIssues(error: ZodError, prefix?: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)]
      .filter((part) => part !== undefined && part !== '')
      .join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

const STATUS_TO_TYPE: Record<number, ProblemType> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
  410: 'gone',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  429: 'rate-limited',
  501: 'not-implemented',
  502: 'upstream-failed',
  503: 'service-unavailable',
};

/** Maps any thrown value to a problem document (without request-specific members). */
export function toProblem(error: unknown): { problem: Problem; headers?: Record<string, string> } {
  if (error instanceof ProblemError) {
    return {
      problem: {
        type: error.type,
        title: PROBLEM_TYPES[error.type].title,
        status: error.status,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.errors === undefined ? {} : { errors: error.errors }),
      },
      ...(error.headers === undefined ? {} : { headers: error.headers }),
    };
  }
  if (error instanceof ZodError) {
    const type = 'validation-failed';
    return {
      problem: {
        type,
        title: PROBLEM_TYPES[type].title,
        status: 400,
        errors: toValidationIssues(error),
      },
    };
  }
  if (error instanceof HTTPException) {
    const type =
      STATUS_TO_TYPE[error.status] ?? (error.status >= 500 ? 'internal-error' : 'bad-request');
    return {
      problem: {
        type,
        title: PROBLEM_TYPES[type].title,
        status: error.status,
        ...(error.status < 500 && error.message ? { detail: error.message } : {}),
      },
    };
  }
  return {
    problem: { type: 'internal-error', title: PROBLEM_TYPES['internal-error'].title, status: 500 },
  };
}

export function problemResponse(
  c: Context,
  problem: Problem,
  headers?: Record<string, string>,
): Response {
  return c.newResponse(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
    ...headers,
    'Content-Type': PROBLEM_CONTENT_TYPE,
  });
}
