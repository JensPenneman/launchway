# 19. Retry automatic deployments until the image exists

Date: 2026-10-07

## Status

Accepted

## Context

Apps increasingly reference images that their own CI builds and pushes, for
example `image: ghcr.io/acme/trail:sha-${LAUNCHWAY_COMMIT_SHA_SHORT}`. The
webhook that starts an automatic deployment (a published release, a push to a
branch) and the CI run that builds the image both start from the same Git
event. The webhook usually wins: the deployment reaches `docker compose pull`
before the image exists and fails with `manifest unknown`. Someone then has to
deploy again by hand once CI is done, which defeats the point of automatic
deployments.

Release automation also produces releases that should not deploy (drafts that
release-please opens and updates, prereleases), and some apps want every push
to a branch deployed instead of releases.

## Decision

1. **The agent classifies failures.** A failed `deployment.result` carries an
   additive `reason`: `image-not-found`, `policy`, `build`, `start` or
   `unknown`. `image-not-found` is reported when `build --pull` or `pull`
   fails with a registry answer meaning "no such image or tag": `manifest
   unknown`, `name unknown`, `manifest for … not found`, BuildKit's `failed to
   resolve source metadata … not found`, containerd's `failed to resolve
   reference … not found`, and, during `pull` only, a bare registry 404. Lines
   that mention `denied`, `unauthorized` or `authentication required` never
   count: they also mean missing credentials, and retrying would hide that.
   The protocol version stays at 1; older agents send no reason, which the
   server treats as `unknown`.
2. **Automatic deployments wait for the image.** A deployment whose trigger is
   not `manual` (release webhooks, release polling, branch pushes and future
   automatic triggers such as previews) that fails with `image-not-found` goes
   from `building` back to `queued` (a new transition in
   `DEPLOYMENT_TRANSITIONS`) with `retryCount` incremented, `failureReason =
   image-not-found` and `nextAttemptAt` set. The waits are 1, 2, 4, 8, 15, 15
   and 15 minutes: seven retries, 60 minutes of waiting in total. The eighth
   failure fails the deployment with the original reason and a message saying
   how long it waited. Each retry writes a `deployment.retry` audit event and a
   system line in the deployment log.
3. **The dispatcher respects `nextAttemptAt`.** A queued deployment is only
   claimed once it is due; the 15-second worker pass picks it up. When a newer
   deployment of the same app is claimed, older deployments still waiting for
   their image are cancelled, so an old release can never overwrite a newer
   one after its image finally appears.
4. **Manual deployments fail at once,** as before. Their status message says
   that the image does not exist yet and suggests deploying again once it has
   been pushed.
5. **Release events.** `published` and `released` deploy; `edited` deploys only
   when its `changes` show that a draft was published. Drafts never deploy.
   Prereleases deploy only for apps with `autoDeployPrereleases`. GitHub sends
   several of these events for one publication; deployments are deduplicated
   per tag under a lock on the app row.
6. **Branch pushes.** `App.autoDeployBranch` (for example `main`) deploys every
   `push` to that branch as an automatic deployment of the pushed commit
   (`ref` = the branch, `commitSha` = the pushed SHA), deduplicated per commit.
   Tag pushes and branch deletions are ignored. The GitHub App must subscribe
   to `push` events.

## Consequences

- With a CI pattern that publishes the release only after the image is pushed
  (draft releases, see the operations guide), retries rarely happen; they are
  the safety net when the order is not guaranteed.
- A typo in an image name of an automatic deployment is noticed after an hour
  instead of at once. The deployment shows "Waiting for image, retry n at …"
  meanwhile and can be cancelled.
- `deployments` gains `retry_count`, `next_attempt_at` and `failure_reason`;
  `apps` gains `auto_deploy_prereleases` and `auto_deploy_branch`.
- Image retries reuse the deployment row: its log holds every attempt, and
  `startedAt` is the start of the latest attempt.
