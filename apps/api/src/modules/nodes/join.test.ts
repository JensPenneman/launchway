import { describe, expect, it } from 'vitest';
import { agentImageTag, agentServerUrl, joinInstructions } from './join.js';

describe('join instructions', () => {
  it('derives the agent server URL from the public origin', () => {
    expect(agentServerUrl('https://deploy.example.com')).toBe('wss://deploy.example.com');
    expect(agentServerUrl('http://192.168.1.10:3000/')).toBe('ws://192.168.1.10:3000');
  });

  it('pins release images and falls back to latest otherwise', () => {
    expect(agentImageTag('0.1.0')).toBe('0.1.0');
    expect(agentImageTag('0.0.0-test')).toBe('latest');
    expect(agentImageTag('edge')).toBe('edge');
  });

  it('builds docker run and Compose snippets with the token', () => {
    const token = `slpn_${'a'.repeat(43)}`;
    const { dockerRunCommand, composeSnippet } = joinInstructions({
      serverUrl: 'wss://deploy.example.com',
      token,
      version: '0.1.0',
      expiresAt: new Date('2026-01-01T00:15:00Z'),
    });
    expect(dockerRunCommand).toContain(`-e SLIPWAY_JOIN_TOKEN='${token}'`);
    expect(dockerRunCommand).toContain("-e SLIPWAY_SERVER_URL='wss://deploy.example.com'");
    expect(dockerRunCommand).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(dockerRunCommand).toMatch(/ghcr\.io\/jenspenneman\/slipway-agent:0\.1\.0$/);
    expect(composeSnippet).toContain(`SLIPWAY_JOIN_TOKEN: "${token}"`);
    expect(composeSnippet).toContain('network_mode: host');
    expect(composeSnippet).toContain('stop_grace_period: 30s');
    expect(dockerRunCommand).toContain('--stop-timeout 30');
    expect(composeSnippet).toContain('2026-01-01T00:15:00.000Z');
  });
});
