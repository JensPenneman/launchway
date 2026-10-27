import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AppSlug,
  CHECK_LABEL,
  CHECK_LOG_LINE_LIMIT,
  CHECK_PROJECT_PREFIX,
  type CheckResultPayload,
  type CheckRunId,
  type CheckRunPayload,
  checkProjectName,
  DEFAULT_PROXY_NETWORK,
  isTypeId,
  type LogLine,
  type LogStream,
} from '@launchway/contracts';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  type BuilderContext,
  CheckBuilderError,
  ensureCheckBuilder,
  pruneCheckBuilder,
} from './check-builder.js';
import { buildCheckDocument, checkEnvironment, checkSourcePaths } from './check-document.js';
import { probeSources } from './check-sources.js';
import { type ComposeTarget, composeArgs } from './compose.js';
import { formatEnvFile } from './compose-files.js';
import { maskQuotedText } from './compose-output.js';
import { evaluateComposePolicy, parseComposeConfig } from './compose-policy.js';
import { ComposeFileError, preflightComposeFiles } from './compose-preflight.js';
import { type Semaphore, secretsOf } from './deployments.js';
import { childEnv, type Runner, type RunResult, runProcess } from './exec.js';
import { assertSafeRef, fetchCommitPlan, type GitConfig, gitEnv } from './git.js';
import { Batcher, MAX_LINE_LENGTH, Tail } from './lines.js';
import type { Send } from './outbox.js';
import {
  isInsideReal,
  MissingFileError,
  PolicyError,
  type Workspace,
  writeFileReplacing,
} from './workspace.js';

const MINUTE = 60_000;
const TIMEOUTS = {
  git: 10 * MINUTE,
  config: 2 * MINUTE,
  build: 60 * MINUTE,
  pull: 30 * MINUTE,
  /** Short docker commands: volume create, container create/inspect/rm/kill, image inspect. */
  docker: MINUTE,
  copy: 10 * MINUTE,
  chown: 10 * MINUTE,
  /** Each cleanup step (down, rm, prune). */
  cleanup: 2 * MINUTE,
};
const CONFIG_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** Output lines a failure message quotes. */
const TAIL_LINES = 15;
/** Text of the log lines one run sends (besides CHECK_LOG_LINE_LIMIT lines). */
const LOG_BYTE_LIMIT = 16 * 1024 * 1024;
const MESSAGE_LIMIT = 2000;
/** Results of finished runs kept for duplicate `check.run` requests. */
const FINISHED_KEPT = 100;
/** `user[:group]` as `chown` takes it from a Compose file or an image; never starts with `-`. */
const OWNER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;
const ROOT_IDS = ['root', '0'];

type CheckOutcome = Omit<CheckResultPayload, 'runId'>;

export interface CheckManagerOptions {
  logger: Logger;
  send: Send;
  workspace: Workspace;
  /** The node's build/pull slots, shared with deployments. */
  builds: Semaphore;
  run?: Runner;
  /** Base environment for child processes (already allow-listed). */
  env?: NodeJS.ProcessEnv;
  /** Extra git configuration (tests rewrite URLs with `url.<base>.insteadOf`). */
  gitConfig?: GitConfig;
  /** Values no check log line or message may show (the node credential, the join token). */
  secrets?: () => readonly (string | null | undefined)[];
}

/** Ends a run with `reason`; with `tail` its message quotes the last output lines. */
class CheckFailure extends Error {
  readonly reason: CheckOutcome['reason'];
  readonly tail: boolean;
  constructor(reason: CheckOutcome['reason'], message: string, tail = false) {
    super(message);
    this.name = 'CheckFailure';
    this.reason = reason;
    this.tail = tail;
  }
}

/** `30 minutes`, `1 minute`, `3 seconds`. */
function formatDuration(ms: number): string {
  if (ms >= MINUTE && ms % MINUTE === 0) {
    const minutes = ms / MINUTE;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** `message` plus as much of the end of `lines` as fits in MESSAGE_LIMIT. */
function withTail(message: string, lines: readonly string[]): string {
  const head = `${message}\n--- last log lines ---\n`;
  if (lines.length === 0 || head.length >= MESSAGE_LIMIT) return message.slice(0, MESSAGE_LIMIT);
  return head + lines.join('\n').slice(-(MESSAGE_LIMIT - head.length));
}

/** True unless `owner` is empty or root (`root`, `0`, `0:0`, `root:root`, ...). */
function needsChown(owner: string): boolean {
  if (owner === '') return false;
  const [user = '', group] = owner.split(':');
  return !(ROOT_IDS.includes(user) && (group === undefined || ROOT_IDS.includes(group)));
}

/**
 * Proxy settings may carry credentials: a project could interpolate them (`${HTTPS_PROXY}`) or
 * pass them on (`environment: [HTTPS_PROXY]`, `args: {HTTPS_PROXY: null}`). Git keeps them.
 */
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'ftp_proxy',
];

/** Environment of the docker and compose commands of checks: the base without proxy settings. */
function dockerEnvOf(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DOCKER_CLI_HINTS: 'false', BUILDKIT_PROGRESS: 'plain' };
  for (const key of PROXY_VARIABLES) delete env[key];
  return env;
}

