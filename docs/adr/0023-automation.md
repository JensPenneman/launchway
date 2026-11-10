# 23. Automation

Date: 2026-11-10

## Status

Accepted. The notification helper is the first part; the other parts of the
automation (the pull request classifier, the executor, the release train) add
their decisions below.

## Context

Unattended work (merging a Dependabot pull request, cutting a release) has to
tell the owner when it needs a person. The owner runs an ntfy server; nothing
in Launchway should depend on a notification arriving.

## Decision

1. **One helper, no table.** `modules/notifications/ntfy.ts` exports
   `createNotifier(deps)`, which returns `notify({ title, priority, tags,
   click, body })`. There is no digest, no notification list in the UI and no
   notification table; dedupe belongs to the caller (the automation run record).
2. **Target in the settings.** `notifyUrl` (a topic URL without credentials,
   query or fragment) and `notifyToken` (printable ASCII, AES-256-GCM, bound
   to its column). Both are write-only: the settings answer carries
   `notifyUrlSet` and `notifyTokenSet`, because on a topic without auth the
   topic name is the secret and viewers and read tokens must not learn it. Both
   are read on every call, so a change applies at once, and no URL means no
   notification. A token needs an https URL: the API refuses the combination
   and the sender never posts a token over http.
3. **Passkey-session writes.** Writing either field needs a session that
   signed in with a passkey (`getPasskeySessionPrincipal`; sessions store their
   `auth_method`, sessions that existed before the migration count as
   `password`). API tokens of any scope and password sessions get 403. The same
   rule applies to the automation and verification settings later. The audit
   log records that the fields changed, not their values.
4. **Delivery.** Three tries with backoff (1 s, 4 s) for network errors,
   timeouts, 429 and 5xx; other statuses fail at once. Redirects are not
   followed, so the token cannot leave the configured host. A try times out
   after 3 s, so one `notify` takes at most about 14 s. The body is collapsed
   to one line of at most 500 characters. `notify` never throws and logs only
   the reason and the number of tries. Notifications carry PR numbers,
   versions and links only. A webhook handler must not await `notify`: it records what to send in
   the run record and sends afterwards. No endpoint reports delivery status or
   latency, since the server posts to an address an admin chose and the answer
   would map internal hosts.
5. **Write tokens (GitHub App).** Installation tokens that can write (`contents`,
   `pull_requests`) are minted only by `installationWriteToken`, for one
   repository, and only from `modules/automation/`; every other mint passes an
   explicit read-only permission set, so a new permission on the App never
   widens an existing code path. An import scan in the tests enforces the
   location.

## Consequences

A lost notification is possible by design (ntfy down for more than a few
seconds); callers that need certainty read the run record, not the phone.
Replacing the helper by outbound webhooks later changes one module.
