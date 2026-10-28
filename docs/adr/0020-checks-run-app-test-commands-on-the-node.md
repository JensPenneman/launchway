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
  `docker-container` builder of their own; deployments keep the engine's
  builder. It has the memory without swap, CPUs and processes of a check
  service and is named after the limits and a hash of everything it is made
  of (`launchway-check-build-<memory>m-<cpus>c-<hash>`: BuildKit image,
  network, BuildKit flags and configuration), so a change of any of them
  makes a new builder instead of keeping one that no longer matches. The
  agent creates it with the first build of a check (`docker compose build
  --builder`, buildx records in the agent's volume), keeps it between runs,
  removes the builders of other limits or settings when it creates one, and
  removes builders unused for a day (at start and hourly), the builder
  network with the last one. Like the sweep of check projects, this assumes
  one agent per Docker daemon: a second agent would remove the first one's
  builders, builds running in them included.
- The builder's cache is bounded and kept apart per app. BuildKit keeps at
  most 5000 MB (garbage collection while it builds, and a prune after every
  run); that bounds what stays, not what one build writes while it runs.
  Every check build gets the build argument
  `BUILDKIT_SANDBOX_HOSTNAME=check-<app id>`, which the Dockerfile frontend
  (1.2 and later) makes the hostname of `RUN` steps and part of their cache
  key, and which a Dockerfile `ARG` cannot change: a `RUN` step one app built
  is never reused by another app's build. That matters because a step's
  cache key leaves out what its cache mounts and secrets held, so a step
  shared between apps could carry what another repository planted. Steps
  that follow from their inputs alone (`FROM`, `COPY`, `ADD`) are shared.
  Cache mounts (`RUN --mount=type=cache`) are emptied before every build and
  after every run, so they last for the builds of one run. A Dockerfile that
  pins a frontend older than `docker/dockerfile:1.2` ignores the hostname;
  its `RUN` steps are shared with other builds that do the same.
- Build steps share the builder container's network namespace
  (`--oci-worker-net=host`) on its own bridge network `launchway-check-build`
  and resolve names through Docker's embedded DNS (`[dns] nameservers =
  ["127.0.0.11"]`, which forwards to the node's resolvers; BuildKit would
  give them 8.8.8.8 otherwise). They reach the internet but not the
  addresses of containers on the default bridge or on other networks. They
  do reach ports the node publishes, through the gateway of any bridge
  (172.17.0.1, or the builder network's own), the API's port 3000 included,
  and on Docker Desktop the host through `host.docker.internal`
  (192.168.65.254), its loopback included: ports published on 127.0.0.1
  answer there. Check containers reach the same.
- `# syntax=` may only name Docker's Dockerfile frontend
  (`[frontend."gateway.v0"] allowedRepositories =
  ["docker.io/docker/dockerfile"]`); other frontend images are refused before
  they are pulled. The BuildKit image is pinned by digest, in the agent
  (`CHECK_BUILDER_IMAGE`) and in `apps/agent/check-builder.Dockerfile`, which
  Dependabot updates; a test keeps both equal. As with every
  `docker-container` builder, BuildKit runs privileged in that container and
  buildx allows it the `network.host` entitlement; build steps stay in
  BuildKit's sandbox, checks never request the entitlement (the policy
  refuses `network: host` and entitlements), and the network it would give
  is the builder's own anyway. Apps, trusted or not, cannot mount the state
  volumes of check builders (`buildx_buildkit_launchway-check-build-*`).
