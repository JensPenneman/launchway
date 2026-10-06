import { describe, expect, it } from 'vitest';
import { AgentConfigError, loadAgentConfig, toSocketUrl } from './config.js';

describe('agent config', () => {
  it('derives the socket URL from ws(s) and http(s) base URLs', () => {
    expect(toSocketUrl('ws://slipway:3000')).toBe('ws://slipway:3000/api/agent/ws');
    expect(toSocketUrl('https://deploy.example.com')).toBe('wss://deploy.example.com/api/agent/ws');
    expect(toSocketUrl('http://localhost:3000/')).toBe('ws://localhost:3000/api/agent/ws');
  });

  it('applies defaults and treats empty values as unset', () => {
    expect(
      loadAgentConfig({ SLIPWAY_SERVER_URL: 'ws://slipway:3000', SLIPWAY_JOIN_TOKEN: '' }),
    ).toEqual({
      socketUrl: 'ws://slipway:3000/api/agent/ws',
      joinToken: null,
      lanIp: null,
      workspace: '/var/lib/slipway',
      dockerHost: 'unix:///var/run/docker.sock',
      logLevel: 'info',
    });
  });

  it('rejects malformed values without echoing tokens', () => {
    const token = 'slpn_not-a-valid-token';
    try {
      loadAgentConfig({
        SLIPWAY_SERVER_URL: 'ftp://x',
        SLIPWAY_JOIN_TOKEN: token,
        SLIPWAY_NODE_LAN_IP: 'nope',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigError);
      const message = (error as Error).message;
      expect(message).toMatch(
        /SLIPWAY_SERVER_URL[\s\S]*SLIPWAY_JOIN_TOKEN[\s\S]*SLIPWAY_NODE_LAN_IP/,
      );
      expect(message).not.toContain(token);
    }
  });
});
