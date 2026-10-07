# Development guide

How to work on Launchway: setup, commands, how the workspace fits together, and the conventions
every module follows. The architecture contract is [architecture.md](architecture.md); decisions
are recorded in [adr/](adr/).

## Prerequisites

- Node.js 24 LTS (`.node-version`) and pnpm 11 (`corepack enable` picks the version from
  `packageManager`).
- Docker (Docker Desktop on macOS/Windows) for the development database, the integration tests
  (Testcontainers) and image builds.
- Optional: the dev container in `.devcontainer/` provides all of the above.

## Getting started

```sh
pnpm install                                   # also installs the git hooks (lefthook)
docker compose -f compose.dev.yaml up -d       # PostgreSQL 18 on localhost:5432 (launchway/launchway)
cp apps/api/.env.example apps/api/.env
echo "LAUNCHWAY_SECRET_KEY=$(openssl rand -base64 32)" >> apps/api/.env
pnpm dev                                       # API on :3000, web UI on :5173 (proxies /api)
```

- API: <http://localhost:3000/api/health/ready>, OpenAPI document `/api/openapi.json`, API
  reference `/api/docs`.
- UI: <http://localhost:5173>. The API also serves the built UI at `/` once `apps/web/dist`
  exists (`pnpm build`).
- The API applies pending migrations at start. `pnpm db:migrate` does the same on demand.

`pnpm dev` does not start an agent, so a development install has no node and deployments stay
`queued`. To run one against your local API (it needs Docker):

1. In the UI, open Nodes → Add node and copy the join token.
2. `cp apps/agent/.env.example apps/agent/.env`, then set `LAUNCHWAY_SERVER_URL=ws://localhost:3000`
   and `LAUNCHWAY_JOIN_TOKEN` to the copied token.
3. `pnpm --filter @launchway/agent dev`. The agent stores its node credential and the checkouts in
   `apps/agent/.workspace/` (git-ignored).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API (tsx watch) + web (Vite) + contracts (tsc watch), via Turborepo |
| `pnpm build` | Builds every package (`dist/`) |
| `pnpm lint` / `pnpm lint:fix` / `pnpm lint:ci` | Biome check / check with fixes / `biome ci` |
| `pnpm typecheck` | `tsc` for every package (project references) |
| `pnpm test` | Unit tests (Vitest), per package |
| `pnpm test:integration` | Integration tests: the API against PostgreSQL (Testcontainers, or `TEST_DATABASE_URL`) and a Caddy container; the agent against the local Docker daemon (pulls `traefik/whoami`) |
| `pnpm test:e2e` | Playwright smoke tests of the web UI against its mock API (`pnpm --filter @launchway/web exec playwright install chromium` once) |
| `pnpm knip` | Unused files, exports and dependencies |
| `pnpm check` | lint + typecheck + knip + unit tests (run before pushing; the pre-push hook runs typecheck + unit tests) |
| `pnpm db:generate` | drizzle-kit: next SQL migration from the schema (see the rule below) |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm openapi:generate` | Export the OpenAPI document and regenerate the web client types |

Single package: `pnpm --filter @launchway/api test`, `pnpm --filter @launchway/web dev`, ...

## How the workspace fits together

```
packages/tsconfig    shared compiler options (strict, NodeNext / Bundler)
packages/contracts   Zod schemas + types: API payloads, enums, the agent protocol
apps/api             Hono control plane; Drizzle + PostgreSQL; serves the UI
apps/agent           node agent (WebSocket client, Docker)
apps/web             React SPA; API client generated from the OpenAPI document
```

- **Live types.** Workspace packages export their TypeScript sources under the custom export
  condition `@launchway/source` and compiled `dist/` otherwise. Vite, Vitest and tsx run with that
  condition, so a change in `packages/contracts` is visible immediately without rebuilding.
  Type checking goes through TypeScript project references (`tsc -b` builds `contracts` first
  when needed). Production code and Docker images use `dist/`.
- **API to UI.** Route schemas in `apps/api` produce the OpenAPI document. `pnpm openapi:generate`
  writes `apps/api/openapi.json` (without starting the server) and
  `apps/web/src/lib/api/schema.gen.ts`; both are generated, git-ignored, and rebuilt by Turborepo
  before the web app builds or type checks.
- **Images.** `apps/api/Dockerfile` and `apps/agent/Dockerfile` build from the repository root and
  use `pnpm deploy --prod --config.inject-workspace-packages=true` for a pruned, self-contained
  runtime directory (workspace packages copied in, production dependencies only). The workspace
  itself keeps symlinked workspace packages so live types keep working.

## Conventions for module authors

The API is split into modules under `apps/api/src/modules/<module>/`. The `settings` module is the
reference implementation. Copy its shape.

### Module layout

```
apps/api/src/modules/<module>/
  schema.ts     Drizzle tables and enums owned by the module
  service.ts    create<Module>Service(deps): business logic, transactions, audit, events
  routes.ts     register<Module>Routes(api, deps): OpenAPI route definitions and handlers
  *.test.ts     unit tests next to the code
