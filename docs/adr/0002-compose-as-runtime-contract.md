# 2. Compose is the runtime contract

Date: 2026-10-06

## Status

Accepted

## Context

Slipway runs its owner's apps as well as third-party software such as a mail
server or a media tool ([architecture.md](../architecture.md) §1). Most
self-hostable software already ships a Compose file, and multi-service apps
need networks, volumes, health checks and start order. A Slipway-specific
manifest would have to describe all of that again and be written for every
upstream project. Every node already runs Docker, and the agent image carries
the Docker CLI with the Compose plugin (§9).

## Decision

The Compose file in the app's repository is the runtime contract (§1, §4).

- An app declares `composeFiles` (paths relative to the repository root,
  default `["compose.yaml"]`, merged in order) or a `dockerfile` with a
  `context`. For the latter, Slipway synthesizes the one-service file
  `services: { app: { build: { context, dockerfile } } }`.
- Slipway never edits the repository's files. Next to the checkout, the agent
  writes `.env` (mode `0600`) with the app's environment variables and an
  override file, `compose.slipway.yaml`, which:
  - attaches routed services to the external network `slipway-proxy` under the
    alias `<slug>-<service>` (a DNS label of at most 63 characters);
  - adds the labels `slipway.app`, `slipway.deployment` and `slipway.service`;
  - on nodes other than the edge, publishes each routed port on the node's LAN
    IP so that the edge can reach it.
- Each app is the Compose project `slipway-<slug>`, run as
  `docker compose -p slipway-<slug> --project-directory <dir> -f … build --pull`,
  then `pull`, then `up -d --wait --remove-orphans`.
- Before anything runs, the agent checks the merged model printed by
  `docker compose config` against a policy: no host bind mounts, no
  `privileged`, no `network_mode: host`, no `pid: host`, no capabilities beyond
  a small `cap_add` allow-list. Named volumes, `configs:` with inline `content`
  and published `ports:` are allowed; published ports are reported back.
- The slugs `slipway`, `caddy`, `db` and `agent` are reserved, so that app
  aliases and project names cannot collide with the platform's own containers
  on `slipway-proxy`. Without this, the slug `slipway` with a service `agent`
  would produce the alias `slipway-agent`.

## Consequences

- Any Compose app can be deployed unchanged if it passes the policy, and the
  repository still runs with a plain `docker compose up` outside Slipway.
- Apps that need host bind mounts, host networking or privileged mode cannot
  be deployed; configuration files move into named volumes or inline
  `configs:`.
- The policy is enforced on the agent, the component that talks to Docker, not
  only in the UI (§14).
- Slipway depends on Compose CLI behavior (`config` output, `--wait`). The
  Compose version is the one in the agent image, so it changes with Slipway
  releases rather than with each node's Docker installation.
- Published ports can clash between apps on one node; Docker then fails the
  deployment.
- Hyphens are valid in both slugs and service names, so two apps can produce
  the same alias (`shop` with `api-db` and `shop-api` with `db` both give
  `shop-api-db`). Alias uniqueness must be checked across apps, not assumed.
- Rollback is a new deployment of an older ref; images cached on the node keep
  it fast.
