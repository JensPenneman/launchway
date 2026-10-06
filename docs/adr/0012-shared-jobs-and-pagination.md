# 12. One job runner and one keyset pagination helper

Date: 2026-10-07

## Status

Accepted

## Context

Two branches built the same infrastructure twice. The deployments worker and
the GitHub release poller each ran their own `setInterval` loop, while the DNS
branch added `lib/jobs.ts` (jitter, runs that never overlap, stop on the
lifecycle signal, logged failures). The auth branch put microsecond-exact
`(created_at, id)` keyset helpers in `modules/audit/keyset.ts` and the routes
module wrote the same cursor logic inline. `docs/development.md` asks for
shared infrastructure in `apps/api/src/lib`.

## Decision

- `startJob` in `lib/jobs.ts` is the only periodic job runner. The deployment
  worker and the release poller use it; their intervals are unchanged.
- The keyset helpers `createdAtKey`, `afterCursor` and `toPage` live in
  `lib/pagination.ts`, next to `encodeCursor` and `decodeCursor`. Audit,
  users, invitations and routes use them. New list endpoints use them too.
- The apps and deployments lists keep their own cursors: those tables are
  written with millisecond `created_at` values from JavaScript, so a `Date`
  cursor is exact. The domains list orders by `created_at` truncated to
  milliseconds. Both are correct; moving them to the shared helpers is
  optional clean-up.

## Consequences

- Background jobs behave the same way: none piles up behind a slow run, none
  keeps the process alive, all stop on shutdown.
- Cursors stay opaque, so changing their encoding is not an API change.
