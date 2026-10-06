# 6. DNS providers are plugins

Date: 2026-10-06

## Status

Accepted

## Context

Slipway serves domains from a home connection whose public IPv4 can change
([architecture.md](../architecture.md) §5, §6). Keeping app domains pointed at
it means writing DNS records, and people host their zones with different
providers, some of which have no API. Provider specifics must not leak into
domains, routes or the UI.

## Decision

- Every provider implements one interface:
  `DnsProvider { kind; capabilities: { proxied; ttl }; listZones; listRecords;
  upsertRecord; deleteRecord; verifyCredentials }`.
- A registry maps `kind` to `{ credentialsSchema, create(creds), label,
  docsUrl }`, where `credentialsSchema` is a Zod schema.
  `GET /api/v1/dns/providers` returns the registry with each schema as JSON
  Schema, and the UI renders the "add provider account" form from it.
  Credentials are stored encrypted in `DnsProviderAccount`.
- v0.1 ships two providers: `cloudflare` (API token; zones; `A`, `AAAA`,
  `CNAME` and `TXT` records; `proxied`) and `manual` (no API: the UI shows the
  records to create, and Slipway only verifies them).
- Adding a provider means one file in `apps/api/src/modules/dns/providers/`,
  a registry entry and the shared contract test, which every provider must
  pass against the interface.
- `Setting.anchorHostname` (for example `home.example.com`) holds the
  public IPv4 as an `A` record. Every 5 minutes the API asks two independent
  HTTP services for the public IPv4; when both agree and the address changed,
  it updates the record through the provider of the anchor's zone.
- Managed app domains are created as `CNAME <anchor>`, DNS-only by default.
  `proxied` is a per-record option where the provider supports it.

## Consequences

- An IP change updates one record; every app domain follows through its
  CNAME.
- New providers are self-contained: the UI needs no change, and the contract
  test defines what a working provider is.
- The credentials form is generated from the schema, so the schema's field
  descriptions are the help text users see.
- With the `manual` provider, Slipway cannot update the anchor record; dynamic
  DNS needs a provider with an API.
- Standard DNS forbids a CNAME at a zone apex. An apex domain depends on the
  provider flattening the CNAME (Cloudflare does) or needs an `A` record that
  is maintained outside Slipway.
- Dynamic DNS tracks IPv4 in v0.1. `AAAA` records can be managed but do not
  follow a changing address.
- `TXT` records are supported for domain verification and a future ACME DNS-01
  challenge.
