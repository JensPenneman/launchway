# 20. Checks run app test commands on the node

Date: 2026-10-27

## Status

Accepted

## Context

The owner wants the CI checks of his apps (Trail: quality, integration and
end-to-end tests) to run on his Launchway node instead of on GitHub-hosted
runners, and to keep on GitHub only what has to stay there (CodeQL,
Dependabot, release-please, publishing). Branch protection must still be able
to require the checks before a pull request merges.

Launchway already fetches commits, reads Compose files through a policy and
builds and runs Compose projects on nodes, and the apps carry a development
container: Trail's `.devcontainer/compose.yaml` has a `dev` service built
from its own Dockerfile (Node and Chromium), a `db` PostgreSQL sidecar, bind
mounts of the checkout and of one SQL file, and the project name from
`COMPOSE_PROJECT_NAME`. Its CI commands run in that container.

Running a test command means running the code of any branch of the
repository on the production node, next to the production apps. Two facts
shape the design:

- The agent runs in a container that owns the Docker socket. Its workspace is
  a named volume, so a path of a checkout does not exist on the Docker host:
  a bind mount of the checkout cannot work, and a bind mount of anything the
  repository names must never be honoured.
- The agent's own file system holds every app's decrypted `.env` of its
  deployments and the node credential. Compose reads files while it loads a
  project (`include`, `extends`, `label_file`), before any policy can look at
  the result.

## Decision

1. **Configuration.** `App.checks` (`apps.checks`, JSON) holds `enabled`,
   `composeFiles` (default `.devcontainer/compose.yaml`), `branches` (exact
   names, `null` = every branch), `skipBots` (default off) and up to ten
   items `{ name, command, service (default dev), composeFile?,
   timeoutMinutes (1-120, default 30) }` with unique names
   (`^[a-z0-9][a-z0-9-]{0,38}$`). Members edit it through `PATCH /apps/{id}`
   (partial update; `items` replaces the list). `POST /apps/{id}/checks`
   runs the checks of a ref by hand; it is the only trigger for token
   connections, which get no webhooks.
2. **Triggers.** A `push` to a branch (not tags, not deletions) and a
   `pull_request` `opened`, `reopened` or `synchronize` whose head is a
   branch of the same repository queue one run per item for the head commit.
   Pull requests from forks never run. `branches` filters the pushed branch,
   and the base branch of pull requests (like GitHub Actions); `skipBots`
   skips pushes whose sender and pull requests whose author is a bot. Runs
   are deduplicated per app, commit and name, so a push and the
   `synchronize` of the same commit run once. A newer commit of a branch
   cancels the queued runs of older commits of that branch (`superseded`);
   running ones finish.
3. **Runs.** `check_runs` (`chk_…`) keeps a snapshot of the item (command,
   service, Compose files, timeout), the commit, branch and pull request,
   the trigger, the status (`queued`, `running`, `succeeded`, `failed`,
   `errored`, `cancelled`) with a reason and the exit code, and the state
   last posted to GitHub. A partial unique index allows one `running` run per
   node: checks of all apps of a node run one after another, oldest first.
   The dispatcher claims runs like the deployment dispatcher. The agent
   acknowledges `check.run` at once; without an acknowledgement within 30
   seconds the run is `errored` with reason `unsupported` (older agents
   ignore the unknown message). Heartbeats list the runs an agent holds, so
   runs whose result was lost become `errored` (`lost`), and runs the
   database no longer expects are cancelled on the node. Queued runs of a node
   that stays offline for 10 minutes are `errored`. Log lines
   (`check_log_lines`) are deleted after 30 days; runs are kept. The UI and
   `GET /checks/{id}/logs` stream them like deployment logs, and the change
   feed has a `checks` topic.
4. **Commit statuses, not check runs.** Every run is reported as the commit
   status `launchway/<name>` of its commit: `pending` while queued or
   running, `success` for exit code 0, `failure` for another exit code or a
   timeout, and `error` for everything that is no verdict on the code (policy,
   build, Docker, offline node, cancelled, superseded). The description says
   why in at most 140 characters and the target URL opens the run in the UI.
   GitHub's Checks API would also show annotations, but only GitHub Apps can
   write check runs; commit statuses work for GitHub Apps and fine-grained
   tokens alike, one context per check is easy to require in branch
   protection, and a re-run simply posts a new status for the same context.
   Posting needs `statuses: write` (fine-grained tokens: *Commit statuses:
   read and write*). It is best effort like the deployment mirror (ADR 0017),
   with its own refusal pause, and pending states are synced again from the
   database after a restart.
