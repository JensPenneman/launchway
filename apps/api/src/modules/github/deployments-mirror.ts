import {
  type AppId,
  type DeploymentId,
  type DeploymentStatus,
  isInProgressStatus,
  type PlatformEvent,
  PRODUCTION_ENVIRONMENT,
  type PreviewId,
} from '@launchway/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { forgetInstallationTokens } from '../../lib/git-provider.js';
import { apps } from '../apps/schema.js';
import { recordGitHubDeploymentId } from '../deployments/model.js';
import { deployments } from '../deployments/schema.js';
import { domains } from '../domains/schema.js';
import { previews } from '../previews/schema.js';
import { routes } from '../routes/schema.js';
import { createSettingsService } from '../settings/service.js';
import {
  connectionOctokit,
  errorStatus,
  isRateLimited,
  type OctokitLike,
  requestWithRetry,
} from './octokit.js';
import type { ConnectionRow } from './providers.js';
import { githubConnections } from './schema.js';
import { DENIAL_LOG_INTERVAL_MS, githubConnectionState } from './state.js';

/** States of a GitHub deployment status that Launchway posts. */
export type GitHubDeploymentState = 'in_progress' | 'success' | 'failure' | 'inactive' | 'error';

/**
 * Launchway status -> GitHub deployment status. `queued` posts nothing: a new GitHub deployment
 * is `pending` until the first status arrives.
 */
export function githubDeploymentState(status: DeploymentStatus): GitHubDeploymentState | null {
  switch (status) {
    case 'queued':
      return null;
    case 'cloning':
    case 'building':
    case 'starting':
      return 'in_progress';
    case 'running':
      return 'success';
    case 'failed':
      return 'failure';
    case 'superseded':
    case 'stopped':
      return 'inactive';
    case 'cancelled':
      return 'error';
  }
}

const PREVIEW_ENVIRONMENT_PREFIX = 'preview/';

/** GitHub environment of a deployment: `production`, or `preview/pr-<n>` for previews. */
export function githubEnvironment(environmentName: string | null | undefined) {
  const environment = environmentName?.trim() || PRODUCTION_ENVIRONMENT;
  const preview = environment.startsWith(PREVIEW_ENVIRONMENT_PREFIX);
  return {
    environment,
    transientEnvironment: preview,
    productionEnvironment: environment === PRODUCTION_ENVIRONMENT,
  };
}

/** Everything one mirror step needs about a deployment, loaded fresh for every step. */
export interface MirrorSnapshot {
  readonly deployment: {
    readonly id: DeploymentId;
    readonly appId: AppId;
    readonly commitSha: string;
    readonly status: DeploymentStatus;
    readonly statusMessage: string | null;
    readonly githubDeploymentId: number | null;
    /** `production`, or `preview/pr-<n>` for previews; null is treated as production. */
    readonly environmentName: string | null;
  };
  readonly app: {
    readonly repoOwner: string;
    readonly repoName: string;
    readonly githubDeployments: boolean;
  };
  readonly connection: ConnectionRow;
  /** `https://<first route hostname>` of the app, when it has a route. */
  readonly environmentUrl: string | null;
  /** Platform public URL (origin), for `log_url`. */
  readonly publicUrl: string | null;
}

export interface MirrorStore {
  load(id: DeploymentId): Promise<MirrorSnapshot | null>;
  saveGitHubDeploymentId(id: DeploymentId, githubDeploymentId: number): Promise<void>;
}

