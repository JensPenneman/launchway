import { describe, expect, it } from 'vitest';
import { AgentConfigError, loadAgentConfig, toSocketUrl } from './config.js';

describe('agent config', () => {
  it('derives the socket URL from ws(s) and http(s) base URLs', () => {
    expect(toSocketUrl('ws://launchway:3000')).toBe('ws://launchway:3000/api/agent/ws');
    expect(toSocketUrl('https://deploy.example.com')).toBe('wss://deploy.example.com/api/agent/ws');
    expect(toSocketUrl('http://localhost:3000/')).toBe('ws://localhost:3000/api/agent/ws');
  });

  it('applies defaults and treats empty values as unset', () => {
    expect(
      loadAgentConfig({ LAUNCHWAY_SERVER_URL: 'ws://launchway:3000', LAUNCHWAY_JOIN_TOKEN: '' }),
    ).toEqual({
      socketUrl: 'ws://launchway:3000/api/agent/ws',
      joinToken: null,
      lanIp: null,
      workspace: '/var/lib/launchway',
      dockerHost: 'unix:///var/run/docker.sock',
      logLevel: 'info',
    });
  });

  it('rejects malformed values without echoing tokens', () => {
    const token = 'lwyn_not-a-valid-token';
    try {
      loadAgentConfig({
        LAUNCHWAY_SERVER_URL: 'ftp://x',
        LAUNCHWAY_JOIN_TOKEN: token,
        LAUNCHWAY_NODE_LAN_IP: 'nope',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigError);
      const message = (error as Error).message;
      expect(message).toMatch(
        /LAUNCHWAY_SERVER_URL[\s\S]*LAUNCHWAY_JOIN_TOKEN[\s\S]*LAUNCHWAY_NODE_LAN_IP/,
      );
      expect(message).not.toContain(token);
    }
  });
});
