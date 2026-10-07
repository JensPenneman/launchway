import {
  type CreateDomainInput,
  type DnsRecordInput,
  type DnsZoneId,
  type Domain,
  type DomainId,
  DomainId as DomainIdSchema,
  type DomainListQuery,
  type DomainPage,
  type DomainStatus,
  type DomainVerification,
  type UpdateDomainInput,
} from '@launchway/contracts';
import { and, asc, eq, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import { type RequestActor, systemActor } from '../../lib/auth-context.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { conflict, invalidField, notFound, ProblemError } from '../../lib/problem.js';
import { diffSummary, recordAudit } from '../audit/service.js';
import { callProvider, providerProblem } from '../dns/errors.js';
import { DnsProviderError } from '../dns/providers/types.js';
import { createDnsService, type DnsService, isInZone, type ZoneProvider } from '../dns/service.js';
import { createSettingsService, type SettingsService } from '../settings/service.js';
import { domains } from './schema.js';
import {
  createResolver,
  type DnsCheckResult,
  type DnsLookup,
  evaluateDns,
  expectedRecordFor,
  observeDns,
  recordInputFor,
} from './verify.js';

type DomainRow = typeof domains.$inferSelect;

export interface DomainsServiceOptions {
  readonly dns?: DnsService;
  readonly settings?: SettingsService;
  /** DNS resolver used by verification (default: system resolvers, then 1.1.1.1, 8.8.8.8). */
  readonly resolver?: DnsLookup;
}

export interface DomainsService {
  create(input: CreateDomainInput, actor: RequestActor): Promise<Domain>;
  list(query: DomainListQuery): Promise<DomainPage>;
  get(id: DomainId): Promise<Domain>;
  update(id: DomainId, input: UpdateDomainInput, actor: RequestActor): Promise<Domain>;
  remove(id: DomainId, actor: RequestActor): Promise<void>;
  /** Runs the DNS preflight now and stores the resulting status. Audited. */
  verify(id: DomainId, actor: RequestActor): Promise<DomainVerification>;
  /** Re-checks every domain that is not `active` (background job); returns how many changed. */
  recheckPending(): Promise<number>;
  /**
   * For the edge module: the edge holds a certificate for the domain, so it is `active`.
   * Idempotent; audited and published only when the status changes.
   */
  markDomainActive(id: DomainId, actor?: RequestActor): Promise<Domain>;
}

const CursorPosition = z.object({ c: z.iso.datetime(), i: DomainIdSchema });
/** created_at at millisecond precision, the precision a cursor carries. */
const createdAtMs = sql`date_trunc('milliseconds', ${domains.createdAt})`;

function toDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    hostname: row.hostname,
    zoneId: row.zoneId,
    managed: row.zoneId !== null && row.dnsRecordExternalId !== null,
    proxied: row.proxied,
    force: row.force,
    status: row.status,
    statusMessage: row.statusMessage,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createDomainsService(
  deps: Pick<Deps, 'db' | 'secrets' | 'events' | 'logger' | 'config'>,
  options: DomainsServiceOptions = {},
): DomainsService {
  const dns = options.dns ?? createDnsService(deps);
  const settings = options.settings ?? createSettingsService(deps);
  let resolver = options.resolver;
  const getResolver = () => {
    resolver ??= createResolver();
    return resolver;
  };

  async function load(id: DomainId): Promise<DomainRow> {
    const [row] = await deps.db.select().from(domains).where(eq(domains.id, id));
    if (!row) throw notFound(`Domain ${id} does not exist`);
    return row;
  }

  /** Resolves the zone of a request: undefined = automatic, null = unmanaged. */
  async function resolveZone(
    hostname: string,
    zoneId: DnsZoneId | null | undefined,
  ): Promise<ZoneProvider | null> {
    if (zoneId === null) return null;
    if (zoneId === undefined) {
      const zone = await dns.findZoneForHostname(hostname);
      return zone ? dns.providerForZone(zone.id) : null;
    }
    let zoneProvider: ZoneProvider;
    try {
      zoneProvider = await dns.providerForZone(zoneId);
    } catch (error) {
      if (error instanceof ProblemError && error.type === 'not-found') {
        throw invalidField('body.zoneId', 'Unknown zone');
      }
      throw error;
    }
    if (!isInZone(hostname, zoneProvider.zone.name)) {
      throw invalidField('body.zoneId', `${hostname} is not inside ${zoneProvider.zone.name}`);
    }
    return zoneProvider;
  }

  /** The record a managed domain needs; conflict while neither anchor nor IPv4 is known. */
  async function desiredRecord(
    hostname: string,
    proxied: boolean,
    zone: ZoneProvider,
  ): Promise<DnsRecordInput> {
    const expected = expectedRecordFor(hostname, await settings.get());
    if (!expected) {
      throw conflict(
        'Set the anchor hostname in the settings, or wait until the public IPv4 is detected, before creating a managed domain',
      );
    }
    return recordInputFor(hostname, expected, proxied && zone.provider.capabilities.proxied);
  }

  /** Deletes a record Launchway created; a record that is already gone is fine. */
  async function deleteManagedRecord(row: DomainRow): Promise<void> {
    if (!row.zoneId || !row.dnsRecordExternalId) return;
    const { zone, provider } = await dns.providerForZone(row.zoneId);
    const recordId = row.dnsRecordExternalId;
    try {
      await provider.deleteRecord(zone.externalId, recordId);
    } catch (error) {
      if (error instanceof DnsProviderError && error.reason === 'not-found') {
        deps.logger.info({ domainId: row.id }, 'managed DNS record was already deleted');
        return;
      }
      if (error instanceof DnsProviderError) throw providerProblem(error);
      throw error;
    }
  }

  /**
   * Stores a check result; returns the updated row and whether the status changed. The status is
   * derived from the row as it is now (locked), not as it was before the slow DNS lookups: the
   * edge may have marked the domain `active` meanwhile. A failed lookup keeps the status.
   */
  async function applyCheck(
    initial: DomainRow,
    result: DnsCheckResult,
    checkedAt: Date,
    actor: RequestActor,
    audit: 'always' | 'on-change',
  ): Promise<{ row: DomainRow; changed: boolean }> {
    const { ok, message } = result;
    let changed = false;
    let status: DomainStatus = initial.status;
    const updated = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(domains).where(eq(domains.id, initial.id)).for('update');
      if (!row) throw notFound(`Domain ${initial.id} does not exist`);
      status = result.inconclusive
        ? row.status
        : ok
          ? row.status === 'active'
            ? 'active'
            : 'verified'
          : 'misconfigured';
      changed = status !== row.status || message !== row.statusMessage;
      const [after] = await tx
        .update(domains)
        .set({ status, statusMessage: message, lastCheckedAt: checkedAt })
        .where(eq(domains.id, row.id))
        .returning();
      if (!after) throw notFound(`Domain ${row.id} does not exist`);
      if (audit === 'always' || status !== row.status) {
        await recordAudit(tx, actor, {
          action: 'domain.verify',
          target: { type: 'domain', id: row.id },
          summary: { hostname: row.hostname, ok, ...diffSummary(row, after, ['status']) },
        });
      }
      return after;
    });
    if (changed) {
      deps.events.publish({
        topic: 'domains',
        action: 'updated',
        resourceId: initial.id,
        data: { status },
      });
    }
    return { row: updated, changed };
  }

  async function check(row: DomainRow, actor: RequestActor, audit: 'always' | 'on-change') {
    const target = await settings.get();
    const expected = expectedRecordFor(row.hostname, target);
    const { observed, error } = await observeDns(row.hostname, getResolver());
    const result = evaluateDns(row.hostname, expected, observed, {
      publicIpv4: target.publicIpv4,
      proxied: row.proxied,
      lookupError: error,
    });
    const checkedAt = new Date();
    const applied = await applyCheck(row, result, checkedAt, actor, audit);
    const verification: DomainVerification = {
      domainId: row.id,
      hostname: row.hostname,
      ok: result.ok,
      status: applied.row.status,
      checkedAt: checkedAt.toISOString(),
      expected,
      observed,
      message: result.message,
      requiredRecords:
        expected && applied.row.dnsRecordExternalId === null
          ? [recordInputFor(row.hostname, expected)]
          : [],
    };
    return { verification, changed: applied.changed };
  }

  return {
    async create(input, actor) {
      const [existing] = await deps.db
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.hostname, input.hostname));
      if (existing) throw conflict(`${input.hostname} already exists`);

      const zone = await resolveZone(input.hostname, input.zoneId);
      let record: { externalId: string; input: DnsRecordInput } | null = null;
      if (zone) {
        const wanted = await desiredRecord(input.hostname, input.proxied, zone);
        const created = await callProvider(() =>
          zone.provider.upsertRecord(zone.zone.externalId, wanted),
        );
        record = { externalId: created.externalId, input: wanted };
      }

      let row: DomainRow;
      try {
        row = await deps.db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(domains)
            .values({
              hostname: input.hostname,
              zoneId: zone?.zone.id ?? null,
              proxied: input.proxied,
              force: input.force,
              dnsRecordExternalId: record?.externalId ?? null,
            })
            .returning();
          if (!inserted) throw new Error('insert returned no row');
          await recordAudit(tx, actor, {
            action: 'domain.create',
            target: { type: 'domain', id: inserted.id },
            summary: {
              hostname: inserted.hostname,
              zoneId: inserted.zoneId,
              proxied: inserted.proxied,
              force: inserted.force,
              ...(record
                ? { record: { type: record.input.type, content: record.input.content } }
                : {}),
            },
          });
          return inserted;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost a race with another create of the same name: leave its record alone.
        throw conflict(`${input.hostname} already exists`);
      }
      deps.events.publish({ topic: 'domains', action: 'created', resourceId: row.id });
      return toDomain(row);
    },

    async list(query) {
      const conditions: SQL[] = [];
      if (query.status) conditions.push(eq(domains.status, query.status));
      if (query.cursor) {
        const position = decodeCursor(query.cursor, CursorPosition);
        conditions.push(
          sql`(${createdAtMs}, ${domains.id}) > (${position.c}::timestamptz, ${position.i})`,
        );
      }
      const rows = await deps.db
        .select()
        .from(domains)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(createdAtMs), asc(domains.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(toDomain),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ c: last.createdAt.toISOString(), i: last.id })
            : null,
      };
    },

    async get(id) {
      return toDomain(await load(id));
    },

    async update(id, input, actor) {
      const before = await load(id);
      const zoneChanged = input.zoneId !== undefined && input.zoneId !== before.zoneId;
      const proxied = input.proxied ?? before.proxied;
      const zone = zoneChanged
        ? await resolveZone(before.hostname, input.zoneId)
        : before.zoneId
          ? await dns.providerForZone(before.zoneId)
          : null;

      let recordId = before.dnsRecordExternalId;
      if (zoneChanged) {
        await deleteManagedRecord(before);
        recordId = null;
      }
      if (zone && (zoneChanged || proxied !== before.proxied || recordId === null)) {
        const wanted = await desiredRecord(before.hostname, proxied, zone);
        const record = await callProvider(() =>
          zone.provider.upsertRecord(zone.zone.externalId, wanted, recordId ?? undefined),
        );
        recordId = record.externalId;
      }

      const after = await deps.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(domains)
          .set({
            zoneId: zone?.zone.id ?? null,
            proxied,
            ...(input.force === undefined ? {} : { force: input.force }),
            dnsRecordExternalId: recordId,
            ...(zoneChanged ? { status: 'pending' as const, statusMessage: null } : {}),
          })
          .where(eq(domains.id, id))
          .returning();
        if (!updated) throw notFound(`Domain ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'domain.update',
          target: { type: 'domain', id },
          summary: diffSummary(before, updated, [
            'zoneId',
            'proxied',
            'force',
            'dnsRecordExternalId',
            'status',
          ]),
        });
        return updated;
      });
      deps.events.publish({ topic: 'domains', action: 'updated', resourceId: id });
      return toDomain(after);
    },

    async remove(id, actor) {
      const row = await load(id);
      await deleteManagedRecord(row);
      await deps.db.transaction(async (tx) => {
        const [deleted] = await tx.delete(domains).where(eq(domains.id, id)).returning();
        if (!deleted) throw notFound(`Domain ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'domain.delete',
          target: { type: 'domain', id },
          summary: {
            hostname: deleted.hostname,
            recordDeleted: deleted.dnsRecordExternalId !== null,
          },
        });
      });
      deps.events.publish({ topic: 'domains', action: 'deleted', resourceId: id });
    },

    async verify(id, actor) {
      const { verification } = await check(await load(id), actor, 'always');
      return verification;
    },

    async recheckPending() {
      const rows = await deps.db
        .select()
        .from(domains)
        .where(ne(domains.status, 'active'))
        .orderBy(asc(domains.lastCheckedAt), asc(domains.id));
      const actor = systemActor('domain-verify');
      let changed = 0;
      for (const row of rows) {
        try {
          if ((await check(row, actor, 'on-change')).changed) changed += 1;
        } catch (error) {
          deps.logger.warn({ err: error, domainId: row.id }, 'domain check failed');
        }
      }
      return changed;
    },

    async markDomainActive(id, actor = systemActor('edge')) {
      const before = await load(id);
      if (before.status === 'active') return toDomain(before);
      const after = await deps.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(domains)
          .set({ status: 'active', statusMessage: null })
          .where(eq(domains.id, id))
          .returning();
        if (!updated) throw notFound(`Domain ${id} does not exist`);
        await recordAudit(tx, actor, {
          action: 'domain.activate',
          target: { type: 'domain', id },
          summary: diffSummary(before, updated, ['status']),
        });
        return updated;
      });
      deps.events.publish({
        topic: 'domains',
        action: 'updated',
        resourceId: id,
        data: { status: 'active' },
      });
      return toDomain(after);
    },
  };
}
