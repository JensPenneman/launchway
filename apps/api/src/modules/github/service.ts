import {
  type AppManifestStart,
  type CompleteAppManifestInput,
  type CreatePatConnectionInput,
  type GitHubConnection,
  type GitHubConnectionId,
  type GitHubConnectionList,
  type GitHubReleaseListQuery,
  type GitHubReleasePage,
  type GitHubRepoListQuery,
  type GitHubRepoPage,
  generateId,
  type InstallationCallbackQuery,
  type ResolvedGitRef,
  type StartAppManifestInput,
} from '@slipway/contracts';
import { asc, count, eq } from 'drizzle-orm';
import { isUniqueViolation } from '../../db/errors.js';
import type { Deps } from '../../deps.js';
import type { RequestActor } from '../../lib/auth-context.js';
import {
  convertAppManifest,
  forgetInstallationTokens,
  GitProviderError,
  getAppInstallation,
  verifyPatToken,
} from '../../lib/git-provider.js';
import { badRequest, conflict, forbidden, invalidField } from '../../lib/problem.js';
import { apps } from '../apps/schema.js';
import { recordAudit } from '../audit/service.js';
import { createSettingsService } from '../settings/service.js';
import {
  buildManifest,
  connectionUrls,
  defaultAppName,
  manifestPostUrl,
  signManifestState,
  verifyManifestState,
} from './manifest.js';
import {
  appCredentials,
  type ConnectionRow,
  getConnection,
  providerFor,
  secretContext,
  toGitProblem,
} from './providers.js';
import { githubConnections } from './schema.js';

