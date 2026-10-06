# @slipway/web

React SPA for Slipway. It is only a client of the REST API (`/api/v1`), served by the API from
the same origin in production and proxied to `localhost:3000` by Vite in development.

```sh
pnpm --filter @slipway/web dev        # http://localhost:5173, API proxied to :3000
pnpm --filter @slipway/web dev:mock   # same, but the whole API is served by MSW (no backend)
pnpm --filter @slipway/web test       # Vitest unit tests (logic in src/lib, src/api, ...)
pnpm --filter @slipway/web test:e2e   # Playwright smoke tests against a mock-API build
```

## Layout

| Path | What |
|---|---|
| `src/routes` | File-based routes (TanStack Router, code-split per route). `_app/` = inside the shell, behind sign-in. |
| `src/api/request.ts` | The one `fetch` wrapper: cookie credentials, RFC 9457 problems → `ApiError`, 401 → sign-in, responses parsed with the `@slipway/contracts` Zod schemas (`ContractDriftError` when the API and UI disagree). |
| `src/api/<resource>.ts` | Thin resource modules: request functions and TanStack Query `queryOptions`. |
| `src/api/keys.ts` | Query-key roots and `keysForTopic()`, used by `useLiveEvents` to invalidate on `GET /events`. |
| `src/api/events.ts` | SSE hooks: the platform change feed and the deployment / container log streams. |
| `src/api/provisional.ts` | Lenient schemas for responses the contracts on `main` lack (`/apps/{id}/status`, `/dns/ddns`, edge load state). |
| `src/features` | Page sections (app tabs, settings sections, domain/zone panels). |
| `src/components` | Shared building blocks; `ui/` holds the vendored shadcn/ui components. |
| `src/lib/api` | The `openapi-fetch` client generated from the OpenAPI document (`pnpm openapi:generate`). |
| `src/mocks` | MSW handlers for the whole API with an in-memory database and realistic fixtures. |

## Mock API

`VITE_API_MOCK=1` starts MSW before the app renders; the service worker script is served by a
small Vite plugin (`vite.config.ts`) and is never part of a normal build. The mock behaves like a
backend: it validates bodies with the contract schemas, enforces roles, writes audit events,
publishes change events over SSE and walks new deployments through the state machine with live
logs.

Scenarios are chosen with `localStorage['slipway-mock-scenario']` before the page loads:
`default` (signed in as the owner), `fresh` (no owner yet: setup wizard), `signed-out`, `viewer`.
Every mock user signs in with the password `correct horse battery staple`; `/invite#slpi_aaa…a`
(43 `a`) opens a valid invitation.

## Links the API hands out

- Invitations: `<publicUrl>/invite#<token>` (also `/invite/<token>`).
- After the GitHub App manifest and installation callbacks: `/settings/github` (redirects to the
  GitHub tab of the settings page).
