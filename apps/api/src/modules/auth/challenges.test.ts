import { generateId } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import { CHALLENGE_TTL_MS, createChallengeStore } from './challenges.js';

describe('createChallengeStore', () => {
  const user = generateId('user');

  it('accepts a challenge once', () => {
    const store = createChallengeStore();
    store.remember('c1', 'login', null);
    expect(store.consume('c1', 'login', null)).toBe(true);
    expect(store.consume('c1', 'login', null)).toBe(false);
  });

  it('binds challenges to their purpose and user', () => {
    const store = createChallengeStore();
    store.remember('c1', 'register', user);
    expect(store.consume('c1', 'login', null)).toBe(false);
    store.remember('c2', 'register', user);
    expect(store.consume('c2', 'register', generateId('user'))).toBe(false);
    store.remember('c3', 'register', user);
    expect(store.consume('c3', 'register', user)).toBe(true);
  });

  it('expires challenges after the TTL', () => {
    let now = 0;
    const store = createChallengeStore(() => now);
    store.remember('c1', 'login', null);
    now = CHALLENGE_TTL_MS;
    expect(store.consume('c1', 'login', null)).toBe(false);
  });
});
