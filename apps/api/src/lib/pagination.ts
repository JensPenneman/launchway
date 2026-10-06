import type { ZodType } from 'zod';
import { badRequest } from './problem.js';

/** Encodes a keyset position (e.g. `{ createdAt, id }`) into an opaque, URL-safe cursor. */
export function encodeCursor(position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Decodes a cursor produced by `encodeCursor`; malformed cursors are a 400. */
export function decodeCursor<T>(cursor: string, schema: ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Invalid cursor');
  }
}
