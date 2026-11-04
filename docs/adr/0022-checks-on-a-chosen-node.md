# 22. Checks on a chosen node

Date: 2026-11-04

## Status

Accepted. Amends [ADR 0020](0020-checks-run-app-test-commands-on-the-node.md),
which ran an app's checks on the app's node, and
[ADR 0021](0021-concurrent-checks-per-node.md), whose concurrency was one
platform value for every node.

## Context

Checks are the heaviest work Launchway starts: each one builds images and
runs a development container with its sidecars under the platform limits. The
edge node also serves production and deploys, and a laptop that does both
cannot run several end-to-end suites at once. The owner has a second machine
on the LAN (a Mac Studio) that is much faster and has nothing to serve. Two
things stand in the way: a run always took the node of its app, and the
number of checks at once was the same for every node, although a Mac Studio
can run many more than a 16 GB laptop.

## Decision

1. **A node for the checks of an app.** `App.checks.nodeId` (in the `checks`
   JSON, so no column and no migration of apps) names the node that runs the
   app's checks; null or absent means the node of the app. Writing it
   requires an existing node (400 on `body.checks.nodeId` otherwise). Naming
   the node of the app is allowed and means the same as null for the runs,
   but it stays when the app later moves. Deleting a node that an app names
   is refused (409), as for an app that runs on it. Naming the app's own node
   pins the checks there if the app later moves; null follows the app.
2. **One function decides.** `checkNodeOf(app) = app.checks.nodeId ??
   app.nodeId` is the node of every new check run: the row lock and the
   queue cap per node when runs are queued, the node stored on the run for
   pushes, pull requests, manual runs, re-runs and the schedule pass. A run
   keeps its `nodeId` for life, so dispatch, `queuedBehind`, same-tree
   copies, supersede and cancel need no change: they already work per
   `check_runs.node_id`. Same-tree copies look for a finished run of the app
   and check, whatever its node; only passing over a queued run while the same
   check runs for its tree is per node. Deployments, previews,
   routes and the app's volumes keep using `app.nodeId`.
3. **Changing the node.** When `checkNodeOf` changes (the app moves while it
   checks on its own node, or `checks.nodeId` changes), the queued runs of
   the app on the old check node are cancelled, as when an app moved before;
   running ones finish where they run. Moving an app whose checks run
   elsewhere leaves its queued runs alone.
4. **The agent of the check node.** It must run checks. The rule of ADR 0020
   applies to the node that holds the run: when the heartbeat of the check
   node shows an agent without checks, the queued and running runs on it end
   `errored` (`unsupported`), whatever the node of their apps.
5. **A concurrency per node.** `nodes.check_concurrency` is a nullable integer
   from 1 to 16 (a CHECK constraint); `PATCH /nodes/{id}` takes
   `checkConcurrency` (admin). The dispatcher claims up to
   `node.checkConcurrency ?? settings.checkConcurrency`, read once per
   dispatch pass; the advisory lock per node of ADR 0021 is unchanged. The
   platform setting stays the default (1 to 8); a node may go to 16.

## Consequences

- The edge node can keep deploying while a stronger node runs the checks.
  Each check there still gets the platform limits per service, so the check
  node needs `checkConcurrency x services x limits` of memory and CPUs
  (`docs/operations.md`, *Run checks on another node*).
- A check node needs Docker, the agent at the same version as the control
  plane, and network reach to GitHub for the checkout; it never needs to
  reach the app's volumes, because checks get no app variables, secrets or
  volumes.
- The queue cap per node counts the runs of the check node, so apps of other
  nodes that check there share its bound.
- Changing the node of an app's checks cancels its queued runs; GitHub shows
  them as cancelled and a push or a manual run queues them again.
- A node that has ever run a check cannot be deleted: `check_runs.node_id` is
  `ON DELETE RESTRICT` and runs are kept as history (they go only with their
  app). Deleting answers 409 ("still referenced") while any run exists, so a
  check-only node can be revoked and left idle but not removed.
- The check node must stay awake and online: a run queued for a node that has
  been offline for 10 minutes ends `errored` (`offline`), with no fallback to
  the app's node. A Mac that sleeps, or Docker Desktop pausing its VM, counts
  as offline.
- `queuedBehind` uses the limit of the run's own node.
- Previews are not moved: a routed preview still runs on the app's node.
- A changed `check_concurrency` applies to the next dispatch pass; runs
  already running are not stopped when it is lowered.
