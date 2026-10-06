# 4. Agents connect outbound over WebSocket

Date: 2026-10-06

## Status

Accepted

## Context

The control plane manages nodes, and each node runs an agent that owns Docker
on that machine ([architecture.md](../architecture.md) §1, §9). Nodes may sit
behind NAT, on another network, or on a machine without a stable address. The
control plane must push commands (deploy, stop, stream logs) and receive
progress, logs and status as they happen. Reaching into nodes over SSH, a
remote Docker API or an HTTP API on the agent would need inbound ports,
per-node TLS and firewall rules, and would put a root-equivalent interface on
the network. Polling adds latency and cannot stream logs.

## Decision

- The agent dials `<SLIPWAY_SERVER_URL>/api/agent/ws` and keeps the WebSocket
  open: `wss://<public url>` on remote nodes, `ws://slipway:3000` on the
  control-plane host. The agent never listens on a port.
- The upgrade request carries
  `Authorization: Bearer <join token or node credential>`. A new node presents
  its one-time join token (`slpn_…`, valid for 15 minutes, created in the UI).
  The server answers with a long-lived node credential (`slpa_…`) in
  `hello.ok`; the agent stores it in `/var/lib/slipway/agent/credentials.json`
  (mode `0600`) and uses it from then on. The server keeps only SHA-256 hashes
  of both and compares them in constant time. Credentials can be rotated and
  revoked in the UI; upgrades without a valid token are rejected.
- Messages are JSON text frames `{ id, type, payload }`. Each type has a Zod
  schema in `@slipway/contracts` (`agent/*`), validated on both sides. A reply
  echoes the `id` of its request.
- Agent to server: `hello`, `heartbeat`, `deployment.progress`,
  `deployment.log`, `deployment.result`, `app.status`, `logs.chunk`,
  `logs.end`. Server to agent: `hello.ok`, `deploy`, `stop`, `remove`,
  `status`, `logs.start`, `logs.stop`. ADR 0009 adds `error` in both
  directions and `deployment.cancel`.
- `hello` carries the protocol version. The server refuses incompatible agents
  with an error that the UI shows. Unknown message types are ignored with a
  warning, so additive changes need no new version.
- The agent sends a heartbeat every 15 s; the server marks the node `offline`
  after 45 s without one. The agent reconnects with exponential backoff and
  jitter. A deployment for an offline node stays `queued` for 10 minutes, then
  fails.

## Consequences

- A node only needs outbound access to the platform URL. Inbound access is
  needed only from the edge to the LAN IP of a node that runs routed apps.
- Remote agents reach the API through the edge, so an edge outage takes
  remote nodes offline. Their running containers are not affected, and the
  agents reconnect once the edge is back.
- The node credential is as sensitive as the node. Its holder receives the
  node's deploy commands, including the apps' environment values, and the
  agent itself is root-equivalent on its node (§14).
- Each agent holds one long-lived connection to the single API instance of
  v0.1. Running several API instances would require routing each command to
  the instance that holds the node's connection.
- Shared schemas make version skew visible at `hello` rather than as
  malformed messages. Breaking protocol changes require upgrading the agents
  together with the control plane.
