# 7. Hono, Drizzle and PostgreSQL for the control plane

Date: 2026-10-06

## Status

Accepted

## Context

The API is the single source of truth ([architecture.md](../architecture.md)
§1): the UI, the agent and scripts all use it. It therefore needs a
machine-readable contract from which the UI client is generated, and every
external input must be validated at run time (§14). The project is
TypeScript end to end, and the Zod schemas in `@slipway/contracts` are shared
by the API, the agent and the UI. The control plane is one container that
needs durable, transactional storage for users, sessions, deployments, logs
and audit events, with schema upgrades that need no manual steps. A framework
validated with JSON Schema would add a second schema language; an RPC-style
framework would make the API awkward to use with `curl`.

## Decision

- **HTTP:** Hono 4 on Node 24. Routes are declared with `@hono/zod-openapi`,
  so one Zod schema is both the run-time validator and the source of the
  OpenAPI 3.1 document at `/api/openapi.json`. Interactive docs (Scalar) are
  served at `/api/docs`. The UI's client is generated from the document with
  `openapi-typescript` and `openapi-fetch` (§11).
- **Conventions (§10):** base path `/api/v1`, JSON only. Errors are RFC 9457
  problem details (`application/problem+json`) with stable `type` slugs.
  Lists use cursor pagination (`?limit=&cursor=` returns
  `{ items, nextCursor }`). Deployment logs, app logs and the `/events` change
  feed are Server-Sent Events.
- **Database:** PostgreSQL 18 (`postgres:18-alpine`) holds all state.
- **Data access:** Drizzle ORM 0.45 with drizzle-kit 0.31. Each module owns
  its schema. `pnpm db:generate` writes SQL migrations, which are committed
  under `apps/api/drizzle` and reviewed like code. The API applies pending
  migrations at start while holding a PostgreSQL advisory lock, so concurrent
  starts never apply them twice.
- **Logging:** pino, never with secrets, tokens or `Authorization` headers.

## Consequences

- One schema language covers request validation, the OpenAPI document, the
  generated UI client and the agent protocol. An API change that the UI does
  not follow fails type checking.
- The API stays usable with `curl`: plain HTTP, JSON and documented errors.
- Upgrading is pulling a new image and restarting. A failing migration stops
  the API from starting, so operators back up before upgrading.
- Migrations only move forward. Returning to an older version means restoring
  a backup taken before the upgrade.
- Server-Sent Events are one-way and reconnect automatically in browsers,
  which is all that log views and the change feed need. Commands remain
  ordinary HTTP requests.
- Cursor pagination stays stable while rows are added, but provides no total
  counts.
- PostgreSQL is a separate container to run and back up
  ([operations.md](../operations.md)).
