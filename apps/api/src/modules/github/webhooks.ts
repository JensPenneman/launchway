import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import { forgetInstallationTokens } from '../../lib/git-provider.js';
import { badRequest, unauthorized } from '../../lib/problem.js';
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

const ReleaseEvent = z.object({
  action: z.string(),
  release: z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive(), account: Account.nullish() }),
});

const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;

export function createWebhookHandler(deps: Deps) {
  const logger = deps.logger.child({ component: 'github-webhooks' });
  const actor = systemActor('github-webhook');
  const deployments = createDeploymentsService(deps);

  async function onRelease(connection: ConnectionRow, payload: unknown): Promise<WebhookOutcome> {
    const event = ReleaseEvent.parse(payload);
    if (event.action !== 'published' || event.release.draft || event.release.prerelease) {
      return 'ignored';
    }
    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    const targets = await deps.db
      .select()
      .from(apps)
      .where(
        and(
          eq(apps.connectionId, connection.id),
          eq(apps.autoDeployReleases, true),
          sql`lower(${apps.repoOwner}) = lower(${owner})`,
          sql`lower(${apps.repoName}) = lower(${repo})`,
        ),
      );
    for (const app of targets) {
      try {
        const deployment = await deployments.createForRelease(app, event.release.tag_name, actor);
        if (deployment) {
          logger.info({ appId: app.id, deploymentId: deployment.id }, 'release auto-deployed');
        }
      } catch (error) {
        logger.warn(
          { appId: app.id, reason: error instanceof Error ? error.message : 'unknown' },
          'auto-deploy of a release failed',
        );
      }
    }
    return 'processed';
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
          case 'installation':
            outcome = await onInstallation(connection, payload);
            break;
          case 'installation_repositories':
            deps.events.publish({ topic: 'github', action: 'updated', resourceId: connection.id });
            outcome = 'processed';
            break;
          default:
            outcome = 'ignored'; // ping and events Slipway does not subscribe to
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
