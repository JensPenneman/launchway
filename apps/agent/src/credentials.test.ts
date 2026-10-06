import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '@slipway/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialsPath, loadCredentials, saveCredentials } from './credentials.js';

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'slipway-agent-'));
  workspaces.push(dir);
  return dir;
}

describe('node credentials', () => {
  it('returns null before the agent joined', async () => {
    expect(await loadCredentials(await workspace())).toBeNull();
  });

  it('round-trips credentials and stores them with mode 0600', async () => {
    const dir = await workspace();
    const credentials = { nodeId: generateId('node'), credential: `slpa_${'a'.repeat(43)}` };
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
