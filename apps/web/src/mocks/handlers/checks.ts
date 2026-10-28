import {
  type App,
  CHECK_RUN_STATUSES,
  type CheckItem,
  type CheckRun,
  type CheckRunStatus,
  CreateCheckRunsInput,
  generateId,
  githubStateOfCheck,
  isActiveCheckRunStatus,
  type LogLine,
} from '@launchway/contracts';
import { HttpResponse, http, sse } from 'msw';
import { db } from '../db';
import { sha } from '../fixtures';
import { API, guard, now, paginate, parseBody, problem, recordAudit } from '../util';

type LogEvents = { log: string; status: string; end: string };

function findApp(id: unknown): App | undefined {
  return db.apps.find((app) => app.id === id);
}

function findRun(id: unknown): CheckRun | undefined {
  return db.checkRuns.find((run) => run.id === id);
}

/** Commit a ref resolves to: full SHAs stay, known abbreviations expand, other refs are stable. */
function resolveRef(ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (/^[0-9a-f]{7,39}$/.test(ref)) {
    const known = [...db.checkRuns, ...db.deployments].find((item) =>
      item.commitSha.startsWith(ref),
    );
    if (known) return known.commitSha;
  }
  let seed = 7;
  for (const char of ref) seed = (seed * 31 + char.charCodeAt(0)) % 1_000_003;
  return sha(seed);
}

const isRunning = (appId: string, name: string, commitSha: string) =>
  db.checkRuns.some(
    (run) =>
      run.appId === appId &&
      run.name === name &&
      run.commitSha === commitSha &&
      isActiveCheckRunStatus(run.status),
  );

/** A queued run of a configured check, with the check's current configuration. */
function queueRun(
  app: App,
  item: CheckItem,
  target: Pick<CheckRun, 'commitSha' | 'ref' | 'prNumber'>,
): CheckRun {
  const run: CheckRun = {
    id: generateId('chk'),
    appId: app.id,
    nodeId: app.nodeId,
    name: item.name,
    command: item.command,
    service: item.service,
    composeFiles: item.composeFile ? [item.composeFile] : [...app.checks.composeFiles],
    timeoutMinutes: item.timeoutMinutes,
    ...target,
    trigger: 'manual',
    status: 'queued',
    reason: null,
    exitCode: null,
    statusMessage: null,
    githubState: 'pending',
    triggeredBy: db.currentUser()?.id ?? null,
    treeSha: null,
    copiedFrom: null,
    alsoRef: null,
    queuedBehind: 0,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    updatedAt: now(),
  };
  db.checkRuns.push(run);
  db.checkLogs.set(run.id, []);
  db.emit('checks', 'created', run.id, { appId: app.id, status: run.status });
  simulate(run, app);
  return run;
}

/** Walks a new run through queued → running → succeeded like the node would. */
function simulate(run: CheckRun, app: App): void {
  const steps: [number, () => void][] = [
    [
      500,
      () => {
        db.updateCheckRun(run.id, { status: 'running', startedAt: now() });
        db.appendCheckLog(
          run.id,
          'system',
          `Checking out ${app.repository.owner}/${app.repository.name} at ${run.commitSha.slice(0, 7)} (${run.ref ?? 'commit'})`,
        );
        db.appendCheckLog(
          run.id,
          'system',
          `Building service ${run.service} (${run.composeFiles.join(', ')})`,
        );
      },
    ],
    [
      1_100,
      () => {
        db.appendCheckLog(run.id, 'stdout', '#1 [dev internal] load build definition');
        db.appendCheckLog(run.id, 'system', `Running in ${run.service}: ${run.command}`);
        db.appendCheckLog(run.id, 'stdout', 'All checks passed.');
      },
    ],
    [
      1_800,
      () => {
        db.appendCheckLog(run.id, 'system', 'Exited with code 0');
        db.updateCheckRun(run.id, {
          status: 'succeeded',
          reason: 'exit',
          exitCode: 0,
          finishedAt: now(),
          githubState: githubStateOfCheck('succeeded'),
        });
      },
    ],
  ];
  for (const [delay, step] of steps) {
    setTimeout(() => {
      if (isActiveCheckRunStatus(run.status)) step();
    }, delay);
  }
}

