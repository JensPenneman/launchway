export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Advisory: warn (level 1) on unknown scopes, never block.
    'scope-enum': [
      1,
      'always',
      [
        'api',
        'checks',
        'agent',
        'web',
        'contracts',
        'tsconfig',
        'deploy',
        'ci',
        'deps',
        'docs',
        'release',
        'main',
      ],
    ],
  },
};
