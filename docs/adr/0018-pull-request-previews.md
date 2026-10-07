# 18. Pull request previews

Date: 2026-10-07

## Status

Accepted

## Context

Changes that only exist in a pull request could not be tried anywhere but on
a developer machine: a deployment is a ref of the app, and an app runs one
deployment at a time under one Compose project, one set of aliases and one
set of routes. The owner wants every pull request of an app's repository to
get its own running copy at its own HTTPS host name, updated on every push and
removed when the pull request closes.

The runtime pieces already exist: the dispatcher and the per-app queue, the
agent that builds and runs a Compose project, the deployment sink, managed
domains with a CNAME to the anchor, routes and the edge renderer. A preview
should reuse them rather than grow a second deployment path.

## Decision

1. **A preview is a row plus ordinary resources.** `previews` holds one row
   per app and pull request number (`prv_…`, title, branch, head SHA, host
   name, status `pending|deploying|running|failed|closing|closed`, the domain
   and route it created, the running deployment). The domain and route are
   normal rows created through the domains and routes services, so DNS
   records, audit and the edge work as for any other domain.
2. **Environments on deployments.** Deployments get `previewId` and
   `environmentName` (`production` or `preview/pr-<n>`). One deployment runs
   per app and environment (partial unique index), a deployment that reaches
   `running` supersedes only the previous one of its environment, and every
   place that means "the app's running deployment" filters on `production`.
   Previews share the app's dispatch lane: one build per app at a time keeps a
   home server's load bounded; a newer push cancels preview deployments that
   were not sent to the node yet.
3. **Naming without agent changes.** The agent derives the Compose project
   and the aliases from the slug it receives, and keys checkouts and its queue
   by the app id it receives. For a preview the payload carries the slug
   `<slug>-pr-<n>` (project `launchway-<slug>-pr-<n>`, aliases
   `<slug>-pr-<n>-<service>`) and the app id `app_<suffix of the preview id>`.
   Removing or pruning a preview therefore never touches the production
   checkouts, and its named volumes are its own. `composeProjectName` and
   `serviceAlias` take the optional preview number, and the payload builder
   and the edge renderer both call them with it. A slug longer than 34
   characters leaves no room for `-pr-<n>` within the 40-character slug, so
   such apps get no previews.
4. **Previews are untrusted.** Only pull requests whose head is a branch of
   the same repository get a preview; fork pull requests are ignored. A
   preview never gets the app's trusted mounts (bind mounts, external volumes):
   it would share host paths and database volumes with production. Apps that
   need those in production can name separate Compose files for previews.
5. **Environment.** A preview gets the app's variables (secrets included),
   then the app's preview overrides with the placeholders `{{previewUrl}}`,
   `{{previewHost}}`, `{{prNumber}}`, `{{branch}}` and `{{sha}}` filled, then
   the platform variables. Every deployment, production included, also gets
   `LAUNCHWAY_ENVIRONMENT`, `LAUNCHWAY_PREVIEW_NUMBER` and
   `LAUNCHWAY_PUBLIC_URL`. Overrides are stored like plain variables; secrets
   belong in the app's environment.
6. **Host names and certificates.** `Setting.previewBaseDomain` must lie in a
   zone of a provider Launchway can write to; the app's host template must
   contain `{number}` and end with `.{base}`. The preview's domain is created
   with `force`, so the edge serves it before the DNS check passed, and Caddy
   obtains a certificate per host name (HTTP-01), like for every route.
7. **Lifecycle.** `pull_request` `opened`/`reopened`/`synchronize` upsert the
   preview, ensure its domain and route and deploy the head commit (trigger
   `preview`); `closed` removes route, domain (with its record) and the
   Compose project with its volumes. A step that cannot finish (node offline,
   DNS provider down) leaves the preview `closing`; a worker retries it,
   re-derives the status of open previews from their deployments and purges
   closed rows, with their deployments, after seven days. Limits: 10 open
   previews per app and 20 in total by default (platform settings).

## Consequences

- Previews need the GitHub App's `pull_request` event and
  `pull_requests: read`; existing installations must accept the new
  permission on GitHub. Personal access token connections can open previews
  only through the API (`POST /apps/{id}/previews`).
- A long preview build delays a production deployment of the same app (shared
  lane). Splitting lanes per environment is possible later without a schema
  change.
- Each preview host name uses a Let's Encrypt certificate; the limit of 50
  certificates per registered domain per week bounds how many previews can be
  opened, which the default limits stay well below. A wildcard certificate via
  DNS-01 would lift that and is left for later.
- Preview routes appear in the app's route list and in the domains list like
  other routes; they are removed with the preview.
