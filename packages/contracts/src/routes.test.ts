import { describe, expect, it } from 'vitest';
import { generateId } from './ids.js';
import { CreateRouteInput, ExtraDirectives, RouteTarget, UpdateRouteInput } from './routes.js';

describe('route target union', () => {
  it('parses an app target', () => {
    const appId = generateId('app');
    expect(RouteTarget.parse({ kind: 'app', appId, service: 'web', port: 8080 })).toEqual({
      kind: 'app',
      appId,
      service: 'web',
      port: 8080,
    });
  });

  it('parses external targets with host names and IP literals', () => {
    for (const host of ['host.docker.internal', 'nas', '192.168.1.10', 'fd00::10']) {
      expect(
        RouteTarget.safeParse({ kind: 'external', scheme: 'http', host, port: 7878 }).success,
      ).toBe(true);
    }
    expect(
      RouteTarget.safeParse({ kind: 'external', scheme: 'ftp', host: 'nas', port: 21 }).success,
    ).toBe(false);
    expect(
      RouteTarget.safeParse({ kind: 'external', scheme: 'http', host: 'bad host', port: 80 })
        .success,
    ).toBe(false);
  });

  it('rejects external targets on the edge itself or its platform containers', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '169.254.169.254',
      '::1',
      '::',
      'fe80::1',
      '::ffff:127.0.0.1',
      'caddy',
      'launchway',
      'launchway-agent',
      'db',
    ]) {
      expect(
        RouteTarget.safeParse({ kind: 'external', scheme: 'http', host, port: 2019 }).success,
        host,
      ).toBe(false);
    }
  });

  it('defaults redirects to temporary', () => {
    expect(RouteTarget.parse({ kind: 'redirect', to: 'https://example.com/new' })).toEqual({
      kind: 'redirect',
      to: 'https://example.com/new',
      permanent: false,
    });
  });

  it('rejects routing to service names reserved for platform containers', () => {
    for (const service of ['launchway', 'launchway-agent', 'caddy', 'db']) {
      expect(
        RouteTarget.safeParse({ kind: 'app', appId: generateId('app'), service, port: 80 }).success,
      ).toBe(false);
    }
  });

  it('rejects unknown kinds and incomplete targets', () => {
    expect(RouteTarget.safeParse({ kind: 'tcp', host: 'x', port: 1 }).success).toBe(false);
    expect(RouteTarget.safeParse({ kind: 'app', appId: generateId('app'), port: 80 }).success).toBe(
      false,
    );
    expect(
      RouteTarget.safeParse({ kind: 'app', appId: generateId('node'), service: 'web', port: 80 })
        .success,
    ).toBe(false);
    expect(
      RouteTarget.safeParse({ kind: 'app', appId: generateId('app'), service: 'web', port: 70000 })
        .success,
    ).toBe(false);
  });

  it('applies option defaults on create and requires a change on update', () => {
    const input = CreateRouteInput.parse({
      domainId: generateId('dom'),
      target: { kind: 'redirect', to: 'https://example.com', permanent: true },
    });
    expect(input).toMatchObject({ protected: false, compress: true, hsts: true });
    expect(UpdateRouteInput.safeParse({}).success).toBe(false);
    expect(UpdateRouteInput.safeParse({ hsts: false }).success).toBe(true);
  });
});

describe('extra directives', () => {
  it('are optional, nullable and limited to 4 KiB of UTF-8', () => {
    expect(UpdateRouteInput.parse({ extraDirectives: null })).toEqual({ extraDirectives: null });
    expect(ExtraDirectives.safeParse('a'.repeat(4096)).success).toBe(true);
    expect(ExtraDirectives.safeParse('a'.repeat(4097)).success).toBe(false);
    // 2-byte characters: 2049 of them fit the character limit but not the byte limit.
    expect(ExtraDirectives.safeParse('é'.repeat(2049)).success).toBe(false);
    expect(ExtraDirectives.safeParse('respond 404\0').success).toBe(false);
    const create = CreateRouteInput.parse({
      domainId: generateId('dom'),
      target: { kind: 'external', scheme: 'http', host: 'nas.lan', port: 80 },
    });
    expect(create.extraDirectives).toBeUndefined();
  });
});
