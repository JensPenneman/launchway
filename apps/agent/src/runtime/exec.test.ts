import { describe, expect, it } from 'vitest';
import { childEnv, runProcess } from './exec.js';

describe('childEnv', () => {
  it('passes only allow-listed variables plus extras', () => {
    const env = childEnv(
      { EXTRA: '1' },
      {
        PATH: '/bin',
        HOME: '/root',
        LAUNCHWAY_JOIN_TOKEN: 'lwyn_secret',
        DATABASE_URL: 'x',
        DOCKER_HOST: 'unix:///d',
      },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/root', DOCKER_HOST: 'unix:///d', EXTRA: '1' });
  });
});

describe('runProcess', () => {
  it('streams stdout and stderr lines and captures stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await runProcess(
      process.execPath,
      ['-e', 'console.log("a\\nb"); console.error("e")'],
      {
        onStdoutLine: (line) => out.push(line),
        onStderrLine: (line) => err.push(line),
        captureStdoutBytes: 100,
      },
    );
    expect(result).toMatchObject({ code: 0, aborted: false, timedOut: false, stdout: 'a\nb\n' });
    expect(out).toEqual(['a', 'b']);
    expect(err).toEqual(['e']);
  });

  it('kills the process tree on abort', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('rejects when the program does not exist', async () => {
    await expect(runProcess('/nonexistent/launchway-binary', [])).rejects.toThrow();
  });
});
