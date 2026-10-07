import { join } from 'node:path';
import {
  type AgentError,
  composeProjectName,
  type DeploymentId,
  type DeploymentProgressPayload,
  type DeploymentResultPayload,
  type DeployPayload,
  type LogLine,
  type LogStream,
} from '@slipway/contracts';
import type { Logger } from 'pino';
import { type ComposeTarget, composeArgs, ensureProxyNetwork } from './compose.js';
import {
  buildOverride,
  formatEnvFile,
  OVERRIDE_FILE,
  SYNTHESIZED_FILE,
  synthesizeCompose,
} from './compose-files.js';
import { parseComposePs } from './compose-output.js';
import { evaluateComposePolicy, parseComposeConfig } from './compose-policy.js';
import { childEnv, type Runner, type RunResult, runProcess } from './exec.js';
import { checkoutPlan, fetchCommitPlan, type GitConfig, gitEnv } from './git.js';
import { Batcher, MAX_LINE_LENGTH, Tail } from './lines.js';
import type { Send } from './outbox.js';
import { isInsideReal, PolicyError, type Workspace, writeFileReplacing } from './workspace.js';

const MINUTE = 60_000;
const TIMEOUTS = {
  git: 10 * MINUTE,
  config: 2 * MINUTE,
  build: 60 * MINUTE,
  pull: 30 * MINUTE,
  up: 15 * MINUTE,
  ps: 1 * MINUTE,
};
/** `up --wait-timeout`, in seconds (below the `up` process timeout). */
const WAIT_TIMEOUT_S = 600;
const CONFIG_OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface DeploymentManagerOptions {
  logger: Logger;
  send: Send;
  workspace: Workspace;
  run?: Runner;
  /** Base environment for child processes (already allow-listed). */
  env?: NodeJS.ProcessEnv;
  /** Extra git configuration (tests rewrite URLs with `url.<base>.insteadOf`). */
  gitConfig?: GitConfig;
  maxConcurrentBuilds?: number;
  /** Deployment directories kept per app (including the current one). */
  keepCheckouts?: number;
}

type AbortReason = 'cancel' | 'shutdown';

interface Job {
  requestId: string;
  payload: DeployPayload;
  controller: AbortController;
  state: 'queued' | 'running';
  cancelled: boolean;
  /** Next sequence number of the job's log lines (the acknowledgement takes the first). */
  logSeq: number;
}

/** Ends the run with this error (code + message) instead of the generic internal error. */
class StepError extends Error {
  readonly code: AgentError['code'];
  readonly retryable: boolean;
  constructor(message: string, code: AgentError['code'] = 'internal-error', retryable = false) {
    super(message);
    this.name = 'StepError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];
  constructor(slots: number) {
    this.#free = slots;
  }
  /** Runs `fn` in a slot; an abort while waiting leaves the queue and rejects at once. */
  async use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#free > 0) this.#free -= 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.#waiters.push(waiter);
      });
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

/** Secrets that must never appear in a log line (the Authorization value and its token). */
function secretsOf(authorization: string | null): string[] {
  if (!authorization) return [];
  const secrets = [authorization];
  const [, credentials] = authorization.split(/\s+/, 2);
  if (credentials && credentials.length >= 8) {
    secrets.push(credentials);
    try {
      const decoded = Buffer.from(credentials, 'base64').toString('utf8');
      for (const part of [decoded, ...decoded.split(':')]) if (part.length >= 8) secrets.push(part);
    } catch {
      // Not base64.
    }
  }
  return secrets.sort((a, b) => b.length - a.length);
}

/**
 * Runs deployments (spec section 4): one at a time per app (later ones queue), at most
 * `maxConcurrentBuilds` build/pull phases per node, cancellable at any point.
 */
export class DeploymentManager {
  readonly #options: DeploymentManagerOptions;
  readonly #log: Logger;
  readonly #run: Runner;
  readonly #jobs = new Map<DeploymentId, Job>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #builds: Semaphore;
  #shuttingDown = false;

