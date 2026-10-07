import { type Logger, pino } from 'pino';
import type { LogLevel } from './config.js';

/** Safety net only: never log tokens, credentials, Authorization headers or environment values. */
const REDACT_PATHS = [
  'authorization',
  'token',
  'joinToken',
  'credential',
  'env',
  '*.authorization',
  '*.token',
  '*.joinToken',
  '*.credential',
  '*.env',
  'payload.env',
  'payload.credential',
  'payload.source.authorization',
];

export function createLogger(level: LogLevel): Logger {
  return pino({
    name: 'launchway-agent',
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
