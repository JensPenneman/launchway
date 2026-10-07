# Slipway — architecture

Slipway is a self-hosted deployment platform: link a GitHub repository, pick a
release, and Slipway builds it, runs it on one of your machines, gives it a
domain with TLS, and keeps DNS pointed at your home connection. Everything is
reachable through a REST API; the web UI is only a client of that API.

This document is the contract between the people (and agents) building the
pieces. It describes the first release (v0.1). Later ideas are listed at the
end so that today's decisions do not block them.

> Naming: the project, packages, labels and environment variables all use the
> name **Slipway** (`slipway`, `SLIPWAY_*`, `@slipway/*`). Never describe the
> project by comparing it to a commercial hosting product.

## 1. Principles

1. **One source of truth: the API.** The UI, the CLI (later) and the node agent
   all speak to the same HTTP API. Nothing is possible in the UI that is not
   possible with `curl`. First-run setup included.
2. **Apps come from GitHub.** Every deployable thing is a GitHub repository.
   A deployment is a specific release (tag) of that repository. Third-party
   software (a mail server, a media tool) is deployed the same way: a small
   repository with a Compose file that pulls the upstream images.
3. **Compose is the runtime contract.** An app repository carries a Compose
   file (or just a `Dockerfile`, for which Slipway synthesizes a one-service
   Compose file). Slipway adds routing, networks, environment and lifecycle;
   it does not invent a new app manifest.
4. **Multi-node from day one, one node today.** The control plane manages
   *nodes*; each node runs an *agent* that owns Docker on that machine. The
   first installation runs the control plane and an agent on the same machine.
5. **Generic where providers differ.** DNS providers are plugins behind one
   interface (Cloudflare first). Git hosting is GitHub only for now, but sits
   behind a thin interface as well.
6. **Own your data.** PostgreSQL for state, encrypted secrets, no external
   services besides GitHub, the DNS provider and Let's Encrypt.
7. **Boring, well-trodden tech.** TypeScript end to end, Docker Compose, Caddy,
   PostgreSQL.

## 2. Domain model

| Entity | Purpose |
|---|---|
| **User** | A person with a login. Roles: `owner`, `admin`, `member`, `viewer`. |
| **Session** | Server-side session (cookie) for the UI. |
| **Passkey** | WebAuthn credential of a user. |
| **ApiToken** | Bearer token for scripts/CI; hashed at rest, shown once. |
| **Invitation** | Single-use invite link with a role. |
| **GitHubConnection** | How Slipway talks to GitHub: a GitHub App (preferred) or a fine-grained personal access token. |
| **App** | A deployable unit linked to one repository + Compose/Dockerfile location + target node. Has a URL-safe `slug`. |
| **EnvVar** | Per-app environment variable; `secret` ones are encrypted and never returned in clear text. |
| **Deployment** | One attempt to run a specific `ref` (tag, branch, or commit) of an app. Has a state machine and logs. |
| **Node** | A machine running the agent. Reports Docker info, LAN IP, architecture, health. One node is the `edge` (runs Caddy). |
| **DnsProviderAccount** | Credentials for one DNS provider (kind + encrypted credentials). |
| **DnsZone** | A zone discovered from a provider account (e.g. `example.com`). |
| **Domain** | A fully-qualified name Slipway serves (`trail.example.com`). Optionally bound to a zone so Slipway manages its record. |
| **Route** | What a domain serves: an app service port, an external host:port, or a redirect. Options: `protected` (forward auth), `compress`, `hsts`. |
| **Setting** | Platform settings: public URL, ACME e-mail, anchor hostname + dynamic DNS, forward-auth upstream, edge node. |
| **AuditEvent** | Who changed what, when, from where. Written for every mutation. |

IDs are prefixed type IDs (`typeid-js`, UUIDv7 underneath): `user_…`, `sess_…`,
`pk_…`, `tok_…`, `inv_…`, `gh_…`, `app_…`, `env_…`, `dep_…`, `node_…`, `prov_…`,
`zone_…`, `dom_…`, `rt_…`, `aud_…`.

