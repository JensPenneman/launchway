import { type Logger, pino } from 'pino';
import type { LogLevel } from './config.js';

/**
 * Paths that are always redacted. Logs must never contain secrets, tokens or Authorization
 * headers (spec section 14); redaction is the safety net, not the primary control: do not log
 * request bodies, environment values or credentials in the first place.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'secret',
  'secretKey',
  'credential',
  'credentials',
  'privateKey',
  'clientSecret',
  'webhookSecret',
  'joinToken',
  'databaseUrl',
  'env',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.secretKey',
  '*.credential',
  '*.credentials',
  '*.privateKey',
  '*.clientSecret',
  '*.webhookSecret',
  '*.joinToken',
  '*.databaseUrl',
  '*.env',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(options: { level: LogLevel; name?: string }): Logger {
  return pino({
    name: options.name ?? 'launchway-api',
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
