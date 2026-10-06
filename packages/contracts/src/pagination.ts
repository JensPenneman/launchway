import type { ZodType } from 'zod';
import { z } from './zod.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Opaque, URL-safe cursor returned as `nextCursor`. Clients never construct it. */
export const Cursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'Malformed cursor')
  .openapi({ description: 'Opaque cursor from a previous page' });

export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .openapi({ description: `Page size (1-${MAX_PAGE_SIZE})` }),
  cursor: Cursor.optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

/** Cursor-paginated response: `{ items, nextCursor }`; `nextCursor` is null on the last page. */
export function page<T extends ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Non-paginated list response for small, bounded collections. */
export function list<T extends ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}
