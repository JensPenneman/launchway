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
   acknowledges `check.run` at once, and agents that run checks list their
   runs in every heartbeat (`activeCheckRunIds`). Older agents ignore
   `check.run` and send heartbeats without that list: their node's runs end
   with `errored`, reason `unsupported`. A run whose acknowledgement does not
   arrive within 30 seconds stays claimed until the heartbeats tell: listed,
   it goes on; missing from a capable agent, it is sent again. Heartbeats
   also turn runs whose result was lost into `errored` (`lost`), and cancel on
   the node the runs the database no longer expects. Queued runs of a node
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
   top-level merge key and any `extends.file`, `env_file` or `label_file`
   that is not a relative path inside the checkout from every directory
   Compose might resolve it against, then reads the project with `docker
   compose config --no-env-resolution` and applies the Compose policy in a
   checks mode: untrusted, no routes, every bind mount outside the checkout
   refused, only volume and tmpfs mounts (no image mounts of other apps'
   images), additional build contexts only from the repository, no configs or
   secrets read from the environment. It writes one resolved document and uses
   only that file afterwards: every service gets the label
   `launchway.check=<run id>`, the limits of the platform settings, `no-new-
   privileges`, `oom_score_adj: 1000` and the `json-file` logging driver with
   rotation (at most 30 MB of logs per container); published ports, container
   names, restart policies, logging drivers, `ulimits`, `cpuset`,
   `storage_opt` and the other resource settings of the project are removed,
   and so are subnets and fixed addresses of its networks (`ipam`,
   `enable_ipv6`), which could change routing on the node; built services are tagged `launchway-check/<slug>-<service>` so a
   check can never retag an image of a deployment; every other image is pulled
   from its registry for each run, so a check cannot use an image that only
   exists on the node; environment entries and build arguments without a
   value are dropped and Compose runs without the agent's proxy variables, so
   nothing of the agent's environment reaches the containers; nothing joins
   the proxy network. The project is `launchway-check_<slug>_<run>`; app slugs contain
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
   settings (defaults 2048 MiB, 2 CPUs, 4096 processes: a check of a dev
   container and a database fits an 8 GB Docker VM next to production) and the
   OOM killer
   takes check containers first. Builds share the node's build slots with
   deployments and stop after 60 minutes; the command stops after its
   `timeoutMinutes`; a run sends at most 20 000 log lines or 16 MiB of text,
   and inlines at most 256 files and 1 MiB.
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
  16 GB node. Images of checks and the check builder's cache stay on the node.
- Builds of checks (follow-up of this decision) run in a buildx
  `docker-container` builder of their own, named after the limits
  (`launchway-check-build-<memory>m-<cpus>c`): the memory without swap, CPUs
  and processes of a check service, its own BuildKit cache and cache mounts
  (bounded to 5000 MB by BuildKit's garbage collection and a prune after
  every run), and its own bridge network, which reaches the internet but no
  other container. The agent creates it with the first build of a check
  (`docker compose build --builder`, buildx records in the agent's volume),
  keeps it between runs and replaces it when the limits change; deployments
  keep the engine's builder. Its BuildKit image is pinned by digest. As with
  every `docker-container` builder, BuildKit runs privileged in that
  container and buildx allows it the `network.host` entitlement; build steps
  stay in BuildKit's sandbox, checks never request the entitlement (the
  policy refuses `network: host` and entitlements), and that network would be
  the builder's own.
- The queue is bounded (follow-up of this decision): an app may hold at most
  `checkMaxQueuedPerApp` queued runs (default 30) and a node
  `checkMaxQueuedPerNode` (default 100), platform settings. A push or pull
  request whose runs would exceed either bound gets them at once as `errored`
  with reason `queue-full`, so GitHub shows a clear error instead of a
  pending status that may never move; manual runs and re-runs are refused
  (409). Runs that never ran (`superseded`, `queue-full`) do not count for
  the deduplication, so pushing such a commit again runs it, and the newest
  push of a branch supersedes the queued runs of every other commit of it.
- The Compose file preflight applies to deployments as well: `include`,
  `extends.file`, `env_file` and `label_file` must stay inside the repository
  there too, and remote includes are refused, which closes the same way of
  reading another app's `.env` for previews. Deployments may no longer use
  images in the `launchway-check/` namespace, so a check build can never
  replace an image a deployment runs. The operations guide lists what
  deployments that worked before may now meet (*Upgrade*).
- Risks that remain: checks have outbound network access (installing
  dependencies needs it) and can reach ports the node publishes, the
  Launchway API's port 3000 included; images the node's Docker client may
  pull with stored registry credentials can be pulled by checks as well; the
  check builder's BuildKit runs privileged in its container (see above) and
  its pinned image is not updated by Dependabot; the policy is a deny-list, so a new Compose
  feature that reaches outside the project is not refused until it is known;
  repository code is isolated by the container runtime only.
- Follow-ups: an allow-list of Compose keys for checks; a rootless BuildKit
  for the check builder; binding the API's port to loopback (or a firewall rule)
  once the platform domain works, so job containers cannot reach it; cache
  volumes per app (package managers) to speed up runs; more than one check
  per node; `include` support for checks.
