import { z } from './zod.js';

/** RFC 3339 timestamp as serialized by the API (`Date#toISOString()`). */
export const Timestamp = z.iso
  .datetime({ offset: true })
  .openapi({ description: 'RFC 3339 timestamp', example: '2026-10-06T12:00:00.000Z' });

/** E-mail address, normalized to lower case. */
export const Email = z.email().max(254).toLowerCase().openapi({ example: 'ops@example.com' });

/** Human-readable name of a user, token, node, connection, ... */
export const DisplayName = z.string().trim().min(1).max(100);

/** New password (argon2id at rest). */
export const Password = z
  .string()
  .min(12)
  .max(256)
  .openapi({ format: 'password', description: 'At least 12 characters' });

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const DNS_LABEL = '(?!-)[a-z0-9_-]{1,63}(?<!-)';

/** Fully-qualified host name with at least two labels (`app.example.com`). */
export const HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`);
/** DNS record name; like a host name but labels may contain `_` (`_acme-challenge.example.com`). */
export const DNS_NAME_PATTERN = new RegExp(`^(?=.{1,253}$)(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const SINGLE_OR_MULTI_LABEL_HOST = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)*${LABEL}$`);

export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOSTNAME_PATTERN, 'Must be a fully-qualified domain name such as app.example.com')
  .openapi({ example: 'app.example.com' });

export const DnsName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(DNS_NAME_PATTERN, 'Must be a fully-qualified DNS name')
  .openapi({ example: '_acme-challenge.example.com' });

export const IpAddress = z.union([z.ipv4(), z.ipv6()]).openapi({ example: '192.168.1.20' });

/** Upstream host: an IP literal, a container/host alias or a fully-qualified name. */
export const UpstreamHost = z
  .union([
    z.ipv4(),
    z.ipv6(),
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(SINGLE_OR_MULTI_LABEL_HOST, 'Must be a host name or IP address'),
  ])
  .openapi({ example: 'host.docker.internal' });

export const Port = z.number().int().min(1).max(65_535).openapi({ example: 8080 });

/** Absolute http(s) URL. */
export const HttpUrl = z.url({ protocol: /^https?$/ }).openapi({ example: 'https://example.com' });

/** Origin only (`https://deploy.example.com`): no path, query, fragment or credentials. */
export const PublicUrl = z
  .url({ protocol: /^https?$/ })
  .regex(
    /^https?:\/\/[^/?#@\s]+\/?$/,
    'Must be an origin such as https://deploy.example.com (no path, query or credentials)',
  )
  .openapi({ example: 'https://deploy.example.com' });

/**
 * Path relative to a repository root: no leading `/` or `-`, no `..` segments.
 * Used for compose files, Dockerfiles and build contexts.
 */
export const RELATIVE_PATH_PATTERN = /^(?![/-])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]+$/;
export const RelativePath = z
  .string()
  .min(1)
  .max(255)
  .regex(RELATIVE_PATH_PATTERN, 'Must be a relative path inside the repository')
  .openapi({ example: 'compose.yaml' });

/** Git ref accepted for deployments (spec section 9): tag, branch or commit. */
export const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
export const GitRef = z
  .string()
  .min(1)
  .max(255)
  .regex(GIT_REF_PATTERN, 'Must match ^[A-Za-z0-9._/-]+$ and must not start with -')
  .openapi({ example: 'v1.4.2' });

export const CommitSha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Must be a full lowercase commit SHA')
  .openapi({ example: '3f786850e387550fdab836ed7e6dc881de23001b' });

/** Compose service name that can be routed (also used in network aliases). */
export const ServiceName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/, 'Must be a lowercase Compose service name')
  .openapi({ example: 'web' });

/** Free-form JSON object. */
export const JsonObject = z.record(z.string(), z.unknown());