/** Length of the run id suffix in `checkProjectName` (a TypeID suffix). */
const RUN_SUFFIX_LENGTH = 26;

/**
 * The check-run project (`launchway-check_<slug>_<run id suffix>`) a Docker name belongs to, and
 * the rest of the name (`_<key>` of a volume or network, `-<name>` of a container); null for
 * anything else, such as `launchway-check` and `launchway-check_<key>` of an app named `check`.
 */
function runProjectOf(name: string): { project: string; slug: string; rest: string } | null {
  if (!name.startsWith(CHECK_PROJECT_PREFIX)) return null;
  const tail = name.slice(CHECK_PROJECT_PREFIX.length);
  const end = tail.indexOf('_');
  if (end <= 0) return null;
  const slug = tail.slice(0, end);
  const suffix = tail.slice(end + 1, end + 1 + RUN_SUFFIX_LENGTH);
  if (!AppSlug.safeParse(slug).success || !isTypeId('chk', `chk_${suffix}`)) return null;
  const project = `${CHECK_PROJECT_PREFIX}${slug}_${suffix}`;
  return { project, slug, rest: name.slice(project.length) };
}

/** Which leftovers a sweep removes: of every app, or of one app's runs only. */
interface SweepScope {
  slug?: string;
}

/** True for a name of `shape` (the project itself, a volume or network of it, a container). */
function isRunName(name: string, shape: 'project' | 'resource' | 'container', scope: SweepScope) {
  const parsed = runProjectOf(name);
  if (!parsed || (scope.slug !== undefined && parsed.slug !== scope.slug)) return false;
  if (shape === 'project') return parsed.rest === '';
  return parsed.rest.length > 1 && parsed.rest.startsWith(shape === 'resource' ? '_' : '-');
}

const outputLines = (stdout: string) =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const ContainerState = z.looseObject({
  Running: z.boolean().optional(),
  OOMKilled: z.boolean().optional(),
  ExitCode: z.number().int().optional(),
  StartedAt: z.string().optional(),
  Error: z.string().optional(),
});

/**
 * The log of one run: lines are redacted (the Authorization value and its token), cut to
 * MAX_LINE_LENGTH and batched into `check.log`; after CHECK_LOG_LINE_LIMIT lines or
 * LOG_BYTE_LIMIT bytes of text one "truncated" line follows and the rest is dropped. The last
 * output lines stay in memory for messages.
 */
class CheckLog {
  readonly #secrets: readonly string[];
  readonly #batcher: Batcher<LogLine>;
  readonly #tail = new Tail<string>(TAIL_LINES);
  #seq = 0;
  #bytes = 0;
  #truncated = false;
  #closed = false;

  constructor(secrets: readonly string[], send: (lines: LogLine[]) => void) {
    this.#secrets = secrets;
    this.#batcher = new Batcher<LogLine>(send);
  }

  /** A system line for a message of its own (acknowledgements); sent even past the limit. */
  immediate(line: string): LogLine {
    this.#batcher.flush();
    return this.#next('system', line);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.replaceAll(secret, '[redacted]');
    return out;
  }

