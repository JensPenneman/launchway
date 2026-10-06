import {
  type CreateDnsProviderAccountInput,
  type DnsProviderAccount,
  type DnsProviderAccountId,
  type DnsProviderInfo,
  type DnsRecord,
  type DnsRecordInput,
  type DnsZone,
  type DnsZoneId,
  type DnsZoneListQuery,
  generateId,
  type UpdateDnsProviderAccountInput,
} from '@slipway/contracts';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import {
  conflict,
  invalidField,
  notFound,
  ProblemError,
  toValidationIssues,
} from '../../lib/problem.js';
import { recordAudit } from '../audit/service.js';
import { callProvider, providerProblem } from './errors.js';
import { type DnsProviderRegistry, dnsProviders } from './providers/registry.js';
import {
  type DnsProvider,
  type DnsProviderDefinition,
  DnsProviderError,
} from './providers/types.js';
import { dnsProviderAccounts, dnsZones } from './schema.js';

type AccountRow = typeof dnsProviderAccounts.$inferSelect;
export type DnsZoneRow = typeof dnsZones.$inferSelect;

export interface DnsServiceOptions {
  readonly registry?: DnsProviderRegistry;
  readonly fetch?: typeof fetch;
}

/** A zone with a ready-to-use client of its provider account. */
export interface ZoneProvider {
  readonly zone: DnsZoneRow;
  readonly provider: DnsProvider;
}

export interface DnsService {
  listProviders(): DnsProviderInfo[];
  listAccounts(): Promise<DnsProviderAccount[]>;
  getAccount(id: DnsProviderAccountId): Promise<DnsProviderAccount>;
  createAccount(
    input: CreateDnsProviderAccountInput,
    actor: RequestActor,
  ): Promise<DnsProviderAccount>;
  updateAccount(
    id: DnsProviderAccountId,
    input: UpdateDnsProviderAccountInput,
    actor: RequestActor,
  ): Promise<DnsProviderAccount>;
  deleteAccount(id: DnsProviderAccountId, actor: RequestActor): Promise<void>;
  /** Fetches the zones of the account from the provider and stores them (adds, renames, removes). */
  syncAccount(id: DnsProviderAccountId, actor: RequestActor): Promise<DnsZone[]>;
  listZones(query: DnsZoneListQuery): Promise<DnsZone[]>;
  getZone(id: DnsZoneId): Promise<DnsZone>;
  /** Longest stored zone that contains `hostname` (the zone apex itself included). */
  findZoneForHostname(hostname: string): Promise<DnsZoneRow | null>;
  /** Throws not-found for an unknown zone. */
  providerForZone(zoneId: DnsZoneId): Promise<ZoneProvider>;
  listRecords(zoneId: DnsZoneId): Promise<DnsRecord[]>;
  createRecord(zoneId: DnsZoneId, input: DnsRecordInput, actor: RequestActor): Promise<DnsRecord>;
  updateRecord(
    zoneId: DnsZoneId,
    recordId: string,
    input: DnsRecordInput,
    actor: RequestActor,
  ): Promise<DnsRecord>;
  deleteRecord(zoneId: DnsZoneId, recordId: string, actor: RequestActor): Promise<void>;
}

/** Whether `hostname` is the zone apex or a name below it. */
export function isInZone(hostname: string, zoneName: string): boolean {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}

const credentialsContext = (id: DnsProviderAccountId) => `dns-account:${id}`;

