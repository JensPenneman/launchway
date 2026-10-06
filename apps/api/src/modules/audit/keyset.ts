import { and, type Column, eq, gt, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';

/**
 * Keyset pagination on `(created_at, id)`. PostgreSQL keeps microseconds while a JS `Date` keeps
 * milliseconds, so the cursor carries the exact database value as text (`createdAtKey`) instead
 * of a serialized `Date`; otherwise rows sharing a millisecond would repeat across pages.
 */
const KeysetCursor = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.string().min(1).max(64),
});

/** Select this next to the row: the exact `created_at` in UTC with microseconds. */
export function createdAtKey(column: Column): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Condition selecting the rows after `cursor` in the given direction (null without cursor). */
export function afterCursor(
  cursor: string | undefined,
  createdAt: Column,
  id: Column,
  direction: 'asc' | 'desc',
): SQL | undefined {
  if (!cursor) return undefined;
  const position = decodeCursor(cursor, KeysetCursor);
  const at = sql`${position.t}::timestamptz`;
  const beyond = direction === 'asc' ? gt : lt;
  return or(beyond(createdAt, at), and(eq(createdAt, at), beyond(id, position.id)));
}

/** Cuts a `limit + 1` result to a page and computes `nextCursor`. */
export function toPage<R extends { createdAtKey: string; id: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: hasMore && last ? encodeCursor({ t: last.createdAtKey, id: last.id }) : null,
  };
}
