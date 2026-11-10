# 23. Automation

Date: 2026-11-10

## Status

Accepted. The notification helper is the first part; the other parts of the
automation (the pull request classifier, the executor, the release train) add
their decisions below.

## Context

Unattended work (merging a Dependabot pull request, cutting a release) has to
tell the owner when it needs a person. The owner runs an ntfy server; nothing
in Launchway should depend on a notification arriving. The first act is
merging the dependency updates Dependabot opens when they are safe, which needs
a decision that can be tested in isolation and that a clever pull request
cannot argue out of its rules.

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
6. **A pure classifier.** `modules/automation/policy/classify.ts` takes one
   pull request head (the pull request, its single commit, its changed files,
   the base and head contents of changed `package.json` files) and a policy,
   and returns `eligible`, `hold(reason)` or `ineligible(reason)`. It imports
   nothing from the database, dependency, HTTP or GitHub layers; the caller
   gathers the input and acts on the verdict.
7. **The policy is input.** Dependabot's user id, the allowlist of changed
   paths and the held image names come from the app's automation settings, so
   no app's file layout is known to the platform.
8. **Eligible needs all of:** author id of the policy and type `Bot`; head in
   the base repository on `dependabot/*`, base the default branch, not a
   draft; exactly one commit, the head, verified, authored by that id and
   committed by `web-flow`; the commit and file lists complete (their length
   equals the pull request's `commits` and `changed_files`, within GitHub's
   caps of 250 and 3000); every changed file modified (never added, removed
   or renamed) and on the allowlist; in each `package.json` everything outside
   the four dependency fields equal between base and head; the commit message
   holds exactly one `updated-dependencies` front matter block, ended by a
   `...` line and followed only by blank lines and trailers, that parses.
9. **Hold, not refuse,** for a held image (Postgres and the images built on
   it: `postgres`, `postgis`, `timescaledb`, `pgvector` by default) unless
   Dependabot says the update is a minor or a patch: a major, a digest-only
   bump, an empty or any other `update-type` is held, and a person decides.
   Every other update, npm majors included, is eligible. Lockfile URLs and
   integrity are the business of the app's own supply-chain check.
10. **Fail closed.** Missing, incomplete or unparseable input is `ineligible`.

## Consequences

A lost notification is possible by design (ntfy down for more than a few
seconds); callers that need certainty read the run record, not the phone.
Replacing the helper by outbound webhooks later changes one module.
The classifier rules are table-tested without a database or GitHub. The executor can
change how it reaches GitHub without touching the policy.
