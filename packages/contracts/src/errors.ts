import { z } from './zod.js';

/** Media type of every error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Stable problem `type` slugs with their HTTP status and default title. The `type` member of a
 * problem document is the bare slug (a relative URI reference), e.g. `"type": "not-found"`.
 * Never rename a slug; add new ones instead.
 */
export const PROBLEM_TYPES = {
  'validation-failed': { status: 400, title: 'Validation failed' },
  'bad-request': { status: 400, title: 'Bad request' },
  unauthorized: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  'not-found': { status: 404, title: 'Not found' },
  'method-not-allowed': { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  'payload-too-large': { status: 413, title: 'Payload too large' },
  'unsupported-media-type': { status: 415, title: 'Unsupported media type' },
  'rate-limited': { status: 429, title: 'Too many requests' },
  'internal-error': { status: 500, title: 'Internal server error' },
  'not-implemented': { status: 501, title: 'Not implemented' },
  'upstream-failed': { status: 502, title: 'Upstream service failed' },
  'service-unavailable': { status: 503, title: 'Service unavailable' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemType = keyof typeof PROBLEM_TYPES;
export const PROBLEM_TYPE_SLUGS = Object.keys(PROBLEM_TYPES) as [ProblemType, ...ProblemType[]];
export const ProblemType = z.enum(PROBLEM_TYPE_SLUGS).openapi('ProblemType');

export const ValidationIssue = z
  .object({
    path: z
      .string()
      .openapi({ description: 'Dot-separated path of the invalid field', example: 'body.email' }),
    message: z.string(),
    code: z.string().openapi({ example: 'invalid_format' }),
  })
  .openapi('ValidationIssue');
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const Problem = z
  .object({
    type: ProblemType,
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().optional().openapi({ description: 'Correlates with server logs' }),
    errors: z
      .array(ValidationIssue)
      .optional()
      .openapi({ description: 'Present for validation-failed' }),
  })
  .openapi('Problem', { description: 'RFC 9457 problem details' });
export type Problem = z.infer<typeof Problem>;