### Deployment state machine

```
queued ──▶ cloning ──▶ building ──▶ starting ──▶ running ──▶ superseded
   │           │           │            │           └──────▶ stopped
   └───────────┴───────────┴────────────┴──────────────────▶ failed
   (any non-terminal state) ───────────────────────────────▶ cancelled
```

`App.activeDeploymentId` points at the `running` deployment. A newer
deployment reaching `running` marks the previous one `superseded`. A rollback is
simply a new deployment of an older ref (images are cached, so it is fast).

## 3. System architecture

```
                 internet
                    │  80/443 (router forward)        GitHub (webhooks, API, git)
                    ▼                                        ▲
 ┌──────────────────────────────── edge node ────────────────┼──────────────────┐
 │  Caddy (edge)  ◀── Caddyfile via admin API ──  API (control plane)  ─▶ PostgreSQL│
 │     │ slipway-proxy network                        ▲  ws                      │
 │     ├──▶ app containers (same node)                │                          │
 │     └──▶ <lan-ip>:<port> of apps on other nodes    │                          │
 │  Agent (node 1) ── docker socket ── Docker ────────┘                          │
 └───────────────────────────────────────────────────────────────────────────────┘
 ┌──────── node 2 ────────┐   agents connect *outbound* over WebSocket, so
 │ Agent ── Docker        │   nodes behind NAT or on other networks work.
 └────────────────────────┘
```

Components and where they run:

| Component | Package | Runs as | Notes |
|---|---|---|---|
| Control plane API | `apps/api` | container `slipway` | Hono on Node 24. Serves the built UI as static files at `/`, the API at `/api/v1`, OpenAPI at `/api/openapi.json`, docs at `/api/docs`. |
| Web UI | `apps/web` | built into the `slipway` image | React SPA. Same origin as the API — no CORS. |
| Node agent | `apps/agent` | container `slipway-agent` on every node | Mounts the Docker socket and a workspace volume. Clones, builds, runs Compose projects, streams logs. |
| Edge proxy | `caddy:2-alpine` | container on the edge node | Config pushed by the API through the admin API (`POST /load`, `text/caddyfile`). Persists its last config and resumes on restart. |
| Database | `postgres:18-alpine` | container on the control-plane node | Drizzle ORM; migrations run at API start. |

Docker networks: the installer creates the external network `slipway-proxy`
(default subnet `10.210.0.0/24`, Caddy fixed at `10.210.0.2`). Every routed app
service is attached to it under the alias `<app-slug>-<service>`. Compose
project names are `slipway-<app-slug>`. Containers carry labels
`slipway.app`, `slipway.deployment`, `slipway.service`.

The control plane itself (`deploy/compose.yaml`: `slipway`, `slipway-agent`,
`caddy`, `db`) is installed by `deploy/install.sh` (Linux/macOS) or
`deploy/install.ps1` (Windows with Docker Desktop). Upgrades pull newer images
of the same compose file. The API listens on `0.0.0.0:3000` inside the
network and is published on the host (default `3000`) so the first setup
works before any domain exists.

## 4. Deployment model

### Source

An app points at `owner/repo` through a GitHubConnection and declares:

- `composeFiles`: list of paths relative to the repository root
  (default `["compose.yaml"]`; Compose merges them in order), **or**
- `dockerfile` + `context` when there is no Compose file. Slipway then
  synthesizes `services: { app: { build: {context, dockerfile} } }`.
- `nodeId`: the node that runs it (v0.1 placement = explicit choice).

Deployable refs: GitHub **releases** (tags) first-class — list, pick, deploy.
Branch heads and raw commits are accepted too (`ref` is a string; the API
resolves it to a commit SHA at deployment creation). Optional per app:
`autoDeployReleases: true` deploys every `release.published` webhook event.

