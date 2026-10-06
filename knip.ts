import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  compilers: {
    // Follow CSS @import statements, so packages imported from stylesheets count as used.
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join('\n'),
  },
  workspaces: {
    '.': {},
    'packages/contracts': {
      project: ['src/**/*.ts'],
    },
    'apps/api': {
      entry: ['scripts/*.ts'],
      project: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    },
    'apps/agent': {
      entry: ['src/healthcheck.ts'],
      project: ['src/**/*.ts'],
    },
    'apps/web': {
      // shadcn/ui components are vendored source: unused exports are expected.
      entry: ['src/routes/**/*.tsx', 'src/components/ui/*.tsx', 'src/lib/utils.ts'],
      project: ['src/**/*.{ts,tsx,css}', 'e2e/**/*.ts'],
    },
  },
  ignoreExportsUsedInFile: true,
};

export default config;
