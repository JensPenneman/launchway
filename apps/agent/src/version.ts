import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** Agent version: the image build version when set, otherwise the package version. */
export const AGENT_VERSION: string = process.env.SLIPWAY_BUILD_VERSION || pkg.version;
