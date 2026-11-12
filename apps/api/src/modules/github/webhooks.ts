import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type AppPreviewSettings,
  CommitSha,
  DEFAULT_APP_PREVIEW_SETTINGS,
  GitRef,
  TreeSha,
} from '@launchway/contracts';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { systemActor } from '../../lib/auth-context.js';
import { forgetInstallationTokens } from '../../lib/git-provider.js';
import { badRequest, ProblemError, unauthorized } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { createAutomationService } from '../automation/service.js';
import { checksSettingsOf } from '../checks/model.js';
import { type CommitTarget, createChecksService } from '../checks/service.js';
import { type CheckEvent, checkTrigger, isBot } from '../checks/trigger.js';
import { createDeploymentsService } from '../deployments/service.js';
import { createPreviewsService } from '../previews/service.js';
import type { ConnectionRow } from './providers.js';
import { secretContext } from './providers.js';
import { githubConnections, githubWebhookDeliveries } from './schema.js';
import { resetConnectionState } from './state.js';

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

const Label = z.object({ name: z.string() });

const Repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  /** Checks of the default branch are never cancelled by a closed pull request. */
  default_branch: z.string().nullish(),
});

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
  /** The commit the branch pointed at before the push (the deleted head for deletions). */
  before: z.string().optional(),
  after: z.string(),
  deleted: z.boolean().optional(),
  /** The pushed head commit; `tree_id` is its tree (same-tree copies of the checks). */
  head_commit: z.object({ id: z.string(), tree_id: z.string() }).nullish(),
  /** Who pushed (skipBots of the checks). */
  sender: Account.nullish(),
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

/** The branch a push event deletes and the commit it pointed at, or null for other pushes. */
export function deletedBranch(
  event: z.infer<typeof PushEvent>,
): { name: string; headSha: string } | null {
  if (!event.deleted || !event.ref.startsWith(BRANCH_REF_PREFIX)) return null;
  const name = GitRef.safeParse(event.ref.slice(BRANCH_REF_PREFIX.length));
  const headSha = CommitSha.safeParse(event.before);
  if (!name.success || !headSha.success || /^0+$/.test(headSha.data)) return null;
  return { name: name.data, headSha: headSha.data };
}

/**
 * The branch and commit a push event deploys, or null (tags, deleted branches, bad input), with
 * the commit's tree when the event's head commit is that commit.
 */
export function pushedBranch(event: z.infer<typeof PushEvent>): {
  branch: string;
  commitSha: string;
  treeSha: string | undefined;
} | null {
  if (event.deleted || !event.ref.startsWith(BRANCH_REF_PREFIX)) return null;
  const branch = GitRef.safeParse(event.ref.slice(BRANCH_REF_PREFIX.length));
  const commitSha = CommitSha.safeParse(event.after);
  if (!branch.success || !commitSha.success || /^0+$/.test(commitSha.data)) return null;
  const head = event.head_commit;
  const tree = head?.id === commitSha.data ? TreeSha.safeParse(head.tree_id) : null;
  return {
    branch: branch.data,
    commitSha: commitSha.data,
    treeSha: tree?.success ? tree.data : undefined,
  };
}

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  /** `labeled` / `unlabeled`: the label added or removed. */
  label: Label.nullish(),
  pull_request: z.object({
    title: z.string(),
    state: z.string().optional(),
    merged: z.boolean().nullish(),
    /** When it was closed: runs queued later (a reopen delivered first) are not cancelled. */
    closed_at: z.string().nullish(),
    user: Account.nullish(),
    labels: z.array(Label).nullish(),
    head: z.object({
      ref: z.string(),
      sha: z.string().regex(/^[0-9a-f]{40}$/),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
    /** `ref`: the branch the pull request merges into (the branch filter of the checks). */
    base: z.object({ ref: z.string().optional(), repo: z.object({ full_name: z.string() }) }),
  }),
  repository: Repository,
});

type PullRequestEvent = z.infer<typeof PullRequestEvent>;

/** `pull_request` actions that open or update a preview; `closed` removes it. */
const PREVIEW_UPDATE_ACTIONS: ReadonlySet<string> = new Set(['opened', 'reopened', 'synchronize']);

/** Actions that can change a preview; `labeled` / `unlabeled` only with a required label. */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  ...PREVIEW_UPDATE_ACTIONS,
  'closed',
  'labeled',
  'unlabeled',
]);

/** What a `pull_request` event does to the preview of one app; `reason` explains a skip. */
type PreviewAction =
  | { readonly kind: 'open' | 'close' }
  | { readonly kind: 'ignore'; readonly reason?: string };

