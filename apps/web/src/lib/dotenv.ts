import { ENV_KEY_PATTERN } from '@launchway/contracts';

export interface DotenvEntry {
  key: string;
  value: string;
}

export interface DotenvResult {
  entries: DotenvEntry[];
  /** Human-readable problems with their 1-based line numbers. */
  errors: string[];
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Parses pasted `.env` content: `KEY=value`, optional `export `, `#` comments, single quotes
 * (literal) and double quotes (with \n, \t, \" escapes, may span lines). Later keys win.
 */
export function parseDotenv(text: string): DotenvResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const byKey = new Map<string, string>();
  const errors: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = (lines[index] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = raw.startsWith('export ') ? raw.slice(7).trimStart() : raw;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`Line ${lineNumber}: expected KEY=value`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push(`Line ${lineNumber}: "${key}" is not a valid variable name`);
      continue;
    }
    let rest = line.slice(eq + 1).trimStart();
    let value: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // Collect following lines until the closing quote (multi-line values).
      let body = rest.slice(1);
      let close = findClosingQuote(body, quote);
      while (close === -1 && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index] ?? ''}`;
        close = findClosingQuote(body, quote);
      }
      if (close === -1) {
        errors.push(
          `Line ${lineNumber}: unterminated ${quote === '"' ? 'double' : 'single'} quote`,
        );
        continue;
      }
      const inner = body.slice(0, close);
      value =
        quote === '"' ? inner.replace(/\\([nrt"\\])/g, (_, c: string) => ESCAPES[c] ?? c) : inner;
    } else {
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment);
      value = rest.trim();
    }
    byKey.set(key, value);
  }

  return { entries: [...byKey].map(([key, value]) => ({ key, value })), errors };
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && quote === '"') {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}
