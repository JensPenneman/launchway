import { describe, expect, it } from 'vitest';
import { CaddyError } from './caddy.js';
import { checkDirectiveStructure, mapCaddyMessage, validateExtraDirectives } from './directives.js';

const site = { hostname: 'login.example.com', protected: false, compress: true, hsts: true };

/** Adapter double: records the probe and answers like Caddy's `/adapt`. */
function fakeCaddy(answer: (caddyfile: string) => unknown) {
  const probes: string[] = [];
  return {
    probes,
    adapt: (caddyfile: string) => {
      probes.push(caddyfile);
      try {
        return Promise.resolve(answer(caddyfile));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

describe('checkDirectiveStructure', () => {
  it('accepts balanced blocks, placeholders, quotes and comments', () => {
    expect(
      checkDirectiveStructure(
        [
          'handle /oauth2/* {',
          '\treverse_proxy login-oauth2-proxy:4180 # the gate { not a block',
          '}',
          'respond "}" 404',
          'redir https://example.com{uri}',
          'header X-Note `a } b`',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('refuses text that would close the site block and open another one', () => {
    expect(checkDirectiveStructure('}\nevil.example.com {\n\treverse_proxy x:1')).toMatch(
      /^line 1: "}" closes a block/,
    );
  });

  it('refuses unclosed blocks and quotes', () => {
    expect(checkDirectiveStructure('handle /x {\n\trespond 404')).toBe(
      '1 block not closed (missing "}")',
    );
    expect(checkDirectiveStructure('respond 404\nheader X "open')).toBe(
      'line 2: unterminated quote',
    );
  });
});

describe('validateExtraDirectives', () => {
  it('adapts a throwaway Caddyfile that contains just this site', async () => {
    const caddy = fakeCaddy(() => ({ apps: {} }));
    const result = await validateExtraDirectives(caddy, site, 'request_header -X-API-KEY');
    expect(result).toEqual({ ok: true, warnings: [] });
    expect(caddy.probes).toHaveLength(1);
    expect(caddy.probes[0]).toContain('login.example.com {');
    expect(caddy.probes[0]).toContain('\trequest_header -X-API-KEY\n\treverse_proxy');
  });

  it("maps Caddy's error positions to lines of the directives", async () => {
    const caddy = fakeCaddy((caddyfile) => {
      const line = caddyfile.split('\n').indexOf('\tbogus_directive') + 1;
      throw new CaddyError(
        `adapting config using caddyfile: Caddyfile:${line}: unrecognized directive: bogus_directive`,
        false,
      );
    });
    const result = await validateExtraDirectives(
      caddy,
      site,
      'request_header -X-API-KEY\nbogus_directive',
    );
    expect(result).toEqual({
      ok: false,
      message: 'line 2: unrecognized directive: bogus_directive',
    });
  });

  it('falls back to the structural check with a warning when Caddy is unreachable', async () => {
    const unreachable = fakeCaddy(() => {
      throw new CaddyError('connect ENOENT /run/caddy-admin/admin.sock', true);
    });
    const ok = await validateExtraDirectives(unreachable, site, 'encode gzip');
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.warnings[0]).toMatch(/Caddy could not be reached/);
    const broken = await validateExtraDirectives(unreachable, site, 'handle {');
    expect(broken).toEqual({ ok: false, message: '1 block not closed (missing "}")' });
  });

  it('never asks Caddy about structurally broken text', async () => {
    const caddy = fakeCaddy(() => ({}));
    await validateExtraDirectives(caddy, site, '}');
    expect(caddy.probes).toEqual([]);
  });
});

describe('mapCaddyMessage', () => {
  it('leaves positions outside the directives alone', () => {
    expect(mapCaddyMessage('Caddyfile:2: oops', 10, 3)).toBe('Caddyfile:2: oops');
    expect(mapCaddyMessage('Caddyfile:11 - Error during parsing', 10, 3)).toBe(
      'line 2 - Error during parsing',
    );
  });
});
