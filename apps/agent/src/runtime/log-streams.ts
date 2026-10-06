import { type AppLogLine, composeProjectName, type LogsStartPayload } from '@slipway/contracts';
import type { Logger } from 'pino';
import { composeArgs } from './compose.js';
import { containerServiceMap, parseComposeLogLine } from './compose-output.js';
import { childEnv, type Runner, runProcess } from './exec.js';
import { Batcher, RateLimiter, Tail } from './lines.js';
import type { Send } from './outbox.js';

export interface LogStreamOptions {
  logger: Logger;
  send: Send;
  neutralDir: () => Promise<string>;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  maxStreams?: number;
  /** Lines per second per stream; excess lines are dropped (and counted in the agent log). */
  linesPerSecond?: number;
}

interface Stream {
  controller: AbortController;
  slug: string;
}

/**
 * `logs.start` / `logs.stop` (spec section 9): `docker compose logs` per stream, parsed into
 * `AppLogLine`s, batched every 100 ms into `logs.chunk` and closed with `logs.end`.
 */
export class LogStreamManager {
  readonly #options: LogStreamOptions;
  readonly #run: Runner;
  readonly #streams = new Map<string, Stream>();

  constructor(options: LogStreamOptions) {
    this.#options = options;
    this.#run = options.run ?? runProcess;
  }

  get size(): number {
    return this.#streams.size;
  }

  start(streamId: string, payload: LogsStartPayload): void {
    const { send } = this.#options;
    if (this.#streams.has(streamId)) {
      send({
        id: streamId,
        type: 'error',
        payload: {
          code: 'invalid-message',
          message: 'A log stream with this id is already open',
          retryable: false,
        },
      });
      return;
    }
    const max = this.#options.maxStreams ?? 8;
    if (this.#streams.size >= max) {
      send({
        id: streamId,
        type: 'error',
        payload: { code: 'busy', message: `At most ${max} log streams per node`, retryable: true },
      });
      return;
    }
    const stream: Stream = { controller: new AbortController(), slug: payload.slug };
    this.#streams.set(streamId, stream);
    this.#follow(streamId, payload, stream)
      .catch((error: unknown) => {
        this.#options.logger.error({ err: error, streamId }, 'log stream failed');
        send({
          id: streamId,
          type: 'logs.end',
          payload: {
            reason: 'error',
            error: { code: 'internal-error', message: 'The log stream failed', retryable: true },
          },
        });
      })
      .finally(() => this.#streams.delete(streamId));
  }

  /** Stops a stream; `false` when it is unknown (already ended). */
  stop(streamId: string): boolean {
    const stream = this.#streams.get(streamId);
    if (!stream) return false;
    stream.controller.abort();
    return true;
  }

  /** Stops every stream of an app (before stop/remove) or all of them (shutdown). */
  stopAll(slug?: string): void {
    for (const stream of this.#streams.values()) {
      if (slug === undefined || stream.slug === slug) stream.controller.abort();
    }
  }

  async #follow(streamId: string, payload: LogsStartPayload, stream: Stream): Promise<void> {
    const { send, logger } = this.#options;
    const env = this.#options.env ?? childEnv();
    const cwd = await this.#options.neutralDir();
    const project = composeProjectName(payload.slug);
    const signal = stream.controller.signal;

    const ps = await this.#run(
      'docker',
      composeArgs({ project }, 'ps', '--all', '--format', 'json'),
      {
        cwd,
        env,
        signal,
        timeoutMs: 60_000,
        captureStdoutBytes: 4 * 1024 * 1024,
      },
    );
    const services = containerServiceMap(ps.code === 0 ? ps.stdout : '', project);

    const args = composeArgs(
      { project },
      'logs',
      '--no-color',
      '--timestamps',
      '--tail',
      String(payload.tail),
    );
    if (payload.follow) args.push('--follow');
    if (payload.since) args.push('--since', payload.since);
    if (payload.service) args.push('--', payload.service);

    const batcher = new Batcher<AppLogLine>((lines) =>
      send({ id: streamId, type: 'logs.chunk', payload: { lines } }),
    );
    const limiter = new RateLimiter(this.#options.linesPerSecond ?? 1_000);
    const diagnostics = new Tail<string>(5);
    let dropped = 0;
    const onLine = (stream: AppLogLine['stream']) => (raw: string) => {
      const line = parseComposeLogLine(raw, services, stream);
      if (!line) {
        if (raw.trim()) diagnostics.push(raw.slice(0, 300));
        return;
      }
      if (!limiter.tryTake()) {
        dropped += 1;
        return;
      }
      batcher.add(line);
    };
    const result = signal.aborted
      ? { code: null, aborted: true, timedOut: false }
      : await this.#run('docker', args, {
          cwd,
          env,
          signal,
          onStdoutLine: onLine('stdout'),
          onStderrLine: onLine('stderr'),
        });
    batcher.flush();
    if (dropped > 0)
      logger.warn({ streamId, dropped }, 'log stream exceeded the line rate; lines dropped');
    if (result.aborted || signal.aborted) {
      send({ id: streamId, type: 'logs.end', payload: { reason: 'stopped' } });
    } else if (result.code === 0) {
      send({ id: streamId, type: 'logs.end', payload: { reason: 'completed' } });
    } else {
      const detail = diagnostics.values().join('\n');
      send({
        id: streamId,
        type: 'logs.end',
        payload: {
          reason: 'error',
          error: {
            code: 'internal-error',
            message:
              `docker compose logs exited with ${result.code}${detail ? `: ${detail}` : ''}`.slice(
                0,
                2000,
              ),
            retryable: false,
          },
        },
      });
    }
  }
}