### What the agent does for one deployment

1. `git clone --depth 1 --branch <ref>` (or fetch a SHA) into
   `/var/lib/slipway/apps/<appId>/<deploymentId>`. Credentials are passed with
   `-c http.extraHeader="Authorization: basic <token>"`, never written to disk.
   *(v0.1 passes the same setting through the `GIT_CONFIG_*` environment of
   the `git` process, which keeps it out of the process list.)*
2. Policy check with `docker compose config` on the merged files. Rejected:
   host bind mounts (named volumes and `configs:` with inline `content` are
   fine), `privileged`, `network_mode: host`, `pid: host`, capabilities beyond
   `cap_add` of a small allow-list. Published `ports:` are allowed (a mail
   server needs 25/465/993) and reported back so the UI can show them.
   *(v0.1's policy refuses more, for example devices and device cgroup rules,
   namespaces and networks outside the project, host-path volume drivers and
   files outside the checkout; see `apps/agent/src/runtime/compose-policy.ts`.
   Reserved service names are only refused for routed services.)*
3. Write `.env` (mode 0600) from the app's environment variables and the
   override file `compose.slipway.yaml`: attaches routed services to
   `slipway-proxy` with their aliases, adds the labels, and — when the app is
   not on the edge node — publishes each routed service port on the node's
   LAN IP so the edge can reach it. *(While no edge node is set, every app
   counts as on the edge. Routes are applied here, so a route added to a
   running app takes effect with its next deployment;
   [ADR 0011](adr/0011-domain-activation-and-edge-rules.md).)*
4. `docker compose -p slipway-<slug> --project-directory <dir> -f … build --pull`
   then `pull`, then `up -d --wait --remove-orphans`. Every line of output is
   streamed as a log line.
5. Report the result: per service the container ID, state, health and
   published ports. The control plane marks the deployment `running`,
   supersedes the previous one, regenerates the edge config, and prunes old
   checkout directories (keeps the last two).

Rollback = redeploy an older ref. Stop/remove an app = `compose down`
(`--volumes` only on explicit "delete data").

## 5. Edge, TLS and public exposure

- **Caddy** is the only owner of ports 80/443(+udp) on the edge node. The API
  renders a Caddyfile from the active routes and loads it through the admin
  API (`/adapt` to validate, then `/load`), over a unix socket shared only by
  the `caddy` and `slipway` containers. Per route:

  ```caddy
  trail.example.com {
  	import gate           # only when route.protected
  	encode zstd gzip      # only when route.compress
  	header ?Strict-Transport-Security "max-age=31536000"   # route.hsts
  	reverse_proxy trail-app:8080
  }
  ```

  The platform's own domain (`Setting.publicUrl`) is rendered the same way with
  upstream `slipway:3000`. `(gate)` is `forward_auth <Setting.forwardAuthUrl>`
  — an existing passkey gate such as oauth2-proxy + Pocket ID, deployed as a
  normal Slipway app and reachable on `slipway-proxy`.
- **Certificates**: Let's Encrypt through Caddy (`email`, `cert_issuer acme`
  so no fallback CA is tried — the zone's CAA may allow only Let's Encrypt).
  A route is only rendered once its domain passed the **DNS preflight**
  (resolves to the current public IPv4 / to the anchor), unless the user
  forces it. This avoids burning ACME attempts on misconfigured names.
  *(v0.1: a verified domain becomes `active` once the edge serves it. Protected
  routes are skipped while no forward-auth URL is set, and so are routes on
  the platform's own host name; redirects answer 308 or 307;
  [ADR 0011](adr/0011-domain-activation-and-edge-rules.md).)*
- **Anchor hostname + dynamic DNS**: `Setting.anchorHostname`
  (e.g. `home.example.com`) holds the public IPv4 as an `A` record. The
  API detects the public IPv4 every 5 minutes (two independent HTTP services,
  agree-or-skip) and updates the record through the DNS provider of its zone
  when it changed. Managed app domains are created as `CNAME <anchor>`
  (DNS-only / not proxied by default; `proxied` is a per-record option exposed
  by providers that support it).