  add(stream: LogStream, raw: string): void {
    if (this.#closed) return;
    const line = this.redact(raw).slice(0, MAX_LINE_LENGTH);
    if (stream !== 'system') this.#tail.push(line);
    if (this.#truncated) return;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.#seq < CHECK_LOG_LINE_LIMIT && this.#bytes + bytes <= LOG_BYTE_LIMIT) {
      this.#bytes += bytes;
      this.#batcher.add(this.#next(stream, line));
      return;
    }
    this.#truncated = true;
    this.#batcher.add(this.#next('system', `… output truncated after ${this.#seq} lines`));
  }

  tail(): string[] {
    return this.#tail.values();
  }

  /** Sends what is pending; nothing is logged after the run's result. */
  close(): void {
    this.#batcher.flush();
    this.#closed = true;
  }

  #next(stream: LogStream, line: string): LogLine {
    return { seq: this.#seq++, timestamp: new Date().toISOString(), stream, line };
  }
}

interface CheckJob {
  requestId: string;
  payload: CheckRunPayload;
  controller: AbortController;
  state: 'queued' | 'running';
  /** True once check.result was sent; the run may still be cleaning up in its slot. */
  settled: boolean;
  log: CheckLog;
}

interface DockerContext {
  run: Runner;
  env: NodeJS.ProcessEnv;
  cwd: string;
  logger: Logger;
}

/** A cleanup command: bounded, its failure logged and returned as null, never thrown. */
async function cleanupDocker(
  ctx: DockerContext,
  command: string,
  args: string[],
  timeoutMs = TIMEOUTS.docker,
): Promise<RunResult | null> {
  const stderr = new Tail<string>(3);
  try {
    const result = await ctx.run('docker', args, {
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs,
      captureStdoutBytes: 4 * 1024 * 1024,
      onStderrLine: (line) => {
        if (line.trim()) stderr.push(line.slice(0, 300));
      },
    });
    if (result.code === 0) return result;
    ctx.logger.warn(
      { command, code: result.code, timedOut: result.timedOut, stderr: stderr.values() },
      'check cleanup command failed',
    );
  } catch (error) {
    ctx.logger.warn({ err: error, command }, 'check cleanup command could not start');
  }
  return null;
}

const downArgs = (project: string) =>
  composeArgs({ project }, 'down', '--volumes', '--remove-orphans', '--timeout', '5');

/**
 * Removes everything of one run: its containers with their anonymous volumes (a project-only
 * `down` leaves those of the one-off container), the Compose project, the source volume and any
 * other volume or network labelled with the run, then the app's dangling check images.
 */
async function removeRunResources(
  ctx: DockerContext,
  project: string,
  runId: string,
  slug: string,
) {
  const filter = `label=${CHECK_LABEL}=${runId}`;
  const containers = await cleanupDocker(ctx, 'docker ps', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    filter,
  ]);
  const ids = containers ? outputLines(containers.stdout) : [];
  if (ids.length > 0) {
    await cleanupDocker(
      ctx,
      'docker rm',
      ['rm', '--force', '--volumes', '--', ...ids],
      TIMEOUTS.cleanup,
    );
  }
  await cleanupDocker(ctx, 'docker compose down', downArgs(project), TIMEOUTS.cleanup);
  await cleanupDocker(ctx, 'docker volume rm', [
    'volume',
    'rm',
    '--force',
    '--',
    `${project}_source`,
  ]);
  const volumes = await cleanupDocker(ctx, 'docker volume ls', [
    'volume',
    'ls',
    '--quiet',
    '--filter',
    filter,
  ]);
  const names = volumes ? outputLines(volumes.stdout) : [];
  if (names.length > 0)
    await cleanupDocker(ctx, 'docker volume rm', ['volume', 'rm', '--force', '--', ...names]);
  const networks = await cleanupDocker(ctx, 'docker network ls', [
    'network',
    'ls',
    '--quiet',
    '--filter',
    filter,
  ]);
  const networkIds = networks ? outputLines(networks.stdout) : [];
  if (networkIds.length > 0)
    await cleanupDocker(ctx, 'docker network rm', ['network', 'rm', '--', ...networkIds]);
  // Built images carry `launchway.check=<slug>`: only this app's dangling ones go.
  await cleanupDocker(
    ctx,
    'docker image prune',
    ['image', 'prune', '--force', '--filter', `label=${CHECK_LABEL}=${slug}`],
    TIMEOUTS.cleanup,
  );
}

/**
 * Removes what earlier runs left behind (a crash, a shutdown before cleanup finished): only
 * resources labelled `launchway.check` whose Compose project or name has the shape of a check
 * run's (`launchway-check_<slug>_<run id suffix>`, its volumes, networks and containers).
 * Stops at the first listing or removal that fails (false).
 */
