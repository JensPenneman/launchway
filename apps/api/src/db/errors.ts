/** SQLSTATE of a PostgreSQL error, looking through Drizzle's wrapper (`cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

/** @public For services: map unique violations to `conflict()`. */
export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === '23505';
export const isForeignKeyViolation = (error: unknown) => pgErrorCode(error) === '23503';
