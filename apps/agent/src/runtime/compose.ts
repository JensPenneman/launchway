import { DEFAULT_PROXY_NETWORK } from '@launchway/contracts';
import type { Runner } from './exec.js';

/** Subnet the installer gives the default proxy network (spec section 3). */
export const DEFAULT_PROXY_SUBNET = '10.210.0.0/24';

export interface ComposeTarget {
  project: string;
  /** Absolute Compose files; omitted for project-only commands (ps, logs, stop, down). */
  files?: readonly string[];
  projectDir?: string;
}

/** `docker compose` argument array with stable, line-oriented output. */
export function composeArgs(target: ComposeTarget, ...command: string[]): string[] {
  const args = ['compose', '--ansi', 'never', '--progress', 'plain', '-p', target.project];
  if (target.projectDir) args.push('--project-directory', target.projectDir);
  for (const file of target.files ?? []) args.push('-f', file);
  return [...args, ...command];
}

/**
 * Makes sure the external proxy network exists on this node (extra nodes do not have it until the
 * agent creates it). The default network gets the installer's subnet when that range is free.
 */
export async function ensureProxyNetwork(
  run: Runner,
  env: NodeJS.ProcessEnv,
  name: string,
  log: (line: string) => void,
): Promise<void> {
  const inspect = () =>
    run('docker', ['network', 'inspect', '--format', '{{.Name}}', '--', name], {
      env,
      timeoutMs: 30_000,
    });
  if ((await inspect()).code === 0) return;
  const base = ['network', 'create', '--driver', 'bridge', '--label', 'launchway.managed=true'];
  const attempts =
    name === DEFAULT_PROXY_NETWORK
      ? [
          [...base, '--subnet', DEFAULT_PROXY_SUBNET, '--', name],
          [...base, '--', name],
        ]
      : [[...base, '--', name]];
  for (const args of attempts) {
    const created = await run('docker', args, { env, timeoutMs: 30_000 });
    if (created.code === 0) {
      log(`created the proxy network ${name}`);
      return;
    }
    // Another deployment may have created it concurrently.
    if ((await inspect()).code === 0) return;
  }
  throw new Error(`Could not create the proxy network "${name}"`);
}
