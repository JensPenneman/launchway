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
- Revoking the `local` node's credential is undone at the next API start:
  `ensureLocalNode` re-arms `LAUNCHWAY_LOCAL_JOIN_TOKEN`, which never expires.
  Persist a "bootstrap disabled" flag on revoke (schema change) and re-arm only
  a node that never joined; document removing the token from `.env` after the
  first join.
- Agents accept `ws://` server URLs for remote nodes, and the join snippets use
  `ws://` when the public URL is `http`, so credentials, deploy payloads and
  secrets can cross the network unencrypted. Require `wss://` except for
  loopback and the bundled agent, or an explicit opt-in.
- On Docker Desktop (macOS, Windows) every client of the direct port shares
  the VM gateway's address, so they share one per-IP login bucket and audit
  rows record that address. Document that the direct port is for the first
  setup only.
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

- A deployment whose result was lost is failed after two heartbeats leave it
  out, even if it succeeded; the containers then run while the database shows
  the previous deployment. Ask the agent for the app status before settling.
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
- Members can still change the source of a trusted app (connection,
  repository, Compose files), which inherits the admin's mount trust
  ([ADR 0015](adr/0015-trusted-mounts-are-an-explicit-admin-decision.md)).
  Consider requiring the admin role for source changes while `trustedMounts`
  is on.

## Agent

- File-based `configs:`/`secrets:` inside the checkout pass the policy, but
  Compose bind-mounts them from the Docker host, where the agent's workspace
  volume path does not exist. Document a host bind mount of the workspace or
  reject such files.
- `docker compose logs` merges stdout and stderr, so app log lines always
  report `stdout`. Per-stream output needs the Docker API with demuxing.
- Deployment build output has no line-rate cap (log streams do).
- Checkout pruning orders directories by deployment id (UUIDv7). Ids created
  in the same millisecond are not ordered; harmless in practice. It also keeps
  the newest two checkouts rather than the running one: record the last
  successful deployment per app and always keep it (matters once file-based
  configs are bind-mounted from the workspace).
- The app's `.env` (secrets included) is written into the checkout, which is
  the default build context: a Dockerfile with `COPY . .` bakes the secrets
  into an image layer. Write it outside the checkout (mode 0600) and pass
  `--env-file`.
- The Compose policy is a deny-list over `docker compose config` output, and
  `build`/`up` re-read the project afterwards (a remote `include:` may serve
  different content then). Run them against the exact checked document, and
  move the service schema to an allow-list of known keys so new Compose
  features fail closed.
- Trusted apps may bind-mount below the node's allowed roots, but local-driver
  volumes with `o=bind` or a `device` below such a root are still refused.
- Compose gives every service its bare service name as a DNS alias on each
  network it joins, the shared proxy network included. Two apps that both
  attach a service called `app` therefore both answer to `app` there, and a
  container on the proxy network that looks up `app` may reach the other
  app's service; only the `<slug>-<service>` aliases are checked for
  collisions (`assertAliasesFree`). Options: keep app-internal traffic on the
  app's own network and put only the `<slug>-<service>` alias on the shared
  network, which needs control over the aliases there (the override can only
  add aliases, so the agent would attach the proxy network itself, for
  example with `docker network connect --alias <slug>-<service>` after `up`);
  or refuse, when a route, proxy service or forward-auth target is created,
  a service name that another app already attaches to the proxy network.

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
- The `redeploy-required` hint after a forward-auth target change is judged
  from configuration (routes, `proxyServices`, the previous target), not from
  the containers on the node. Recording the attached services per deployment
  (or the networks in `ServiceStatus`) would make it exact.
- A forward-auth target on an app that is not on the edge node keeps protected
  routes offline (fail closed). Supporting it needs the gate port published on
  the LAN like routed ports.
- Without Caddy (development), every relevant change logs an edge load error
  and failed loads are retried with backoff (up to every 5 minutes); log an
  unreachable admin API at `warn`.

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
- `@launchway/contracts` brings all of Zod and zod-to-openapi into the bundle
  (about 120 kB gzip); a browser entry without the OpenAPI extension would
  shrink it.
- Run the integration-time check that compares the UI's API calls with the
  OpenAPI document in CI ([ADR 0013](adr/0013-web-ui-data-layer.md)).
- The API tokens tab is shown from `member` up, while the API also lets
  viewers create read-only tokens.
- No Playwright test covers the forward-auth radio (external URL or app
  service) or the extra-directives editor yet.

## Operations and delivery

- The API reference page (Scalar) loads an exact version of its bundle from a
  CDN with an SRI hash; Dependabot does not update that pin. Self-host the
  bundle (and serve the page with a CSP) if outbound access must be avoided.
- Recommend a backup schedule and retention, and add scheduled, encrypted
  backups of app volumes (§15).
- Release images are published by the image workflow once the GitHub
  repository and its first release exist.
- Base images are `ARG`-templated major tags (`node:24-alpine`,
  `docker:29-cli`), which Dependabot cannot update and which are not
  reproducible. Use literal, digest-pinned references.
- Trivy only reports (SARIF) after the images are pushed and signed, for
  amd64 only. Add a gating scan (`exit-code: 1` on fixable CRITICAL) to the
  CI image build.
- Dependabot ignores `msw` major updates because `@vitest/mocker` only
  accepts msw 2. Drop the ignore in `.github/dependabot.yml` and upgrade once
  vitest accepts msw 3.
- `pnpm-workspace.yaml` overrides `esbuild` under `@esbuild-kit/core-utils`
  (pulled in by drizzle-kit 0.31) to clear an advisory. Remove the override
  when moving to drizzle-kit 1.x, which drops `@esbuild-kit`.