- Routes to apps on other nodes use upstream `<node.lanIp>:<publishedPort>`.
  Routes of kind `external` use whatever `host:port` the user entered
  (e.g. `host.docker.internal:7878` for a service on the Windows host).

## 6. Domains and DNS providers

```ts
export interface DnsProvider {
  readonly kind: string;                       // "cloudflare", "manual", …
  readonly capabilities: { proxied: boolean; ttl: boolean; };
  listZones(): Promise<DnsZoneInfo[]>;
  listRecords(zoneExternalId: string): Promise<DnsRecord[]>;
  upsertRecord(zoneExternalId: string, record: DnsRecordInput): Promise<DnsRecord>;
  deleteRecord(zoneExternalId: string, recordExternalId: string): Promise<void>;
  verifyCredentials(): Promise<void>;
}
```

- A **registry** maps `kind` → `{ credentialsSchema: ZodSchema, create(creds) => DnsProvider, label, docsUrl }`.
  The API exposes the registry (`GET /dns/providers`) with JSON Schema for the
  credentials so the UI renders the "add provider account" form generically.
- v0.1 providers: `cloudflare` (API token; zones, A/AAAA/CNAME/TXT records,
  `proxied`) and `manual` (no API — the UI shows the records the user must
  create and Slipway only verifies them).
- Adding a provider = one file in `apps/api/src/modules/dns/providers/` plus a
  registry entry and a contract test against the interface.
- Record types in v0.1: `A`, `AAAA`, `CNAME`, `TXT` (TXT for future ACME DNS-01
  and domain verification).

## 7. Accounts and authentication

- **First run**: `GET /api/v1/setup` reports whether an owner exists;
  `POST /api/v1/setup` creates the owner (only while no user exists).
- **Passwords**: argon2id. **Passkeys**: WebAuthn via `@simplewebauthn`
  (registration from the account page, discoverable credentials, sign-in
  without typing an e-mail). Both are available; passkeys are the preferred
  path and the UI leads with them.
- **Sessions**: opaque ID in cookie `slipway_session`
  (HttpOnly, SameSite=Lax, `Secure` when served over HTTPS), stored in
  PostgreSQL, 30-day sliding expiry, revocable from the account page.
- **CSRF**: cookie-authenticated mutating requests must carry an `Origin` /
  `Sec-Fetch-Site` that matches the platform origin. Bearer requests are exempt.
- **API tokens**: `slp_` + 32 random bytes (base62). SHA-256 hash at rest,
  plaintext returned once. Scopes: `read`, `write`, `admin`; optional expiry;
  last-used timestamp.
- **Roles**: `owner` (everything, cannot be removed), `admin` (everything
  except user/role management of owners), `member` (manage apps, deployments,
  domains), `viewer` (read-only). Enforced in one middleware with a per-route
  declaration.
- **Invitations**: admin creates an invite (role, expiry) → link → invitee sets
  name + password/passkey.
- **Rate limits** on setup, login, passkey and token endpoints.
- **Audit log** for every mutation (actor, action, target, IP, user agent,
  diff summary).

## 8. GitHub integration

- **GitHub App (preferred)**: Slipway creates its own GitHub App through the
  *manifest flow*: the UI posts a manifest to
  `https://github.com/settings/apps/new?state=…`, GitHub redirects back with a
  `code`, the API exchanges it (`POST /app-manifests/{code}/conversions`) and
  stores `appId`, `clientId`, `clientSecret`, `privateKey`, `webhookSecret`
  (encrypted). Then the user installs the app on their account and selects
  repositories; the `installation_id` arrives on the setup redirect. Repository
  listing, release listing, clone tokens and webhooks all use installation
  tokens (`@octokit/app`, `@octokit/rest`).