```

- Routes stay thin: validate (via the route schema), authorize (`requireRole`), call the service,
  return the result. Business rules, transactions, audit writes and event publishing live in
  the service.
- A module talks to another module through that module's service (or, for read-only joins, its
  schema). Never write another module's tables directly. Biome's `noImportCycles` rejects
  circular imports between modules.
- Shared infrastructure lives in `apps/api/src/lib` (`problem`, `auth-context`, `csrf`,
  `rate-limit`, `crypto`, `sse`, `event-bus`, `pagination`, `jobs`, `openapi`, `client-ip`,
  `agent-gateway`, `git-provider`, `static`) and `apps/api/src/db` (`client`, `columns`, `errors`,
  `migrate`, `schema`). Extend it there when several modules need the same thing.
- Cross-module wiring (the agent gateway and the deployments sink, the edge's domain hooks, the
  background workers) happens in the composition root, `src/server.ts`
  ([ADR 0010](adr/0010-composition-root-wiring.md)).

### Registering routes

Every module exports one function, `register<Module>Routes(api: Api, deps: Deps)`, and is added
to the single registry in `apps/api/src/modules/index.ts`:

```ts
export const modules: readonly ModuleDefinition[] = [
  { name: 'health', mount: 'api', register: registerHealthRoutes },
  { name: 'settings', mount: 'v1', register: registerSettingsRoutes },
  { name: 'apps', mount: 'v1', register: registerAppsRoutes },
  // ...
];
```

`mount: 'v1'` serves the router under `/api/v1` (the public REST API); `mount: 'api'` under
`/api` (health, the agent WebSocket `/api/agent/ws`). Paths inside a module are relative to
the mount (`/apps/{id}`).

A route with authorization, validation and an audited mutation:

```ts
const createApp = createRoute({
  method: 'post',
  path: '/apps',
  operationId: 'createApp',
  tags: ['Apps'],
  summary: 'Create an app',
  security: AUTHENTICATED,
  middleware: [requireRole('member')],
  request: { body: jsonBody(CreateAppInput) },
  responses: { 201: jsonResponse(App, 'The new app'), ...problemResponses(400, 401, 403, 409) },
});

