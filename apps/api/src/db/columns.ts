import { generateId, type IdPrefix, type TypeId } from '@slipway/contracts';
import { customType, text, timestamp } from 'drizzle-orm/pg-core';

/** Primary key holding a prefixed TypeID (`app_01h...`), generated on insert. */
export function idColumn<P extends IdPrefix>(prefix: P) {
  return text('id')
    .primaryKey()
    .$type<TypeId<P>>()
    .$defaultFn(() => generateId(prefix));
}

/** `timestamptz`, mapped to `Date`. */
export function tz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

/** `created_at` / `updated_at` for mutable tables; `updated_at` is bumped on every update. */
export function timestamps() {
  return {
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}

/** `bytea`, mapped to `Buffer`. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
