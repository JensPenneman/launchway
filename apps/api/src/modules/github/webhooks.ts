import { createHmac, timingSafeEqual } from 'node:crypto';
import { CommitSha, GitRef } from '@launchway/contracts';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import { forgetInstallationTokens } from '../../lib/git-provider.js';
import { badRequest, ProblemError, unauthorized } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { createDeploymentsService } from '../deployments/service.js';
import type { ConnectionRow } from './providers.js';
import { secretContext } from './providers.js';
import { githubConnections, githubWebhookDeliveries } from './schema.js';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Checks `X-Hub-Signature-256` (`sha256=<hex HMAC-SHA256 of the raw body>`) in constant time.
 */
export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean {
  if (!header?.startsWith(SIGNATURE_PREFIX)) return false;
  const given = header.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(Buffer.from(given.toLowerCase(), 'hex'), expected);
}

/** Request metadata GitHub sends with every delivery. */
export interface WebhookHeaders {
  readonly event: string | undefined;
  readonly deliveryId: string | undefined;
  readonly signature: string | undefined;
  /** `X-GitHub-Hook-Installation-Target-Type` / `-ID`: `integration` + the app id. */
  readonly targetType: string | undefined;
  readonly targetId: string | undefined;
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

const Account = z.object({ login: z.string(), type: z.string() });

const Repository = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });

const ReleaseEvent = z.object({
  action: z.string(),
  release: z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
  /** `edited`: the previous values of the changed fields. */
  changes: z
    .object({ draft: z.object({ from: z.boolean() }).optional() })
    .loose()
    .optional(),
  repository: Repository,
});
type ReleaseEvent = z.infer<typeof ReleaseEvent>;

const PushEvent = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository: Repository,
});

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * Whether a release event publishes a release (ADR 0019): `published` and `released` do;
 * `edited` only when it turns a draft into a published release. Drafts never deploy;
 * prereleases only for apps with `autoDeployPrereleases` (the caller filters on that).
 * GitHub sends `published` and `released` for the same publication; deployments are deduped
 * per tag.
 */
export function releasePublication(
  event: ReleaseEvent,
): { tag: string; prerelease: boolean } | null {
  if (event.release.draft) return null;
  const publishes =
    event.action === 'published' ||
    event.action === 'released' ||
    (event.action === 'edited' && event.changes?.draft?.from === true);
  return publishes ? { tag: event.release.tag_name, prerelease: event.release.prerelease } : null;
}

/** The branch and commit a push event deploys, or null (tags, deleted branches, bad input). */
export function pushedBranch(event: z.infer<typeof PushEvent>): {
  branch: string;
  commitSha: string;
} | null {
  if (event.deleted || !event.ref.startsWith(BRANCH_REF_PREFIX)) return null;
  const branch = GitRef.safeParse(event.ref.slice(BRANCH_REF_PREFIX.length));
  const commitSha = CommitSha.safeParse(event.after);
  if (!branch.success || !commitSha.success || /^0+$/.test(commitSha.data)) return null;
  return { branch: branch.data, commitSha: commitSha.data };
}

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive(), account: Account.nullish() }),
});

const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;

