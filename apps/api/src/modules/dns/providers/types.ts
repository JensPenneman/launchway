import type {
  DnsProviderCapabilities,
  DnsProviderKind,
  DnsRecord,
  DnsRecordInput,
  DnsZoneInfo,
} from '@launchway/contracts';
import type { ZodType } from 'zod';

/**
 * One DNS provider account, ready to use (credentials already bound). Every method throws
 * `DnsProviderError` for provider-side failures; the service layer maps those to problems.
 */
export interface DnsProvider {
  readonly kind: DnsProviderKind;
  readonly capabilities: DnsProviderCapabilities;
  listZones(): Promise<DnsZoneInfo[]>;
  /** Records of the supported types (A, AAAA, CNAME, TXT); other types are left out. */
  listRecords(zoneExternalId: string): Promise<DnsRecord[]>;
  /**
   * Creates or updates a record. With `recordExternalId` that record is updated. Without it, an
   * existing record with the same name and type (TXT: same name and content) is updated, and a
   * new one is created otherwise. `proxied` is ignored without the `proxied` capability, `ttl`
   * without the `ttl` capability.
   */
  upsertRecord(
    zoneExternalId: string,
    record: DnsRecordInput,
    recordExternalId?: string,
  ): Promise<DnsRecord>;
  /** Throws `DnsProviderError` with reason `not-found` when the record does not exist. */
  deleteRecord(zoneExternalId: string, recordExternalId: string): Promise<void>;
  /** Resolves when the credentials work; throws `unauthorized` / `forbidden` otherwise. */
  verifyCredentials(): Promise<void>;
}

/** Runtime services a provider may use; injected so tests never touch the network. */
export interface DnsProviderContext {
  readonly fetch: typeof fetch;
}

/** A registry entry: how to validate credentials for a provider kind and build a client. */
export interface DnsProviderDefinition<Credentials = unknown> {
  readonly kind: DnsProviderKind;
  readonly label: string;
  readonly docsUrl: string | null;
  readonly capabilities: DnsProviderCapabilities;
  /** Validates the stored credentials; also exposed to the UI as JSON Schema. */
  readonly credentialsSchema: ZodType<Credentials>;
  create(credentials: Credentials, context: DnsProviderContext): DnsProvider;
}

export const DNS_PROVIDER_ERROR_REASONS = [
  'unauthorized',
  'forbidden',
  'rate-limited',
  'not-found',
  'conflict',
  'invalid',
  'unavailable',
] as const;
export type DnsProviderErrorReason = (typeof DNS_PROVIDER_ERROR_REASONS)[number];

/** Provider-side failure. `message` is shown to users: never include credentials in it. */
export class DnsProviderError extends Error {
  readonly reason: DnsProviderErrorReason;
  /** Seconds, when the provider asked to back off. */
  readonly retryAfter: number | undefined;

  constructor(
    reason: DnsProviderErrorReason,
    message: string,
    options: { retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DnsProviderError';
    this.reason = reason;
    this.retryAfter = options.retryAfter;
  }
}
