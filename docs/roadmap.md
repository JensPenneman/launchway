# Roadmap

Known gaps and follow-ups after the v0.1 integration, grouped by area. They
come from the module authors' notes and from the full-stack smoke test. Larger
features that are deliberately out of scope for v0.1 are listed in
[architecture.md §15](architecture.md#15-deliberately-later).

## Accounts and security

- WebAuthn challenges and rate-limit buckets live in process memory. That is
  fine for the single API instance of v0.1; several instances need a shared
  store (a PostgreSQL table or similar).
- Agent WebSocket upgrades are not rate-limited on failed authentication and
  are not restricted to the Docker networks (§14). The local bootstrap token is
  likewise accepted from anywhere that reaches the API ([ADR 0010](adr/0010-composition-root-wiring.md)).
- Changing the e-mail address (`PATCH /me`) does not ask for the password again.
- Logout and session revocation are audited but publish no change event; there
  is no `sessions` topic.
- Expired sessions and expired, unaccepted invitations are never deleted; add a
  periodic clean-up job.
- `GET /users`, `/audit` and `/invitations` require `admin`. A slimmer
  viewer-level endpoint would let the UI show user names (audit actors) to
  everyone.
- argon2 ships no prebuild for Intel Macs (`darwin-x64`); developers there need
  `argon2: true` in `allowBuilds` and a C++ toolchain.
- `@simplewebauthn/server` logs a harmless Node `ExperimentalWarning` on first
  use; silence it if it clutters the logs.

## GitHub, apps and deployments

- Restarting the API while a deployment runs fails it ("node went offline")
  when the API marks stale nodes offline at start; the agent's later result is
  ignored because the deployment is already terminal. Use
  `heartbeat.activeDeploymentIds` after a reconnect, or accept late results for
  deployments the agent still reports, before failing them.
- A route added to a running app works only after the next deployment
  ([ADR 0011](adr/0011-domain-activation-and-edge-rules.md)). Attach networks
  live, or persist a "redeploy required" flag (also for environment and source
  changes, which today only publish an `apps` event with `redeployRequired`)
  and show it as a banner in the UI.
- Creating or updating an app does not check that the repository is reachable
  through the connection; a wrong repository only shows when a deployment
  resolves its ref.
- Auto-deploy skips prereleases and drafts, and the release poller (token
  connections) only looks at `/releases/latest`. Make both per-app options.
- Release-driven deployments use the trigger `auto`; add `release` to
  `DEPLOYMENT_TRIGGERS` (with a migration) if the distinction matters.
- Webhook deliveries of apps whose installation was removed still pass the
  signature check; their release events fail to resolve the ref (logged).

## Agent

- File-based `configs:`/`secrets:` inside the checkout pass the policy, but
  Compose bind-mounts them from the Docker host, where the agent's workspace
  volume path does not exist. Document a host bind mount of the workspace or
  reject such files.
- `docker compose logs` merges stdout and stderr, so app log lines always
  report `stdout`. Per-stream output needs the Docker API with demuxing.
- Deployment build output has no line-rate cap (log streams do).
- Checkout pruning orders directories by deployment id (UUIDv7). Ids created
  in the same millisecond are not ordered; harmless in practice.

## Nodes and edge

- Credential rotation is not crash-safe: the new credential reaches the agent
  before the commit and there is no grace period for the old one. If either
  side fails half-way, the node needs a new join token.
- The bundled agent's node is found by its name, `local`. Renaming it makes the
  next start create a second `local` node.
- The UI shows `active` domains as served, not certificate state. Surface
  certificate issuance and renewal errors from Caddy.
- `forward_auth` copies only the `X-Auth-Request-User`, `-Email` and `-Groups`
  headers (oauth2-proxy style). Other gates may need other headers or a login
  redirect (`handle_errors`).
- Without Caddy (development), every relevant change logs an edge load error;
  log an unreachable admin API at `warn`.

## DNS and domains

- Creating a domain calls the provider before inserting the row. If the insert
  then fails with anything but a unique violation, the record stays at the
  provider. Upsert also takes over an existing CNAME of the same name, which is
  then deleted with the domain.
- `GET /dns/ddns` keeps `lastRun` in memory (per process, reset on restart);
  the public IPv4 itself is stored in the settings.
- Deleting a DNS provider account, or a zone disappearing on sync, leaves the
  records at the provider; the affected domains become unmanaged.
- Members can manage DNS provider accounts (credentials). Consider making that
  admin-only.
- The DNS and domain jobs start inside their modules (guarded by the
  environment) while the deployment worker and the release poller start in the
  composition root; move them there for consistency.

## Web UI

- No UI to edit a DNS provider account (rename, new credentials) or a domain's
  `proxied` flag after creation.
- Passkey registration and sign-in are not covered by Playwright; add a test
  with a CDP virtual authenticator.
- The audit log's `since`/`until` filters are not exposed.
- `@slipway/contracts` brings all of Zod and zod-to-openapi into the bundle
  (about 120 kB gzip); a browser entry without the OpenAPI extension would
  shrink it.
- Run the integration-time check that compares the UI's API calls with the
  OpenAPI document in CI ([ADR 0013](adr/0013-web-ui-data-layer.md)).
- The API tokens tab is shown from `member` up, while the API also lets
  viewers create read-only tokens.

## Operations and delivery

- The API reference page (Scalar) loads an exact version of its bundle from a
  CDN with an SRI hash; Dependabot does not update that pin. Self-host the
  bundle (and serve the page with a CSP) if outbound access must be avoided.
- Recommend a backup schedule and retention, and add scheduled, encrypted
  backups of app volumes (§15).
- Release images are published by the image workflow once the GitHub
  repository and its first release exist.
