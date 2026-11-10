import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Deps } from '../../deps.js';
import { settings } from '../settings/schema.js';
import { NOTIFY_TOKEN_CONTEXT } from '../settings/service.js';

export const NTFY_PRIORITIES = ['min', 'low', 'default', 'high', 'urgent'] as const;
export type NtfyPriority = (typeof NTFY_PRIORITIES)[number];

/** What a notification carries: PR numbers, versions and links, never log text or secrets. */
export interface Notification {
  title: string;
  priority: NtfyPriority;
  tags?: readonly string[];
  /** URL opened when the notification is tapped. */
  click?: string;
  /** Collapsed to one line of at most NOTIFY_BODY_LIMIT characters. */
  body: string;
}

export const NOTIFY_BODY_LIMIT = 500;
export const NOTIFY_TRIES = 3;
const BACKOFF_MS = [1_000, 4_000] as const;
/** Worst case of one notify: 3 tries of 3 s plus 5 s of backoff, about 14 s. */
const TRY_TIMEOUT_MS = 3_000;

export interface NtfyTarget {
  url: string;
  token: string | null;
}

export interface NtfyOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
}

export type NotifyResult =
  | { delivered: true; tries: number }
  | { delivered: false; tries: number; reason: 'not-configured' | 'rejected' | 'unreachable' };

/** One line of at most NOTIFY_BODY_LIMIT characters (an ellipsis marks a cut). */
export function oneLine(text: string, limit = NOTIFY_BODY_LIMIT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= limit ? line : `${chars.slice(0, limit - 1).join('')}…`;
}

/** Header values must be one line of printable ASCII; anything else travels RFC 2047 encoded. */
function headerValue(text: string): string {
  const line = oneLine(text, 250);
  if (/^[\x20-\x7e]*$/.test(line)) return line;
  return `=?UTF-8?B?${Buffer.from(line, 'utf8').toString('base64')}?=`;
}

function headersOf(message: Notification, token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    title: headerValue(message.title),
    priority: message.priority,
  };
  if (message.tags?.length) headers.tags = headerValue(message.tags.join(','));
  if (message.click) headers.click = headerValue(message.click);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Posts one message to an ntfy topic: up to three tries with backoff on network errors, timeouts,
 * 429 and 5xx; other statuses fail at once. Redirects are not followed, so the token never leaves
 * the configured host. Never throws: a notification must not break the work it reports on.
 */
export async function sendNtfy(
  target: NtfyTarget,
  message: Notification,
  options: NtfyOptions = {},
): Promise<NotifyResult> {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const body = oneLine(message.body);
  // Never send the bearer token in clear text, whatever the stored URL says.
  if (target.token && !target.url.startsWith('https:')) {
    return { delivered: false, tries: 0, reason: 'rejected' };
  }
  let reason: 'rejected' | 'unreachable' = 'unreachable';
  for (let attempt = 1; attempt <= NOTIFY_TRIES; attempt++) {
    try {
      const response = await send(target.url, {
        method: 'POST',
        headers: headersOf(message, target.token),
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return { delivered: true, tries: attempt };
      reason = 'rejected';
      if (!retryable(response.status)) return { delivered: false, tries: attempt, reason };
    } catch {
      reason = 'unreachable';
    }
    if (attempt < NOTIFY_TRIES) await sleep(backoff[attempt - 1] ?? backoff.at(-1) ?? 0);
  }
  return { delivered: false, tries: NOTIFY_TRIES, reason };
}

export type Notifier = (message: Notification) => Promise<NotifyResult>;

async function loadTarget(db: Database, secrets: Deps['secrets']): Promise<NtfyTarget | null> {
  const [row] = await db
    .select({ url: settings.notifyUrl, token: settings.notifyTokenEncrypted })
    .from(settings)
    .where(eq(settings.id, 1));
  if (!row?.url) return null;
  return {
    url: row.url,
    token: row.token === null ? null : secrets.decrypt(row.token, NOTIFY_TOKEN_CONTEXT),
  };
}

/**
 * `notify({title, priority, tags, click, body})` reads the target from the settings on every call
 * (so a change applies at once) and does nothing while no URL is set. Failures are logged by
 * status only, never with the URL, token or message.
 */
export function createNotifier(
  deps: Pick<Deps, 'db' | 'secrets' | 'logger'>,
  options: NtfyOptions = {},
): Notifier {
  return async (message) => {
    try {
      const target = await loadTarget(deps.db, deps.secrets);
      if (!target) return { delivered: false, tries: 0, reason: 'not-configured' };
      const result = await sendNtfy(target, message, options);
      if (!result.delivered) {
        deps.logger.warn(
          { reason: result.reason, tries: result.tries },
          'notification not delivered',
        );
      }
      return result;
    } catch {
      deps.logger.warn({ reason: 'unreadable-target' }, 'notification not delivered');
      return { delivered: false, tries: 0, reason: 'unreachable' };
    }
  };
}