export function toConnection(row: ConnectionRow): GitHubConnection {
  const app =
    row.kind === 'app' && row.appId !== null && row.appSlug !== null
      ? {
          appId: row.appId,
          slug: row.appSlug,
          htmlUrl: row.appHtmlUrl ?? `https://github.com/apps/${row.appSlug}`,
          installUrl: `https://github.com/apps/${row.appSlug}/installations/new`,
          installationId: row.installationId,
        }
      : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    account:
      row.accountLogin !== null
        ? { login: row.accountLogin, type: row.accountType ?? 'User' }
        : null,
    app,
    webhooksEnabled: row.kind === 'app' && row.installationId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface GitHubService {
  list(): Promise<GitHubConnectionList>;
  get(id: GitHubConnectionId): Promise<GitHubConnection>;
  createPat(input: CreatePatConnectionInput, actor: RequestActor): Promise<GitHubConnection>;
  startManifest(input: StartAppManifestInput, actor: RequestActor): Promise<AppManifestStart>;
  /** Returns the UI URL to redirect the browser to. */
  completeManifest(input: CompleteAppManifestInput, actor: RequestActor): Promise<string>;
  /** Returns the UI URL to redirect the browser to. */
  completeInstallation(
    id: GitHubConnectionId,
    query: InstallationCallbackQuery,
    actor: RequestActor,
  ): Promise<string>;
  remove(id: GitHubConnectionId, actor: RequestActor): Promise<void>;
  listRepos(query: GitHubRepoListQuery): Promise<GitHubRepoPage>;
  listReleases(
    owner: string,
    repo: string,
    query: GitHubReleaseListQuery,
  ): Promise<GitHubReleasePage>;
  resolveRef(
    owner: string,
    repo: string,
    ref: string,
    connectionId: GitHubConnectionId,
  ): Promise<ResolvedGitRef>;
}

export function createGitHubService(deps: Deps): GitHubService {
  const settings = createSettingsService(deps);

  async function publicUrl(): Promise<string> {
    const url = (await settings.get()).effectivePublicUrl;
    if (!url) {
      throw conflict('Set the platform public URL (settings) before connecting a GitHub App');
    }
    return url;
  }

  async function withGitHub<T>(work: () => Promise<T>, notFoundDetail?: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toGitProblem(error, notFoundDetail);
    }
  }

  function publishChange(action: 'created' | 'updated' | 'deleted', id: GitHubConnectionId) {
    deps.events.publish({ topic: 'github', action, resourceId: id });
  }

  return {
    async list() {
      const rows = await deps.db
        .select()
        .from(githubConnections)
        .orderBy(asc(githubConnections.createdAt), asc(githubConnections.id));
      return { items: rows.map(toConnection) };
    },

    async get(id) {
      return toConnection(await getConnection(deps.db, id));
    },

    async createPat(input, actor) {
      let account: Awaited<ReturnType<typeof verifyPatToken>>;
      try {
        account = await verifyPatToken(input.token);
      } catch (error) {
        if (error instanceof GitProviderError && error.kind === 'unauthorized') {
          throw invalidField('body.token', 'GitHub rejected this token');
        }
        throw toGitProblem(error);
      }
      const id = generateId('gh');
      const row = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(githubConnections)
          .values({
            id,
            kind: 'pat',
            name: input.name,
            accountLogin: account.login,
            accountType: account.type,
            tokenEncrypted: deps.secrets.encrypt(input.token, secretContext.token(id)),
            createdById: actor.principal?.user.id ?? null,
          })
          .returning();
        if (!created) throw new Error('insert returned no row');
        await recordAudit(tx, actor, {
          action: 'github-connection.create',
          target: { type: 'github-connection', id },
          summary: { kind: 'pat', name: input.name, account: account.login },
        });
        return created;
      });
      publishChange('created', id);
      return toConnection(row);
    },

    async startManifest(input, actor) {
      const url = await publicUrl();
      const connectionId = generateId('gh');
      const state = signManifestState(deps.config.secretKey, {
        connectionId,
        userId: actor.principal?.user.id ?? null,
      });
      return {
        postUrl: manifestPostUrl(state, input.organization),
        state,
        manifest: buildManifest(url, connectionId, input.name ?? defaultAppName(url)),
      };
    },

    async completeManifest(input, actor) {
      const state = verifyManifestState(deps.config.secretKey, input.state);
      if (!state) throw badRequest('The GitHub App setup link is invalid or expired; start again');
      if (state.u !== null && state.u !== (actor.principal?.user.id ?? null)) {
        throw forbidden('The GitHub App setup was started by another user');
      }
      const url = await publicUrl();
      const conversion = await withGitHub(
        () => convertAppManifest(input.code),
        'The GitHub App code is invalid or was already used',
      );
      const id = state.c;
      try {
        await deps.db.transaction(async (tx) => {
          await tx.insert(githubConnections).values({
            id,
            kind: 'app',
            name: conversion.name,
            accountLogin: conversion.owner?.login ?? null,
            accountType: conversion.owner?.type ?? null,
            appId: conversion.appId,
            appSlug: conversion.slug,
            appHtmlUrl: conversion.htmlUrl,
            clientId: conversion.clientId,
            clientSecretEncrypted: deps.secrets.encrypt(
              conversion.clientSecret,
              secretContext.clientSecret(id),
            ),
            privateKeyEncrypted: deps.secrets.encrypt(
              conversion.privateKey,
              secretContext.privateKey(id),
            ),
            webhookSecretEncrypted: deps.secrets.encrypt(
              conversion.webhookSecret,
              secretContext.webhookSecret(id),
            ),
            createdById: actor.principal?.user.id ?? null,
          });
          await recordAudit(tx, actor, {
            action: 'github-connection.create',
            target: { type: 'github-connection', id },
            summary: { kind: 'app', name: conversion.name, appId: conversion.appId },
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('This GitHub App is already connected');
        throw error;
      }
      publishChange('created', id);
      return connectionUrls(url, id).settingsUrl;
    },

    async completeInstallation(id, query, actor) {
      const row = await getConnection(deps.db, id);
      if (row.kind !== 'app') throw badRequest('This connection is not a GitHub App');
      const url = await publicUrl();
      const installation = await withGitHub(
        () => getAppInstallation(appCredentials(deps, row), query.installation_id),
        'This installation does not belong to the GitHub App of this connection',
      );
      await deps.db.transaction(async (tx) => {
        await tx
          .update(githubConnections)
          .set({
            installationId: installation.id,
            accountLogin: installation.account?.login ?? row.accountLogin,
            accountType: installation.account?.type ?? row.accountType,
          })
          .where(eq(githubConnections.id, id));
        await recordAudit(tx, actor, {
          action: 'github-connection.install',
          target: { type: 'github-connection', id },
          summary: {
            installationId: { from: row.installationId, to: installation.id },
            account: installation.account?.login ?? null,
            setupAction: query.setup_action ?? null,
          },
        });
      });
      if (row.appId !== null) forgetInstallationTokens(row.appId);
      publishChange('updated', id);
      return connectionUrls(url, id).settingsUrl;
    },

    async remove(id, actor) {
      const row = await getConnection(deps.db, id);
      await deps.db.transaction(async (tx) => {
        const [usage] = await tx
          .select({ value: count() })
          .from(apps)
          .where(eq(apps.connectionId, id));
        if ((usage?.value ?? 0) > 0) {
          throw conflict(`${usage?.value} app(s) use this connection; move or delete them first`);
        }
        await tx.delete(githubConnections).where(eq(githubConnections.id, id));
        await recordAudit(tx, actor, {
          action: 'github-connection.delete',
          target: { type: 'github-connection', id },
          summary: { kind: row.kind, name: row.name },
        });
      });
      if (row.appId !== null) forgetInstallationTokens(row.appId);
      publishChange('deleted', id);
    },

    async listRepos(query) {
      const row = await getConnection(deps.db, query.connectionId);
      return withGitHub(() =>
        providerFor(deps, row).listRepos(query.query, query.cursor, query.limit),
      );
    },

    async listReleases(owner, repo, query) {
      const row = await getConnection(deps.db, query.connectionId);
      return withGitHub(
        () => providerFor(deps, row).listReleases(owner, repo, query.cursor, query.limit),
        'Repository not found or not accessible with this connection',
      );
    },

    async resolveRef(owner, repo, ref, connectionId) {
      const row = await getConnection(deps.db, connectionId);
      const resolved = await withGitHub(
        () => providerFor(deps, row).resolveRef(owner, repo, ref),
        `Ref not found in ${owner}/${repo}`,
      );
      return { ref, sha: resolved.sha, kind: resolved.kind };
    },
  };
}
