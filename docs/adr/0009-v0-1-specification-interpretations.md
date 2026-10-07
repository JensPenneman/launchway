# 9. Interpretations of the v0.1 specification

Date: 2026-10-06

## Status

Accepted

## Context

Implementing v0.1 surfaced points that [architecture.md](../architecture.md)
leaves open or that can be read in more than one way. The API, the agent and
the UI are built in parallel and need one answer for each. None of these
interpretations contradicts the specification; they narrow it.

## Decision

1. **Deployment states (§2).** `cancelled` is reachable only from the
   in-progress states `queued`, `cloning`, `building` and `starting`.
   `running` is left only for `superseded` or `stopped`. `failed` is reachable
   only from the in-progress states, as drawn.
2. **Agent protocol (§9).**
   - A generic `error` message exists in both directions, with payload
     `{ code, message, retryable }`, echoing the `id` of the request it
     answers; for example `not-implemented` or `incompatible-protocol`.
   - The server can send `deployment.cancel`.
   - `stop`, `remove` and `status` are answered with `app.status`.
   - `logs.chunk` and `logs.end` echo the `id` of `logs.start`; `logs.stop`
     names that stream `id` in its payload.
   - `deployment.result` is a union on `outcome`: `succeeded`, `failed` or
     `cancelled`.
   - The agent prunes old checkouts itself after reporting a result and keeps
     the last two, since the checkouts live on the node (§4, step 5).
   - `LAUNCHWAY_SERVER_URL` is a base URL; the agent appends `/api/agent/ws`.
3. **Local node bootstrap.** The installer generates
   `LAUNCHWAY_LOCAL_JOIN_TOKEN` and passes it to the API, and to the bundled
   agent as `LAUNCHWAY_JOIN_TOKEN`. The API accepts it once, only from the
   Docker network, for the local edge node. It has no 15-minute expiry.
4. **Problem types (§10).** RFC 9457 `type` values are the bare stable slugs,
   as relative URI references: `"type": "not-found"`.
5. **Environment variables (§2, §14).** All values are encrypted at rest;
   `secret` only controls whether the API ever returns the value.
6. **Settings (§2).** Platform settings are a singleton row with typed
   columns.
7. **Hashed tokens (§7, §14).** The session cookie carries a random token,
   stored as a SHA-256 hash; each session also has a separate public `sess_…`
   ID. Join tokens, node credentials, invitation tokens and API tokens are
   likewise stored hashed.
8. **Keys (§13, §14).** Subkeys are derived from `LAUNCHWAY_SECRET_KEY` with
   HKDF-SHA256, with separate `info` labels for secret encryption and cookie
   signing. Ciphertexts have the format `v1.<iv>.<ciphertext>.<tag>`
   (base64url), with optional additional authenticated data that binds a
   value to its owning record.
9. **Extra configuration (§13).** `LAUNCHWAY_ACME_EMAIL` is the default ACME
   e-mail and also feeds the Caddy bootstrap file. `LAUNCHWAY_LOCAL_JOIN_TOKEN`
   is described in point 3. `LAUNCHWAY_WEB_ROOT` is the directory of the built
   UI (image default `/app/web`).
10. **Supporting tables (§2).** Besides the listed entities, the schema stores
    deployment log lines and GitHub webhook deliveries (replay protection).
11. **Routes (§2, §5).** The target is discriminated by `kind`: `app`,
    `external` or `redirect`. A domain has one route. Defaults:
    `compress: true`, `hsts: true`, `protected: false`.
12. **Domain status.** `pending`, `verified` or `misconfigured`.
13. **API docs (§10).** The Scalar page loads its UI bundle from a CDN for
    now; self-hosting it is a follow-up.

14. **Active deployment (§2).** `App.activeDeploymentId` is derived rather
    than stored: it is the app's single deployment in `running`, enforced by a
    partial unique index on `deployments (app_id) WHERE status = 'running'`.
    It cannot go stale, and no circular foreign key between `apps` and
    `deployments` is needed. A newer deployment marks the previous one
    `superseded` before it becomes `running`, in one transaction.
15. **Reserved names on the proxy network (§3).** Compose registers every
    service name as a DNS alias on each network a service joins. App slugs
    `launchway`, `caddy`, `db` and `agent` and routed service names `launchway`,
    `launchway-agent`, `caddy` and `db` are therefore rejected by the contracts,
    so an app cannot capture traffic meant for the platform.
16. **Trusted proxies in the bundled compose file (§13).** The API default
    remains `10.210.0.0/24`, but `deploy/compose.yaml` trusts only Caddy's fixed
    address `10.210.0.2/32`, because app containers share the proxy network
    and could otherwise forge `X-Forwarded-For`.
17. **Image builds (§12).** `pnpm deploy` runs with
    `--config.inject-workspace-packages=true` in the Dockerfiles only. pnpm 11
    makes deploys self-contained only with injected workspace packages, while
    development keeps them symlinked for the `@launchway/source` live types.

## Consequences

- A crashed container does not change the state of a `running` deployment;
  the agent reports it through `app.status`.
- The protocol additions are part of the `@launchway/contracts` schemas, so the
  API and the agent cannot disagree about them.
- The local join token never leaves the host and works only from the Docker
  network, so it needs no expiry; once used, it cannot register another node.
- Bare slugs keep problem types short and independent of the host name.
  Clients compare them as strings; they are not documentation URLs.
- Since every environment value is encrypted, marking a variable as secret,
  or no longer secret, needs no re-encryption.
- Separate derived keys keep one key from serving two purposes, and the `v1`
  prefix leaves room for a new format or key rotation.
- The API docs page needs internet access in the viewer's browser until its
  bundle is self-hosted. The API itself does not depend on the CDN.
- The architecture document should absorb these points in its next revision.
- Reserved names are enforced by schema validation, in the API and on the
  agent, which receives the same `deploy` contract.