async function sweepResources(ctx: DockerContext, scope: SweepScope): Promise<boolean> {
  const label = `label=${CHECK_LABEL}`;
  const containers = await cleanupDocker(ctx, 'docker ps', [
    'ps',
    '--all',
    '--filter',
    label,
    '--format',
    '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  if (!containers) return false;
  const ids: string[] = [];
  const projects = new Set<string>();
  for (const row of outputLines(containers.stdout)) {
    const [id = '', names = '', project = ''] = row.split('\t');
    const ofRun = isRunName(project, 'project', scope);
    if (ofRun) projects.add(project);
    const named = names.split(',').some((name) => isRunName(name, 'container', scope));
    if (id && (ofRun || named)) ids.push(id);
  }
  if (ids.length > 0) {
    const removed = await cleanupDocker(
      ctx,
      'docker rm',
      ['rm', '--force', '--volumes', '--', ...ids],
      TIMEOUTS.cleanup,
    );
    if (!removed) return false;
  }
  for (const project of projects)
    await cleanupDocker(ctx, 'docker compose down', downArgs(project), TIMEOUTS.cleanup);
  const volumes = await cleanupDocker(ctx, 'docker volume ls', [
    'volume',
    'ls',
    '--filter',
    label,
    '--format',
    '{{.Name}}',
  ]);
  if (!volumes) return false;
  const names = outputLines(volumes.stdout).filter((name) => isRunName(name, 'resource', scope));
  if (names.length > 0)
    await cleanupDocker(ctx, 'docker volume rm', ['volume', 'rm', '--force', '--', ...names]);
  const networks = await cleanupDocker(ctx, 'docker network ls', [
    'network',
    'ls',
    '--filter',
    label,
    '--format',
    '{{.ID}}\t{{.Name}}',
  ]);
  if (!networks) return false;
  const networkIds = outputLines(networks.stdout)
    .map((row) => row.split('\t'))
    .filter(([id, name = '']) => id && isRunName(name, 'resource', scope))
    .map(([id = '']) => id);
  if (networkIds.length > 0)
    await cleanupDocker(ctx, 'docker network rm', ['network', 'rm', '--', ...networkIds]);
  const images = scope.slug === undefined ? label : `${label}=${scope.slug}`;
  await cleanupDocker(
    ctx,
    'docker image prune',
    ['image', 'prune', '--force', '--filter', images],
    TIMEOUTS.cleanup,
  );
  if (ids.length + names.length + networkIds.length > 0) {
    ctx.logger.info(
      {
        containers: ids.length,
        projects: projects.size,
        volumes: names.length,
        networks: networkIds.length,
      },
      'removed leftovers of earlier check runs',
    );
  }
  return true;
}

interface ExecOptions {
  /** Short description for failure messages (`docker compose build`). */
  label: string;
  /** Reason of the result when the command fails or times out. */
  reason: 'build' | 'infrastructure';
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Capture stdout instead of logging it (Compose config output, ids). */
  captureStdout?: boolean;
  /** Rewrites each stderr line before it is logged. */
  stderrFilter?: (line: string) => string;
}

/** One check run, from fetching the commit to cleaning up (ADR 0020). */
class CheckRun {
  readonly #job: CheckJob;
  readonly #payload: CheckRunPayload;
  readonly #options: CheckManagerOptions;
  readonly #run: Runner;
  readonly #settle: (outcome: CheckOutcome) => void;
  readonly #logger: Logger;
  readonly #project: string;
  /** Set before the first command that creates Docker resources. */
  #dockerUsed = false;
  /** The check builder the run built with, pruned after the run. */
  #builder: string | null = null;

  constructor(
    job: CheckJob,
    options: CheckManagerOptions,
    run: Runner,
    settle: (outcome: CheckOutcome) => void,
  ) {
    this.#job = job;
    this.#payload = job.payload;
    this.#options = options;
    this.#run = run;
    this.#settle = settle;
    this.#project = checkProjectName(job.payload.app.slug, job.payload.runId);
    this.#logger = options.logger.child({ runId: job.payload.runId, appId: job.payload.app.id });
  }

  get #signal(): AbortSignal {
    return this.#job.controller.signal;
  }

  /** Reports the result first, then cleans up; never throws. */
  async execute(): Promise<void> {
    this.#logger.info({ check: this.#payload.check.name }, 'check run started');
    let outcome: CheckOutcome | null;
    try {
      outcome = await this.#steps();
    } catch (error) {
      outcome = this.#failure(error);
    }
    if (outcome) {
      this.#logger.info({ reason: outcome.reason, exitCode: outcome.exitCode }, 'check run ended');
      this.#settle(outcome);
    }
    await this.#cleanup();
  }

  /** The outcome of a failed run; null when it was cancelled or interrupted (already reported). */
  #failure(error: unknown): CheckOutcome | null {
    if (this.#signal.aborted) return null;
    if (error instanceof CheckFailure) {
      const message = error.tail
        ? withTail(error.message, this.#job.log.tail())
        : error.message.slice(0, MESSAGE_LIMIT);
      return { reason: error.reason, exitCode: null, message };
    }
    if (error instanceof MissingFileError || error instanceof ComposeFileError) {
      return { reason: 'build', exitCode: null, message: error.message.slice(0, MESSAGE_LIMIT) };
    }
    if (error instanceof PolicyError) {
      return { reason: 'policy', exitCode: null, message: error.message.slice(0, MESSAGE_LIMIT) };
    }
    this.#logger.error({ err: error }, 'unexpected check error');
    return { reason: 'infrastructure', exitCode: null, message: 'Unexpected agent error' };
  }

  async #steps(): Promise<CheckOutcome> {
    const { app, runId, check, composeFiles, limits } = this.#payload;
    const workspace = this.#options.workspace;
    const runDir = await workspace.prepareCheckRunDir(app.id, runId);
    const srcDir = join(runDir, 'src');
    await this.#fetch(runDir, srcDir);

    const resolved = await workspace.resolveComposeFiles(srcDir, composeFiles);
    // Before Compose reads anything the files name: no include, extends only within the repository.
    await preflightComposeFiles({ ...resolved, mode: 'check' });
    const checkEnv = checkEnvironment(this.#payload, this.#project);
    const envFile = join(runDir, 'check.env');
    await writeFileReplacing(envFile, formatEnvFile(checkEnv), 0o600);
    const env = this.#env();
    const files: ComposeTarget = {
      project: this.#project,
      files: resolved.files,
      projectDir: resolved.projectDir,
      envFile,
    };
    // --no-env-resolution: env_file contents are not read before the policy saw their paths.
    let masked = 0;
    const output = await this.#exec(
      'docker',
      composeArgs(files, 'config', '--format', 'json', '--no-env-resolution'),
      {
        label: 'docker compose config',
        reason: 'build',
        cwd: resolved.projectDir,
        env,
        timeoutMs: TIMEOUTS.config,
        captureStdout: true,
        stderrFilter: (line) => {
          const shown = maskQuotedText(line);
          if (shown !== line) masked += 1;
          return shown;
        },
      },
    ).finally(() => {
      if (masked > 0) {
        this.#system(
          'Quoted text in the output of docker compose config is masked: it may quote files outside the repository',
        );
      }
    });
    const config = parseComposeConfig(output.stdout);
    if (!config) throw new CheckFailure('build', 'Could not read the Compose configuration');

    const sources = await probeSources(
      resolved.root,
      checkSourcePaths(config, resolved.projectDir),
    );
    const policy = evaluateComposePolicy(config, {
      mode: 'check',
      projectName: this.#project,
      proxyNetwork: DEFAULT_PROXY_NETWORK,
      routes: [],
      isInsideCheckout: (path) => isInsideReal(resolved.root, path),
      projectDir: resolved.projectDir,
      workspaceRoot: workspace.root,
      fileSize: (path) => {
        const source = sources.get(path);
        return source?.kind === 'file' ? source.size : null;
      },
    });
    if (policy.violations.length > 0) {
      for (const violation of policy.violations) this.#system(`policy: ${violation}`);
      throw new PolicyError(`Compose policy violation: ${policy.violations.join('; ')}`);
    }
    const built = buildCheckDocument(config, {
      project: this.#project,
      slug: app.slug,
      runId,
      service: check.service,
      env: checkEnv,
      limits,
      projectDir: resolved.projectDir,
      sources: (path) => sources.get(path),
    });
    for (const note of built.notes) this.#system(note);
    // Missing bind sources become directories, as Docker would create them on the host.
    for (const dir of built.directories) {
      await mkdir(join(resolved.root, dir), { recursive: true }).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        throw new CheckFailure('infrastructure', `Could not create "${dir}" to mount (${code})`);
      });
    }
    const documentPath = join(runDir, 'compose.json');
    await writeFileReplacing(documentPath, `${JSON.stringify(built.document, null, 2)}\n`, 0o600);
    const target: ComposeTarget = { project: this.#project, files: [documentPath], envFile };

    this.#dockerUsed = true;
    const services = Object.values((built.document.services ?? {}) as Record<string, object>);
    const builds = services.some((service) => 'build' in service);
    await this.#options.builds.use(async () => {
      this.#system('Building and pulling the images');
      // Builds run in the check builder (limits, cache and network of their own), never in the
      // engine's builder that deployments use.
      const builder = builds ? await this.#ensureBuilder(runDir) : null;
      const build = composeArgs(
        target,
        'build',
        '--pull',
        ...(builder ? ['--builder', builder] : []),
      );
      await this.#exec('docker', build, {
        label: 'docker compose build',
        reason: 'build',
        cwd: runDir,
        // Compose finds the check builder in the agent's buildx records.
        env: builder ? await this.#builderEnv() : env,
        timeoutMs: TIMEOUTS.build,
      });
      // Always from the registry: an image that only exists on the node may be another app's.
      const pull = composeArgs(target, 'pull', '--policy', 'always', '--ignore-buildable');
      await this.#exec('docker', pull, {
        label: 'docker compose pull',
        reason: 'build',
        cwd: runDir,
        env,
        timeoutMs: TIMEOUTS.pull,
      });
    }, this.#signal);
    if (built.usesSource) await this.#deliverSource(resolved.root, built.image, built.user);
    return this.#runCommand(target, runDir);
  }

  /** Fetches exactly the commit (credentials only in git's environment) and verifies HEAD. */
  async #fetch(runDir: string, srcDir: string): Promise<void> {
    const { source } = this.#payload;
    try {
      assertSafeRef(source.ref);
    } catch (error) {
      throw new CheckFailure('build', (error as Error).message);
    }
    this.#system(`Fetching ${source.ref} (${source.sha.slice(0, 12)})`);
    const env = {
      ...(this.#options.env ?? childEnv()),
      ...gitEnv(source.authorization, this.#options.gitConfig),
    };
    for (const step of fetchCommitPlan(source.cloneUrl, source.sha, srcDir, true).steps) {
      await this.#exec('git', step.args, {
        label: `git ${step.args[0]}`,
        reason: 'build',
        cwd: step.inParent ? runDir : srcDir,
        env,
        timeoutMs: TIMEOUTS.git,
      });
    }
    const head = await this.#exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      label: 'git rev-parse',
      reason: 'build',
      cwd: srcDir,
      env,
      timeoutMs: TIMEOUTS.docker,
      captureStdout: true,
    });
    const sha = head.stdout.trim();
    if (sha !== source.sha) {
      throw new CheckFailure('build', `Checked out ${sha} but the check expects ${source.sha}`);
    }
    this.#system(`checked out ${sha}`);
  }

  /**
   * Fills the source volume without host binds (the agent's paths do not exist on the Docker
   * host): `docker cp` into a container that is never started, then hands the files to the
   * service's user with a short-lived `chown` container (the agent itself cannot chown).
   */
  async #deliverSource(root: string, image: string, user: string | null): Promise<void> {
    const { runId, limits, check } = this.#payload;
    const volume = `${this.#project}_source`;
    const helper = `${this.#project}-source`;
    const label = `${CHECK_LABEL}=${runId}`;
    const options = {
      reason: 'infrastructure' as const,
      cwd: await this.#options.workspace.neutralDir(),
      env: this.#env(),
      timeoutMs: TIMEOUTS.docker,
      captureStdout: true,
    };
    this.#system('Copying the repository into the source volume');
    await this.#exec('docker', ['volume', 'create', '--label', label, '--', volume], {
      ...options,
      label: 'docker volume create',
    });
    await this.#exec(
      'docker',
      [
        'container',
        'create',
        '--pull',
        'never',
        '--name',
        helper,
        '--label',
        label,
        '--network',
        'none',
        '--entrypoint',
        'true',
        '--mount',
        `type=volume,src=${volume},dst=/src,volume-nocopy`,
        '--',
        image,
      ],
      { ...options, label: 'docker container create' },
    );
    await this.#exec('docker', ['cp', `${root}/.`, `${helper}:/src`], {
      ...options,
      label: 'docker cp',
      timeoutMs: TIMEOUTS.copy,
    });
    await this.#exec('docker', ['rm', '--force', '--', helper], { ...options, label: 'docker rm' });

    const owner =
      user ??
      (
        await this.#exec(
          'docker',
          ['image', 'inspect', '--format', '{{.Config.User}}', '--', image],
          { ...options, label: 'docker image inspect' },
        )
      ).stdout.trim();
    if (!needsChown(owner)) return;
    if (!OWNER_PATTERN.test(owner)) {
      throw new CheckFailure(
        'policy',
        `The user "${owner.slice(0, 80)}" of the service "${check.service}" is not a user name the repository can be handed to`,
      );
    }
    this.#system(`Handing the source volume to ${owner}`);
    await this.#exec(
      'docker',
      [
        'run',
        '--rm',
        '--pull',
        'never',
        '--name',
        `${this.#project}-chown`,
        '--label',
        label,
        '--network',
        'none',
        '--user',
        '0:0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--cap-add',
        'DAC_OVERRIDE',
        '--cap-add',
        'FOWNER',
        '--security-opt',
        'no-new-privileges:true',
        '--memory',
        String(limits.memoryBytes),
        '--memory-swap',
        String(limits.memoryBytes),
        '--cpus',
        String(limits.cpus),
        '--pids-limit',
        String(limits.pidsLimit),
        '--entrypoint',
        'chown',
        '--mount',
        `type=volume,src=${volume},dst=/src`,
        '--',
        image,
        '-R',
        '-h',
        '--',
        owner,
        '/src',
      ],
      {
        ...options,
        label: 'chown of the source volume',
        timeoutMs: TIMEOUTS.chown,
        captureStdout: false,
      },
    );
  }

  /**
   * `compose run` of the check's command (sidecars start through depends_on). Killing the CLI
   * leaves the container running, so a timeout or an abort also kills the container.
   */
  async #runCommand(target: ComposeTarget, runDir: string): Promise<CheckOutcome> {
    const { check } = this.#payload;
    const name = `${this.#project}-check`;
    const args = composeArgs(
      target,
      'run',
      '-T',
      '--pull',
      'never',
      '--name',
      name,
      check.service,
      'sh',
      '-c',
      check.command,
    );
    if (this.#signal.aborted) throw new Error('aborted');
    this.#system(
      `Running the check "${check.name}" in the service ${check.service} (time limit ${formatDuration(check.timeoutMs)})`,
    );
    // Quoted: the command may span lines.
    this.#system(`$ docker ${[...args.slice(0, -1), JSON.stringify(check.command)].join(' ')}`);
    const step = new AbortController();
    let timedOut = false;
    const stop = () => {
      step.abort();
      void this.#kill(name);
    };
    this.#signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, check.timeoutMs);
    try {
      await this.#spawn('docker', args, {
        cwd: runDir,
        env: this.#env(),
        signal: step.signal,
        onStdoutLine: (line) => this.#line('stdout', line),
        onStderrLine: (line) => this.#line('stderr', line),
      });
    } finally {
      clearTimeout(timer);
      this.#signal.removeEventListener('abort', stop);
    }
    if (this.#signal.aborted || timedOut) {
      // The CLI may have created the container after the first kill.
      await this.#kill(name);
      if (this.#signal.aborted) throw new Error('aborted');
      this.#system(`Timed out after ${formatDuration(check.timeoutMs)}; the container was stopped`);
      return {
        reason: 'timeout',
        exitCode: null,
        message: `Timed out after ${formatDuration(check.timeoutMs)}`,
      };
    }
    const state = await this.#containerState(name);
    if (!state?.StartedAt || state.StartedAt.startsWith('0001-01-01')) {
      throw new CheckFailure(
        'infrastructure',
        `The check container did not start${state?.Error ? `: ${state.Error}` : ''}`,
        true,
      );
    }
    if (state.Running) {
      await this.#kill(name);
      throw new CheckFailure('infrastructure', 'The check container kept running', true);
    }
    if (state.ExitCode === undefined) {
      throw new CheckFailure('infrastructure', 'Could not read the exit code of the check', true);
    }
    const code = state.ExitCode;
    this.#system(`exited with code ${code}${state.OOMKilled ? ' (out of memory)' : ''}`);
    if (code === 0) return { reason: 'exit', exitCode: 0 };
    return {
      reason: 'exit',
      exitCode: code,
      message: `Exited with code ${code}${state.OOMKilled ? ' (out of memory)' : ''}`,
    };
  }

  async #containerState(name: string): Promise<z.infer<typeof ContainerState> | null> {
    const result = await this.#spawn(
      'docker',
      ['container', 'inspect', '--format', '{{json .State}}', '--', name],
      { env: this.#env(), timeoutMs: TIMEOUTS.docker, captureStdoutBytes: 64 * 1024 },
    );
    if (result.code !== 0) return null;
    try {
      const parsed = ContainerState.safeParse(JSON.parse(result.stdout));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** `docker kill` of the run's container; "not running" and "no such container" are fine. */
  async #kill(name: string): Promise<void> {
    try {
      await this.#run('docker', ['kill', '--', name], {
        env: this.#env(),
        timeoutMs: 30_000,
      });
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not run docker kill');
    }
  }

  /** The check builder for the run's limits, created or started when needed. */
  async #ensureBuilder(cwd: string): Promise<string> {
    const { limits } = this.#payload;
    const ctx: BuilderContext = {
      run: this.#run,
      env: await this.#builderEnv(),
      cwd,
      logger: this.#logger,
      signal: this.#signal,
      onLine: (line) => this.#system(line),
    };
    try {
      const name = await ensureCheckBuilder(ctx, limits);
      this.#builder = name;
      const mib = Math.round(limits.memoryBytes / (1024 * 1024));
      this.#system(
        `building with the check builder ${name}: ${mib} MiB without swap, ${limits.cpus} CPUs, ${limits.pidsLimit} processes`,
      );
      return name;
    } catch (error) {
      if (this.#signal.aborted) throw new Error('aborted');
      if (error instanceof CheckBuilderError) {
        for (const line of error.output) this.#line('stderr', line);
        throw new CheckFailure('infrastructure', error.message, true);
      }
      throw error;
    }
  }

  /** The docker environment of checks with the agent's own buildx records (BUILDX_CONFIG). */
  async #builderEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...this.#env(),
      BUILDX_CONFIG: await this.#options.workspace.buildxDir(),
    };
    delete env.BUILDX_BUILDER;
    return env;
  }

  async #cleanup(): Promise<void> {
    const { app, runId } = this.#payload;
    const workspace = this.#options.workspace;
    try {
      if (this.#dockerUsed) {
        const ctx: DockerContext = {
          run: this.#run,
          env: this.#env(),
          cwd: await workspace.neutralDir(),
          logger: this.#logger,
        };
        await removeRunResources(ctx, this.#project, runId, app.slug);
      }
      if (this.#builder) {
        await pruneCheckBuilder(
          {
            run: this.#run,
            env: await this.#builderEnv(),
            cwd: await workspace.neutralDir(),
            logger: this.#logger,
          },
          this.#builder,
        );
      }
    } catch (error) {
      this.#logger.warn({ err: error }, 'check cleanup failed');
    }
    try {
      await workspace.removeCheckRunDir(app.id, runId);
    } catch (error) {
      this.#logger.warn({ err: error }, 'failed to remove the check run directory');
    }
    this.#logger.debug('check run cleaned up');
  }

  async #exec(command: string, args: string[], options: ExecOptions): Promise<RunResult> {
    if (this.#signal.aborted) throw new Error('aborted');
    this.#system(`$ ${command} ${args.join(' ')}`);
    const result = await this.#spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: this.#signal,
      timeoutMs: options.timeoutMs,
      onStderrLine: (line) =>
        this.#line('stderr', options.stderrFilter ? options.stderrFilter(line) : line),
      ...(options.captureStdout
        ? { captureStdoutBytes: CONFIG_OUTPUT_LIMIT }
        : { onStdoutLine: (line: string) => this.#line('stdout', line) }),
    });
    if (result.aborted || this.#signal.aborted) throw new Error('aborted');
    if (result.timedOut) {
      throw new CheckFailure(
        options.reason,
        `Timed out after ${formatDuration(options.timeoutMs)}: ${options.label}`,
        true,
      );
    }
    if (result.code !== 0) {
      throw new CheckFailure(
        options.reason,
        `Command failed (exit ${result.code ?? result.signal}): ${options.label}`,
        true,
      );
    }
    return result;
  }

  async #spawn(...call: Parameters<Runner>): Promise<RunResult> {
    try {
      return await this.#run(...call);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
      throw new CheckFailure(
        'infrastructure',
        `Could not start ${call[0]} (${code}); is it installed?`,
      );
    }
  }

  #env(): NodeJS.ProcessEnv {
    return dockerEnvOf(this.#options.env ?? childEnv());
  }

  #line(stream: LogStream, line: string): void {
    this.#job.log.add(stream, line);
  }

  #system(line: string): void {
    this.#job.log.add('system', line);
  }
}

