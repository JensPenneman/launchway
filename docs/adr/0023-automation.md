# 23. Automation

Date: 2026-11-10

## Status

Accepted. The notification helper is the first part, the pull request
classifier the second, the executor and the Dependabot auto-merge the third;
the release train adds its decisions below.

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
11. **Policy is `decide`, effects are actions.** `policy/decide.ts` maps a
    snapshot (mode, pause, state of the default branch, the head's verdict,
    the newest check run of each name, the outcomes recorded so far) to a list
    of actions. It is pure and deterministic: no clock (the snapshot carries
    the time), no database, no HTTP. Every action's input is plain JSON and
    carries an idempotency key; an action whose key already has an outcome is
    never emitted again (a transient refusal excepted). The action types are `github.enableAutoMerge`,
    `github.disableAutoMerge`, `github.merge`, `checks.rerun`, `notify` and
    `recordState`.
12. **A refusal returns to `decide`.** The one executor
    (`executor.ts`) performs actions and returns an outcome, `done` or
    `refused(reason, transient)`; failing to reach the other side throws, and
    a throw leaves the action unrecorded so a retry resumes. GitHub reports
    mutation errors as HTTP 200 with `errors`: only `UNPROCESSABLE` is an
    answer (the "clean status" message makes `decide` ask for the REST merge);
    `RATE_LIMITED`, `FORBIDDEN` and every other type are failures. A refused
    disable is never an outcome and is never judged by its message: GitHub's
    answer is followed by a GraphQL read of the pull request's
    `autoMergeRequest` (the REST field can lag), and the disable counts as done
    only when that read shows no request; otherwise, or when the read fails, it
    throws, so the head goes on as if the auto-merge were still on and no check
    is queued for it. While the record says the App enabled an auto-merge, it is
    on whatever REST reads, and the record is cleared only after a confirmed
    disable. A refusal whose
    reason is transient (a status still settling, a full check queue) comes
    back on a later pass, at most three times for an enable or a merge, and
    one notification per head tells a person of the final refusal. The
    executor holds no policy.
13. **One table.** `automation_runs` (`app_id`, `kind` `pr` or `train`, `key`,
    `state`, `snapshot`, `actions`, unique per app, kind and key) holds the
    last snapshot and the ordered actions with their results. A new head resets
    the actions (keeping notifications not yet sent); a restart and the
    reconcile resume from the row. One pull request has one writer: its work
    holds a session-level PostgreSQL advisory lock on (app, kind, key) on a
    dedicated small pool (never the main pool; the sweep has its own), under a
    deadline of two minutes after which the lock is released and the handle can
    no longer reach GitHub; the reconcile takes the lock without waiting and
    skips a busy pull request. The work re-reads the app's settings at the start
    of every round and before every write, and drops every write the settings no longer allow, so a
    pause or a change of mode cannot be overtaken by a handle that started
    earlier, in this or another process. App-level notices (main unknown, a
    pull request failing repeatedly, no usable connection, an auto-merge that
    stays on) are rows of kind `notice` keyed by notice, so each is sent once (a
    failure streak by head and streak, an unreachable main by hour).
14. **Before the checks.** The webhook handler only records: for a
    `dependabot/*` head it stores the checks the event would queue as
    *held* in the pull request's run and returns, so it never waits for
    GitHub. A background pass takes the pull request's lock, disables what
    the App enabled, classifies (complete commit and file lists, pinned to
    the head), records, enables with `expectedHeadOid`, and only then queues
    the held checks (`queueForCommit` dedupes per commit) for the head the
    API reports; a payload head that differs from it queues nothing. GitHub
    never redelivers a failed delivery by itself, so the 2-minute reconcile
    handles every run that still holds checks, and one notification goes out
    after three failed passes for a pull request. A push to `dependabot/*`
    without a pull request waits for the `opened` event. Checks are held only
    while the mode is `on` or the App enabled an auto-merge for the pull request.
    Once the head is classified the pass queues its checks whenever it has no
    check run other than `queue-full` ones (a held entry for another head that is
    older than five minutes moves onto the API head), keeps the held entry while
    the queue refuses it, and one notification tells a person when a classified
    head has had no check run for ten minutes.