- **Personal access token (fallback)**: a fine-grained PAT with
  `Contents: read`, `Metadata: read`. Same interface, no webhooks (polling
  releases every 5 min when `autoDeployReleases` is on).
- **Webhooks** at `POST /api/v1/webhooks/github`: HMAC `X-Hub-Signature-256`
  verified with timing-safe comparison; events handled: `release`
  (published → deployment when auto-deploy is on), `installation`,
  `installation_repositories`, `ping`. *(v0.1 does not auto-deploy drafts or
  prereleases; such deployments carry the trigger `auto`.)*
- The GitHub side sits behind `interface GitProvider { listRepos; listReleases;
  resolveRef; cloneCredentials; }` so another host could be added later.

## 9. Node agent

- Image `ghcr.io/jenspenneman/slipway-agent`. Runs with `/var/run/docker.sock`
  and a named volume at `/var/lib/slipway`. Needs the `docker` CLI with the
  Compose plugin inside the image, plus `git`.
- **Join**: the UI creates a node and shows a one-time join token
  (`slpn_…`, 15-minute validity) and a ready-made `docker run …` / compose
  snippet. The agent connects to `wss://<publicUrl>/api/agent/ws` (or an
  internal URL on the same host) with the join token; the server replies with
  a long-lived node credential that the agent persists in
  `/var/lib/slipway/agent/credentials.json` (mode 0600). Credentials can be
  rotated and revoked from the UI. *(v0.1: the bundled agent's bootstrap token
  stays valid, and an agent whose stored credential is refused joins again
  with its join token; [ADR 0010](adr/0010-composition-root-wiring.md).)*
- **Protocol**: JSON messages `{ id, type, payload }` over WebSocket, schemas
  in `@slipway/contracts` (`agent/*`). Agent → server: `hello`, `heartbeat`
  (15 s), `deployment.progress`, `deployment.log`, `deployment.result`,
  `app.status`, `logs.chunk`, `logs.end`. Server → agent: `hello.ok`,
  `deploy`, `stop`, `remove`, `status`, `logs.start`, `logs.stop`. Request
  types carry the `id` the reply must echo. Unknown message types are
  ignored with a warning (forward compatibility); `hello` carries the
  protocol version and the server refuses incompatible agents with a clear
  error that the UI shows.
- Reconnects with exponential backoff and jitter; the server marks a node
  `offline` after 45 s without heartbeat. A deployment addressed to an offline
  node stays `queued` until the node has been gone for 10 minutes, then
  `failed`; waiting behind another deployment on an online node never times
  out. *(v0.1: a disconnected node has 45 s to reconnect before its in-progress
  deployments fail, since the agent keeps running them. The agent answers
  `deploy` at once with a log line, and the server compares the heartbeat's
  `activeDeploymentIds` with the database: a deployment left out of two
  heartbeats is failed (its result was lost) or, if never started, re-sent.)*
- All process execution uses `execFile` with argument arrays — never a shell
  string. Refs match `^[A-Za-z0-9._/-]+$` and may not start with `-`.
  Environment values are never logged.
- The agent is root-equivalent on its node (it owns Docker). Protecting the
  node credential and the TLS edge is what protects the node.

## 10. API conventions

- Base path `/api/v1`. JSON only. OpenAPI 3.1 generated from the Zod route
  schemas (`@hono/zod-openapi`), served at `/api/openapi.json`; interactive
  docs (Scalar) at `/api/docs`. Internal endpoints used by the edge
  (`/internal/*`) are not part of the public spec and only accept requests
  from the Docker network. *(v0.1 has no internal endpoints.)*
- Errors are RFC 9457 problem details (`application/problem+json`) with stable
  `type` slugs (`validation-failed`, `not-found`, `forbidden`, `conflict`,
  `rate-limited`, …).
- Lists are cursor-paginated: `?limit=&cursor=` → `{ items, nextCursor }`.
- Streams use Server-Sent Events: `GET /deployments/{id}/logs?follow=true`,
  `GET /apps/{id}/logs?service=&follow=true`, `GET /events` (platform-wide
  change feed the UI uses to refresh).
