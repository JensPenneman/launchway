import { describe, expect, it } from 'vitest';
import { parseDotenv } from './dotenv';

describe('parseDotenv', () => {
  it('parses plain, quoted, exported and commented lines', () => {
    const result = parseDotenv(
      [
        '# database',
        'DATABASE_URL=postgres://app@db:5432/app',
        'export NODE_ENV=production # inline comment',
        "GREETING='hello # not a comment'",
        'MULTI="line one\\nline two"',
        'EMPTY=',
        '',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://app@db:5432/app' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'GREETING', value: 'hello # not a comment' },
      { key: 'MULTI', value: 'line one\nline two' },
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('supports values spanning several lines and lets later keys win', () => {
    const result = parseDotenv('KEY="-----BEGIN\nabc\n-----END"\nA=1\nA=2');
    expect(result.entries).toEqual([
      { key: 'KEY', value: '-----BEGIN\nabc\n-----END' },
      { key: 'A', value: '2' },
    ]);
  });

  it('reports invalid lines with their numbers', () => {
    const result = parseDotenv('OK=1\nnot a pair\n1BAD=x\nOPEN="never closed');
    expect(result.entries).toEqual([{ key: 'OK', value: '1' }]);
    expect(result.errors).toEqual([
      'Line 2: expected KEY=value',
      'Line 3: "1BAD" is not a valid variable name',
      'Line 4: unterminated double quote',
    ]);
  });
});
