import { randomBytes } from 'node:crypto';
import { GitHubAppManifest, generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  defaultAppName,
  MANIFEST_STATE_TTL_MS,
  manifestPostUrl,
  signManifestState,
  verifyManifestState,
} from './manifest.js';

const key = randomBytes(32);

describe('GitHub App manifest', () => {
  it('builds the manifest with the platform URLs and the permissions Launchway needs', () => {
    const id = generateId('gh');
    const manifest = buildManifest(
      'https://deploy.example.com',
      id,
      'Launchway (deploy.example.com)',
    );
    expect(GitHubAppManifest.parse(manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({
      redirect_url: 'https://deploy.example.com/api/v1/github/connections/app-manifest/callback',
      setup_url: `https://deploy.example.com/api/v1/github/connections/${id}/installation-callback`,
      hook_attributes: { url: 'https://deploy.example.com/api/v1/webhooks/github', active: true },
      default_permissions: {
        contents: 'read',
        metadata: 'read',
        deployments: 'write',
        pull_requests: 'read',
      },
      default_events: ['release', 'pull_request'],
      public: false,
    });
  });

  it('names the app after the public host within GitHub limits', () => {
    expect(defaultAppName('https://deploy.example.com')).toBe('Launchway (deploy.example.com)');
    const long = defaultAppName('https://a-very-long-subdomain.of-a-long-domain.example.com');
    expect(long.length).toBeLessThanOrEqual(34);
    expect(long.startsWith('Launchway (')).toBe(true);
  });

  it('posts to the personal or organization app form with the state', () => {
    expect(manifestPostUrl('s.t')).toBe('https://github.com/settings/apps/new?state=s.t');
    expect(manifestPostUrl('s', 'acme')).toBe(
      'https://github.com/organizations/acme/settings/apps/new?state=s',
    );
  });

  it('signs and verifies the state', () => {
    const connectionId = generateId('gh');
    const state = signManifestState(key, { connectionId, userId: 'user_x' });
    expect(state.length).toBeLessThanOrEqual(256);
    expect(verifyManifestState(key, state)).toMatchObject({ c: connectionId, u: 'user_x' });
  });

  it('rejects tampered, foreign-key and expired states', () => {
    const connectionId = generateId('gh');
    const now = Date.now();
    const state = signManifestState(key, { connectionId, userId: null }, now);
    const [body = '', signature = ''] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ c: generateId('gh'), u: null, e: 9_999_999_999, n: 'x' }),
    ).toString('base64url');
    expect(verifyManifestState(key, `${forged}.${signature}`)).toBeNull();
    expect(verifyManifestState(randomBytes(32), state)).toBeNull();
    expect(verifyManifestState(key, `${body}.`)).toBeNull();
    expect(verifyManifestState(key, 'garbage')).toBeNull();
    expect(verifyManifestState(key, state, now + MANIFEST_STATE_TTL_MS + 1000)).toBeNull();
  });
});