  constructor(options: DeploymentManagerOptions) {
    this.#options = options;
    this.#log = options.logger;
    this.#run = options.run ?? runProcess;
    this.#builds = new Semaphore(options.maxConcurrentBuilds ?? 2);
  }

  /** Deployments queued or running on this node (heartbeat `activeDeploymentIds`). */
  activeDeploymentIds(): DeploymentId[] {
    return [...this.#jobs.keys()].slice(0, 100);
  }

  deploy(requestId: string, payload: DeployPayload): void {
    const { deploymentId } = payload;
    const existing = this.#jobs.get(deploymentId);
    if (existing) {
      this.#log.warn({ deploymentId }, 'deployment already queued or running; ignoring duplicate');
      this.#acknowledge(requestId, existing, `Already ${existing.state} on this node`);
      return;
    }
    if (this.#shuttingDown) {
      this.#sendResult(requestId, deploymentId, {
        code: 'busy',
        message: 'The agent is shutting down',
        retryable: true,
      });
      return;
    }
    const job: Job = {
      requestId,
      payload,
      controller: new AbortController(),
      state: 'queued',
      cancelled: false,
      logSeq: 0,
    };
    this.#jobs.set(deploymentId, job);
    this.#log.info({ deploymentId, appId: payload.app.id }, 'deployment queued');
    // Answer at once: the job may wait behind other work of the app or for a build slot.
    this.#acknowledge(requestId, job, 'Received by the node');
    void this.#enqueue(payload.app.id, () => this.#execute(job));
  }

  /** Cancels a queued or running deployment; `false` when it is unknown. */
  cancel(deploymentId: DeploymentId, reason: AbortReason = 'cancel'): boolean {
    const job = this.#jobs.get(deploymentId);
    if (!job) return false;
    if (job.state === 'queued') {
      job.cancelled = true;
      this.#jobs.delete(deploymentId);
      if (reason === 'cancel') {
        this.#options.send({
          id: job.requestId,
          type: 'deployment.result',
          payload: { deploymentId, outcome: 'cancelled' },
        });
      } else {
        this.#sendResult(job.requestId, deploymentId, {
          code: 'internal-error',
          message: 'The agent shut down before the deployment started',
          retryable: true,
        });
      }
      return true;
    }
    job.controller.abort(reason);
    return true;
  }

  /** Cancels everything queued or running for an app and waits until its queue is idle. */
  async cancelApp(appId: string): Promise<void> {
    for (const job of [...this.#jobs.values()]) {
      if (job.payload.app.id === appId) this.cancel(job.payload.deploymentId);
    }
    await this.#tails.get(appId);
  }

  /** Runs `task` in the app's queue, after any deployment of that app. */
  exclusive<T>(appId: string, task: () => Promise<T>): Promise<T> {
    return this.#enqueue(appId, task);
  }

  /** Lets running deployments finish within `graceMs`, then fails them; queued ones fail now. */
  async shutdown(graceMs: number): Promise<void> {
    this.#shuttingDown = true;
    for (const job of [...this.#jobs.values()]) {
      if (job.state === 'queued') this.cancel(job.payload.deploymentId, 'shutdown');
    }
    const idle = Promise.all([...this.#tails.values()]).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      idle.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!timedOut) return;
    for (const job of [...this.#jobs.values()]) this.cancel(job.payload.deploymentId, 'shutdown');
    await idle;
  }

  #enqueue<T>(appId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(appId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(appId, tail);
    void tail.then(() => {
      if (this.#tails.get(appId) === tail) this.#tails.delete(appId);
    });
    return result;
  }

  async #execute(job: Job): Promise<void> {
    if (job.cancelled) return;
    job.state = 'running';
    try {
      await new DeploymentRun(job, this.#options, this.#run, this.#builds).run();
    } catch (error) {
      this.#log.error({ err: error, deploymentId: job.payload.deploymentId }, 'deployment crashed');
    } finally {
      this.#jobs.delete(job.payload.deploymentId);
    }
  }

  /** The server waits for a first reply to `deploy`; a system log line is that reply. */
  #acknowledge(requestId: string, job: Job, line: string): void {
    this.#options.send({
      id: requestId,
      type: 'deployment.log',
      payload: {
        deploymentId: job.payload.deploymentId,
        lines: [{ seq: job.logSeq++, timestamp: new Date().toISOString(), stream: 'system', line }],
      },
    });
  }

  #sendResult(requestId: string, deploymentId: DeploymentId, error: AgentError): void {
    this.#options.send({
      id: requestId,
      type: 'deployment.result',
      payload: { deploymentId, outcome: 'failed', error },
    });
  }
}

