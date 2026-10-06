import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** File the agent touches periodically; the container HEALTHCHECK reads it. */
export const LIVENESS_FILE = join(tmpdir(), 'slipway-agent.alive.json');
export const LIVENESS_INTERVAL_MS = 10_000;
export const LIVENESS_MAX_AGE_MS = 60_000;

export interface LivenessState {
  at: string;
  connected: boolean;
}

export async function writeLiveness(state: LivenessState, file = LIVENESS_FILE): Promise<void> {
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
}

/** True when the agent process reported in within `maxAgeMs` (connection state is informational). */
export async function isAlive(
  file = LIVENESS_FILE,
  now = Date.now(),
  maxAgeMs = LIVENESS_MAX_AGE_MS,
): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as Partial<LivenessState>;
    const at = Date.parse(state.at ?? '');
    return Number.isFinite(at) && now - at <= maxAgeMs;
  } catch {
    return false;
  }
}