function toAccount(row: AccountRow): DnsProviderAccount {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toZone(row: DnsZoneRow): DnsZone {
  return {
    id: row.id,
    accountId: row.accountId,
    externalId: row.externalId,
    name: row.name,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProviderInfo(definition: DnsProviderDefinition): DnsProviderInfo {
  return {
    kind: definition.kind,
    label: definition.label,
    docsUrl: definition.docsUrl,
    capabilities: { ...definition.capabilities },
    credentialsSchema: z.toJSONSchema(definition.credentialsSchema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as Record<string, unknown>,
  };
}

export function createDnsService(
  deps: Pick<Deps, 'db' | 'secrets' | 'events' | 'logger'>,
  options: DnsServiceOptions = {},
): DnsService {
  const registry = options.registry ?? dnsProviders;
  const fetchFn = options.fetch ?? globalThis.fetch;

  function definitionOf(kind: string): DnsProviderDefinition {
    const definition = registry.get(kind);
    if (!definition) throw conflict(`DNS provider "${kind}" is not available in this version`);
    return definition;
  }

  /** Validates credentials for a kind; `path` names the request field in errors. */
  function parseCredentials(definition: DnsProviderDefinition, raw: unknown): unknown {
    const parsed = definition.credentialsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProblemError('validation-failed', {
        errors: toValidationIssues(parsed.error, 'body.credentials'),
      });
    }
    return parsed.data;
  }

  /** Checks credentials with the provider; rejected credentials are a validation error. */
  async function verify(definition: DnsProviderDefinition, credentials: unknown): Promise<void> {
    try {
      await definition.create(credentials, { fetch: fetchFn }).verifyCredentials();
    } catch (error) {
      if (
        error instanceof DnsProviderError &&
        (error.reason === 'unauthorized' || error.reason === 'forbidden')
      ) {
        throw invalidField('body.credentials', error.message);
      }
      if (error instanceof DnsProviderError) throw providerProblem(error);
      throw error;
    }
  }

  async function loadAccount(id: DnsProviderAccountId): Promise<AccountRow> {
    const [row] = await deps.db
      .select()
      .from(dnsProviderAccounts)
      .where(eq(dnsProviderAccounts.id, id));
    if (!row) throw notFound(`DNS provider account ${id} does not exist`);
    return row;
  }

  function clientOf(account: AccountRow): DnsProvider {
    const definition = definitionOf(account.kind);
    const plaintext = deps.secrets.decrypt(
      account.credentialsEncrypted,
      credentialsContext(account.id),
    );
    const credentials = definition.credentialsSchema.parse(JSON.parse(plaintext));
    return definition.create(credentials, { fetch: fetchFn });
  }

  async function loadZone(id: DnsZoneId): Promise<DnsZoneRow> {
    const [row] = await deps.db.select().from(dnsZones).where(eq(dnsZones.id, id));
    if (!row) throw notFound(`DNS zone ${id} does not exist`);
    return row;
  }

  async function providerForZone(zoneId: DnsZoneId): Promise<ZoneProvider> {
    const zone = await loadZone(zoneId);
    const account = await loadAccount(zone.accountId);
    return { zone, provider: clientOf(account) };
  }

  function assertInZone(zone: DnsZoneRow, input: DnsRecordInput): void {
    if (!isInZone(input.name, zone.name)) {
      throw invalidField('body.name', `Must be ${zone.name} or a name below it`);
    }
  }

  async function auditRecord(
    actor: RequestActor,
    zone: DnsZoneRow,
    verb: 'create' | 'update' | 'delete',
    summary: Record<string, unknown>,
  ): Promise<void> {
    await deps.db.transaction(async (tx) => {
      await recordAudit(tx, actor, {
        action: `dns-record.${verb}`,
        target: { type: 'dns-zone', id: zone.id },
        summary: { zone: zone.name, ...summary },
      });
    });
    deps.events.publish({ topic: 'dns', action: 'updated', resourceId: zone.id });
  }

  return {
    listProviders: () => registry.list().map(toProviderInfo),

    async listAccounts() {
      const rows = await deps.db
        .select()
        .from(dnsProviderAccounts)
        .orderBy(asc(dnsProviderAccounts.createdAt), asc(dnsProviderAccounts.id));
      return rows.map(toAccount);
    },

    async getAccount(id) {
      return toAccount(await loadAccount(id));
    },

    async createAccount(input, actor) {
      const definition = registry.get(input.kind);
      if (!definition) throw invalidField('body.kind', `Unknown DNS provider "${input.kind}"`);
      const credentials = parseCredentials(definition, input.credentials);
      await verify(definition, credentials);

      const id = generateId('prov');
      const row = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(dnsProviderAccounts)
          .values({
            id,
            kind: definition.kind,
            name: input.name,
            credentialsEncrypted: deps.secrets.encrypt(
              JSON.stringify(credentials),
              credentialsContext(id),
            ),
            lastVerifiedAt: new Date(),
          })
          .returning();
        if (!created) throw new Error('insert returned no row');
        await recordAudit(tx, actor, {
          action: 'dns-account.create',
          target: { type: 'dns-account', id },
          summary: { kind: created.kind, name: created.name },
        });
        return created;
      });
      deps.events.publish({ topic: 'dns', action: 'created', resourceId: row.id });
      return toAccount(row);
    },

    async updateAccount(id, input, actor) {
      const current = await loadAccount(id);
      const patch: Partial<Pick<AccountRow, 'name' | 'credentialsEncrypted' | 'lastVerifiedAt'>> =
        {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.credentials !== undefined) {
        const definition = definitionOf(current.kind);
        const credentials = parseCredentials(definition, input.credentials);
        await verify(definition, credentials);
        patch.credentialsEncrypted = deps.secrets.encrypt(
          JSON.stringify(credentials),
          credentialsContext(id),
        );
        patch.lastVerifiedAt = new Date();
      }
      const row = await deps.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(dnsProviderAccounts)
          .set(patch)
          .where(eq(dnsProviderAccounts.id, id))
          .returning();
        if (!updated) throw notFound(`DNS provider account ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'dns-account.update',
          target: { type: 'dns-account', id },
          summary: {
            ...(input.name !== undefined && input.name !== current.name
              ? { name: { from: current.name, to: updated.name } }
              : {}),
            ...(input.credentials !== undefined ? { credentials: '[redacted]' } : {}),
          },
        });
        return updated;
      });
      deps.events.publish({ topic: 'dns', action: 'updated', resourceId: id });
      return toAccount(row);
    },

    async deleteAccount(id, actor) {
      await deps.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(dnsProviderAccounts)
          .where(eq(dnsProviderAccounts.id, id))
          .returning();
        if (!deleted) throw notFound(`DNS provider account ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'dns-account.delete',
          target: { type: 'dns-account', id },
          summary: { kind: deleted.kind, name: deleted.name },
        });
      });
      deps.events.publish({ topic: 'dns', action: 'deleted', resourceId: id });
    },

    async syncAccount(id, actor) {
      const account = await loadAccount(id);
      const remote = await callProvider(() => clientOf(account).listZones());
      const now = new Date();
      const rows = await deps.db.transaction(async (tx) => {
        const before = await tx
          .select({ externalId: dnsZones.externalId })
          .from(dnsZones)
          .where(eq(dnsZones.accountId, id));
        const known = new Set(before.map((zone) => zone.externalId));
        const seen = remote.map((zone) => zone.externalId);
        for (const zone of remote) {
          await tx
            .insert(dnsZones)
            .values({
              accountId: id,
              externalId: zone.externalId,
              name: zone.name,
              lastSyncedAt: now,
            })
            .onConflictDoUpdate({
              target: [dnsZones.accountId, dnsZones.externalId],
              set: { name: zone.name, lastSyncedAt: now },
            });
        }
        const removed = await tx
          .delete(dnsZones)
          .where(
            seen.length > 0
              ? and(eq(dnsZones.accountId, id), notInArray(dnsZones.externalId, seen))
              : eq(dnsZones.accountId, id),
          )
          .returning({ name: dnsZones.name });
        await tx
          .update(dnsProviderAccounts)
          .set({ lastVerifiedAt: now })
          .where(eq(dnsProviderAccounts.id, id));
        await recordAudit(tx, actor, {
          action: 'dns-account.sync',
          target: { type: 'dns-account', id },
          summary: {
            zones: remote.length,
            added: remote.filter((zone) => !known.has(zone.externalId)).map((zone) => zone.name),
            removed: removed.map((zone) => zone.name),
          },
        });
        return tx
          .select()
          .from(dnsZones)
          .where(eq(dnsZones.accountId, id))
          .orderBy(asc(dnsZones.name), asc(dnsZones.id));
      });
      deps.events.publish({ topic: 'dns', action: 'updated', resourceId: id });
      return rows.map(toZone);
    },

    async listZones(query) {
      const rows = await deps.db
        .select()
        .from(dnsZones)
        .where(query.accountId === undefined ? undefined : eq(dnsZones.accountId, query.accountId))
        .orderBy(asc(dnsZones.name), asc(dnsZones.id));
      return rows.map(toZone);
    },

    async getZone(id) {
      return toZone(await loadZone(id));
    },

    async findZoneForHostname(hostname) {
      const labels = hostname.split('.');
      const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
      if (candidates.length === 0) return null;
      const rows = await deps.db
        .select()
        .from(dnsZones)
        .where(inArray(dnsZones.name, candidates))
        .orderBy(asc(dnsZones.createdAt), asc(dnsZones.id));
      let best: DnsZoneRow | null = null;
      for (const row of rows) if (!best || row.name.length > best.name.length) best = row;
      return best;
    },

    providerForZone,

    async listRecords(zoneId) {
      const { zone, provider } = await providerForZone(zoneId);
      return callProvider(() => provider.listRecords(zone.externalId));
    },

    async createRecord(zoneId, input, actor) {
      const { zone, provider } = await providerForZone(zoneId);
      assertInZone(zone, input);
      const record = await callProvider(() => provider.upsertRecord(zone.externalId, input));
      await auditRecord(actor, zone, 'create', {
        recordId: record.externalId,
        type: record.type,
        name: record.name,
        content: record.content,
      });
      return record;
    },

    async updateRecord(zoneId, recordId, input, actor) {
      const { zone, provider } = await providerForZone(zoneId);
      assertInZone(zone, input);
      const record = await callProvider(() =>
        provider.upsertRecord(zone.externalId, input, recordId),
      );
      await auditRecord(actor, zone, 'update', {
        recordId,
        type: record.type,
        name: record.name,
        content: record.content,
      });
      return record;
    },

    async deleteRecord(zoneId, recordId, actor) {
      const { zone, provider } = await providerForZone(zoneId);
      await callProvider(() => provider.deleteRecord(zone.externalId, recordId));
      await auditRecord(actor, zone, 'delete', { recordId });
    },
  };
}
