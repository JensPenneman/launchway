import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '@launchway/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTokenSource,
  credentialsPath,
  loadCredentials,
  saveCredentials,
} from './credentials.js';

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'launchway-agent-'));
  workspaces.push(dir);
  return dir;
}

describe('node credentials', () => {
  it('returns null before the agent joined', async () => {
    expect(await loadCredentials(await workspace())).toBeNull();
  });

  it('round-trips credentials and stores them with mode 0600', async () => {
    const dir = await workspace();
    const credentials = { nodeId: generateId('node'), credential: `lwya_${'a'.repeat(43)}` };
    await saveCredentials(dir, credentials);
    expect(await loadCredentials(dir)).toEqual(credentials);
    expect((await stat(credentialsPath(dir))).mode & 0o777).toBe(0o600);
  });

  it('refuses to store malformed credentials', async () => {
    await expect(
      saveCredentials(await workspace(), { nodeId: generateId('node'), credential: 'nope' }),
    ).rejects.toThrow();
  });
});

describe('token source', () => {
  const joinToken = `lwyn_${'j'.repeat(43)}`;
  const stored = { nodeId: generateId('node'), credential: `lwya_${'c'.repeat(43)}` };

  it('uses the join token until a credential is stored', () => {
    const tokens = createTokenSource(null, joinToken);
    expect(tokens.token()).toBe(joinToken);
    tokens.store(stored);
    expect(tokens.token()).toBe(stored.credential);
  });

  it('falls back to the join token once the server refuses the stored credential', () => {
    const tokens = createTokenSource(stored, joinToken);
    expect(tokens.token()).toBe(stored.credential);
    expect(tokens.refused()).toBe(true);
    expect(tokens.token()).toBe(joinToken);
    // A refused join token has nothing left to fall back to.
    expect(tokens.refused()).toBe(false);
    const rejoined = { nodeId: generateId('node'), credential: `lwya_${'d'.repeat(43)}` };
    tokens.store(rejoined);
    expect(tokens.token()).toBe(rejoined.credential);
  });

  it('keeps the credential when no join token is configured', () => {
    const tokens = createTokenSource(stored, null);
    expect(tokens.refused()).toBe(false);
    expect(tokens.token()).toBe(stored.credential);
  });
});
