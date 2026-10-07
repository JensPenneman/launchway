# 17. Mirror deployments to GitHub's Deployments API

Date: 2026-10-07

## Status

Accepted

## Context

Launchway deploys repositories that live on GitHub, but GitHub knew nothing
about those deployments. A repository page could not show what runs in
production, a commit could not link to its deployment, and pull request
previews (planned next) had no place to report their URL.

GitHub's Deployments API records exactly that: a deployment of a ref to an
environment, with a stream of statuses (`in_progress`, `success`, `failure`,
`inactive`, `error`) carrying a log link and the environment URL. Writing it
needs the `deployments: write` permission. GitHub Apps created by Launchway
before this change only request `contents: read` and `metadata: read`, and an
app's permissions can only be widened on GitHub by its owner, followed by an
approval on every installation.

## Decision

1. **Manifest.** New GitHub Apps request `deployments: write` and
   `pull_requests: read` next to `contents: read` and `metadata: read`, and
   subscribe to `pull_request` besides `release`. Clone tokens handed to nodes
   stay limited to `contents: read` on one repository.
2. **Mirror service.** `modules/github/deployments-mirror.ts` subscribes to the
   `deployments` change events. When a deployment is created (or first seen in
   progress) it creates a GitHub deployment of the resolved commit SHA with
   `auto_merge: false` and `required_contexts: []`, in environment
   `deployments.environmentName`: `production`, or `preview/pr-<n>` for a
   pull request preview (transient, not production; its `environment_url` is
   the preview's host). The GitHub id is stored in
   `deployments.github_deployment_id`; only the first id sticks.
3. **Status mapping.** `cloning`/`building`/`starting` -> `in_progress`,
   `running` -> `success` (with `environment_url` = `https://<first route host>`
   and `log_url` = `<publicUrl>/apps/<appId>?deployment=<id>`), `failed` ->
   `failure`, `superseded`/`stopped`/`cancelled` -> `inactive` (a cancel is an
   operator decision, not a failure). `queued` posts nothing (a new GitHub
   deployment is `pending`), except while it waits for its image (ADR 0019):
   one `in_progress` status per retry, "Waiting for the image (retry <n>, next
   attempt <ISO time>)". A failure after the retries says the image never
   appeared (`failureReason` `image-not-found`).
4. **Best effort.** Steps of one deployment run one at a time and coalesce;
   each step reads the current state, so GitHub converges on the latest status.
   Rate-limited answers (429, or 403 with an exhausted quota or `Retry-After`)
   are retried up to 3 times with backoff. A 401/403/404 is a refusal: it is
   logged and announced (`github` change event) once per connection per hour,
   new GitHub deployments of that connection pause for 5 minutes, and cached
   installation tokens are dropped so a newly approved permission is picked
   up. No failure ever changes the Launchway deployment.
5. **No backfill.** Deployments that were already running or finished when the
   mirror first saw them are not created on GitHub.
6. **Opt-out.** `App.githubDeployments` (default true) turns the mirror off per
   app.
7. **Capabilities.** `GET /github/connections/{id}/capabilities` tells the UI
   what is missing. GitHub Apps are read with the app JWT (`GET /app` for what
   the app requests, the installation for what was approved). Tokens do not
   list their permissions: Launchway probes reads of deployments and pull
   requests on a repository of the connection and marks deployments missing
   after a refused mirror attempt. Results are cached for 5 minutes
   (`?refresh=true` bypasses the cache); the `installation` webhook action
   `new_permissions_accepted` clears the cache.

## Consequences

- Repositories show their Launchway environments, deployment history and live
  URL on GitHub, and previews get a natural place to report their URL.
- Existing GitHub Apps keep working without the new permission; the
  connection card shows what to grant and links to the app's permission page
  and the installation approval.
- Mirror state (last posted status, refusals, capability cache) lives in
  memory. After a restart a status may be posted once more, which GitHub
  accepts; GitHub ids survive in the database.
- Fine-grained tokens need `Deployments: read and write` to take part. Classic
  tokens Launchway accepts are read-only and never can.
