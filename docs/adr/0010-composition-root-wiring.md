# 10. Wiring the modules in the composition root

Date: 2026-10-07

## Status

Accepted

## Context

The v0.1 modules were built in parallel. Each author left its cross-module
connections to the integration stage: the nodes module's agent gateway must
report to the deployments module's sink, the sink dispatches queued
deployments through that same gateway, the edge must tell the domains module
which domains it serves, and the background jobs need a start order.
`src/server.ts` is the only place that sees every module.

## Decision

1. **Deferred deployment sink.** The gateway reports to the sink and the sink
   dispatches through the gateway, so neither can be built first.
   `createDeferredDeploymentSink()` (`lib/agent-gateway.ts`) gives the
   gateway a forwarder; the real `createDeploymentSink(deps)` is bound to it
   as soon as the full `Deps` exist, before any agent can connect. The sink is
   built from the same `deps` object as the routes, because both share the
   live deployment log hub keyed by `deps.events`.
2. **Dispatch when a node comes online.** The sink implements the optional
   `onNodeOnline` hook with one dispatcher pass, so deployments queued for a
   node go out right after its agent connects instead of on the next 15-second
   worker pass. The pass is not awaited: dispatching waits for the agent's
   acknowledgement, which must not hold up the gateway's per-node state queue.
   Claims lock the app row, so the pass and the worker cannot send the same
   deployment twice.
3. **Agent tokens are not API credentials.** The global `authenticate`
   middleware also runs for `GET /api/agent/ws`. The API token resolver
   treats `Authorization: Bearer slpn_…` / `slpa_…` as anonymous instead of
   answering 401, and the agent socket checks those tokens itself. Before this,
   every agent was refused.
4. **Start order.** Migrations, then `Deps`, then the HTTP app; then
   `ensureLocalNode` (bundled agent bootstrap), `agents.start()` (marks nodes
   that a previous process left online as offline, through the sink), the edge
   reconciler with the domains module's `markDomainActive` hook, and finally
   the deployment worker and the release poller. The DNS and domains jobs keep
   starting inside their modules, guarded by `config.env !== 'test'`, as their
   author built them.
5. **The bundled agent can always rejoin.** The local bootstrap token
   (`SLIPWAY_LOCAL_JOIN_TOKEN`) has no expiry and stays valid after use, as the
   nodes module implements it. When the server refuses an agent's stored
   credential (HTTP 401 on the upgrade, or close code `unauthorized`) and the
   agent has `SLIPWAY_JOIN_TOKEN`, it joins again with that token. This
   recovers the local node after a database restore into a new installation.
   For other nodes the one-time join token was used up, so nothing changes for
   them. This narrows ADR 0009, point 3: the bootstrap token is accepted more
   than once, and v0.1 does not restrict it to the Docker network.

## Consequences

- Agent progress, logs, results and offline events reach the deployments
  module; a node that reconnects gets its queued work immediately.
- Revoking the local node's credential works like a rotation: the bundled
  agent rejoins with the bootstrap token. Whoever can read `.env` on the
  control-plane host can join as the local node, which they could already do
  by starting the bundled agent.
- Restricting agent upgrades (and the bootstrap token) to the Docker network,
  as the security checklist asks, remains open; see
  [roadmap.md](../roadmap.md).
