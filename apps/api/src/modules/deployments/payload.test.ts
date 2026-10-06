import { generateId } from '@slipway/contracts';
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
    },
    clone: { cloneUrl: 'https://github.com/octo/trail.git', authorization: 'basic eA==' },
    env: { PLAIN: 'a', SECRET: 's3' },
    routes: [
      { service: 'web', port: 8080 },
      { service: 'web', port: 8080 },
      { service: 'api', port: 3000 },
    ],
    proxyNetwork: 'slipway-proxy',
    nodeLanIp: '192.168.1.20',
    edgeNodeId: edge,
    ...overrides,
  };
}

describe('buildDeployPayload', () => {
  it('does not publish on the LAN IP when the app runs on the edge node', () => {
    expect(buildDeployPayload(input()).network).toEqual({
      proxyNetwork: 'slipway-proxy',
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

  it('treats a missing edge node as "not the edge"', () => {
    expect(buildDeployPayload(input({ edgeNodeId: null })).network.publishOnIp).toBe(
      '192.168.1.20',
    );
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
        },
      }),
    );
    expect(payload.source).toMatchObject({
      ref: 'v1.0.0',
      commitSha: SHA,
      authorization: 'basic eA==',
    });
    expect(payload.env).toEqual({ PLAIN: 'a', SECRET: 's3' });
    expect(payload.build).toEqual({ kind: 'dockerfile', dockerfile: 'Dockerfile', context: '.' });
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
    expect((error as InvalidDeployPayloadError).paths).toEqual(['routes.0.service']);
  });
});