export function createWebhookHandler(deps: Deps) {
  const logger = deps.logger.child({ component: 'github-webhooks' });
  const actor = systemActor('github-webhook');
  const deployments = createDeploymentsService(deps);

  /** Apps of the connection linked to the event's repository that match `filter`. */
  function appsOf(connection: ConnectionRow, repository: z.infer<typeof Repository>, filter: SQL) {
    return deps.db
      .select()
      .from(apps)
      .where(
        and(
          eq(apps.connectionId, connection.id),
          filter,
          sql`lower(${apps.repoOwner}) = lower(${repository.owner.login})`,
          sql`lower(${apps.repoName}) = lower(${repository.name})`,
        ),
      );
  }

  /**
   * Creates a deployment per app; GitHub or the database failing for any of them makes the
   * delivery fail so GitHub's redelivery retries (apps deployed already are skipped then).
   */
  async function deployEach(
    targets: (typeof apps.$inferSelect)[],
    what: string,
    create: (app: typeof apps.$inferSelect) => Promise<{ id: string } | null>,
  ): Promise<WebhookOutcome> {
    let retry = false;
    for (const app of targets) {
      try {
        const deployment = await create(app);
        if (deployment) {
          logger.info({ appId: app.id, deploymentId: deployment.id }, `${what} auto-deployed`);
        }
      } catch (error) {
        logger.warn(
          { appId: app.id, reason: error instanceof Error ? error.message : 'unknown' },
          `auto-deploy of a ${what} failed`,
        );
        // GitHub or the database failing is worth a redelivery; an unknown ref is not.
        retry ||= !(error instanceof ProblemError) || error.type === 'upstream-failed';
      }
    }
    if (retry) {
      // The handler forgets the delivery, so GitHub's redelivery is not rejected as a duplicate.
      throw new ProblemError('upstream-failed', {
        detail: `Auto-deploying the ${what} failed for at least one app; redeliver to retry`,
      });
    }
    return 'processed';
  }

  async function onRelease(connection: ConnectionRow, payload: unknown): Promise<WebhookOutcome> {
    const event = ReleaseEvent.parse(payload);
    const publication = releasePublication(event);
    if (!publication) return 'ignored';
    const filter = publication.prerelease
      ? and(eq(apps.autoDeployReleases, true), eq(apps.autoDeployPrereleases, true))
      : eq(apps.autoDeployReleases, true);
    const targets = await appsOf(connection, event.repository, filter as SQL);
    return deployEach(targets, 'release', (app) =>
      deployments.createForRelease(app, publication.tag, actor),
    );
  }

  async function onPush(connection: ConnectionRow, payload: unknown): Promise<WebhookOutcome> {
    const event = PushEvent.parse(payload);
    const pushed = pushedBranch(event);
    if (!pushed) return 'ignored';
    const targets = await appsOf(
      connection,
      event.repository,
      eq(apps.autoDeployBranch, pushed.branch),
    );
    if (targets.length === 0) return 'ignored';
    return deployEach(targets, 'push', (app) =>
      deployments.createForPush(app, pushed.branch, pushed.commitSha, actor),
    );
  }

  async function onInstallation(
    connection: ConnectionRow,
    payload: unknown,
  ): Promise<WebhookOutcome> {
    const event = InstallationEvent.parse(payload);
    const installationId = event.installation.id;
    if (event.action === 'deleted') {
      if (connection.installationId !== installationId) return 'ignored';
      await deps.db.transaction(async (tx) => {
        await tx
          .update(githubConnections)
          .set({ installationId: null })
          .where(eq(githubConnections.id, connection.id));
        await recordAudit(tx, actor, {
          action: 'github-connection.uninstall',
          target: { type: 'github-connection', id: connection.id },
          summary: { installationId: { from: installationId, to: null } },
        });
      });
    } else if (event.action === 'created' && connection.installationId === null) {
      const account = event.installation.account;
      await deps.db.transaction(async (tx) => {
        await tx
          .update(githubConnections)
          .set({
            installationId,
            ...(account
              ? {
                  accountLogin: account.login,
                  accountType: account.type === 'Organization' ? 'Organization' : 'User',
                }
              : {}),
          })
          .where(eq(githubConnections.id, connection.id));
        await recordAudit(tx, actor, {
          action: 'github-connection.install',
          target: { type: 'github-connection', id: connection.id },
          summary: { installationId: { from: null, to: installationId } },
        });
      });
    } else {
      logger.info({ connectionId: connection.id, action: event.action }, 'installation event');
      return 'ignored';
    }
    if (connection.appId !== null) forgetInstallationTokens(connection.appId);
    deps.events.publish({ topic: 'github', action: 'updated', resourceId: connection.id });
    return 'processed';
  }

  return {
    /** Verifies, dedupes and handles one delivery. Throws problems for rejected requests. */
    async handle(headers: WebhookHeaders, body: Uint8Array): Promise<WebhookOutcome> {
      const { event, deliveryId } = headers;
      if (!event || !deliveryId || !DELIVERY_ID.test(deliveryId)) {
        throw badRequest('Missing GitHub delivery headers');
      }
      const appId = headers.targetType === 'integration' ? Number(headers.targetId) : Number.NaN;
      const [connection] = Number.isSafeInteger(appId)
        ? await deps.db.select().from(githubConnections).where(eq(githubConnections.appId, appId))
        : [];
      const secret =
        connection?.webhookSecretEncrypted != null
          ? deps.secrets.decrypt(
              connection.webhookSecretEncrypted,
              secretContext.webhookSecret(connection.id),
            )
          : null;
      if (!connection || !secret || !verifyWebhookSignature(secret, body, headers.signature)) {
        logger.warn({ event, deliveryId }, 'rejected a webhook delivery with an invalid signature');
        throw unauthorized('Invalid webhook signature');
      }

      const [fresh] = await deps.db
        .insert(githubWebhookDeliveries)
        .values({ deliveryId, connectionId: connection.id, event })
        .onConflictDoNothing()
        .returning({ deliveryId: githubWebhookDeliveries.deliveryId });
      if (!fresh) return 'duplicate';

      try {
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.from(body).toString('utf8'));
        } catch {
          throw badRequest('The webhook body is not JSON');
        }
        let outcome: WebhookOutcome;
        switch (event) {
          case 'release':
            outcome = await onRelease(connection, payload);
            break;
          case 'push':
            outcome = await onPush(connection, payload);
            break;
          case 'installation':
            outcome = await onInstallation(connection, payload);
            break;
          case 'installation_repositories':
            deps.events.publish({ topic: 'github', action: 'updated', resourceId: connection.id });
            outcome = 'processed';
            break;
          default:
            outcome = 'ignored'; // ping and events Launchway does not subscribe to
        }
        logger.info({ event, deliveryId, connectionId: connection.id, outcome }, 'webhook handled');
        return outcome;
      } catch (error) {
        // Let a redelivery retry what failed.
        await deps.db
          .delete(githubWebhookDeliveries)
          .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
        if (error instanceof z.ZodError) throw badRequest('Unexpected webhook payload');
        throw error;
      }
    },
  };
}
