import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DockerInfo } from '@slipway/contracts';
import Docker from 'dockerode';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

export interface DockerProbe {
  docker: DockerInfo | null;
  dockerError: string | null;
}

/** dockerode client for DOCKER_HOST (`unix:///var/run/docker.sock` or `tcp://host:2375`). */
export function createDockerClient(dockerHost: string): Docker {
  const url = new URL(dockerHost);
  if (url.protocol === 'unix:') return new Docker({ socketPath: url.pathname });
  return new Docker({
    host: url.hostname,
    port: Number(url.port || 2375),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  });
}

/** Version of the Compose plugin, via `docker compose version --short` (argument array, no shell). */
async function composeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', ['compose', 'version', '--short'], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Collects the Docker facts reported in `hello`. Never throws: failures become `dockerError`. */
export async function probeDocker(docker: Docker): Promise<DockerProbe> {
  try {
    const [info, version, compose] = await Promise.all([
      docker.info(),
      docker.version(),
      composeVersion(),
    ]);
    return {
      docker: {
        serverVersion: String(info.ServerVersion ?? version.Version ?? 'unknown'),
        apiVersion: version.ApiVersion ?? null,
        composeVersion: compose,
        operatingSystem: String(info.OperatingSystem ?? 'unknown'),
        osType: String(info.OSType ?? 'unknown'),
        kernelVersion: String(info.KernelVersion ?? 'unknown'),
        architecture: String(info.Architecture ?? 'unknown'),
        cpus: Number(info.NCPU ?? 0),
        memoryBytes: Number(info.MemTotal ?? 0),
        storageDriver: info.Driver ? String(info.Driver) : null,
        rootDir: info.DockerRootDir ? String(info.DockerRootDir) : null,
      },
      dockerError: null,
    };
  } catch (error) {
    return { docker: null, dockerError: error instanceof Error ? error.message : String(error) };
  }
}

/** Maps Docker/Node architecture names to the OCI platform names (`amd64`, `arm64`, ...). */
export function normalizeArch(arch: string): string {
  const map: Record<string, string> = {
    x86_64: 'amd64',
    x64: 'amd64',
    aarch64: 'arm64',
    armv7l: 'arm',
  };
  return map[arch] ?? arch;
}
