import { type ChildProcess, spawn } from 'node:child_process';
import { LineSplitter } from './lines.js';

/**
 * Variables of the agent's own environment that child processes (git, docker) may see. Everything
 * else (join token, app settings, the operator's shell) stays out: Compose interpolates `${VAR}`
 * from the process environment before `.env`, so leaking variables would hand them to apps.
 */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'BUILDX_CONFIG',
  'BUILDX_BUILDER',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/** A minimal child environment: the allow-listed variables of `base` plus `extra`. */
export function childEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Collect stdout (up to this many bytes) instead of, or in addition to, splitting it. */
  captureStdoutBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  aborted: boolean;
  timedOut: boolean;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

const KILL_GRACE_MS = 5_000;

/** Signals the whole process group of a child started with `detached: true`. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a program with an argument array (never a shell), in its own process group so that
 * cancellation stops the whole tree (docker -> compose plugin -> buildx). Rejects only when the
 * program cannot be started; a non-zero exit is part of the result.
 */
export const runProcess: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', aborted: true, timedOut: false });
      return;
    }
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let aborted = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      killTree(child, 'SIGTERM');
      forceTimer ??= setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs);

    const captureLimit = options.captureStdoutBytes ?? 0;
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    const stdoutLines = options.onStdoutLine ? new LineSplitter(options.onStdoutLine) : undefined;
    const stderrLines = options.onStderrLine ? new LineSplitter(options.onStderrLine) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLines?.push(chunk);
      if (capturedBytes < captureLimit) {
        const part = chunk.subarray(0, captureLimit - capturedBytes);
        captured.push(part);
        capturedBytes += part.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrLines?.push(chunk));

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      clearTimeout(forceTimer);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      stdoutLines?.end();
      stderrLines?.end();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(captured).toString('utf8'),
        aborted,
        timedOut,
      });
    });
  });
