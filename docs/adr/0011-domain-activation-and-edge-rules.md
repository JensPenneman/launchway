# 11. Domain activation and the edge rules

Date: 2026-10-07

## Status

Accepted

## Context

The domains module and the edge module meet in two places: the edge decides
which domains to render from their DNS status, and it reports back which
domains it serves. The deployments module and the edge renderer also both
decide whether an app is reached on the proxy network or on its node's LAN
address. The authors' rules differed in a few details that only show once the
modules run together.

## Decision

1. **Statuses.** A domain is `pending` (not checked yet), `verified` (the DNS
   preflight passed), `misconfigured` (it failed, with a message) or `active`.
   The spec's working names `dns_ok` and `error` map to `verified` and
   `misconfigured`.
2. **Rendering.** The edge renders a route when its domain is `verified` or
   `active`, or when the domain is `force`d. Forced domains are served but keep
   their DNS status.
3. **`active` means served.** After every reconciliation whose configuration
   Caddy holds, whether it was reloaded or was already loaded, the edge marks
   each rendered `verified` domain `active`. It does not wait for the
   certificate: Caddy obtains and renews certificates on its own, and failures
   show in the Caddy logs. Activation only touches `verified` domains, so the
   status change cannot trigger another reload loop. A manual or periodic DNS
   check keeps an `active` domain `active` while it passes.
4. **No edge node.** When `settings.edgeNodeId` is not set, every app counts
   as running on the edge: the renderer uses `<slug>-<service>:<port>` on the
   proxy network and the deploy payload publishes nothing on the LAN
   (`publishOnIp: null`). The installer's bundled agent makes the local node
   the edge on first start, so this only matters for hand-made setups.
5. **Routes attach at deploy time.** The agent attaches routed services to the
   proxy network, and publishes their ports on a non-edge node, while it
   deploys. A route added to a service of a running app therefore takes effect
   with the next deployment; the UI says so when the route is created.

## Consequences

- The UI shows `active` as "served by the edge", not as "certificate issued".
  Surfacing certificate state needs Caddy's events or its certificate cache
  (roadmap).
- A domain that is forced first and fixed later becomes `active` on the next
  reconciliation, without a reload.
- Making a new route work without a redeploy would need a live network attach
  on the node (`docker network connect`) and a protocol message for it.
