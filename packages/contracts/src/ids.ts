import { TypeID, typeid } from 'typeid-js';
import type { ZodType } from 'zod';
import { z } from './zod.js';

/** Type-id prefixes per entity (spec section 2). IDs are TypeIDs: `<prefix>_<base32 UUIDv7>`. */
export const ID_PREFIXES = {
  user: 'user',
  session: 'sess',
  passkey: 'pk',
  apiToken: 'tok',
  invitation: 'inv',
  githubConnection: 'gh',
  app: 'app',
  envVar: 'env',
  deployment: 'dep',
  node: 'node',
  dnsProviderAccount: 'prov',
  dnsZone: 'zone',
  domain: 'dom',
  route: 'rt',
  auditEvent: 'aud',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
export type TypeId<P extends IdPrefix> = `${P}_${string}`;

const SUFFIX = '[0-7][0-9a-hjkmnp-tv-z]{25}';
const EXAMPLE_UUID = '01928a3e-6e5b-7cc3-9b1e-3f2a4c5d6e7f';

export function typeIdPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${SUFFIX}$`);
}

/** Zod schema for an ID with the given prefix; infers the template literal type `prefix_${string}`. */
export function typeId<P extends IdPrefix>(prefix: P): ZodType<TypeId<P>, TypeId<P>> {
  return z
    .string()
    .regex(typeIdPattern(prefix), `Must be a ${prefix}_ type ID`)
    .openapi({
      description: `TypeID with prefix \`${prefix}\``,
      example: TypeID.fromUUID(prefix, EXAMPLE_UUID).toString(),
    }) as unknown as ZodType<TypeId<P>, TypeId<P>>;
}

/** Generates a new, time-ordered ID (UUIDv7 underneath). */
export function generateId<P extends IdPrefix>(prefix: P): TypeId<P> {
  return typeid(prefix).toString() as TypeId<P>;
}

export function isTypeId<P extends IdPrefix>(prefix: P, value: unknown): value is TypeId<P> {
  return typeof value === 'string' && typeIdPattern(prefix).test(value);
}

export const UserId = typeId('user');
export type UserId = z.infer<typeof UserId>;
export const SessionId = typeId('sess');
export type SessionId = z.infer<typeof SessionId>;
export const PasskeyId = typeId('pk');
export type PasskeyId = z.infer<typeof PasskeyId>;
export const ApiTokenId = typeId('tok');
export type ApiTokenId = z.infer<typeof ApiTokenId>;
export const InvitationId = typeId('inv');
export type InvitationId = z.infer<typeof InvitationId>;
export const GitHubConnectionId = typeId('gh');
export type GitHubConnectionId = z.infer<typeof GitHubConnectionId>;
export const AppId = typeId('app');
export type AppId = z.infer<typeof AppId>;
export const EnvVarId = typeId('env');
export type EnvVarId = z.infer<typeof EnvVarId>;
export const DeploymentId = typeId('dep');
export type DeploymentId = z.infer<typeof DeploymentId>;
export const NodeId = typeId('node');
export type NodeId = z.infer<typeof NodeId>;
export const DnsProviderAccountId = typeId('prov');
export type DnsProviderAccountId = z.infer<typeof DnsProviderAccountId>;
export const DnsZoneId = typeId('zone');
export type DnsZoneId = z.infer<typeof DnsZoneId>;
export const DomainId = typeId('dom');
export type DomainId = z.infer<typeof DomainId>;
export const RouteId = typeId('rt');
export type RouteId = z.infer<typeof RouteId>;
export const AuditEventId = typeId('aud');
export type AuditEventId = z.infer<typeof AuditEventId>;
