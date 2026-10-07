import { describe, expect, it } from 'vitest';
import {
  containerServiceMap,
  normalizeTimestamp,
  parseComposeLogLine,
  parseComposePs,
  toPublishedPorts,
} from './compose-output.js';

const web = {
  ID: 'db2655ad371b',
  Name: 'launchway-trail-web-1',
  Service: 'web',
  State: 'running',
  Health: 'healthy',
  Publishers: [
    { URL: '192.168.1.20', TargetPort: 8080, PublishedPort: 53732, Protocol: 'tcp' },
    { URL: '', TargetPort: 9000, PublishedPort: 0, Protocol: 'tcp' },
  ],
};
const worker = {
  ID: 'f358da6c5e51',
  Name: 'launchway-trail-worker-1',
  Service: 'worker',
  State: 'exited',
  Health: '',
  Publishers: null,
};

describe('parseComposePs', () => {
  it('reads newline-delimited JSON', () => {
    expect(parseComposePs(`${JSON.stringify(worker)}\n${JSON.stringify(web)}\n`)).toEqual([
      {
        service: 'web',
        containerId: 'db2655ad371b',
        state: 'running',
        health: 'healthy',
        publishedPorts: [
          { containerPort: 8080, hostPort: 53732, protocol: 'tcp', hostIp: '192.168.1.20' },
        ],
      },
      {
        service: 'worker',
        containerId: 'f358da6c5e51',
        state: 'exited',
        health: null,
        publishedPorts: [],
      },
    ]);
  });

  it('reads the older array format and empty output', () => {
    expect(parseComposePs(JSON.stringify([web]))).toHaveLength(1);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('\n')).toEqual([]);
  });

  it('maps unknown states and health values defensively', () => {
    const [status] = parseComposePs(JSON.stringify({ ...web, State: 'weird', Health: 'odd' }));
    expect(status).toMatchObject({ state: 'exited', health: null });
  });
});

describe('toPublishedPorts', () => {
  it('drops unpublished ports, dedupes, and keeps wildcard addresses', () => {
    expect(
      toPublishedPorts([
        { URL: '0.0.0.0', TargetPort: 25, PublishedPort: 25, Protocol: 'tcp' },
        { URL: '0.0.0.0', TargetPort: 25, PublishedPort: 25, Protocol: 'tcp' },
        { URL: '::', TargetPort: 25, PublishedPort: 25, Protocol: 'tcp' },
        { URL: 'not-an-ip', TargetPort: 53, PublishedPort: 5353, Protocol: 'udp' },
        { URL: '', TargetPort: 80, PublishedPort: 0, Protocol: 'tcp' },
      ]),
    ).toEqual([
      { containerPort: 25, hostPort: 25, protocol: 'tcp', hostIp: '0.0.0.0' },
      { containerPort: 25, hostPort: 25, protocol: 'tcp', hostIp: '::' },
      { containerPort: 53, hostPort: 5353, protocol: 'udp', hostIp: null },
    ]);
  });
});

describe('log lines', () => {
  const services = containerServiceMap(
    [web, worker, { ...web, Name: 'custom-name', Service: 'api' }]
      .map((e) => JSON.stringify(e))
      .join('\n'),
    'launchway-trail',
  );

  it('normalizes nanosecond timestamps', () => {
    expect(normalizeTimestamp('2026-10-06T22:25:38.915202085Z')).toBe('2026-10-06T22:25:38.915Z');
    expect(normalizeTimestamp('2026-10-06T22:25:38Z')).toBe('2026-10-06T22:25:38.000Z');
    expect(normalizeTimestamp('2026-10-06T22:25:38.5+02:00')).toBe('2026-10-06T20:25:38.500Z');
    expect(normalizeTimestamp('yesterday')).toBeNull();
  });

  it('parses prefixed, timestamped lines', () => {
    expect(
      parseComposeLogLine(
        'web-1  | 2026-10-06T22:25:38.915202085Z Starting up on port 80',
        services,
      ),
    ).toEqual({
      service: 'web',
      timestamp: '2026-10-06T22:25:38.915Z',
      stream: 'stdout',
      line: 'Starting up on port 80',
    });
    expect(
      parseComposeLogLine('custom-name  | 2026-10-06T22:25:38Z  indented', services),
    ).toMatchObject({
      service: 'api',
      line: ' indented',
    });
    expect(parseComposeLogLine('worker-1  | 2026-10-06T22:25:38Z', services)).toMatchObject({
      line: '',
    });
    expect(
      parseComposeLogLine('other-svc-2 | 2026-10-06T22:25:38Z x', new Map(), 'stderr'),
    ).toMatchObject({
      service: 'other-svc',
      stream: 'stderr',
    });
  });

  it('ignores lines that are not container output', () => {
    expect(parseComposeLogLine('no such service: nope', services)).toBeNull();
    expect(parseComposeLogLine('web-1 | not-a-time hello', services)).toBeNull();
    expect(parseComposeLogLine('Web_ | 2026-10-06T22:25:38Z x', new Map())).toBeNull();
  });
});