export function registerAppsRoutes(api: Api, deps: Deps): void {
  const service = createAppsService(deps);
  api.openapi(createApp, async (c) => c.json(await service.create(c.req.valid('json'), requestActor(c)), 201));
}
```

and in the service:

```ts
async create(input: CreateAppInput, actor: RequestActor): Promise<App> {
  const row = await deps.db.transaction(async (tx) => {
    const [app] = await tx.insert(apps).values({ ... }).returning();
    await recordAudit(tx, actor, { action: 'app.create', target: { type: 'app', id: app.id }, summary: { slug: app.slug } });
    return app;
  });
  deps.events.publish({ topic: 'apps', action: 'created', resourceId: row.id });
  return toApp(row);
}
```

Rules:

- Every route has an `operationId` (camelCase verb + noun; it becomes the client method name), a
  tag, a summary, `security` (`AUTHENTICATED` or `PUBLIC`) and documented problem responses.
- Request and response schemas come from `@launchway/contracts`. Do not declare ad-hoc Zod
  schemas in route files, except for module-internal ones (as `health` does).
- Return API shapes with ISO timestamps (`date.toISOString()`); map database rows in one
  `to<Entity>(row)` function per entity.
- `@hono/zod-openapi` checks handler return types against the declared responses. Keep them in
  sync instead of casting.

### Contracts first

Add or change the schema in `packages/contracts/src/<module>.ts` (exported through
`src/index.ts`) before writing the route. Conventions:

- PascalCase schema and inferred type share a name: `export const App = z.object(...).openapi('App');`
  then `export type App = z.infer<typeof App>;`.
- Inputs are `Create<Entity>Input` / `Update<Entity>Input` (strict objects; updates need at least
  one field). Lists are `page(Entity)` (cursor) or `list(Entity)` (small, bounded sets).
- IDs use the typed helpers (`AppId`, `typeId('app')`), never `z.string()`. Generate them with
  `generateId('app')` (Drizzle does this through `idColumn('app')`).
- Give named schemas `.openapi('Name')` so they become reusable components, and add descriptions
  where the meaning is not obvious.
- Enum values live in contracts as `const` arrays (`DEPLOYMENT_STATUSES`). Drizzle `pgEnum`s
  are built from them, so the API, database and UI cannot drift.
- Add unit tests for non-trivial rules (unions, refinements, state transitions).

### Database schema and migrations

- Tables of a module live in its `schema.ts` and are re-exported from `src/db/schema.ts`. All v0.1
  entities already exist; extend them rather than adding parallel tables.
- Primary keys: `id: idColumn('<prefix>')`. References: `text('app_id').$type<AppId>().references(...)`.
  Use explicit snake_case column names, `tz()` for timestamps and `...timestamps()` for
  `created_at` / `updated_at` (append-only tables skip `updated_at`).
- Secrets are stored encrypted in text columns named `...Encrypted` (`deps.secrets.encrypt`, with
  the record as context: `` `env:${appId}:${key}` ``). Tokens and credentials are stored as
  `hashToken()` output, never in clear text.
- Prefer constraints in the database (unique indexes, CHECKs, foreign keys) over checks in code,
  and turn violations into problems: `isUniqueViolation(error)` maps to `conflict()`,
  `isForeignKeyViolation(error)` maps to `invalidField(...)`.
- Schema changes come with their migration: change `schema.ts`, run `pnpm db:generate`, review
  the SQL and commit it together with the files under `apps/api/drizzle/meta/` in the same change
  (CI fails when the schema and the committed migrations differ). Never edit or delete a migration
  that was merged to `main`; add a new one. To try a schema quickly, apply it to a throwaway
  database with `pnpm --filter @launchway/api exec drizzle-kit push` (never against shared data).

### Errors

- Throw `ProblemError` (or the helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`,
  `conflict`, `invalidField`) from handlers and services. The global handler renders RFC 9457
  `application/problem+json` with the stable `type` slug, `instance` and `requestId`.
- Never build error JSON by hand and never `return c.json({ error })`.
- Request validation failures become `validation-failed` with an `errors[]` list automatically.
- Unknown errors become a generic 500 with no internal details; the error is logged with the
  request id.
- New problem types are added to `PROBLEM_TYPES` in `packages/contracts/src/errors.ts`. Slugs are
  stable: add new ones, never rename.

### Authentication and authorization

- `c.var.principal` is set for every request by `Deps.auth` (an `AuthResolver`). The server uses
  `createAuthResolver` (`modules/auth/resolver.ts`): a bearer `lwy_...` token (hashed lookup,
  expiry, scopes, `lastUsedAt`) takes precedence over the `launchway_session` cookie (hashed token,
  30-day sliding expiry). Join tokens and node credentials (`lwyn_...`, `lwya_...`) are left to the
  agent socket, which checks them itself. Unit tests keep `anonymousAuthResolver` or `fixedAuth`.
- Unsafe requests that carry the session cookie must send `Sec-Fetch-Site: same-origin`/`none` or
  an `Origin` equal to the platform origin (`lib/csrf.ts`); browsers do this, scripts should use
  bearer tokens. Setup, sign-in, passkeys, invitations and token creation are rate-limited per
  client IP (`lib/rate-limit.ts`); route tests share one bucket per app instance.