export function createDbMirrorStore(deps: Pick<Deps, 'db' | 'config' | 'events'>): MirrorStore {
  const settings = createSettingsService(deps);

  /** A preview's own host, or the hostname of the app's oldest production route. */
  async function environmentUrlOf(
    appId: AppId,
    previewId: PreviewId | null,
  ): Promise<string | null> {
    if (previewId) {
      const [preview] = await deps.db
        .select({ hostname: previews.hostname })
        .from(previews)
        .where(eq(previews.id, previewId));
      return preview ? `https://${preview.hostname}` : null;
    }
    const [route] = await deps.db
      .select({ hostname: domains.hostname })
      .from(routes)
      .innerJoin(domains, eq(domains.id, routes.domainId))
      .leftJoin(previews, eq(previews.routeId, routes.id))
      .where(and(eq(routes.appId, appId), eq(routes.targetKind, 'app'), isNull(previews.id)))
      .orderBy(asc(routes.createdAt), asc(routes.id))
      .limit(1);
    return route ? `https://${route.hostname}` : null;
  }

  return {
    async load(id) {
      const [row] = await deps.db
        .select({ deployment: deployments, app: apps, connection: githubConnections })
        .from(deployments)
        .innerJoin(apps, eq(apps.id, deployments.appId))
        .innerJoin(githubConnections, eq(githubConnections.id, apps.connectionId))
        .where(eq(deployments.id, id));
      if (!row) return null;
      const environmentUrl = await environmentUrlOf(row.deployment.appId, row.deployment.previewId);
      return {
        deployment: {
          id: row.deployment.id,
          appId: row.deployment.appId,
          commitSha: row.deployment.commitSha,
          status: row.deployment.status,
          statusMessage: row.deployment.statusMessage,
          githubDeploymentId: row.deployment.githubDeploymentId,
          environmentName: row.deployment.environmentName,
        },
        app: {
          repoOwner: row.app.repoOwner,
          repoName: row.app.repoName,
          githubDeployments: row.app.githubDeployments,
        },
        connection: row.connection,
        environmentUrl,
        publicUrl: (await settings.get()).effectivePublicUrl,
      };
    },
    async saveGitHubDeploymentId(id, githubDeploymentId) {
      await recordGitHubDeploymentId(deps.db, id, githubDeploymentId);
    },
  };
}

export type MirrorOutcome =
  /** Nothing to do: opted out, unknown deployment, not mirrored and no longer in progress. */
  | 'skipped'
  /** The GitHub deployment was created (and the current status posted, if any). */
  | 'created'
  /** A status was posted to the existing GitHub deployment. */
  | 'updated'
  /** GitHub already shows the current state. */
  | 'unchanged'
  /** GitHub refused (missing permission or repository access); see the capability hint. */
  | 'denied'
  /** Any other failure (logged); a later status change tries again. */
  | 'failed';