- Authentication: session cookie **or** `Authorization: Bearer slp_…`.
- Health: `GET /api/health/live` (process up) and `/api/health/ready`
  (database reachable).
- Resource overview (all under `/api/v1`):
  `setup`, `auth/*` (login, logout, passkeys), `me`, `users`, `invitations`,
  `tokens`, `settings`, `audit`, `github/connections`, `github/repos`,
  `github/repos/{owner}/{repo}/releases`, `apps`, `apps/{id}/env`,
  `apps/{id}/deployments`, `deployments/{id}`, `deployments/{id}/logs`,
  `deployments/{id}/cancel`, `domains`, `domains/{id}/verify`, `routes`,
  `dns/providers`, `dns/accounts`, `dns/zones`, `dns/zones/{id}/records`,
  `nodes`, `nodes/{id}/join-token`, `edge/config` (rendered Caddyfile, read-only),
  `webhooks/github`.

## 11. Web UI

React 19 + Vite + TypeScript, TanStack Router (file-based routes) and TanStack
Query, Tailwind CSS v4 + shadcn/ui components, react-hook-form + Zod. The API
client is generated from the OpenAPI document (`openapi-typescript` +
`openapi-fetch`) at build time so the UI cannot drift from the API. *(v0.1:
the UI's resource modules validate every response with the contract schemas
instead; [ADR 0013](adr/0013-web-ui-data-layer.md).)* Dark and
light theme. Pages: setup wizard · sign-in (passkey first, password fallback) ·
overview · apps (list, create wizard: connection → repository → compose
location → node) · app detail (deployments with live logs, environment,
domains & routes, settings, danger zone) · domains (zones, records, managed
domains with DNS/TLS status) · nodes (list, add node with join snippet,
detail) · settings (account, passkeys, API tokens, users & invitations, GitHub
connections, DNS provider accounts, platform settings) · audit log.

## 12. Repository, toolchain and delivery

- **Monorepo**: pnpm workspaces + Turborepo. `apps/api`, `apps/agent`,
  `apps/web`, `packages/contracts` (Zod schemas + types shared by all three),
  `packages/tsconfig`. ESM only, Node 24 LTS (`.node-version`, `engines`,
  `packageManager` for corepack).
- **TypeScript** strict (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), project references.
- **Lint/format**: Biome (one tool; `biome ci` in CI). **Tests**: Vitest
  (unit; integration against PostgreSQL via Testcontainers), Playwright for
  UI smoke tests. **Dead code**: knip.
- **Database**: Drizzle ORM + drizzle-kit; schema per module, migrations
  committed under `apps/api/drizzle`, applied at API start.
- **Git**: trunk-based on `main`, every change through a pull request,
  squash-merge with a Conventional Commits title. Branch ruleset: PR required,
  CI green, linear history, no force-push. Conventional Commits enforced by
  commitlint (lefthook `commit-msg`); `pre-commit` runs Biome on staged files;
  `pre-push` runs typecheck and unit tests.
- **Releases**: release-please (GitHub Action) opens a release PR from the
  conventional commits; merging it tags `vX.Y.Z`, publishes the GitHub
  Release with the changelog, and triggers the image workflow: multi-arch
  (`amd64`, `arm64`) images `ghcr.io/jenspenneman/slipway` and
  `ghcr.io/jenspenneman/slipway-agent`, with SBOM and provenance attestations,
  signed with cosign (keyless). `main` also publishes `:edge` images.
- **Security automation**: CodeQL, Dependabot (grouped weekly updates, incl.
  GitHub Actions and Docker base images), Trivy scan of built images, secret
  scanning + push protection enabled on the repository.
