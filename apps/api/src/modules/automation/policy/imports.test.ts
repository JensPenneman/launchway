import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE = join(import.meta.dirname, '..');
const SRC = join(MODULE, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const production = (file: string) => !file.endsWith('.test.ts');

/** Module specifiers of the import and export-from statements of a file. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) {
    found.push(m[1] as string);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g))
    found.push(m[1] as string);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1] as string);
  return found;
}

describe('the policy stays pure', () => {
  const policyFiles = [
    ...sourceFiles(join(MODULE, 'policy')),
    ...sourceFiles(SRC).filter((f) => f.endsWith(`${sep}decide.ts`)),
  ].filter(production);

  it('covers the classifier, the actions and every decide.ts', () => {
    const names = policyFiles.map((f) => relative(SRC, f).split(sep).join('/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'modules/automation/policy/decide.ts',
        'modules/automation/policy/classify.ts',
        'modules/automation/policy/actions.ts',
        'modules/automation/policy/metadata.ts',
      ]),
    );
  });

  it('imports nothing but its own files and the contracts', () => {
    for (const file of policyFiles) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        const ok = specifier.startsWith('./') || specifier === '@launchway/contracts';
        expect(ok, `${relative(SRC, file)} imports ${specifier}`).toBe(true);
      }
    }
  });
});

describe('the automation module exports actions, never credentials', () => {
  const files = sourceFiles(MODULE).filter(production);

  it('exports no token, client or key', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const exported = [
        ...text.matchAll(
          /export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+(\w+)/g,
        ),
      ].map((m) => m[1] as string);
      for (const name of exported) {
        expect(name, `${relative(SRC, file)} exports ${name}`).not.toMatch(
          /token|octokit|credential|privatekey|secret|client/i,
        );
      }
      expect(text, relative(SRC, file)).not.toMatch(/export\s*\*\s*from/);
      expect(text, relative(SRC, file)).not.toMatch(/export\s*\{[^}]*(?:Token|githubClient)/);
    }
  });

  it('keeps the App token behind the github.ts operations', () => {
    const users = files
      .filter((f) => /\binstallationWriteToken\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULE, f));
    expect(users).toEqual(['github.ts']);
  });
});
