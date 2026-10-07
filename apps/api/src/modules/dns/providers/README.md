# DNS providers

Launchway talks to DNS hosts through one interface, `DnsProvider` (`types.ts`). Each provider
kind is a registry entry (`DnsProviderDefinition`) in `registry.ts`:

| Field | Purpose |
|---|---|
| `kind` | Registry key stored in `dns_provider_accounts.kind` (`^[a-z][a-z0-9-]{1,31}$`). Never rename it. |
| `label`, `docsUrl` | Shown in the "add DNS provider account" form; `docsUrl` explains how to create credentials. |
| `capabilities` | `proxied` (per-record proxy flag) and `ttl` (custom TTLs). |
| `credentialsSchema` | Zod schema of the credentials. `GET /api/v1/dns/providers` exposes it as JSON Schema, so the UI renders the form without provider-specific code. Use `.meta({ title, description, writeOnly })` for labels. |
| `create(credentials, { fetch })` | Returns a `DnsProvider` bound to validated credentials. |

The credentials are validated with `credentialsSchema`, checked with `verifyCredentials()` and
stored encrypted (context `dns-account:<accountId>`). They are never returned by the API.

## Adding a provider

1. Create `<kind>.ts` in this directory exporting a `DnsProviderDefinition`:
   - Call the provider's HTTP API with the injected `fetch` (no SDKs), with a timeout, and
     validate every response with Zod.
   - Implement the interface semantics documented in `types.ts`: `upsertRecord` updates the
     record named by `recordExternalId`, or else the record with the same name and type (TXT:
     same name and content), and creates one otherwise. `listRecords` returns only A, AAAA,
     CNAME and TXT records with lower-case names. Paginate list calls.
   - Throw `DnsProviderError` with a `reason` (`unauthorized`, `forbidden`, `rate-limited`,
     `not-found`, `conflict`, `invalid`, `unavailable`). The API maps reasons to problem
     documents (`../errors.ts`). Messages are shown to users: never put credentials in them.
2. Add the definition to `dnsProviders` in `registry.ts`.
3. Write a fake of the provider's API (see `apps/api/test/support/fake-cloudflare.ts`) and add
   one `describeDnsProviderContract('<kind> (mocked API)', ...)` call to `contract.test.ts`. The
   contract suite checks the behaviour every provider must share. Add a `<kind>.test.ts` for
   the provider's own mapping (errors, pagination, request bodies).

A provider without an API (like `manual`) lists no zones or records and answers `upsertRecord`
with a record carrying an `instruction` for the user. It does not run the contract suite.

## Shipped providers

- `cloudflare`: API token with `Zone:Read` and `DNS:Edit`. Zones and A/AAAA/CNAME/TXT records,
  `proxied`, custom TTLs (`1` = automatic). `verifyCredentials` calls `/user/tokens/verify` and
  then lists zones, so a token without zone access is rejected when the account is added.
- `manual`: no credentials. Launchway shows which records to create and only verifies them.

Tests use the in-memory provider in `apps/api/test/support/memory-dns.ts`; register it under a
unique kind with `dnsProviders.register(memoryProviderDefinition(kind, state))`.
