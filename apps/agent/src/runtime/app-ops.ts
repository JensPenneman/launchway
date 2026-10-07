import {
  type AppTargetPayload,
  composeProjectName,
  type RemovePayload,
  type ServiceStatus,
} from '@launchway/contracts';
import type { Logger } from 'pino';
import { composeArgs } from './compose.js';
import { parseComposePs } from './compose-output.js';
import { childEnv, type Runner, runProcess } from './exec.js';
import { Tail } from './lines.js';
import type { Workspace } from './workspace.js';

export interface AppOpsOptions {
  logger: Logger;
  workspace: Workspace;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

/** A Compose command failed; the message carries its last stderr lines. */
export class ComposeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeCommandError';
  }
}

/** stop / remove / status of an app's Compose project (no compose files needed: `-p` only). */
export class AppOps {
  readonly #options: AppOpsOptions;
  readonly #run: Runner;

  constructor(options: AppOpsOptions) {
    this.#options = options;
    this.#run = options.run ?? runProcess;
  }

  async status(target: AppTargetPayload): Promise<ServiceStatus[]> {
    const stdout = await this.#compose(target, ['ps', '--all', '--format', 'json'], 60_000);
    return parseComposePs(stdout);
  }

  async stop(target: AppTargetPayload): Promise<ServiceStatus[]> {
    await this.#compose(target, ['stop', '--timeout', '60'], 5 * 60_000);
    return this.status(target);
  }

  /** `down --remove-orphans [--volumes]` and deletes the app's checkouts. */
  async remove(target: RemovePayload): Promise<void> {
    const args = ['down', '--remove-orphans', '--timeout', '60'];
    if (target.removeVolumes) args.push('--volumes');
    await this.#compose(target, args, 5 * 60_000);
    await this.#options.workspace.removeApp(target.appId);
  }

  async #compose(target: AppTargetPayload, command: string[], timeoutMs: number): Promise<string> {
    const stderr = new Tail<string>(5);
    const project = composeProjectName(target.slug);
    const result = await this.#run('docker', composeArgs({ project }, ...command), {
      cwd: await this.#options.workspace.neutralDir(),
      env: this.#options.env ?? childEnv(),
      timeoutMs,
      captureStdoutBytes: 8 * 1024 * 1024,
      onStderrLine: (line) => {
        if (line.trim()) stderr.push(line.slice(0, 300));
      },
    });
    if (result.code !== 0) {
      const detail = stderr.values().join('\n');
      this.#options.logger.warn(
        { project, command: command[0], code: result.code },
        'compose command failed',
      );
      throw new ComposeCommandError(
        `docker compose ${command[0]} failed${result.timedOut ? ' (timed out)' : ''}${detail ? `: ${detail}` : ''}`,
      );
    }
    return result.stdout;
  }
}
