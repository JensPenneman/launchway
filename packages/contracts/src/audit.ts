import { IpAddress, JsonObject, Timestamp } from './common.js';
import { AuditEventId } from './ids.js';
import { PaginationQuery, page } from './pagination.js';
import { z } from './zod.js';

export const AUDIT_ACTOR_TYPES = ['user', 'token', 'agent', 'system'] as const;
export const AuditActorType = z.enum(AUDIT_ACTOR_TYPES).openapi('AuditActorType');
export type AuditActorType = z.infer<typeof AuditActorType>;

/** `<resource>.<verb>` in lower case, e.g. `settings.update`, `app.create`, `deployment.cancel`. */
export const AuditAction = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, 'Must look like resource.verb')
  .openapi({ example: 'settings.update' });
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditActor = z
  .object({
    type: AuditActorType,
    id: z.string().nullable().openapi({ description: 'User/token/node id; null for system' }),
    label: z
      .string()
      .nullable()
      .openapi({ description: 'Snapshot of the name/e-mail at the time' }),
  })
  .openapi('AuditActor');
export type AuditActor = z.infer<typeof AuditActor>;

export const AuditTarget = z
  .object({ type: z.string().max(50), id: z.string().max(64).nullable() })
  .openapi('AuditTarget');
export type AuditTarget = z.infer<typeof AuditTarget>;

export const AuditEvent = z
  .object({
    id: AuditEventId,
    action: AuditAction,
    actor: AuditActor,
    target: AuditTarget.nullable(),
    ipAddress: IpAddress.nullable(),
    userAgent: z.string().nullable(),
    summary: JsonObject.nullable().openapi({
      description: 'Diff summary of the change. Never contains secret values.',
    }),
    createdAt: Timestamp,
  })
  .openapi('AuditEvent');
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditEventPage = page(AuditEvent).openapi('AuditEventPage');
export type AuditEventPage = z.infer<typeof AuditEventPage>;

export const AuditListQuery = PaginationQuery.extend({
  action: z
    .string()
    .max(100)
    .optional()
    .openapi({ description: 'Action prefix, e.g. `user.` or `settings.update`' }),
  actorId: z.string().max(64).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(64).optional(),
  since: Timestamp.optional().openapi({ description: 'Only events at or after this time' }),
  until: Timestamp.optional().openapi({ description: 'Only events before this time' }),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;
