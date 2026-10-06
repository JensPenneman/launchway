import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  type GitHubAppManifest,
  GitHubConnectionId,
} from '@slipway/contracts';
import { z } from 'zod';

/** GitHub limits app names to 34 characters. */
const MAX_APP_NAME = 34;
export const MANIFEST_STATE_TTL_MS = 60 * 60 * 1000;

/** Default app name: `Slipway (<public host>)`, shortened to GitHub's limit. */
export function defaultAppName(publicUrl: string): string {
  const host = new URL(publicUrl).host;
  const name = `Slipway (${host})`;
  if (name.length <= MAX_APP_NAME) return name;
  return `Slipway (${host.slice(0, MAX_APP_NAME - 13)}...)`;
}

/** Callback URLs of a connection; `publicUrl` is an origin without trailing slash. */
export function connectionUrls(publicUrl: string, connectionId: GitHubConnectionId) {
  return {
    redirectUrl: `${publicUrl}/api/v1/github/connections/app-manifest/callback`,
    setupUrl: `${publicUrl}/api/v1/github/connections/${connectionId}/installation-callback`,
    webhookUrl: `${publicUrl}/api/v1/webhooks/github`,
    settingsUrl: `${publicUrl}/settings/github?connection=${connectionId}`,
  };
}

export function buildManifest(
  publicUrl: string,
  connectionId: GitHubConnectionId,
  name: string,
): GitHubAppManifest {
  const urls = connectionUrls(publicUrl, connectionId);
  return {
    name,
    url: publicUrl,
    hook_attributes: { url: urls.webhookUrl, active: true },
    redirect_url: urls.redirectUrl,
    callback_urls: [urls.redirectUrl],
    setup_url: urls.setupUrl,
    description: 'Deploys GitHub releases of your repositories with Slipway.',
    public: false,
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    default_events: [...GITHUB_APP_EVENTS],
    setup_on_update: true,
    request_oauth_on_install: false,
  };
}

/** Where the UI posts the manifest form. */
export function manifestPostUrl(state: string, organization?: string): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

const StatePayload = z.object({
  /** Connection id reserved for the app being created (also in setup_url). */
  c: GitHubConnectionId,
  /** User who started the flow; null for non-user principals. */
  u: z.string().nullable(),
  /** Expiry, epoch seconds. */
  e: z.number().int(),
  /** Nonce. */
  n: z.string(),
});
export type ManifestState = z.infer<typeof StatePayload>;

function stateKey(secretKey: Buffer): Buffer {
  return createHmac('sha256', secretKey).update('slipway:github-manifest-state:v1').digest();
}

function sign(secretKey: Buffer, body: string): Buffer {
  return createHmac('sha256', stateKey(secretKey)).update(body).digest();
}

/** Signed, expiring `state` for the manifest flow: `<base64url payload>.<base64url hmac>`. */
export function signManifestState(
  secretKey: Buffer,
  input: { connectionId: GitHubConnectionId; userId: string | null },
  now = Date.now(),
): string {
  const payload: ManifestState = {
    c: input.connectionId,
    u: input.userId,
    e: Math.floor((now + MANIFEST_STATE_TTL_MS) / 1000),
    n: randomBytes(9).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secretKey, body).toString('base64url')}`;
}

/** Returns the payload of a valid, unexpired state; null otherwise. */
export function verifyManifestState(
  secretKey: Buffer,
  state: string,
  now = Date.now(),
): ManifestState | null {
  const [body, signature, ...rest] = state.split('.');
  if (!body || !signature || rest.length > 0) return null;
  const expected = sign(secretKey, body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = StatePayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return payload.e * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}
