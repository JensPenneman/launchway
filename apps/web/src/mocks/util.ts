import {
  type AuditEvent,
  generateId,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  type ProblemType,
  roleAtLeast,
  type UserRole,
  type z,
} from '@launchway/contracts';
import { HttpResponse } from 'msw';
import { db } from './db';

export const API = '/api/v1';

export const now = () => new Date().toISOString();

export function problem(
  type: ProblemType,
  detail?: string,
  errors?: { path: string; message: string; code: string }[],
): HttpResponse<string> {
  const { status, title } = PROBLEM_TYPES[type];
  return new HttpResponse(
    JSON.stringify({
      type,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
    }),
    { status, headers: { 'Content-Type': PROBLEM_CONTENT_TYPE } },
  );
}

/** JSON response typed like `problem()`, for handlers whose branches must share one body type. */
export function json(data: unknown, status = 200): HttpResponse<string> {
  return new HttpResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 401 without a session, 403 below `minimum`; null when allowed. */
export function guard(minimum: UserRole): HttpResponse<string> | null {
  const role = db.role();
  if (!role) return problem('unauthorized');
  if (!roleAtLeast(role, minimum)) {
    return problem('forbidden', `This action needs the ${minimum} role or higher.`);
  }
  return null;
}

/** Like the API: only admins may change `App.trustedMounts`. */
export function guardTrustedMounts(): HttpResponse<string> | null {
  const role = db.role();
  if (role && roleAtLeast(role, 'admin')) return null;
  return problem(
    'forbidden',
    'Only an admin can change trustedMounts: trusted apps may bind-mount host directories and reuse foreign volumes',
  );
}

/** Parses the JSON body with a contract schema; the error is a `validation-failed` problem. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T; error?: never } | { data?: never; error: HttpResponse<string> }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { error: problem('bad-request', 'The body must be JSON.') };
  }
  const result = schema.safeParse(json);
  if (result.success) return { data: result.data };
  return {
    error: problem(
      'validation-failed',
      undefined,
      result.error.issues.map((issue) => ({
        path: ['body', ...issue.path.map(String)].join('.'),
        message: issue.message,
        code: issue.code,
      })),
    ),
  };
}

/** Offset cursor pagination (`o<offset>`), shaped like the API's `{ items, nextCursor }`. */
export function paginate<T>(items: readonly T[], url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25) || 25, 1), 100);
  const offset = Number(url.searchParams.get('cursor')?.replace(/^o/, '') ?? 0) || 0;
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    nextCursor: offset + limit < items.length ? `o${offset + limit}` : null,
  };
}

export function recordAudit(
  action: string,
  targetType: string,
  targetId: string | null,
  summary?: Record<string, unknown>,
): void {
  const user = db.currentUser();
  const event: AuditEvent = {
    id: generateId('aud'),
    action,
    actor: user
      ? { type: 'user', id: user.id, label: user.email }
      : { type: 'system', id: null, label: 'mock' },
    target: { type: targetType, id: targetId },
    ipAddress: '192.168.1.24',
    userAgent: navigator.userAgent,
    summary: summary ?? null,
    createdAt: now(),
  };
  db.audit.unshift(event);
}

export function randomSha(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(prefix: string): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  return prefix + [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'app'
  );
}
