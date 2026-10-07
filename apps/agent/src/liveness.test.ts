import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isAlive, writeLiveness } from './liveness.js';

const dir = await mkdtemp(join(tmpdir(), 'launchway-liveness-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('liveness file', () => {
  it('is alive while the timestamp is fresh', async () => {
    const file = join(dir, 'alive.json');
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    await writeLiveness({ at: new Date(now).toISOString(), connected: false }, file);
    expect(await isAlive(file, now + 30_000)).toBe(true);
    expect(await isAlive(file, now + 120_000)).toBe(false);
    expect(await isAlive(join(dir, 'missing.json'), now)).toBe(false);
  });
});