- Declare authorization per route with `middleware: [requireRole('viewer' | 'member' | 'admin' | 'owner')]`.
  Tokens are capped by scope (`read` acts as viewer, `write` as member, `admin` up to the user's
  role); `effectiveRole(principal)` computes the result.
- In handlers use `getPrincipal(c)` when you need the user, and pass `requestActor(c)` to
  services for audit events. Background jobs use `systemActor('job-name')`.
- `viewer` must never read secrets or tokens: return masked values (`maskEnvVar`) or omit them.

### Audit log and change events

- Every mutation writes exactly one audit event with `recordAudit(tx, actor, entry)` **inside the
  same transaction** as the change. `action` is `<resource>.<verb>` (`app.create`,
  `deployment.cancel`), `target` names the entity, and `summary` is a small diff. Use
  `diffSummary(before, after, keys, redactKeys)` and redact anything secret.
- After the transaction commits, publish a change event with
  `deps.events.publish({ topic, action, resourceId })` so `GET /events` subscribers (the UI)
  refresh. Do not put secrets in `data`.

### Secrets and tokens

- `deps.secrets.encrypt(plaintext, context)` / `decrypt(ciphertext, context)`: AES-256-GCM with a
  key derived from `LAUNCHWAY_SECRET_KEY`. Always pass a context naming the owning record.
- `generateToken(prefix)` creates `lwy_` / `lwyn_` / `lwya_` / `lwyi_` tokens (43 base62
  characters). Store `hashToken(token)`, show `tokenHint(token)`, and compare with `safeEqual`.

### Pagination, streaming and WebSockets

- Lists accept `PaginationQuery` (`limit`, `cursor`) and return `page(Entity)`. Use keyset
  pagination on `(created_at, id)` with the helpers in `src/lib/pagination.ts`: select
  `createdAtKey(table.createdAt)` next to the row, filter with `afterCursor(cursor, createdAt, id,
  'asc' | 'desc')` and cut the `limit + 1` rows with `toPage(rows, limit, map)`. They keep
  PostgreSQL's microseconds in the cursor, which a `Date` would lose. Never use offsets.
- Server-Sent Events: `sseResponse(c, (signal) => source(signal), { signal: deps.lifecycle.signal })`
  with event names from `SSE_EVENTS`. Streams end on client disconnect and on shutdown.
- WebSockets: the HTTP server is created with WebSocket support. A route on the `api` mount uses
  `upgradeWebSocket` from `@hono/node-server`, with authentication (join token or node
  credential) checked before upgrading. Messages are validated with
  `parseAgentToServerMessage`; unknown types are logged and ignored.

### Background jobs

- Periodic work uses `startJob` from `src/lib/jobs.ts`: interval plus jitter, runs that never
  overlap, scheduled-run errors logged, timers that do not keep the process alive, and a stop on
  `deps.lifecycle.signal`. `runNow()` runs the job on demand (and rethrows its error).
- Start jobs from the composition root (`src/server.ts`), not from `register<Module>Routes`:
  `createApp` also runs in tests and in `pnpm openapi:generate`. The DNS and domain jobs predate
  this rule and guard themselves with `config.env !== 'test'`.

### Logging

- Use `c.var.logger` in handlers (bound to the request id) and `deps.logger` elsewhere. Log
  structured fields (`logger.info({ appId }, 'deployment queued')`), not interpolated strings.
- **Never log secrets**: passwords, tokens, credentials, Authorization or Cookie headers,
  environment values, request bodies or query strings. The pino redaction list in
  `src/logger.ts` is a safety net, not permission.
- Levels: `error` for failures needing attention, `warn` for degraded but handled conditions,
  `info` for lifecycle and state changes, `debug` for diagnostics.

### Testing

- Unit tests sit next to the code (`*.test.ts`) and must not need Docker or network access. Use
  `createTestDeps()`, `fixedAuth(principal)` and `testPrincipal(role)` from
  `apps/api/test/support/deps.ts` and drive routes with `createApp(deps).request(...)`. Test
  authorization (401/403) and validation (400) for every route.
