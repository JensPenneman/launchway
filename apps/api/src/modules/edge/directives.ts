import type { CaddyAdmin } from './caddy.js';
import { CaddyError } from './caddy.js';
import type { EdgeRoute } from './render.js';
import { renderDirectivesProbe } from './render.js';

/**
 * Structural check of Caddyfile text that will be placed inside a site block: quotes and
 * backticks closed, and block braces (standalone `{` / `}` tokens, as Caddy reads them) balanced
 * without ever closing the enclosing site. Returns the problem, or null.
 */
export function checkDirectiveStructure(text: string): string | null {
  let depth = 0;
  let line = 1;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index] as string;
    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < length && text[index] !== '\n') index += 1;
      continue;
    }
    // One token: runs until whitespace; quoted and backtick parts may contain anything.
    const start = line;
    let value = '';
    while (index < length && !/\s/.test(text[index] as string)) {
      const current = text[index] as string;
      if (current === '"' || current === '`') {
        const close = current;
        index += 1;
        let closed = false;
        while (index < length) {
          const inner = text[index] as string;
          if (inner === '\n') line += 1;
          if (close === '"' && inner === '\\' && index + 1 < length) {
            index += 2;
            continue;
          }
          index += 1;
          if (inner === close) {
            closed = true;
            break;
          }
        }
        if (!closed) return `line ${start}: unterminated ${close === '"' ? 'quote' : 'backtick'}`;
        value += '""';
        continue;
      }
      value += current;
      index += 1;
    }
    if (value === '{') depth += 1;
    if (value === '}') {
      depth -= 1;
      if (depth < 0) return `line ${start}: "}" closes a block that was not opened here`;
    }
  }
  if (depth > 0) return `${depth} block${depth === 1 ? '' : 's'} not closed (missing "}")`;
  return null;
}

/** Outcome of validating extra directives. */
export type DirectivesValidation =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Rewrites `Caddyfile:<n>` positions in Caddy's error text to lines of the extra directives and
 * drops the adapter prefix.
 */
export function mapCaddyMessage(message: string, firstLine: number, lineCount: number): string {
  return message
    .replace(/^adapting config using caddyfile(?: adapter)?:\s*/i, '')
    .replace(/Caddyfile:(\d+)/g, (match, raw: string) => {
      const relative = Number(raw) - firstLine + 1;
      return relative >= 1 && relative <= lineCount ? `line ${relative}` : match;
    });
}

/**
 * Validates extra directives for one site: the structural check, then Caddy's `/adapt` on a
 * throwaway Caddyfile containing just this site. When Caddy is unreachable the structural check
 * stands and a warning says so.
 */
export async function validateExtraDirectives(
  caddy: Pick<CaddyAdmin, 'adapt'>,
  site: Pick<EdgeRoute, 'hostname' | 'protected' | 'compress' | 'hsts'>,
  directives: string,
): Promise<DirectivesValidation> {
  const structure = checkDirectiveStructure(directives);
  if (structure) return { ok: false, message: structure };
  const probe = renderDirectivesProbe(site, directives);
  try {
    await caddy.adapt(probe.caddyfile);
  } catch (error) {
    if (!(error instanceof CaddyError)) throw error;
    if (!error.unreachable) {
      return {
        ok: false,
        message: mapCaddyMessage(error.message, probe.firstLine, probe.lineCount),
      };
    }
    return {
      ok: true,
      warnings: [
        'Caddy could not be reached, so the extra directives only passed a structural check. Caddy validates them when the edge configuration is loaded next.',
      ],
    };
  }
  return { ok: true, warnings: [] };
}