15. **Notifications are never awaited in a webhook.** `notify` actions are
    recorded as pending and sent afterwards (claimed under the run's lock, so
    none is sent twice); the reconcile sends the ones still pending.
16. **Reconcile every 2 minutes.** Open Dependabot pull requests (every
    page) are handled again: new heads, a changed policy, base or draft state
    (the verdict is stored with a hash of the classifier policy, the
    classifier version and the base, and is re-made when any differs), the
    held checks of a head, errored checks re-run at most twice per head (a
    full queue is retried without counting; other refusals stop after five),
    one notification per head for a failure and for a conflict older than
    24 hours (the timer survives GitHub's "unknown"). An incomplete list or a
    commit that is not yet the head is `unknown`, tried on every pass for ten
    minutes after the head was first seen, then `ineligible`. Apps in `off` or `shadow` are visited while an auto-merge
    of the App may still be on. Until the release train reads the ruleset's
    required contexts, main is `green` only when every configured check item
    has a succeeded run on the default branch's head; `red` when one failed;
    `pending` while some are queued, running or missing (no enabling, the
    auto-merges kept, no notification); `unknown` when one errored or was
    cancelled or GitHub did not answer (no enabling, one notification per app
    and main sha).
17. **Settings, and withdrawing.** `App.automation` (`merge` and `train` as
    `off`, `shadow` or `on`, `paused`, `trainSchedule`, `verify.baseUrl`,
    `holdPaths`, plus the classifier's policy). `PUT /apps/{id}/automation`
    needs a passkey session and an installed GitHub App connection;
    `POST /apps/{id}/automation/pause` takes a token with write scope. In
    `shadow` mode no enable, merge or re-run reaches GitHub, and its
    notifications are marked `[shadow]` at the lowest priority. Withdrawing is
    a safety action allowed in every mode: `decide` disables an auto-merge the
    App enabled whenever the head may not merge right now (mode other than
    `on`, paused, not classified, not eligible, main red or unknown). A pause,
    or any change that moves `merge` away from `on`, waits for a per-app
    sweep (bounded to about 8 s; one running and one queued per app) that
    disables every App-enabled auto-merge; the response lists the pull
    requests confirmed and failed, is 207 when any failed, and the reconcile
    keeps trying with an urgent notification. While an app of the
    repository has `merge` or `train` not `off`, creating an app on that
    repository, changing `checks` or `connectionId` of any app on it, and running
    or re-running checks of an app that is not itself automated need a passkey
    session too: commit status contexts are not scoped to the app, so they are
    the gate an auto-merge relies on. A 207 from the pause or the settings means
    "check `sweep.failed`", and the card says so.
18. **Hardening after review.** GraphQL names a bot without `[bot]`, so every login
    comparison strips the suffix, and a request without `enabledBy` while an App enable is
    on record is the App's. The intent to enable is recorded before the request goes out, so
    a lost response still counts as an enable. Any error answer to a disable is judged by the
    re-read, and a safety disable is never dropped after a transient refusal. A lost lock
    connection aborts the handle (the lock pools set `idle_session_timeout=0`). One predicate
    decides which check runs count for a commit (a run a person cancelled does not, for the
    automation). While an app of a repository has automation on, another app of it may not run
    checks whose names the automated app uses (409), and turning automation on is refused while
    such a sibling exists. Deleting an app whose automation is live, or changing its checks
    node, needs a passkey session, and the delete withdraws the App's auto-merges first.
19. **No credentials leave the module.** `modules/automation` exports
    operations, never tokens or clients; `installationWriteToken` appears only
    in `github.ts` and `@octokit/auth-app` only in `lib/git-provider.ts`.

## Consequences

A lost notification is possible by design (ntfy down for more than a few
seconds); callers that need certainty read the run record, not the phone.
Replacing the helper by outbound webhooks later changes one module.
The classifier rules are table-tested without a database or GitHub. The executor can
change how it reaches GitHub without touching the policy.
