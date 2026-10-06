import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Email, NODE_JOIN_TOKEN_PATTERN, PublicUrl } from '@slipway/contracts';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly env: 'development' | 'production' | 'test';
  readonly databaseUrl: string;
  /** Raw 32-byte master key; use lib/crypto to derive purpose-specific keys. */
  readonly secretKey: Buffer;
  readonly listen: { readonly host: string; readonly port: number };
  /** SLIPWAY_PUBLIC_URL override of Setting.publicUrl (origin, no trailing slash). */
  readonly publicUrl: string | null;
  readonly caddyAdminUrl: string;
  readonly proxyNetwork: string;
  /** CIDRs whose X-Forwarded-* headers are trusted. */
  readonly trustedProxies: readonly string[];
  /** Default for Setting.acmeEmail (also used by the Caddy bootstrap file). */
  readonly acmeEmail: string | null;
  /** Bootstrap join token for the bundled agent on the local (edge) node. */
  readonly localJoinToken: string | null;
  /** Directory with the built web UI (index.html). */
  readonly webRoot: string;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

const listenAddress = z
  .string()
  .default('0.0.0.0:3000')
  .transform((value, ctx) => {
    const match = /^(?:\[(?<v6>[0-9a-fA-F:.]+)\]|(?<host>[^:[\]]+)):(?<port>\d{1,5})$/.exec(value);
    const port = Number(match?.groups?.port);
    const host = match?.groups?.v6 ?? match?.groups?.host;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      ctx.addIssue({ code: 'custom', message: 'must look like 0.0.0.0:3000 or [::]:3000' });
      return z.NEVER;
    }
    return { host, port };
  });

const secretKey = z.string().transform((value, ctx) => {
  const key = /^[A-Za-z0-9+/_-]{43}=?$/.test(value) ? Buffer.from(value, 'base64') : undefined;
  if (key?.length !== 32) {
    ctx.addIssue({ code: 'custom', message: 'must be 32 random bytes, base64 encoded' });
    return z.NEVER;
  }
  return key;
});

const cidrList = z
  .string()
  .default('10.210.0.0/24')
  .transform((value, ctx) => {
    const cidrs = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const cidr of cidrs) {
      const [address = '', prefix = ''] = cidr.split('/');
      const family = isIP(address);
      const bits = Number(prefix);
      if (family === 0 || !/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) {
        ctx.addIssue({ code: 'custom', message: `"${cidr}" is not a CIDR such as 10.210.0.0/24` });
        return z.NEVER;
      }
    }
    return cidrs;
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  SLIPWAY_SECRET_KEY: secretKey,
  SLIPWAY_LISTEN: listenAddress,
  SLIPWAY_PUBLIC_URL: PublicUrl.optional(),
  SLIPWAY_CADDY_ADMIN_URL: z.url({ protocol: /^https?$/ }).default('http://caddy:2019'),
  SLIPWAY_PROXY_NETWORK: z.string().min(1).max(64).default('slipway-proxy'),
  SLIPWAY_TRUSTED_PROXIES: cidrList,
  SLIPWAY_ACME_EMAIL: Email.optional(),
  SLIPWAY_LOCAL_JOIN_TOKEN: z
    .string()
    .regex(NODE_JOIN_TOKEN_PATTERN, 'must be slpn_ followed by 43 base62 characters')
    .optional(),
  SLIPWAY_WEB_ROOT: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/**
 * Parses the process environment (spec section 13). Empty values count as unset. Error messages
 * name the variable but never echo its value.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const input = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      ),
    );
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    secretKey: e.SLIPWAY_SECRET_KEY,
    listen: e.SLIPWAY_LISTEN,
    publicUrl: e.SLIPWAY_PUBLIC_URL ? new URL(e.SLIPWAY_PUBLIC_URL).origin : null,
    caddyAdminUrl: e.SLIPWAY_CADDY_ADMIN_URL.replace(/\/+$/, ''),
    proxyNetwork: e.SLIPWAY_PROXY_NETWORK,
    trustedProxies: e.SLIPWAY_TRUSTED_PROXIES,
    acmeEmail: e.SLIPWAY_ACME_EMAIL ?? null,
    localJoinToken: e.SLIPWAY_LOCAL_JOIN_TOKEN ?? null,
    webRoot: e.SLIPWAY_WEB_ROOT ?? DEFAULT_WEB_ROOT,
    logLevel: e.LOG_LEVEL,
  };
}
