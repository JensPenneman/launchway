import { describe, expect, it } from 'vitest';
import { assertSafeRef, checkoutPlan, gitEnv, isCommitRef } from './git.js';

const sha = '3f786850e387550fdab836ed7e6dc881de23001b';
const url = 'https://github.com/acme/trail.git';

describe('assertSafeRef', () => {
  it.each(['v1.4.2', 'main', 'feature/x-1', 'release_2026.10', sha])('accepts %s', (ref) => {
    expect(() => assertSafeRef(ref)).not.toThrow();
  });

  it.each(['-oops', '--upload-pack=x', 'a..b', 'a b', 'v1;rm', 'tag$', '', 'x'.repeat(256)])(
    'rejects %j',
    (ref) => {
      expect(() => assertSafeRef(ref)).toThrow(RangeError);
    },
  );
});

describe('checkoutPlan', () => {
  it('clones tags and branches shallowly with the ref after --branch and the URL after --', () => {
    const plan = checkoutPlan(url, 'v1.4.2', sha, '/ws/apps/a/d');
    expect(plan.steps).toEqual([
      {
        args: [
          'clone',
          '--depth',
          '1',
          '--single-branch',
          '--no-tags',
          '--branch',
          'v1.4.2',
          '--',
          url,
          '/ws/apps/a/d',
        ],
        inParent: true,
      },
    ]);
  });

  it('fetches commits by SHA', () => {
    expect(isCommitRef('3f78685', sha)).toBe(true);
    expect(isCommitRef('abcdef0', sha)).toBe(false);
    const plan = checkoutPlan(url, sha, sha, '/d');
    expect(plan.steps.map((step) => step.args[0])).toEqual(['init', 'remote', 'fetch', 'checkout']);
    expect(plan.steps[2]?.args).toEqual(['fetch', '--depth', '1', '--no-tags', 'origin', sha]);
  });

  it('refuses unsafe refs', () => {
    expect(() => checkoutPlan(url, '--upload-pack=touch /tmp/x', sha, '/d')).toThrow(RangeError);
  });
});

describe('gitEnv', () => {
  it('passes the Authorization header as config through the environment only', () => {
    const env = gitEnv('basic dG9rZW4=', [['url.file:///repo.insteadOf', 'https://x/']]);
    const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]);
    expect(entries).toContainEqual(['http.extraHeader', 'Authorization: basic dG9rZW4=']);
    expect(entries).toContainEqual(['url.file:///repo.insteadOf', 'https://x/']);
    expect(entries).toContainEqual(['credential.helper', '']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('omits the header without authorization', () => {
    const env = gitEnv(null);
    expect(Object.values(env).some((value) => value.startsWith('Authorization'))).toBe(false);
  });
});