/** `pull_request` actions that run the checks of the head commit. */
const CHECK_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'opened',
  'reopened',
  'synchronize',
]);

/** Actions only the automation looks at: a changed base, draft state, or a closed pull request. */
const AUTOMATION_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'edited',
  'converted_to_draft',
  'ready_for_review',
]);

/**
 * What a `pull_request` event means for the preview of an app with these settings. `opened`,
 * `reopened`, `synchronize` and gaining the required label open or update it, unless previews
 * are off, the author is a bot (`skipBots`) or the pull request lacks the required label (any
 * case, like GitHub). `closed` and losing the required label close it. Other actions and labels
 * change nothing. The manual `POST /apps/{id}/previews` applies no filters.
 */
export function pullRequestPreviewAction(
  event: PullRequestEvent,
  settings: Pick<AppPreviewSettings, 'enabled' | 'skipBots' | 'requireLabel'>,
): PreviewAction {
  const required = settings.requireLabel?.toLowerCase() ?? null;
  const isRequired = (label: { name: string } | null | undefined) =>
    required !== null && label?.name.toLowerCase() === required;
  const pr = event.pull_request;
  const labeled = event.action === 'labeled';
  if (event.action === 'closed') return { kind: 'close' };
  if (event.action === 'unlabeled') {
    return isRequired(event.label) ? { kind: 'close' } : { kind: 'ignore' };
  }
  if (
    labeled
      ? !isRequired(event.label) || pr.state === 'closed'
      : !PREVIEW_UPDATE_ACTIONS.has(event.action)
  ) {
    return { kind: 'ignore' };
  }
  if (!settings.enabled) return { kind: 'ignore', reason: 'previews are off for the app' };
  if (settings.skipBots && isBot(pr.user)) {
    return { kind: 'ignore', reason: `opened by the bot ${pr.user?.login}` };
  }
  if (required !== null && !labeled && !(pr.labels ?? []).some(isRequired)) {
    return { kind: 'ignore', reason: `lacks the label ${settings.requireLabel}` };
  }
  return { kind: 'open' };
}

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive(), account: Account.nullish() }),
});

const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;

type AppRow = typeof apps.$inferSelect;

/** GitHub or the database failing is worth a redelivery; configuration problems are not. */
function needsRedelivery(error: unknown): boolean {
  return !(error instanceof ProblemError) || error.type === 'upstream-failed';
}

function redeliver(detail: string): ProblemError {
  // The handler forgets the delivery, so GitHub's redelivery is not rejected as a duplicate.
  return new ProblemError('upstream-failed', { detail });
}