/**
 * Check runs (ADR 0020): one at a time per node, in the order they arrive (the server sends at
 * most one; the agent serializes anyway). A run reports its result first and then cleans up in
 * its slot, so the next run starts only after the previous project is gone. Cancelling or
 * shutting down reports at once and aborts what is running.
 */
export class CheckManager {
  readonly #options: CheckManagerOptions;
  readonly #logger: Logger;
  readonly #run: Runner;
  readonly #jobs = new Map<CheckRunId, CheckJob>();
  readonly #finished = new Map<CheckRunId, CheckResultPayload>();
  #queue: Promise<void> = Promise.resolve();
  #shuttingDown = false;

  constructor(options: CheckManagerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#run = options.run ?? runProcess;
  }

  /** Runs queued or running on this node (heartbeat `activeCheckRunIds`). */
  activeCheckRunIds(): CheckRunId[] {
    return [...this.#jobs.keys()].slice(0, 100);
  }

  run(requestId: string, payload: CheckRunPayload): void {
    const { runId } = payload;
    const existing = this.#jobs.get(runId);
    if (existing) {
      this.#logger.warn({ runId }, 'check run already queued or running; ignoring duplicate');
      this.#acknowledge(requestId, existing, `Already ${existing.state} on this node`);
      return;
    }
    const finished = this.#finished.get(runId);
    if (finished) {
      this.#logger.warn({ runId }, 'check run already finished; repeating its result');
      this.#options.send({ id: requestId, type: 'check.result', payload: finished });
      return;
    }
    if (this.#shuttingDown) {
      this.#options.send({
        id: requestId,
        type: 'check.result',
        payload: {
          runId,
          reason: 'interrupted',
          exitCode: null,
          message: 'Interrupted: the agent is shutting down',
        },
      });
      return;
    }
    const job: CheckJob = {
      requestId,
      payload,
      controller: new AbortController(),
      state: 'queued',
      settled: false,
      log: new CheckLog(this.#secretsOf(payload), (lines) =>
        this.#options.send({ id: requestId, type: 'check.log', payload: { runId, lines } }),
      ),
    };
    this.#jobs.set(runId, job);
    this.#logger.info(
      { runId, appId: payload.app.id, check: payload.check.name },
      'check run queued',
    );
    // Answer at once: the run may wait for the run before it.
    this.#acknowledge(requestId, job, 'Received by the node');
    this.#enqueue(() => this.#execute(job));
  }

  /** Cancels a queued or running run; false when it is unknown or already reported. */
  cancel(runId: CheckRunId): boolean {
    const job = this.#jobs.get(runId);
    if (!job) return false;
    this.#stop(job, 'cancel');
    return true;
  }

  /**
   * Removes leftovers of earlier runs (Docker resources and this agent's run directories);
   * queued before every run, so call it once at start. A `slug` limits the Docker part to that
   * app's runs.
   */
  sweep(scope: SweepScope = {}): void {
    this.#enqueue(async () => {
      const workspace = this.#options.workspace;
      try {
        const ctx: DockerContext = {
          run: this.#run,
          env: dockerEnvOf(this.#options.env ?? childEnv()),
          cwd: await workspace.neutralDir(),
          logger: this.#logger,
        };
        const swept = await sweepResources(ctx, scope);
        if (!swept) {
          this.#logger.warn('could not clear leftovers of earlier check runs; left them alone');
        }
      } catch (error) {
        this.#logger.warn({ err: error }, 'could not clear leftovers of earlier check runs');
      }
      await workspace.removeChecks().catch((error: unknown) => {
        this.#logger.warn({ err: error }, 'failed to remove old check run directories');
      });
    });
  }

  /** Interrupts every run at once, then gives cleanup up to `graceMs`. */
  async shutdown(graceMs: number): Promise<void> {
    this.#shuttingDown = true;
    for (const job of [...this.#jobs.values()]) this.#stop(job, 'shutdown');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#queue,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** What a run's log never shows: its Authorization value and the agent's own secrets. */
  #secretsOf(payload: CheckRunPayload): string[] {
    return secretsOf(payload.source.authorization, this.#options.secrets?.() ?? []);
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((error: unknown) => {
      this.#logger.error({ err: error }, 'check queue task failed');
    });
  }

  async #execute(job: CheckJob): Promise<void> {
    if (job.settled) return;
    job.state = 'running';
    const run = new CheckRun(job, this.#options, this.#run, (outcome) =>
      this.#settle(job, outcome),
    );
    try {
      await run.execute();
    } catch (error) {
      this.#logger.error({ err: error, runId: job.payload.runId }, 'check run crashed');
      this.#settle(job, {
        reason: 'infrastructure',
        exitCode: null,
        message: 'Unexpected agent error',
      });
    }
  }

  /** Reports at once, then aborts whatever runs (it cleans up in its slot). */
  #stop(job: CheckJob, reason: 'cancel' | 'shutdown'): void {
    this.#settle(
      job,
      reason === 'cancel'
        ? { reason: 'cancelled', exitCode: null }
        : { reason: 'interrupted', exitCode: null, message: 'Interrupted: the agent shut down' },
    );
    job.controller.abort(reason);
  }

  /** Sends the one check.result of a run (later calls do nothing); it is no longer active. */
  #settle(job: CheckJob, outcome: CheckOutcome): void {
    if (job.settled) return;
    job.settled = true;
    job.log.close();
    const { runId } = job.payload;
    if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
    const payload: CheckResultPayload = {
      runId,
      ...outcome,
      ...(outcome.message === undefined ? {} : { message: job.log.redact(outcome.message) }),
    };
    this.#finished.set(runId, payload);
    if (this.#finished.size > FINISHED_KEPT) {
      const oldest = this.#finished.keys().next();
      if (!oldest.done) this.#finished.delete(oldest.value);
    }
    this.#options.send({ id: job.requestId, type: 'check.result', payload });
  }

  /** The server waits for a first reply to `check.run`; a system log line is that reply. */
  #acknowledge(requestId: string, job: CheckJob, line: string): void {
    this.#options.send({
      id: requestId,
      type: 'check.log',
      payload: { runId: job.payload.runId, lines: [job.log.immediate(line)] },
    });
  }
}
