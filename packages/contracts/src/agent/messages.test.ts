import { describe, expect, it } from 'vitest';
import { generateId } from '../ids.js';
import {
  AGENT_TO_SERVER_TYPES,
  DeployMessage,
  parseAgentToServerMessage,
  parseServerToAgentMessage,
  SERVER_TO_AGENT_TYPES,
} from './messages.js';
import { AGENT_PROTOCOL_VERSION, isSupportedProtocolVersion } from './protocol.js';

const hello = {
  id: 'm-1',
  type: 'hello',
  payload: {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: '0.1.0',
    hostname: 'nuc',
    platform: { os: 'linux', arch: 'arm64' },
    lanIp: '192.168.1.20',
    docker: null,
    dockerError: 'connect ENOENT /var/run/docker.sock',
  },
};

describe('agent protocol', () => {
  it('lists the message types of the specification (plus error and deployment.cancel)', () => {
    expect([...AGENT_TO_SERVER_TYPES].sort()).toEqual(
      [
        'hello',
        'heartbeat',
        'deployment.progress',
        'deployment.log',
        'deployment.result',
        'app.status',
        'logs.chunk',
        'logs.end',
        'error',
      ].sort(),
    );
    expect([...SERVER_TO_AGENT_TYPES].sort()).toEqual(
      [
        'hello.ok',
        'deploy',
        'deployment.cancel',
        'stop',
        'remove',
        'status',
        'logs.start',
        'logs.stop',
        'error',
      ].sort(),
    );
  });

  it('parses a valid hello', () => {
    const result = parseAgentToServerMessage(JSON.stringify(hello));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.type).toBe('hello');
  });

  it('reports invalid JSON, envelopes and payloads with the request id when known', () => {
    expect(parseAgentToServerMessage('{nope')).toMatchObject({ ok: false, reason: 'invalid-json' });
    expect(parseAgentToServerMessage(JSON.stringify({ type: 'hello' }))).toMatchObject({
      ok: false,
      reason: 'invalid-envelope',
    });
    expect(
      parseAgentToServerMessage(
        JSON.stringify({ ...hello, payload: { ...hello.payload, protocolVersion: 0 } }),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid-payload', id: 'm-1', type: 'hello' });
  });

  it('flags unknown types separately so they can be ignored (forward compatibility)', () => {
    expect(
      parseServerToAgentMessage(JSON.stringify({ id: 'x', type: 'future.thing', payload: {} })),
    ).toMatchObject({
      ok: false,
      reason: 'unknown-type',
      id: 'x',
      type: 'future.thing',
    });
  });

  it('accepts a complete deploy request and rejects unsafe refs', () => {
    const deploy = {
      id: 'req-1',
      type: 'deploy',
      payload: {
        deploymentId: generateId('dep'),
        app: { id: generateId('app'), slug: 'trail' },
        source: {
          cloneUrl: 'https://github.com/jenspenneman/trail.git',
          ref: 'v1.2.0',
          commitSha: '3f786850e387550fdab836ed7e6dc881de23001b',
          authorization: 'basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=',
        },
        build: { kind: 'compose', composeFiles: ['compose.yaml'] },
        env: { DATABASE_URL: 'postgres://example' },
        routes: [{ service: 'web', port: 8080, alias: 'trail-web' }],
        network: { proxyNetwork: 'launchway-proxy', publishOnIp: null },
      },
    };
    expect(parseServerToAgentMessage(JSON.stringify(deploy)).ok).toBe(true);
    const unsafe = {
      ...deploy,
      payload: { ...deploy.payload, source: { ...deploy.payload.source, ref: '--upload-pack=x' } },
    };
    expect(DeployMessage.safeParse(unsafe).success).toBe(false);
    const insecure = {
      ...deploy,
      payload: {
        ...deploy.payload,
        source: { ...deploy.payload.source, cloneUrl: 'http://github.com/a/b.git' },
      },
    };
    expect(DeployMessage.safeParse(insecure).success).toBe(false);
  });

  it('checks protocol compatibility', () => {
    expect(isSupportedProtocolVersion(AGENT_PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedProtocolVersion(AGENT_PROTOCOL_VERSION + 1)).toBe(false);
  });
});
