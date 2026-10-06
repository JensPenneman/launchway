import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ProblemError } from '../../lib/problem.js';

const ADAPT_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 2000;

/** Client for the Caddy admin API (`SLIPWAY_CADDY_ADMIN_URL`). */
export interface CaddyAdmin {
  /** Validates a Caddyfile (`POST /adapt`) and returns the JSON configuration. */
  adapt(caddyfile: string): Promise<unknown>;
  /** Validates, then replaces the running configuration (`POST /load`). */
  load(caddyfile: string): Promise<void>;
}

/** Caddy rejected the configuration or its admin API failed. */
export class CaddyError extends Error {
  override readonly name = 'CaddyError';
  /** True when Caddy could not be reached at all. */
  readonly unreachable: boolean;

  constructor(message: string, unreachable: boolean, cause?: unknown) {
    super(message, { cause });
    this.unreachable = unreachable;
  }

  toProblem(): ProblemError {
    return this.unreachable
      ? new ProblemError('service-unavailable', {
          detail: `The Caddy admin API is unreachable: ${this.message}`,
          cause: this,
        })
      : new ProblemError('upstream-failed', {
          detail: `Caddy rejected the configuration: ${this.message}`,
          cause: this,
        });
  }
}

/** Minimal HTTP POST used to reach the admin API; replaceable in tests. */
export type CaddyTransport = (
  url: string,
  body: string,
  contentType: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>;

/**
 * POST with node:http(s). Not `fetch`: undici always sends `Sec-Fetch-Mode: cors`, which makes
 * Caddy treat the call as a browser request and reject it ("not allowed to access from origin").
 */
export const nodeHttpTransport: CaddyTransport = (url, body, contentType, timeoutMs) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(body);
  });

/** Caddy answers errors as `{"error": "..."}`; fall back to the raw body. */
function errorMessage(status: number, text: string): string {
  let message = text.trim();
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {
    // Not JSON: keep the text.
  }
  message ||= `HTTP ${status}`;
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...`
    : message;
}

export function createCaddyAdmin(
  adminUrl: string,
  transport: CaddyTransport = nodeHttpTransport,
): CaddyAdmin {
  const base = adminUrl.replace(/\/+$/, '');

  async function post(path: string, body: string, contentType: string, timeoutMs: number) {
    let response: { status: number; body: string };
    try {
      response = await transport(`${base}${path}`, body, contentType, timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CaddyError(reason, true, error);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CaddyError(errorMessage(response.status, response.body), false);
    }
    return response.body;
  }

  async function adapt(caddyfile: string): Promise<unknown> {
    const body = await post('/adapt', caddyfile, 'text/caddyfile', ADAPT_TIMEOUT_MS);
    let adapted: { result?: unknown };
    try {
      adapted = JSON.parse(body) as { result?: unknown };
    } catch (error) {
      throw new CaddyError('adapt returned invalid JSON', false, error);
    }
    if (adapted.result === undefined) {
      throw new CaddyError('adapt returned no configuration', false);
    }
    return adapted.result;
  }

  return {
    adapt,
    async load(caddyfile) {
      const config = await adapt(caddyfile);
      // Load the adapted JSON so Caddy runs exactly what was validated.
      await post('/load', JSON.stringify(config), 'application/json', LOAD_TIMEOUT_MS);
    },
  };
}