export interface MirrorOptions {
  readonly store?: MirrorStore;
  /** Client acting as the connection; null when it cannot act (app not installed). */
  readonly octokitFor?: (connection: ConnectionRow) => Promise<OctokitLike | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** After a refusal, new GitHub deployments of the connection are not attempted for this long. */
export const DENIAL_PAUSE_MS = 5 * 60 * 1000;
/** Cached installation tokens are dropped after a refusal at most this often. */
const TOKEN_FORGET_INTERVAL_MS = 5 * 60 * 1000;
/** Bound of the "last posted state" memory. */
const MAX_REMEMBERED = 2000;
const DESCRIPTION_MAX = 140;

const CreatedDeployment = z.object({ id: z.number().int().positive() });

const STATE_DESCRIPTIONS: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  cloning: 'Cloning the repository',
  building: 'Building',
  starting: 'Starting',
  running: 'Running',
  superseded: 'Superseded by a newer deployment',
  stopped: 'Stopped',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function statusDescription(status: DeploymentStatus, message: string | null): string {
  const base = STATE_DESCRIPTIONS[status];
  const text = status === 'failed' && message ? `${base}: ${message}` : base;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 3)}...` : text;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

interface QueueEntry {
  again: boolean;
  created: boolean;
  done: Promise<void>;
}

class MirrorDenied extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`GitHub refused the request (${status})`);
    this.status = status;
  }
}

/**
 * Mirrors Launchway deployments to GitHub's Deployments API (ADR 0017), driven by the
 * `deployments` change events. Best effort: failures are logged and never touch the Launchway
 * deployment. Steps of one deployment run one at a time and coalesce, and each step reads the
 * current state, so GitHub converges on the latest status even when events arrive in bursts.
 */
export function createDeploymentsMirror(
  deps: Pick<Deps, 'db' | 'config' | 'events' | 'logger' | 'secrets' | 'lifecycle'>,
  options: MirrorOptions = {},
) {
  const logger = deps.logger.child({ component: 'github-deployments-mirror' });
  const store = options.store ?? createDbMirrorStore(deps);
  const octokitFor = options.octokitFor ?? ((row) => connectionOctokit(deps, row));
  const retry = { sleep: options.sleep ?? defaultSleep, now: options.now ?? Date.now };
  const now = retry.now;
  const shared = githubConnectionState(deps.events);
  /** Last GitHub state posted per deployment, so repeated events post nothing. */
  const posted = new Map<DeploymentId, GitHubDeploymentState>();
  const queues = new Map<DeploymentId, QueueEntry>();

  function remember(id: DeploymentId, state: GitHubDeploymentState) {
    posted.delete(id);
    posted.set(id, state);
    if (posted.size > MAX_REMEMBERED) {
      const oldest = posted.keys().next().value;
      if (oldest !== undefined) posted.delete(oldest);
    }
  }

  function onDenied(connection: ConnectionRow, status: number) {
    const at = now();
    shared.denials.set(connection.id, { at, status });
    // The capability hint must reflect the refusal on its next read.
    shared.capabilities.delete(connection.id);
    if (connection.appId !== null) {
      const forgotten = shared.tokensForgottenAt.get(connection.appId) ?? 0;
      // Installation tokens carry the permissions of their creation; a fresh one picks up a
      // permission the owner approved in the meantime.
      if (at - forgotten >= TOKEN_FORGET_INTERVAL_MS) {
        shared.tokensForgottenAt.set(connection.appId, at);
        forgetInstallationTokens(connection.appId);
      }
    }
    const announced = shared.denialAnnouncedAt.get(connection.id);
    if (announced !== undefined && at - announced < DENIAL_LOG_INTERVAL_MS) return;
    shared.denialAnnouncedAt.set(connection.id, at);
    logger.warn(
      { connectionId: connection.id, status },
      'GitHub refused to record deployments for this connection; grant "deployments: write" (see the connection capabilities)',
    );
    deps.events.publish({
      topic: 'github',
      action: 'updated',
      resourceId: connection.id,
      data: { capabilities: true },
    });
  }

  function onAccepted(connection: ConnectionRow) {
    if (shared.denials.delete(connection.id)) {
      shared.denialAnnouncedAt.delete(connection.id);
      shared.capabilities.delete(connection.id);
    }
  }

  async function call(
    client: OctokitLike,
    connection: ConnectionRow,
    route: string,
    params: Record<string, unknown>,
  ) {
    try {
      const response = await requestWithRetry(client, route, params, retry);
      onAccepted(connection);
      return response;
    } catch (error) {
      const status = errorStatus(error);
      if ((status === 401 || status === 403 || status === 404) && !isRateLimited(error)) {
        throw new MirrorDenied(status);
      }
      throw error;
    }
  }

  async function sync(id: DeploymentId, created: boolean): Promise<MirrorOutcome> {
    const snapshot = await store.load(id);
    if (!snapshot?.app.githubDeployments) return 'skipped';
    const { deployment, app, connection } = snapshot;
    const repo = { owner: app.repoOwner, repo: app.repoName };
    const target = githubDeploymentState(deployment.status);
    let githubId = deployment.githubDeploymentId;
    let outcome: MirrorOutcome = 'updated';

    try {
      if (githubId === null) {
        // Deployments from before the mirror (or the opt-in) are not backfilled.
        if (!created && !isInProgressStatus(deployment.status)) return 'skipped';
        const denial = shared.denials.get(connection.id);
        if (denial && now() - denial.at < DENIAL_PAUSE_MS) return 'denied';
        const client = await octokitFor(connection);
        if (!client) return 'skipped';
        const env = githubEnvironment(deployment.environmentName);
        const response = await call(client, connection, 'POST /repos/{owner}/{repo}/deployments', {
          ...repo,
          ref: deployment.commitSha,
          task: 'deploy',
          auto_merge: false,
          required_contexts: [],
          environment: env.environment,
          transient_environment: env.transientEnvironment,
          production_environment: env.productionEnvironment,
          description: `Launchway deployment ${deployment.id}`,
          payload: { launchway: { deploymentId: deployment.id, appId: deployment.appId } },
        });
        const parsed = CreatedDeployment.safeParse(response.data);
        if (!parsed.success) {
          logger.warn(
            { deploymentId: id, status: response.status },
            'GitHub did not create a deployment',
          );
          return 'failed';
        }
        githubId = parsed.data.id;
        await store.saveGitHubDeploymentId(id, githubId);
        posted.delete(id);
        outcome = 'created';
        logger.info(
          { deploymentId: id, githubDeploymentId: githubId },
          'GitHub deployment created',
        );
      }

      if (target === null || posted.get(id) === target) {
        return outcome === 'created' ? outcome : 'unchanged';
      }
      const client = await octokitFor(connection);
      if (!client) return 'skipped';
      const logUrl = snapshot.publicUrl
        ? `${snapshot.publicUrl}/apps/${deployment.appId}?deployment=${deployment.id}`
        : undefined;
      try {
        await call(
          client,
          connection,
          'POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
          {
            ...repo,
            deployment_id: githubId,
            state: target,
            description: statusDescription(deployment.status, deployment.statusMessage),
            ...(logUrl ? { log_url: logUrl } : {}),
            ...(target === 'success' && snapshot.environmentUrl
              ? { environment_url: snapshot.environmentUrl }
              : {}),
          },
        );
      } catch (error) {
        // The GitHub deployment was deleted there: nothing left to update.
        if (error instanceof MirrorDenied && error.status === 404) {
          logger.info({ deploymentId: id, githubDeploymentId: githubId }, 'GitHub deployment gone');
          remember(id, target);
          return 'skipped';
        }
        throw error;
      }
      remember(id, target);
      return outcome;
    } catch (error) {
      if (error instanceof MirrorDenied) {
        onDenied(connection, error.status);
        return 'denied';
      }
      logger.warn(
        {
          deploymentId: id,
          status: errorStatus(error),
          rateLimited: isRateLimited(error),
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'mirroring a deployment to GitHub failed',
      );
      return 'failed';
    }
  }

  /** Runs `sync` for a deployment after its previous step; queued steps coalesce into one. */
  function schedule(id: DeploymentId, created: boolean): Promise<void> {
    const queued = queues.get(id);
    if (queued) {
      queued.again = true;
      queued.created ||= created;
      return queued.done;
    }
    const entry: QueueEntry = { again: true, created, done: Promise.resolve() };
    queues.set(id, entry);
    entry.done = (async () => {
      // Let the caller finish registering before the first step reads the state.
      await Promise.resolve();
      try {
        while (entry.again) {
          entry.again = false;
          const wasCreated = entry.created;
          entry.created = false;
          try {
            await sync(id, wasCreated);
          } catch (error) {
            logger.warn({ err: error, deploymentId: id }, 'deployment mirror step failed');
          }
        }
      } finally {
        queues.delete(id);
      }
    })();
    return entry.done;
  }

  function onEvent(event: PlatformEvent): void {
    if (event.topic !== 'deployments' || !event.resourceId?.startsWith('dep_')) return;
    if (event.action === 'deleted') return;
    // Service health updates carry no status; they cannot change what GitHub shows.
    if (event.action === 'updated' && event.data && !('status' in event.data)) return;
    void schedule(event.resourceId as DeploymentId, event.action === 'created');
  }

  return {
    sync,
    schedule,
    onEvent,
    /** Resolves when every queued step finished (tests, shutdown). */
    async idle(): Promise<void> {
      while (queues.size > 0) {
        await Promise.all([...queues.values()].map((entry) => entry.done));
      }
    },
    /** Subscribes to the change feed until shutdown; returns the unsubscribe function. */
    start(): () => void {
      const unsubscribe = deps.events.subscribe(onEvent);
      deps.lifecycle.signal.addEventListener('abort', unsubscribe, { once: true });
      return unsubscribe;
    },
  };
}

/** Starts mirroring deployments to GitHub (composition root). */
export function startDeploymentsMirror(deps: Deps): () => void {
  return createDeploymentsMirror(deps).start();
}
