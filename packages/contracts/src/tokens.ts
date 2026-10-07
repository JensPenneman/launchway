import { DisplayName, Timestamp } from './common.js';
import { ApiTokenId } from './ids.js';
import { list } from './pagination.js';
import type { UserRole } from './users.js';
import { z } from './zod.js';

/** API tokens are `lwy_` + 32 random bytes in base62 (43 characters). */
export const API_TOKEN_PREFIX = 'lwy_';
export const API_TOKEN_PATTERN = /^lwy_[0-9A-Za-z]{43}$/;

export const TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export const TokenScope = z.enum(TOKEN_SCOPES).openapi('TokenScope', {
  description: 'read: viewer-level access; write: up to member; admin: up to the owning user role',
});
export type TokenScope = z.infer<typeof TokenScope>;

/** Highest role a token with this scope can act as; the effective role is min(user role, ceiling). */
export const SCOPE_ROLE_CEILING: Record<TokenScope, UserRole> = {
  read: 'viewer',
  write: 'member',
  admin: 'owner',
};

const SCOPE_ORDER: Record<TokenScope, number> = { read: 0, write: 1, admin: 2 };

/** Role ceiling granted by a set of scopes (the widest scope wins). */
export function scopeCeiling(scopes: readonly TokenScope[]): UserRole {
  let widest: TokenScope = 'read';
  for (const scope of scopes) {
    if (SCOPE_ORDER[scope] > SCOPE_ORDER[widest]) widest = scope;
  }
  return SCOPE_ROLE_CEILING[widest];
}

export const ApiToken = z
  .object({
    id: ApiTokenId,
    name: DisplayName,
    scopes: z.array(TokenScope).min(1),
    tokenHint: z
      .string()
      .openapi({ description: 'First characters, for recognition', example: 'lwy_4fQx' }),
    expiresAt: Timestamp.nullable(),
    lastUsedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .openapi('ApiToken');
export type ApiToken = z.infer<typeof ApiToken>;

export const ApiTokenList = list(ApiToken).openapi('ApiTokenList');
export type ApiTokenList = z.infer<typeof ApiTokenList>;

export const CreateApiTokenInput = z
  .strictObject({
    name: DisplayName,
    scopes: z.array(TokenScope).min(1).max(TOKEN_SCOPES.length),
    expiresAt: Timestamp.nullable().default(null).openapi({ description: 'null = never expires' }),
  })
  .refine((v) => new Set(v.scopes).size === v.scopes.length, {
    message: 'Scopes must be unique',
    path: ['scopes'],
  })
  .openapi('CreateApiTokenInput');
export type CreateApiTokenInput = z.infer<typeof CreateApiTokenInput>;

export const CreatedApiToken = z
  .object({
    token: ApiToken,
    secret: z
      .string()
      .regex(API_TOKEN_PATTERN)
      .openapi({ description: 'Plaintext token. Returned once; only a SHA-256 hash is stored.' }),
  })
  .openapi('CreatedApiToken');
export type CreatedApiToken = z.infer<typeof CreatedApiToken>;
