import {
  API_TOKEN_PREFIX,
  type ApiToken,
  type ApiTokenId,
  type ApiTokenList,
  type CreateApiTokenInput,
  type CreatedApiToken,
  type UserId,
} from '@launchway/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Deps } from '../../deps.js';
import { effectiveRole, getActorPrincipal, type RequestActor } from '../../lib/auth-context.js';
import { generateToken, hashToken, tokenHint } from '../../lib/crypto.js';
import { forbidden, invalidField, notFound } from '../../lib/problem.js';
import { recordAudit } from '../audit/service.js';
import { scopesBeyondRole } from './rules.js';
import { apiTokens } from './schema.js';

type ApiTokenRow = typeof apiTokens.$inferSelect;

/** API shape of a token: never the hash, only the non-secret hint. */
function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    tokenHint: row.tokenHint,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface TokensService {
  create(input: CreateApiTokenInput, actor: RequestActor): Promise<CreatedApiToken>;
  list(userId: UserId): Promise<ApiTokenList>;
  revoke(id: ApiTokenId, actor: RequestActor): Promise<void>;
}

export function createTokensService(deps: Pick<Deps, 'db' | 'events'>): TokensService {
  return {
    async create(input, actor) {
      const principal = getActorPrincipal(actor);
      if (principal.kind === 'token') {
        throw forbidden('API tokens cannot create API tokens; sign in to create one');
      }
      const beyond = scopesBeyondRole(effectiveRole(principal), input.scopes);
      if (beyond.length > 0) {
        throw forbidden(`Your role cannot grant the scope(s): ${beyond.join(', ')}`);
      }
      const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw invalidField('body.expiresAt', 'Must be in the future');
      }

      const secret = generateToken(API_TOKEN_PREFIX);
      const row = await deps.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(apiTokens)
          .values({
            userId: principal.user.id,
            name: input.name,
            tokenHash: hashToken(secret),
            tokenHint: tokenHint(secret),
            scopes: input.scopes,
            expiresAt,
          })
          .returning();
        if (!inserted) throw new Error('token insert returned no row');
        await recordAudit(tx, actor, {
          action: 'token.create',
          target: { type: 'token', id: inserted.id },
          summary: {
            name: inserted.name,
            scopes: inserted.scopes,
            expiresAt: inserted.expiresAt?.toISOString() ?? null,
          },
        });
        return inserted;
      });
      deps.events.publish({ topic: 'tokens', action: 'created', resourceId: row.id });
      return { token: toApiToken(row), secret };
    },

    async list(userId) {
      const rows = await deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.userId, userId))
        .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
      return { items: rows.map(toApiToken) };
    },

    async revoke(id, actor) {
      const principal = getActorPrincipal(actor);
      await deps.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(apiTokens)
          .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, principal.user.id)))
          .returning();
        if (!deleted) throw notFound('API token not found');
        await recordAudit(tx, actor, {
          action: 'token.delete',
          target: { type: 'token', id },
          summary: { name: deleted.name },
        });
      });
      deps.events.publish({ topic: 'tokens', action: 'deleted', resourceId: id });
    },
  };
}