export const checkHandlers = [
  http.get(`${API}/apps/:id/checks`, ({ params, request }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    if (!findApp(params.id)) return problem('not-found');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const name = url.searchParams.get('name');
    const commitSha = url.searchParams.get('commitSha');
    if (status && !(CHECK_RUN_STATUSES as readonly string[]).includes(status)) {
      return problem('validation-failed', undefined, [
        { path: 'query.status', message: 'Invalid option', code: 'invalid_value' },
      ]);
    }
    const items = db.checkRuns
      .filter(
        (run) =>
          run.appId === params.id &&
          (!status || run.status === (status as CheckRunStatus)) &&
          (!name || run.name === name) &&
          (!commitSha || run.commitSha === commitSha),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return HttpResponse.json(paginate(items, url));
  }),
  http.post(`${API}/apps/:id/checks`, async ({ request, params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const app = findApp(params.id);
    if (!app) return problem('not-found');
    const { data, error } = await parseBody(request, CreateCheckRunsInput);
    if (error) return error;
    if (app.checks.items.length === 0) {
      return problem('conflict', 'This app has no checks; configure them in its settings first.');
    }
    const names = data.names ?? app.checks.items.map((item) => item.name);
    const unknown = names.filter((name) => !app.checks.items.some((item) => item.name === name));
    if (unknown.length > 0) {
      return problem('validation-failed', undefined, [
        {
          path: 'body.names',
          message: `Unknown check ${unknown.map((name) => `"${name}"`).join(', ')}`,
          code: 'custom',
        },
      ]);
    }
    const commitSha = resolveRef(data.ref);
    const items = app.checks.items.filter(
      (item) => names.includes(item.name) && !isRunning(app.id, item.name, commitSha),
    );
    if (items.length === 0) {
      return problem(
        'conflict',
        `Every requested check already runs for ${commitSha.slice(0, 7)}.`,
      );
    }
    const created = items.map((item) =>
      queueRun(app, item, { commitSha, ref: data.ref, prNumber: null }),
    );
    recordAudit('check.create', 'app', app.id, {
      ref: data.ref,
      names: created.map((run) => run.name),
    });
    return HttpResponse.json({ items: created }, { status: 201 });
  }),
  http.get(`${API}/checks/:id`, ({ params }) => {
    const denied = guard('viewer');
    if (denied) return denied;
    const run = findRun(params.id);
    return run ? HttpResponse.json(run) : problem('not-found', 'No such check run.');
  }),
  http.post(`${API}/checks/:id/cancel`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const run = findRun(params.id);
    if (!run) return problem('not-found');
    if (!isActiveCheckRunStatus(run.status)) {
      return problem('conflict', `A ${run.status} check run cannot be cancelled.`);
    }
    db.appendCheckLog(run.id, 'system', `Cancelled by ${db.currentUser()?.name ?? 'request'}`);
    db.updateCheckRun(run.id, {
      status: 'cancelled',
      reason: 'cancelled',
      finishedAt: now(),
      githubState: githubStateOfCheck('cancelled'),
    });
    recordAudit('check.cancel', 'check', run.id, { name: run.name });
    return HttpResponse.json(run);
  }),
  http.post(`${API}/checks/:id/rerun`, ({ params }) => {
    const denied = guard('member');
    if (denied) return denied;
    const run = findRun(params.id);
    if (!run) return problem('not-found');
    const app = findApp(run.appId);
    const item = app?.checks.items.find((entry) => entry.name === run.name);
    if (!app || !item) {
      return problem('conflict', `The check "${run.name}" is no longer configured.`);
    }
    if (isRunning(app.id, run.name, run.commitSha)) {
      return problem(
        'conflict',
        `${run.name} already runs for ${run.commitSha.slice(0, 7)}; cancel it first.`,
      );
    }
    const created = queueRun(app, item, {
      commitSha: run.commitSha,
      ref: run.ref,
      prNumber: run.prNumber,
    });
    recordAudit('check.rerun', 'check', created.id, { name: run.name, of: run.id });
    return HttpResponse.json(created, { status: 201 });
  }),
  sse<LogEvents>(`${API}/checks/:id/logs`, ({ client, params, request }) => {
    const run = findRun(params.id);
    if (!run || !db.role()) {
      client.error();
      return;
    }
    const after = Number(new URL(request.url).searchParams.get('after') ?? -1);
    const sendLine = (line: LogLine) =>
      client.send({ id: String(line.seq), event: 'log', data: JSON.stringify(line) });
    for (const line of db.checkLogs.get(run.id) ?? []) if (line.seq > after) sendLine(line);
    const end = () => {
      client.send({ event: 'end', data: JSON.stringify({ status: run.status }) });
      client.close();
    };
    if (!isActiveCheckRunStatus(run.status)) {
      end();
      return;
    }
    const unsubscribe = db.onCheckRun(run.id, (update) => {
      if ('seq' in update) {
        sendLine(update);
        return;
      }
      client.send({ event: 'status', data: JSON.stringify({ status: update.status }) });
      if (!isActiveCheckRunStatus(update.status)) {
        unsubscribe();
        end();
      }
    });
    request.signal.addEventListener('abort', unsubscribe);
  }),
];