- Integration tests live in `apps/api/test/integration/*.test.ts`, get a migrated database through
  `inject('databaseUrl')` and exercise the real stack (HTTP, then service, then PostgreSQL),
  including audit rows. Tests must not depend on each other's data: use unique values. Helpers in
  `apps/api/test/support`: `FakeAgentGateway`, `FakeGitHub`, an in-memory DNS provider and a fake
  Cloudflare API, `startTestServer` with a scripted `TestAgent` for the agent socket, a software
  WebAuthn authenticator, and fixtures for nodes, apps and domains. The edge test starts a real
  `caddy:2-alpine` container.
- The agent's integration test (`apps/agent/test/integration`) deploys, inspects, streams logs
  of, stops and removes a real Compose project through the local Docker daemon, with an
  in-process WebSocket server playing the control plane.
- Contracts tests cover schemas and helpers. Web unit tests cover logic. Playwright smoke tests
  (`apps/web/e2e`) cover user-visible flows against a build that serves the API from the MSW mock
  (`VITE_API_MOCK=1`, fixtures in `apps/web/src/mocks`).

### Web UI

- Pages are file-based routes in `apps/web/src/routes` (`_app/` = inside the app shell); larger
  page parts live in `src/features/<area>`.
- Data comes from the resource modules in `src/api` (`apps`, `auth`, `domains`, `github`,
  `nodes`, `platform`, `users`): TanStack Query `queryOptions` and mutations around one
  `request()` helper that sends the session cookie, turns problem documents into `ApiError` and
  parses every response with its `@launchway/contracts` schema (`ContractDriftError` on mismatch;
  [ADR 0013](adr/0013-web-ui-data-layer.md)). `useApiMutation` adds toasts and invalidation.
  Query keys have one root per resource; `keysForTopic()` maps each `/events` topic to the keys
  to refresh. The client generated from the OpenAPI document (`src/lib/api/client.ts`) is used
  for the health probe only.
- Streams use the hooks in `src/api/events.ts`: `useLiveEvents` (change feed),
  `useDeploymentLogStream` and `useAppLogStream`.
- `pnpm --filter @launchway/web dev:mock` runs the UI against the MSW mock API; mock users sign in
  with the password `correct horse battery staple` (see `apps/web/README.md` for the
  scenarios).
- UI building blocks are shadcn/ui components in `src/components/ui` (add more with
  `pnpm dlx shadcn@latest add <component>` from `apps/web`). Forms use react-hook-form + the
  contracts schemas. To use `@launchway/contracts` in the UI, add it as a dependency. Vite already
  resolves it from source.

### Agent

- Every process execution uses `execFile` with an argument array, never a shell string. Validate
  refs with `GitRef` before use, pass Git credentials only as Git configuration in the child's
  environment (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, the equivalent of `-c http.extraHeader=...`
  without showing up in the process list), and never log environment values. Child processes get
  an allow-listed environment only.
- The runtime lives in `apps/agent/src/runtime`: checkout, Compose file resolution, the policy
  (`compose-policy.ts`), the `compose.launchway.yaml` override, the per-app deployment queue, log
  streams and the outbox that re-sends results after a reconnect.
- Protocol changes start in `packages/contracts/src/agent`. Breaking changes bump
  `AGENT_PROTOCOL_VERSION`. Requests are answered with replies echoing the request `id`; a request
  the agent cannot handle answers an `error` (for example `not-found` or `busy`).

## Open items

The v0.1 modules are merged and wired. Known gaps and follow-ups, grouped by area, are in
[roadmap.md](roadmap.md). Points that matter while changing the code:

- Every Caddyfile the API pushes repeats the global options block (`admin
  unix//run/caddy-admin/admin.sock|0222`, `email`, `cert_issuer acme`; see `renderEdge`). Without
  `admin`, Caddy moves its admin API to localhost and, with `--resume`, keeps that state across
  restarts. The listener follows `LAUNCHWAY_CADDY_ADMIN_URL`: a `unix://` URL renders the socket, an
  `http://` URL (development and tests only) renders `0.0.0.0:<port>`. Never use a TCP admin
  address where app containers share Caddy's network.
- Routed services join the proxy network when they are deployed, so a new route of a running app
  takes effect with its next deployment ([ADR 0011](adr/0011-domain-activation-and-edge-rules.md)).
- The API reference page (Scalar) loads its bundle from a CDN. Self-host it if outbound access
  must be avoided.
