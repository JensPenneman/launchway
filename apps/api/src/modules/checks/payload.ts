import { type AppId, CheckRunPayload, type Settings } from '@launchway/contracts';
import type { CloneCredentials } from '../../lib/git-provider.js';
import type { CheckRunRow } from './model.js';

export interface CheckRunPayloadInput {
  /** The run with the snapshot of its check (taken when it was queued). */
  readonly run: Pick<
    CheckRunRow,
    'id' | 'name' | 'command' | 'service' | 'composeFiles' | 'timeoutMinutes' | 'commitSha' | 'ref'
  >;
  readonly app: { readonly id: AppId; readonly slug: string };
  /** A fresh `contents: read` credential of the repository (GitHub Apps: one repository). */
  readonly clone: CloneCredentials;
  /** The platform limits of every service of a check. */
  readonly limits: Pick<Settings, 'checkMemoryMb' | 'checkCpus' | 'checkPidsLimit'>;
}

/** Raised when the assembled payload violates the agent contract (values are never included). */
export class InvalidCheckRunPayloadError extends Error {
  override readonly name = 'InvalidCheckRunPayloadError';
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(`check run payload is invalid at ${paths.join(', ') || '(root)'}`);
    this.paths = paths;
  }
}

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;

/**
 * Builds the `check.run` request for the agent (ADR 0020): the commit and its credential, the
 * Compose files and the command of the run's snapshot, its timeout and the platform limits. No
 * app variables or secrets: a check gets only the CHECK_ENV_KEYS from the agent.
 */
export function buildCheckRunPayload(input: CheckRunPayloadInput): CheckRunPayload {
  const { run } = input;
  const candidate = {
    runId: run.id,
    app: { id: input.app.id, slug: input.app.slug },
    source: {
      cloneUrl: input.clone.cloneUrl,
      // LAUNCHWAY_REF: the branch or the requested ref; runs always have one, the SHA is a fallback.
      ref: run.ref ?? run.commitSha,
      sha: run.commitSha,
      authorization: input.clone.authorization,
    },
    composeFiles: [...run.composeFiles],
    check: {
      name: run.name,
      service: run.service,
      command: run.command,
      timeoutMs: run.timeoutMinutes * MINUTE_MS,
    },
    limits: {
      memoryBytes: input.limits.checkMemoryMb * MIB,
      cpus: input.limits.checkCpus,
      pidsLimit: input.limits.checkPidsLimit,
    },
  };
  const parsed = CheckRunPayload.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidCheckRunPayloadError(parsed.error.issues.map((issue) => issue.path.join('.')));
  }
  return parsed.data;
}