interface ExecOptions {
  /** Short description for failure messages (`docker compose build`). */
  label: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Capture stdout instead of logging it (Compose config output contains interpolated secrets). */
  captureStdout?: boolean;
}

/** One deployment from clone to result. */
class DeploymentRun {
  readonly #job: Job;
  readonly #payload: DeployPayload;
  readonly #options: DeploymentManagerOptions;
  readonly #run: Runner;
  readonly #builds: Semaphore;
  readonly #log: Logger;
  readonly #secrets: string[];
  readonly #tail = new Tail<string>(15);
  readonly #batcher: Batcher<LogLine>;

  constructor(job: Job, options: DeploymentManagerOptions, run: Runner, builds: Semaphore) {
    this.#job = job;
    this.#payload = job.payload;
    this.#options = options;
    this.#run = run;
    this.#builds = builds;
    this.#log = options.logger.child({
      deploymentId: job.payload.deploymentId,
      appId: job.payload.app.id,
    });
    this.#secrets = secretsOf(job.payload.source.authorization);
    this.#batcher = new Batcher<LogLine>((lines) =>
      options.send({
        id: job.requestId,
        type: 'deployment.log',
        payload: { deploymentId: job.payload.deploymentId, lines },
      }),
    );
  }

  get #signal(): AbortSignal {
    return this.#job.controller.signal;
  }

  async run(): Promise<void> {
    const { deploymentId, app } = this.#payload;
    const workspace = this.#options.workspace;
    this.#log.info('deployment started');
    let dir: string | undefined;
    try {
      dir = await workspace.prepareDeploymentDir(app.id, deploymentId);
      await this.#checkout(dir);
      const services = await this.#composeUp(dir);
      this.#batcher.flush();
      this.#send({
        type: 'deployment.result',
        payload: { deploymentId, outcome: 'succeeded', services },
      });
      this.#log.info({ services: services.length }, 'deployment succeeded');
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#batcher.flush();
      try {
        const pruned = await workspace.prune(app.id, this.#options.keepCheckouts ?? 2, [
          deploymentId,
        ]);
        if (pruned.length > 0) this.#log.debug({ pruned }, 'pruned old checkouts');
      } catch (error) {
        this.#log.warn({ err: error }, 'failed to prune old checkouts');
      }
    }
  }

  #fail(error: unknown): void {
    const { deploymentId } = this.#payload;
    this.#batcher.flush();
    if (this.#signal.aborted) {
      if (this.#signal.reason === 'shutdown') {
        this.#log.warn('deployment interrupted by agent shutdown');
        this.#send({
          type: 'deployment.result',
          payload: {
            deploymentId,
            outcome: 'failed',
            error: {
              code: 'internal-error',
              message: 'Interrupted: the agent shut down',
              retryable: true,
            },
          },
        });
      } else {
        this.#log.info('deployment cancelled');
        this.#send({ type: 'deployment.result', payload: { deploymentId, outcome: 'cancelled' } });
      }
      return;
    }
    let agentError: AgentError;
    if (error instanceof PolicyError) {
      agentError = { code: 'policy-violation', message: error.message, retryable: false };
    } else if (error instanceof StepError) {
      agentError = { code: error.code, message: error.message, retryable: error.retryable };
    } else {
      this.#log.error({ err: error }, 'unexpected deployment error');
      agentError = { code: 'internal-error', message: 'Unexpected agent error', retryable: true };
    }
    this.#log.warn({ code: agentError.code }, 'deployment failed');
    const tail = this.#tail.values().join('\n');
    const message = tail
      ? `${agentError.message}\n--- last log lines ---\n${tail}`
      : agentError.message;
    this.#send({
      type: 'deployment.result',
      payload: {
        deploymentId,
        outcome: 'failed',
        error: { ...agentError, message: message.slice(0, 2000) },
      },
    });
  }

  async #checkout(dir: string): Promise<void> {
    const { source } = this.#payload;
    const appDir = this.#options.workspace.appDir(this.#payload.app.id);
    this.#progress('cloning', `Fetching ${source.ref} (${source.commitSha.slice(0, 12)})`);
    const env = { ...this.#baseEnv(), ...gitEnv(source.authorization, this.#options.gitConfig) };
    const plan = checkoutPlan(source.cloneUrl, source.ref, source.commitSha, dir);
    for (const step of plan.steps) {
      await this.#exec('git', step.args, {
        label: `git ${step.args[0]}`,
        cwd: step.inParent ? appDir : dir,
        env,
        timeoutMs: TIMEOUTS.git,
      });
    }
    let head = await this.#head(dir, env);
    if (head !== source.commitSha) {
      this.#system(
        `${source.ref} now points at ${head.slice(0, 12)}; fetching ${source.commitSha.slice(0, 12)}`,
      );
      for (const step of fetchCommitPlan(source.cloneUrl, source.commitSha, dir, false).steps) {
        await this.#exec('git', step.args, {
          label: `git ${step.args[0]}`,
          cwd: dir,
          env,
          timeoutMs: TIMEOUTS.git,
        });
      }
      head = await this.#head(dir, env);
      if (head !== source.commitSha) {
        throw new StepError(`Checked out ${head} but the deployment expects ${source.commitSha}`);
      }
    }
    this.#system(`checked out ${head}`);
  }

  async #head(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.#exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      label: 'git rev-parse',
      cwd: dir,
      env,
      timeoutMs: TIMEOUTS.ps,
      captureStdout: true,
    });
    return result.stdout.trim();
  }

  async #composeUp(dir: string) {
    const payload = this.#payload;
    const workspace = this.#options.workspace;
    const env = this.#baseEnv();
    this.#progress('building', 'Checking the Compose project');
    const source = await workspace.resolveSource(dir, payload.build, SYNTHESIZED_FILE);
    const root = source.root;
    if (payload.build.kind === 'dockerfile') {
      await writeFileReplacing(
        join(root, SYNTHESIZED_FILE),
        `${JSON.stringify(synthesizeCompose(payload.build, root), null, 2)}\n`,
        0o644,
      );
    }
    await writeFileReplacing(join(source.projectDir, '.env'), formatEnvFile(payload.env), 0o600);
    const project = composeProjectName(payload.app.slug);
    const appTarget: ComposeTarget = {
      project,
      files: source.files,
      projectDir: source.projectDir,
    };

    const configResult = await this.#exec(
      'docker',
      composeArgs(appTarget, 'config', '--format', 'json', '--no-env-resolution'),
      {
        label: 'docker compose config',
        cwd: source.projectDir,
        env,
        timeoutMs: TIMEOUTS.config,
        captureStdout: true,
      },
    );
    const config = parseComposeConfig(configResult.stdout);
    if (!config) throw new StepError('Could not read the Compose configuration');
    const policy = evaluateComposePolicy(config, {
      projectName: project,
      proxyNetwork: payload.network.proxyNetwork,
      routes: payload.routes,
      isInsideCheckout: (path) => isInsideReal(root, path),
    });
    if (policy.violations.length > 0) {
      for (const violation of policy.violations) this.#system(`policy: ${violation}`);
      throw new PolicyError(`Compose policy violation: ${policy.violations.join('; ')}`);
    }
    for (const port of policy.ports) {
      this.#system(
        `service ${port.service} publishes ${port.hostIp ? `${port.hostIp}:` : ''}${port.hostPort ?? '(ephemeral)'} -> ${port.containerPort}/${port.protocol}`,
      );
    }
    const overridePath = join(root, OVERRIDE_FILE);
    await writeFileReplacing(
      overridePath,
      `${JSON.stringify(buildOverride(config, payload), null, 2)}\n`,
      0o644,
    );
    const target: ComposeTarget = { ...appTarget, files: [...source.files, overridePath] };
    const cwd = source.projectDir;

    await ensureProxyNetwork(this.#run, env, payload.network.proxyNetwork, (line) =>
      this.#system(line),
    );
    await this.#builds.use(async () => {
      this.#progress('building', 'Building images');
      await this.#exec('docker', composeArgs(target, 'build', '--pull'), {
        label: 'docker compose build',
        cwd,
        env,
        timeoutMs: TIMEOUTS.build,
      });
      await this.#exec('docker', composeArgs(target, 'pull', '--ignore-buildable'), {
        label: 'docker compose pull',
        cwd,
        env,
        timeoutMs: TIMEOUTS.pull,
      });
    }, this.#signal);

    this.#progress('starting', 'Starting containers');
    await this.#exec(
      'docker',
      composeArgs(
        target,
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        String(WAIT_TIMEOUT_S),
        '--remove-orphans',
        '--timeout',
        '60',
      ),
      { label: 'docker compose up', cwd, env, timeoutMs: TIMEOUTS.up },
    );
    const ps = await this.#exec(
      'docker',
      composeArgs({ project }, 'ps', '--all', '--format', 'json'),
      {
        label: 'docker compose ps',
        cwd: await workspace.neutralDir(),
        env,
        timeoutMs: TIMEOUTS.ps,
        captureStdout: true,
      },
    );
    return parseComposePs(ps.stdout);
  }

  async #exec(command: string, args: string[], options: ExecOptions): Promise<RunResult> {
    if (this.#signal.aborted) throw new Error('aborted');
    const { label } = options;
    this.#system(`$ ${command} ${args.join(' ')}`);
    const result = await this.#spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: this.#signal,
      timeoutMs: options.timeoutMs,
      onStderrLine: (line) => this.#line('stderr', line),
      ...(options.captureStdout
        ? { captureStdoutBytes: CONFIG_OUTPUT_LIMIT }
        : { onStdoutLine: (line: string) => this.#line('stdout', line) }),
    });
    if (result.aborted || this.#signal.aborted) throw new Error('aborted');
    if (result.timedOut) {
      throw new StepError(
        `Timed out after ${Math.round(options.timeoutMs / 1000)} s: ${label}`,
        'timeout',
        true,
      );
    }
    if (result.code !== 0) {
      throw new StepError(`Command failed (exit ${result.code ?? result.signal}): ${label}`);
    }
    return result;
  }

  async #spawn(...call: Parameters<Runner>): Promise<RunResult> {
    try {
      return await this.#run(...call);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
      throw new StepError(
        `Could not start ${call[0]} (${code}); is it installed?`,
        'internal-error',
        true,
      );
    }
  }

  #baseEnv(): NodeJS.ProcessEnv {
    return {
      ...(this.#options.env ?? childEnv()),
      DOCKER_CLI_HINTS: 'false',
      BUILDKIT_PROGRESS: 'plain',
    };
  }

  #redact(line: string): string {
    let out = line;
    for (const secret of this.#secrets) out = out.replaceAll(secret, '[redacted]');
    return out;
  }

  #line(stream: LogStream, raw: string): void {
    const line = this.#redact(raw).slice(0, MAX_LINE_LENGTH);
    if (stream !== 'system') this.#tail.push(line);
    this.#batcher.add({
      seq: this.#job.logSeq++,
      timestamp: new Date().toISOString(),
      stream,
      line,
    });
  }

  #system(line: string): void {
    this.#line('system', line);
  }

  #progress(status: DeploymentProgressPayload['status'], message: string): void {
    this.#batcher.flush();
    this.#log.info({ status }, message);
    this.#send({
      type: 'deployment.progress',
      payload: { deploymentId: this.#payload.deploymentId, status, message },
    });
  }

  #send(
    message:
      | { type: 'deployment.result'; payload: DeploymentResultPayload }
      | { type: 'deployment.progress'; payload: DeploymentProgressPayload },
  ): void {
    this.#options.send({ id: this.#job.requestId, ...message });
  }
}