5. **One resolved document.** The agent fetches the exact commit, parses the
   configured Compose files itself (YAML 1.2) and refuses `include`, a
   top-level merge key and any `extends.file` outside the checkout, then reads
   the project with `docker compose config --no-env-resolution` and applies
   the Compose policy in a checks mode: untrusted, no routes, every bind mount
   outside the checkout refused. It writes one resolved document and uses
   only that file afterwards: every service gets the label
   `launchway.check=<run id>`, the limits of the platform settings, `no-new-
   privileges` and `oom_score_adj: 1000`; published ports, container names,
   restart policies, logging drivers and resource settings of the project are
   removed; built services are tagged `launchway-check/<slug>-<service>` so a
   check can never retag an image of a deployment; nothing joins the proxy
   network. The project is `launchway-check_<slug>_<run>`; app slugs contain
   no `_`, so it cannot collide with an app or a preview.
6. **Source delivery through a volume.** The checkout is copied into a volume
   of the run with `docker cp` into a created, never started container, and
   handed to the image's user by a one-shot `chown` container (the agent has
   no `CHOWN` capability). Directory binds inside the checkout become volume
   mounts with `subpath` (verified with Docker Desktop's engine 29.6 and the
   agent's Compose 5.5 on the production node), read-only text files up to
   64 KiB become `configs` with inline content, and file-based configs and
   secrets are inlined the same way.
7. **No app variables, no secrets.** A check gets an environment file outside
   the checkout with only `CI=true`, `COMPOSE_PROJECT_NAME`, `LAUNCHWAY_APP`,
   `LAUNCHWAY_CHECK=1`, `LAUNCHWAY_CHECK_RUN_ID`, `LAUNCHWAY_COMMIT_SHA` and
   `LAUNCHWAY_REF`, which its service also receives. The clone token is used
   by git in the agent only and redacted from every line, like the node
   credential and the join token.
8. **`sh -c` inside the app's own container.** The command runs as
   `docker compose run <service> sh -c <command>`. The command is
   configuration that members set, and members can already deploy any code of
   the repository; the shell starts inside the container built from that
   repository, as the image's user, with the same isolation as everything
   else of the check. The agent itself still never runs a shell string.
9. **Resource caps.** Every service of a check gets `mem_limit` =
   `memswap_limit` (no swap), `cpus` and `pids_limit` from the platform
   settings (defaults 4096 MiB, 2 CPUs, 4096 processes) and the OOM killer
   takes check containers first. Builds share the node's build slots with
   deployments and stop after 60 minutes; the command stops after its
   `timeoutMinutes`; a run sends at most 20 000 log lines.
10. **Cleanup.** The result is reported first, then the run cleans up while it
    still holds the node's check slot: its containers, `down --volumes
    --remove-orphans`, the source volume, remaining labelled volumes and
    networks, dangling images with the `launchway.check` label and the
    checkout. At start the agent removes leftovers of `launchway-check_*`
    projects.

## Consequences

- Trail's checks can move to the node, and branch protection can require
  `launchway/quality` and the others from the Launchway GitHub App.
- Existing GitHub Apps must be granted *Commit statuses: read and write*
  (and the installation must approve it); fine-grained tokens need the same
  permission. Without it checks still run and show in Launchway.
- Checks compete with production for the node. The caps, one check per node
  and the OOM preference bound that, and the operations guide sizes them for a
  16 GB node. Images and BuildKit cache of checks stay on the node.
- The Compose file preflight applies to deployments as well: `include` and
  `extends.file` must stay inside the repository there too, and remote
  includes are refused, which closes the same way of reading another app's
  `.env` for previews.
- Risks that remain: checks have outbound network access (installing
  dependencies needs it) and can reach ports the node publishes, the
  Launchway API's port 3000 included; build steps run in BuildKit without the
  service limits; the policy is a deny-list, so a new Compose feature that
  reaches outside the project is not refused until it is known; repository
  code is isolated by the container runtime only.
- Follow-ups: an allow-list of Compose keys for checks; pruning the BuildKit
  cache of checks; binding the API's port to loopback (or a firewall rule)
  once the platform domain works, so job containers cannot reach it; cache
  volumes per app (package managers) to speed up runs; more than one check
  per node; `include` support for checks.
