import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildDeployPayload,
  type DeployPayloadInput,
  InvalidDeployPayloadError,
} from './payload.js';

const edge = generateId('node');
const other = generateId('node');
const SHA = 'a'.repeat(40);

function input(overrides: Partial<DeployPayloadInput> = {}): DeployPayloadInput {
  return {
    deployment: { id: generateId('dep'), ref: 'v1.0.0', commitSha: SHA, nodeId: edge },
    app: {
      id: generateId('app'),
      slug: 'trail',
      composeFiles: ['compose.yaml'],
      dockerfile: null,
      context: null,
      trustedMounts: false,
      proxyServices: [],
    },
    node: { name: 'edge-1' },
    clone: { cloneUrl: 'https://github.com/octo/trail.git', authorization: 'basic eA==' },
    env: { PLAIN: 'a', SECRET: 's3' },
    routes: [
      { service: 'web', port: 8080 },
      { service: 'web', port: 8080 },
      { service: 'api', port: 3000 },
    ],
    forwardAuthTarget: null,
    proxyNetwork: 'launchway-proxy',
    nodeLanIp: '192.168.1.20',
    nodeAllowedBindRoots: [],
    edgeNodeId: edge,
    ...overrides,
  };
}

describe('buildDeployPayload', () => {
  it('does not publish on the LAN IP when the app runs on the edge node', () => {
    expect(buildDeployPayload(input()).network).toEqual({
      proxyNetwork: 'launchway-proxy',
      publishOnIp: null,
    });
  });

  it('publishes on the node LAN IP when the app runs on another node', () => {
    const payload = buildDeployPayload(
      input({
        deployment: { id: generateId('dep'), ref: 'v1', commitSha: SHA, nodeId: other },
      }),
    );
    expect(payload.network.publishOnIp).toBe('192.168.1.20');
  });

  it('treats every node as the edge while no edge node is set, like the edge renderer', () => {
    expect(buildDeployPayload(input({ edgeNodeId: null })).network.publishOnIp).toBeNull();
  });

  it('collapses duplicate routes and assigns proxy aliases', () => {
    expect(buildDeployPayload(input()).routes).toEqual([
      { service: 'api', port: 3000, alias: 'trail-api' },
      { service: 'web', port: 8080, alias: 'trail-web' },
    ]);
  });

  it('carries source, env and build', () => {
    const payload = buildDeployPayload(
      input({
        app: {
          id: generateId('app'),
          slug: 'trail',
          composeFiles: null,
          dockerfile: 'Dockerfile',
          context: '.',
          trustedMounts: false,
          proxyServices: [],
        },
      }),
    );
    expect(payload.source).toMatchObject({
      ref: 'v1.0.0',
      commitSha: SHA,
      authorization: 'basic eA==',
    });
    expect(payload.env).toMatchObject({ PLAIN: 'a', SECRET: 's3' });
    expect(payload.build).toEqual({ kind: 'dockerfile', dockerfile: 'Dockerfile', context: '.' });
  });

  it('fills the mount policy from the app and its node', () => {
    expect(buildDeployPayload(input()).policy).toEqual({
      trustedMounts: false,
      allowedBindRoots: [],
    });
    const trusted = buildDeployPayload(
      input({
        app: { ...input().app, trustedMounts: true },
        nodeAllowedBindRoots: ['/srv/data', '/run/desktop/mnt/host/d/Backups'],
      }),
    );
    expect(trusted.policy).toEqual({
      trustedMounts: true,
      allowedBindRoots: ['/srv/data', '/run/desktop/mnt/host/d/Backups'],
    });
  });

  it('sends the node roots even for untrusted apps (the agent ignores them)', () => {
    const payload = buildDeployPayload(input({ nodeAllowedBindRoots: ['/srv/data'] }));
    expect(payload.policy).toEqual({ trustedMounts: false, allowedBindRoots: ['/srv/data'] });
  });

  it('rejects payloads violating the agent contract without echoing values', () => {
    let error: unknown;
    try {
      buildDeployPayload(
        input({ routes: [{ service: 'db', port: 5432 }], env: { KEY: 'super-secret' } }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidDeployPayloadError);
    expect((error as Error).message).not.toContain('super-secret');
    expect((error as InvalidDeployPayloadError).paths).toContain('routes.0.service');
  });

  it('adds the LAUNCHWAY_* platform variables and lets them win over stored keys', () => {
    const deploymentId = generateId('dep');
    const appId = generateId('app');
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const payload = buildDeployPayload(
      input({
        deployment: { id: deploymentId, ref: 'v2.1.0', commitSha: sha, nodeId: edge },
        app: { ...input().app, id: appId },
        env: { PLAIN: 'a', LAUNCHWAY_APP: 'spoofed', LAUNCHWAY_LEGACY: 'old' },
      }),
    );
    expect(payload.env).toEqual({
      PLAIN: 'a',
      LAUNCHWAY_APP: 'trail',
      LAUNCHWAY_APP_ID: appId,
      LAUNCHWAY_DEPLOYMENT_ID: deploymentId,
      LAUNCHWAY_REF: 'v2.1.0',
      LAUNCHWAY_COMMIT_SHA: sha,
      LAUNCHWAY_COMMIT_SHA_SHORT: '0123456',
      LAUNCHWAY_NODE: 'edge-1',
      LAUNCHWAY_ENVIRONMENT: 'production',
      LAUNCHWAY_PREVIEW_NUMBER: '',
      LAUNCHWAY_PUBLIC_URL: '',
    });
  });

  it('attaches routed services, proxyServices and its forward-auth target service', () => {
    const base = input();
    const payload = buildDeployPayload(
      input({
        app: { ...base.app, proxyServices: ['oauth2-proxy', 'web'] },
        forwardAuthTarget: { appId: base.app.id, service: 'gate', port: 4180, uri: '/' },
      }),
    );
    expect(payload.attach).toEqual([
      { service: 'api', alias: 'trail-api' },
      { service: 'gate', alias: 'trail-gate' },
      { service: 'oauth2-proxy', alias: 'trail-oauth2-proxy' },
      { service: 'web', alias: 'trail-web' },
    ]);
    // Only routed services are published off the edge node; attach entries carry no port.
    expect(payload.routes.map((route) => route.service)).toEqual(['api', 'web']);
  });

  it('ignores a forward-auth target of another app', () => {
    const payload = buildDeployPayload(
      input({
        routes: [],
        forwardAuthTarget: { appId: generateId('app'), service: 'gate', port: 4180, uri: '/' },
      }),
    );
    expect(payload.attach).toEqual([]);
  });
});

describe('buildDeployPayload for previews', () => {
  const previewInput = (overrides: Partial<DeployPayloadInput> = {}) => {
    const base = input();
    return input({
      deployment: { ...base.deployment, ref: SHA },
      app: { ...base.app, trustedMounts: true, proxyServices: ['oauth2-proxy'] },
      env: { PLAIN: 'a', BASE_URL: 'https://trail.example.com', SECRET: 's3' },
      routes: [{ service: 'web', port: 8080 }],
      forwardAuthTarget: { appId: base.app.id, service: 'gate', port: 4180, uri: '/' },
      nodeAllowedBindRoots: ['/srv/data'],
      publicHostname: 'trail.example.com',
      preview: {
        number: 42,
        agentAppId: generateId('app'),
        branch: 'feature/login',
        hostname: 'trail-pr-42.preview.example.com',
        envOverrides: {
          BASE_URL: '{{previewUrl}}',
          DB_NAME: 'trail_pr_{{prNumber}}',
          INFO: '{{branch}}@{{sha}} on {{previewHost}}',
          LAUNCHWAY_ENVIRONMENT: 'spoofed',
        },
        composeFiles: ['compose.preview.yaml'],
      },
      ...overrides,
    });
  };

  it('runs as <slug>-pr-<n> under the preview agent id, with preview aliases', () => {
    const value = previewInput();
    const payload = buildDeployPayload(value);
    expect(payload.app).toEqual({ id: value.preview?.agentAppId, slug: 'trail-pr-42' });
    expect(payload.routes).toEqual([{ service: 'web', port: 8080, alias: 'trail-pr-42-web' }]);
    // Only routed services: no proxyServices, no forward-auth target of the production app.
    expect(payload.attach).toEqual([{ service: 'web', alias: 'trail-pr-42-web' }]);
    expect(payload.build).toEqual({ kind: 'compose', composeFiles: ['compose.preview.yaml'] });
  });

  it('never grants the mount trust to a preview', () => {
    expect(buildDeployPayload(previewInput()).policy).toEqual({
      trustedMounts: false,
      allowedBindRoots: [],
    });
  });

  it('merges app variables with the rendered overrides and the platform variables', () => {
    const payload = buildDeployPayload(previewInput());
    expect(payload.env).toMatchObject({
      PLAIN: 'a',
      SECRET: 's3',
      BASE_URL: 'https://trail-pr-42.preview.example.com',
      DB_NAME: 'trail_pr_42',
      INFO: `feature/login@${SHA} on trail-pr-42.preview.example.com`,
      LAUNCHWAY_APP: 'trail',
      LAUNCHWAY_ENVIRONMENT: 'preview',
      LAUNCHWAY_PREVIEW_NUMBER: '42',
      LAUNCHWAY_PUBLIC_URL: 'https://trail-pr-42.preview.example.com',
    });
  });

  it('uses the app source without a preview compose override', () => {
    const base = previewInput();
    const payload = buildDeployPayload(
      previewInput({
        preview: {
          ...(base.preview as NonNullable<DeployPayloadInput['preview']>),
          composeFiles: null,
        },
      }),
    );
    expect(payload.build).toEqual({ kind: 'compose', composeFiles: ['compose.yaml'] });
  });

  it('gives production its first route as public URL and an empty preview number', () => {
    const payload = buildDeployPayload(input({ publicHostname: 'trail.example.com' }));
    expect(payload.env).toMatchObject({
      LAUNCHWAY_ENVIRONMENT: 'production',
      LAUNCHWAY_PREVIEW_NUMBER: '',
      LAUNCHWAY_PUBLIC_URL: 'https://trail.example.com',
    });
  });
});
