# 21. Concurrent checks per node

Date: 2026-10-28

## Status

Accepted. Amends [ADR 0020](0020-checks-run-app-test-commands-on-the-node.md),
which ran one check per node at a time.

## Context

A node runs one check at a time (ADR 0020): a partial unique index allows one
`running` run per node and the agent serializes the runs it gets. The
production node is a 6-core, 12-thread laptop with 16 GB; while a 20-minute
end-to-end suite runs, most of it is idle and every other check of every app
waits. The checks of one push (Trail: quality, integration, end-to-end) are
independent and could run side by side.

Running checks at once needs more than a higher limit: two runs of one app at
once must not share anything that one of them changes or removes. Each run
already has its own Compose project, container and volume names, checkout
directory and log, but the images it builds were tagged per app and service
(`launchway-check/<slug>-<service>`), so a second build of the app would
retag the image the first run is about to start; a check's Compose project
could publish host ports, on which two projects of one app would collide;
cache mounts of the check builder are emptied before every build so that no
build reads what another repository wrote there; and the start-up sweep
removes every check project it finds.

## Decision

1. **A platform setting.** `checkConcurrency` (`settings.check_concurrency`,
   1-8, default 1) is how many checks a node runs at once, all apps together.
   Admins set it beside the limits of a check service.
2. **The API counts, under a lock of the node.** The dispatcher's claim takes
   `pg_advisory_xact_lock(hashtext('launchway.checks.node:' || node_id))`,
   counts the node's `running` runs and, below the limit, claims the oldest
   queued run (or ends it as a same-tree copy) as before; claims of one node
   take turns, claims of different nodes do not wait for each other. The
   partial unique index `check_runs_one_running_per_node` is dropped (the
   index on `(node_id, status)` serves the count). A dispatch pass claims and
   sends runs until the node is full or nothing waits. A queued run's
   `queuedBehind` is the number of the node's runs that have to end before it
   starts.
3. **The agent runs what it gets, side by side.** It has no cap of its own;
   the API is the authority. Every run's names are its own, built images
   included: they are tagged with the run
   (`launchway-check/<slug>-<service>:<run id suffix>`) and untagged by its
   cleanup, so another run of the same commit keeps its tag of the same
   image. Cleanup only names the run's own label, project, volumes, networks,
   images and directory, besides the app's dangling check images, which no
   run uses. Cancelling stops one run; shutting down stops all of them and
   gives their cleanups the grace period side by side, without the prunes
   of the check builder (the next build empties its cache mounts first).
4. **One build at a time in the check builder.** Builds of checks take turns
   in the check builder, and so do the prunes after each run and the
   untagging of its images (neither may meet an image that a build is
   loading): every build still starts with empty cache mounts that no build
   of another run writes to meanwhile. A run that waits for its turn says so
   in its log, and the wait counts as its running time. The commands run
   side by side. Sweeps (at start) run alone:
   they wait for the runs before them and hold back the runs after them, and
   they remove every image of the check namespace, the per-app tags of
   earlier agents included.
5. **No published ports.** A check's resolved Compose document has no `ports`
   on any service, whatever its files say (ADR 0020 already removed them;
   it is now what lets two projects of one app run at once). Checks need
   none: the check container joins the project's network and reaches its
   sidecars there. Deployments keep their ports.

## Consequences

- With `checkConcurrency` 2, Trail's shorter checks run while its end-to-end
  suite does instead of after it, on cores that were idle.
- The memory and CPUs a node gives checks are *`checkConcurrency` × services
  × limits*: two checks of Trail (`dev` and `db`) at 2048 MiB may take 8 GiB,
  which needs Docker Desktop's WSL VM at 12 GB on a 16 GB laptop next to
  production (`docs/operations.md`, *Resources on a 16 GB node*). The default
  of 1 keeps today's budget; limits are caps, not reservations, and the OOM
  killer still takes check processes first.
- Builds of checks wait for each other, so concurrency mostly shortens the
  commands; a slow build delays the other runs' builds.
- Images built for checks no longer stay on the node between runs; their
  layers stay in the check builder's cache, and each run loads its image into
  the engine again.
- An agent older than this decision serializes what it gets: raising the
  setting before upgrading the agent makes runs wait on the node instead of
  in the queue, still in order.
- The sweep at start assumes, as before, one agent per Docker daemon.
- Follow-up: same-tree copies of a queued run are made when it is queued,
  when a run of its tree ends and when the claim takes it, and they need a
  run that has ended. With two or more checks at once, the claim can start a
  queued run while a run of the same check and tree is still running on the
  node, so both run where one check at a time would have copied the result.
  The claim should pass over such a run (it becomes a copy when the running
  one ends) and take the next queued one.