export function createWebhookHandler(deps: Deps) {
  const logger = deps.logger.child({ component: 'github-webhooks' });
  const actor = systemActor('github-webhook');
  const deployments = createDeploymentsService(deps);
  const previews = createPreviewsService(deps, { deployments });
  const checks = createChecksService(deps);
  const automation = createAutomationService(deps);

  /** Apps with checks turned on; only they log why an event runs no checks. */
  const checksOn = sql`${apps.checks}->>'enabled' = 'true'`;

  /**
   * Queues the checks of a pushed commit or a pull request head for each app whose settings let
   * the event run them (`checkTrigger`). `handled` when any app took it; `retry` when queueing
   * failed in a way a redelivery may fix (queueing dedupes per commit, so redelivering is safe).
   */
  async function queueChecks(
    targets: readonly AppRow[],
    commit: CommitTarget,
    event: CheckEvent,
  ): Promise<{ handled: boolean; retry: boolean }> {
    let handled = false;
    let retry = false;
    for (const app of targets) {
      const decision = checkTrigger(checksSettingsOf(app), event);
      if (!decision.run) {
        logger.info(
          {
            appId: app.id,
            trigger: commit.trigger,
            commitSha: commit.sha,
            ...(commit.prNumber === null ? {} : { prNumber: commit.prNumber }),
            reason: decision.reason,
          },
          'event runs no checks for the app',
        );
        continue;
      }
      handled = true;
      try {
        const runs = await checks.queueForCommit(app, commit, actor);
        logger.info(
          { appId: app.id, trigger: commit.trigger, commitSha: commit.sha, queued: runs.length },
          runs.length > 0 ? 'checks queued' : 'checks ran for this commit already',
        );
      } catch (error) {
        logger.warn(
          { appId: app.id, reason: error instanceof Error ? error.message : 'unknown' },
          'queueing checks failed',
        );
        retry ||= needsRedelivery(error);
      }
    }
    return { handled, retry };
  }

  /**
   * Pull requests from branches of the repository open, update and close previews as far as each
   * app's filters let them (`pullRequestPreviewAction`). Pull requests from forks are ignored:
   * their code is not trusted with the app's environment.
   */
  async function onPullRequest(
    connection: ConnectionRow,
    payload: unknown,
  ): Promise<WebhookOutcome> {
    const event = PullRequestEvent.parse(payload);
    // Forks never get here: neither previews nor checks run code from forks.
    if (!PULL_REQUEST_ACTIONS.has(event.action) && !AUTOMATION_ONLY_ACTIONS.has(event.action)) {
      return 'ignored';
    }
    const pr = event.pull_request;
    const head = pr.head.repo?.full_name.toLowerCase() ?? null;
    if (head !== pr.base.repo.full_name.toLowerCase()) {
      logger.info(
        { connectionId: connection.id, prNumber: event.number, action: event.action },
        'ignoring a pull request from a fork',
      );
      return 'ignored';
    }
    const targets = await appsOf(connection, event.repository);
    // The automation classifies a Dependabot head before any check is queued for it (plan §3.3).
    const automated = await automateDependabot(connection, event, targets);
    if (AUTOMATION_ONLY_ACTIONS.has(event.action)) {
      if (automated.retry) {
        throw redeliver('The automation could not record the pull request; redeliver to retry');
      }
      return automated.held.size > 0 ? 'processed' : 'ignored';
    }
    let retry = false;
    let handled = false;
    for (const app of targets) {
      const action = pullRequestPreviewAction(event, {
        ...DEFAULT_APP_PREVIEW_SETTINGS,
        ...app.previews,
      });
      if (action.kind === 'ignore') {
        if (action.reason) {
          logger.info(
            { appId: app.id, prNumber: event.number, action: event.action, reason: action.reason },
            'pull request ignored for previews',
          );
        }
        continue;
      }
      const closing = action.kind === 'close';
      try {
        const preview = closing
          ? await previews.closeForPullRequest(app, event.number, actor)
          : await previews.openFromPullRequest(
              app,
              { number: event.number, title: pr.title, branch: pr.head.ref, headSha: pr.head.sha },
              actor,
            );
        if (preview) {
          handled = true;
          logger.info(
            {
              appId: app.id,
              previewId: preview.id,
              action: event.action,
              merged: pr.merged ?? false,
            },
            closing ? 'preview closed' : 'preview deployed',
          );
        }
      } catch (error) {
        logger.warn(
          {
            appId: app.id,
            prNumber: event.number,
            reason: error instanceof Error ? error.message : 'unknown',
          },
          'handling a pull request for a preview failed',
        );
        retry ||= needsRedelivery(error);
      }
    }
    const checked =
      event.action === 'closed'
        ? await closedPullRequestChecks(event, targets)
        : await pullRequestChecks(
            event,
            targets.filter((app) => !automated.held.has(app.id)),
          );
    if (automated.retry) {
      throw redeliver('The automation could not record the pull request; redeliver to retry');
    }
    if (retry) {
      throw redeliver('Updating a preview failed for at least one app; redeliver to retry');
    }
    if (checked.retry) {
      throw redeliver(
        'Updating the checks of a pull request failed for at least one app; redeliver to retry',
      );
    }
    return handled || checked.handled ? 'processed' : 'ignored';
  }

  /** The checks a `pull_request` event would queue for the app, or null when it runs none. */
  function pullCheckTarget(event: PullRequestEvent, app: AppRow): CommitTarget | null {
    if (!CHECK_PULL_REQUEST_ACTIONS.has(event.action) || !checksSettingsOf(app).enabled) {
      return null;
    }
    const pr = event.pull_request;
    const head = GitRef.safeParse(pr.head.ref);
    if (!head.success) return null;
    const decision = checkTrigger(checksSettingsOf(app), {
      kind: 'pull_request',
      baseBranch: pr.base.ref ?? null,
      author: pr.user,
    });
    return decision.run
      ? { sha: pr.head.sha, ref: head.data, prNumber: event.number, trigger: 'pull_request' }
      : null;
  }

  /**
   * A `dependabot/*` head's events (opened, reopened, synchronize, a changed base or draft state,
   * closed): the automation records the head and its held checks and returns; it classifies in the
   * background and queues the held checks itself once the head is recorded (the 2-minute
   * reconcile does so when that failed). Apps it holds checks for get none from this handler.
   */
  async function automateDependabot(
    connection: ConnectionRow,
    event: PullRequestEvent,
    targets: readonly AppRow[],
  ): Promise<{ held: Set<AppRow['id']>; retry: boolean }> {
    const held = new Set<AppRow['id']>();
    let retry = false;
    if (
      !(
        CHECK_PULL_REQUEST_ACTIONS.has(event.action) ||
        AUTOMATION_ONLY_ACTIONS.has(event.action) ||
        event.action === 'closed'
      ) ||
      !event.pull_request.head.ref.startsWith('dependabot/')
    ) {
      return { held, retry };
    }
    for (const app of targets) {
      try {
        const result = await automation.onPullRequest(
          app,
          connection,
          event.number,
          event.pull_request.head.sha,
          pullCheckTarget(event, app),
        );
        if (result.held) held.add(app.id);
      } catch (error) {
        logger.warn(
          {
            appId: app.id,
            prNumber: event.number,
            reason: error instanceof Error ? error.message : 'unknown',
          },
          'the automation could not record a pull request; its checks are not queued',
        );
        // Not recorded: the checks stay unqueued here, and the redelivery tries again.
        held.add(app.id);
        retry ||= needsRedelivery(error);
      }
    }
    return { held, retry };
  }

  /** `opened`, `reopened` and `synchronize` run the checks of the head commit. */
  function pullRequestChecks(event: PullRequestEvent, targets: readonly AppRow[]) {
    const none = Promise.resolve({ handled: false, retry: false });
    if (!CHECK_PULL_REQUEST_ACTIONS.has(event.action)) return none;
    const pr = event.pull_request;
    const enabled = targets.filter((app) => checksSettingsOf(app).enabled);
    if (enabled.length === 0) return none;
    const head = GitRef.safeParse(pr.head.ref);
    if (!head.success) {
      logger.info({ prNumber: event.number }, 'the head branch of the pull request runs no checks');
      return none;
    }
    return queueChecks(
      enabled,
      { sha: pr.head.sha, ref: head.data, prNumber: event.number, trigger: 'pull_request' },
      { kind: 'pull_request', baseBranch: pr.base.ref ?? null, author: pr.user },
    );
  }

  /**
   * A closed or merged pull request cancels its queued checks in every app of the repository
   * (the apps the delivery's connection links to the event's repository, so a delivery of one
   * repository never touches the runs of another). Runs also serving a push stay.
   */
  async function closedPullRequestChecks(event: PullRequestEvent, targets: readonly AppRow[]) {
    const head = GitRef.safeParse(event.pull_request.head.ref);
    let handled = false;
    let retry = false;
    if (!head.success) return { handled, retry };
    const closedAt = event.pull_request.closed_at ? new Date(event.pull_request.closed_at) : null;
    const pr = {
      number: event.number,
      headRef: head.data,
      merged: event.pull_request.merged === true,
      closedAt: closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : new Date(),
      defaultBranch: event.repository.default_branch ?? null,
    };
    for (const app of targets) {
      try {
        const cancelled = await checks.closePullRequest(app, pr, actor);
        handled ||= cancelled.length > 0;
      } catch (error) {
        logger.warn(
          {
            appId: app.id,
            prNumber: event.number,
            reason: error instanceof Error ? error.message : 'unknown',
          },
          'cancelling the checks of a closed pull request failed',
        );
        retry ||= needsRedelivery(error);
      }
    }
    return { handled, retry };
  }

  /** Apps of the connection linked to the event's repository (case-insensitive, like GitHub). */
  function appsOf(connection: ConnectionRow, repository: z.infer<typeof Repository>, filter?: SQL) {
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
    targets: AppRow[],
    what: string,
    create: (app: AppRow) => Promise<{ id: string } | null>,
  ): Promise<{ retry: boolean }> {
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
        retry ||= needsRedelivery(error);
      }
    }
    return { retry };
  }

  const deployFailed = (what: string) =>
    redeliver(`Auto-deploying the ${what} failed for at least one app; redeliver to retry`);

  async function onRelease(connection: ConnectionRow, payload: unknown): Promise<WebhookOutcome> {
    const event = ReleaseEvent.parse(payload);
    const publication = releasePublication(event);
    if (!publication) return 'ignored';
    const filter = publication.prerelease
      ? and(eq(apps.autoDeployReleases, true), eq(apps.autoDeployPrereleases, true))
      : eq(apps.autoDeployReleases, true);
    const targets = await appsOf(connection, event.repository, filter as SQL);
    const { retry } = await deployEach(targets, 'release', (app) =>
      deployments.createForRelease(app, publication.tag, actor),
    );
    if (retry) throw deployFailed('release');
    return 'processed';
  }

  /** A deleted branch cancels its queued checks in every app of the repository. */
  async function onBranchDeleted(
    connection: ConnectionRow,
    event: z.infer<typeof PushEvent>,
    branch: { name: string; headSha: string },
  ): Promise<WebhookOutcome> {
    const targets = await appsOf(connection, event.repository);
    let handled = false;
    let retry = false;
    for (const app of targets) {
      try {
        const cancelled = await checks.closeBranch(
          app,
          { ...branch, defaultBranch: event.repository.default_branch ?? null },
          actor,
        );
        handled ||= cancelled.length > 0;
      } catch (error) {
        logger.warn(
          {
            appId: app.id,
            branch: branch.name,
            reason: error instanceof Error ? error.message : 'unknown',
          },
          'cancelling the checks of a deleted branch failed',
        );
        retry ||= needsRedelivery(error);
      }
    }
    if (retry) {
      throw redeliver(
        'Cancelling the checks of a deleted branch failed for at least one app; redeliver to retry',
      );
    }
    return handled ? 'processed' : 'ignored';
  }

  /** Pushes to a branch auto-deploy (`autoDeployBranch`) and run the checks of the commit. */
  async function onPush(connection: ConnectionRow, payload: unknown): Promise<WebhookOutcome> {
    const event = PushEvent.parse(payload);
    const deleted = deletedBranch(event);
    if (deleted) return onBranchDeleted(connection, event, deleted);
    const pushed = pushedBranch(event);
    if (!pushed) return 'ignored';
    const deployTargets = await appsOf(
      connection,
      event.repository,
      eq(apps.autoDeployBranch, pushed.branch),
    );
    const checkTargets = await appsOf(connection, event.repository, checksOn);
    if (deployTargets.length === 0 && checkTargets.length === 0) return 'ignored';
    const deployed =
      deployTargets.length === 0
        ? { retry: false }
        : await deployEach(deployTargets, 'push', (app) =>
            deployments.createForPush(app, pushed.branch, pushed.commitSha, actor),
          );
    // A push to a `dependabot/*` branch is held for the automation, which queues its checks once
    // the head is recorded; a head without a pull request yet waits for its `opened` event.
    const classified: AppRow[] = [];
    let automationRetry = false;
    const pushTarget: CommitTarget = {
      sha: pushed.commitSha,
      ref: pushed.branch,
      prNumber: null,
      trigger: 'push',
      ...(pushed.treeSha === undefined ? {} : { treeSha: pushed.treeSha }),
    };
    for (const app of checkTargets) {
      try {
        const run = checkTrigger(checksSettingsOf(app), {
          kind: 'push',
          branch: pushed.branch,
          sender: event.sender,
        }).run;
        const { held } = await automation.onPush(
          app,
          connection,
          pushed.branch,
          pushed.commitSha,
          run ? pushTarget : null,
        );
        if (!held) classified.push(app);
      } catch (error) {
        logger.warn(
          {
            appId: app.id,
            branch: pushed.branch,
            reason: error instanceof Error ? error.message : 'unknown',
          },
          'the automation failed for a push; its checks are not queued',
        );
        automationRetry ||= needsRedelivery(error);
      }
    }
    const checked = await queueChecks(
      classified,
      {
        sha: pushed.commitSha,
        ref: pushed.branch,
        prNumber: null,
        trigger: 'push',
        ...(pushed.treeSha === undefined ? {} : { treeSha: pushed.treeSha }),
      },
      { kind: 'push', branch: pushed.branch, sender: event.sender },
    );
    if (deployed.retry) throw deployFailed('push');
    if (automationRetry) {
      throw redeliver('The automation failed for at least one app; redeliver to retry');
    }
    if (checked.retry) {
      throw redeliver(
        'Queueing the checks of a push failed for at least one app; redeliver to retry',
      );
    }
    return deployTargets.length > 0 || checked.handled ? 'processed' : 'ignored';
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
    } else if (
      event.action === 'new_permissions_accepted' &&
      connection.installationId === installationId
    ) {
      // Tokens minted before carry the old permissions; the capability hint must re-check.
      resetConnectionState(deps.events, connection.id);
      logger.info({ connectionId: connection.id }, 'GitHub App permissions accepted');
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
          case 'pull_request':
            outcome = await onPullRequest(connection, payload);
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