- **Repository hygiene**: `README.md`, `LICENSE` (Apache-2.0),
  `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, issue and PR templates,
  `docs/` (this file, `operations.md`, `development.md`, `adr/` with one
  Architecture Decision Record per significant decision), `.editorconfig`,
  `.vscode/` recommendations, `devcontainer.json`.
- **Docker images**: multi-stage, `node:24-alpine`, pnpm deploy with pruned
  production dependencies, non-root user, `HEALTHCHECK`, `init: true` in
  compose, read-only root filesystem where possible (not the agent).

## 13. Configuration

API (`slipway` container):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `SLIPWAY_SECRET_KEY` | — | 32 bytes, base64. AES-256-GCM key for secrets at rest; also derives the cookie signing key. Generated by the installer. |
| `SLIPWAY_LISTEN` | `0.0.0.0:3000` | Bind address |
| `SLIPWAY_PUBLIC_URL` | (from settings) | Overrides `Setting.publicUrl` (useful before setup) |
| `SLIPWAY_CADDY_ADMIN_URL` | `unix:///run/caddy-admin/admin.sock` | Edge admin API (`http://` only for development) |
| `SLIPWAY_PROXY_NETWORK` | `slipway-proxy` | Shared Docker network name |
| `SLIPWAY_TRUSTED_PROXIES` | `10.210.0.2/32` | CIDRs whose `X-Forwarded-*` are trusted (only Caddy; never the app subnet) |
| `LOG_LEVEL` | `info` | pino level |

Agent (`slipway-agent` container):

| Variable | Default | Purpose |
|---|---|---|
| `SLIPWAY_SERVER_URL` | — | `wss://…` or `ws://slipway:3000` on the same host |
| `SLIPWAY_JOIN_TOKEN` | — | One-time join token (first start only) |
| `SLIPWAY_NODE_LAN_IP` | auto | LAN address other nodes/the edge use to reach this node |
| `SLIPWAY_WORKSPACE` | `/var/lib/slipway` | Checkouts, credentials |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker daemon |

## 14. Security requirements (checklist for reviewers)

- Secrets (env var values, provider credentials, GitHub private key/secrets,
  node credentials) encrypted with AES-256-GCM, random IV, key from
  `SLIPWAY_SECRET_KEY`; never returned in clear text after creation (env vars:
  `secret: true` masks the value; non-secret ones are returned).
- Passwords argon2id; tokens and node credentials hashed (SHA-256) at rest;
  constant-time comparisons.
- Webhook signatures verified before parsing; replay protection by delivery ID.
- Session fixation prevented (new session ID on login), sessions revocable.
- Authorization checked per route; `viewer` cannot read secrets or tokens.
- No shell string execution anywhere; all external input validated with Zod.
- Compose policy (section 4) enforced on the agent, not only in the UI.
- Internal endpoints (`/internal/*`, agent WebSocket upgrades without a valid
  token) reject requests from outside the Docker networks. *(v0.1 refuses
  upgrades without a valid token with 401 from any network; the network
  restriction is on the [roadmap](roadmap.md).)*
- Logs never contain secrets, tokens or Authorization headers.
- Platform containers run non-root with dropped capabilities except where the
  Docker socket is required.

## 15. Deliberately later

Blue/green deployments with health-gated switch · build cache / image registry
shared between nodes · placement by labels and resources · per-app managed
volumes with scheduled encrypted backups · metrics and alerts · OIDC login
(sign in to Slipway with an external IdP) · preview deployments from pull
requests · a CLI · TCP/UDP routing at the edge (Caddy L4) · Cloudflare Tunnel
as an alternative to port forwarding · a host-native agent (no container) for
machines without Docker Desktop · other Git hosts.

## 16. Open questions for the owner

1. Keep the Windows laptop as it is (Docker Desktop, platform in containers)
   or move it to Linux? Both work; Linux is the better long-term server.
2. License: Apache-2.0 proposed.
3. Project name: *Slipway* is the working name; renaming is a search/replace.
4. Platform URL: `deploy.example.com` proposed.