- The queue is bounded (follow-up of this decision): an app may hold at most
  `checkMaxQueuedPerApp` queued runs (default 30) and a node
  `checkMaxQueuedPerNode` (default 100), platform settings of at least 10, the
  most checks an app may have, since a commit queues all its checks or none.
  A push or pull request whose runs would exceed either bound gets them at
  once as `errored` with reason `queue-full`, so GitHub shows a clear error
  ("Not run: 28 queued and 5 new checks would exceed the app's limit of 30;
  run it again later") instead of a pending status that may never move;
  manual runs and re-runs are refused (409). Runs that never ran
  (`superseded`, `queue-full`, and `offline` before their node took them) do
  not count for the deduplication, so pushing such a commit again runs it,
  and the newest push of a branch supersedes the queued runs of every other
  commit of it.
- Queue hygiene (follow-up of this decision), since one node runs one check
  at a time and its queue reached 90 minutes of work:
  - A `pull_request` `closed` event (merged or not) cancels the queued runs
    the pull request started (reason `closed`; GitHub: error, "Pull request
    closed"): trigger `pull_request`, its number, its head branch, queued
    before its `closed_at` (a reopen delivered before the close keeps its
    runs), in the apps the delivery's connection links to the delivery's
    repository, so a delivery for one repository never cancels another's
    runs. Push runs are never cancelled by a pull request, even when it
    shares them: a pull request's run that the push of its own branch uses
    becomes a push run. Runs of the default branch stay (the branch from the
    event, else GitHub's API; when neither tells, nothing is cancelled), and
    so do runs another open pull request with the same head needs (`GET
    /repos/{owner}/{repo}/commits/{sha}/pulls`; they become that pull
    request's runs, and when GitHub cannot tell they stay), runs that serve a
    push of another branch (`alsoRef`, set when a push of the same commit is
    deduplicated into a run of another branch, so a fast-forward merge keeps
    its checks), and manual runs and re-runs. Running runs finish: a merged
    pull request's result can still serve the merge commit (next point), and
    cancelling would throw away work already done. A deleted branch (`push`
    with `deleted`) cancels its queued runs of the commit it pointed at
    (GitHub: "Branch deleted"), never the default branch's, and hands them to
    an open pull request from another branch at that commit instead (a pull
    request recreated from a new branch); a handed-over run takes the pull
    request's number and head branch, so its close or its branch's deletion
    cancels it as its own. Cancelled runs
    never ran, so they do not count for the deduplication.
  - Same-tree copies: a push or pull request run whose commit has the tree of
    a commit for which the same check ran and exited within seven days ends
    at once as a copy of that run (status and exit code, reason `same-tree`,
    `copiedFrom`), and GitHub gets the status on the new commit ("Same tree
    as 3f78685, passed in 4m 18s"), so a release workflow waiting for the
    statuses is never left without them. Runs store their commit's tree,
    from the signed push event (`head_commit.tree_id`) or GitHub's API, never
    from the agent or the repository's content. A copy needs the same app
    (an app cannot change its repository, so also the same repository) and
    the same snapshot of the check (name, command, service, Compose files,
    timeout); only runs that exited count, not timeouts (they may be the
    node's load), errors or cancellations; copies are never sources. Copies
    are made when a run is queued, when a run of the tree ends (for runs
    queued meanwhile) and when the dispatcher takes a queued run. Manual
    runs, re-runs and scheduled runs always run.
  - A per-app schedule (`checks.schedule`, cron in UTC, one minute so at most
    hourly, off by default) queues the checks for the head of the default
    branch (trigger `schedule`) once per slot: the app's last slot is stored
    (`checks_last_slot`, also set when the schedule changes, so a new
    schedule starts with its next slot), and the slot is claimed under the
    app row lock together with the runs. Scheduled runs, and their re-runs,
    report as `launchway/<name>/schedule`, so they never replace the push's
    verdict on the default branch's head, nor hold it at pending. At a full
    queue the slot is used without runs (no errored runs) and
    `checks_schedule_note` says why on the Checks tab; a slot whose GitHub
    lookups fail is tried after 1, 2, 4 and 8 minutes, then used the same
    way. It runs whether or not webhooks run the checks, and counts against
    the queue bounds.
  - The dispatcher's claim waits for a row another statement holds for a
    moment (the status mirror, a cancel, a copy) instead of skipping it
    (`FOR UPDATE`, not `SKIP LOCKED`), so the oldest run goes first;
    concurrent claims of one node meet at that row or at the one-running-run
    index.
  - The API reports a queued run's place in its node's queue (`queuedBehind`),
    which the Checks tab shows with the copy provenance.
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
  check builder's BuildKit runs privileged in its container (see above), and
  one build can fill the node's disk while it runs; the branches of one app
  share its cached build steps; a same-tree copy takes the verdict of another
  commit as it was, so a command that depends on `LAUNCHWAY_REF` or
  `LAUNCHWAY_COMMIT_SHA`, on the platform limits or on what changed upstream
  in the last seven days is not run again; the policy is a deny-list, so a
  new Compose feature that reaches outside the project is not refused until
  it is known; repository code is isolated by the container runtime only.
- Follow-ups: an allow-list of Compose keys for checks; a rootless BuildKit
  for the check builder; binding the API's port to loopback (or a firewall
  rule) once the platform domain works, so job containers cannot reach it on
  Linux nodes (on Docker Desktop they reach the host's loopback as well);
  keying the build steps of deployments per app too (they share the engine's
  cache); cache volumes per app (package managers) to speed up runs; more
  than one check per node; `include` support for checks.
