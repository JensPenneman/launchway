import { type AppChecksSettings, DEFAULT_APP_CHECKS_SETTINGS } from '@launchway/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ChecksForm,
  newCheckItem,
  parseChecksForm,
  scheduleHint,
  toChecksForm,
} from './checks-form';

const SETTINGS: AppChecksSettings = {
  enabled: true,
  composeFiles: ['.devcontainer/compose.yaml', '.devcontainer/compose.ci.yaml'],
  branches: ['main', 'release'],
  skipBots: true,
  schedule: '0 6 * * 1',
  items: [
    { name: 'quality', command: 'pnpm check', service: 'dev', timeoutMinutes: 30 },
    {
      name: 'e2e',
      command: 'pnpm test:e2e',
      service: 'browser',
      timeoutMinutes: 45,
      composeFile: '.devcontainer/compose.e2e.yaml',
    },
  ],
};

function form(patch: Partial<ChecksForm> = {}): ChecksForm {
  return { ...toChecksForm(SETTINGS), ...patch };
}

describe('toChecksForm', () => {
  it('turns the settings into input texts', () => {
    expect(toChecksForm(SETTINGS)).toEqual({
      enabled: true,
      composeFiles: '.devcontainer/compose.yaml\n.devcontainer/compose.ci.yaml',
      branches: 'main, release',
      skipBots: true,
      schedule: '0 6 * * 1',
      items: [
        {
          name: 'quality',
          command: 'pnpm check',
          service: 'dev',
          timeoutMinutes: '30',
          composeFile: '',
        },
        {
          name: 'e2e',
          command: 'pnpm test:e2e',
          service: 'browser',
          timeoutMinutes: '45',
          composeFile: '.devcontainer/compose.e2e.yaml',
        },
      ],
    });
  });

  it('shows "every branch" as an empty list', () => {
    expect(toChecksForm(DEFAULT_APP_CHECKS_SETTINGS).branches).toBe('');
  });
});

describe('parseChecksForm', () => {
  it('reads the form back into the same settings', () => {
    expect(parseChecksForm(toChecksForm(SETTINGS))).toEqual({ success: true, data: SETTINGS });
  });

  it('accepts lists with commas, spaces and blank lines and trims the inputs', () => {
    const result = parseChecksForm(
      form({
        composeFiles: '  .devcontainer/compose.yaml \n\n',
        branches: 'main,  develop\nrelease',
        items: [
          {
            name: ' lint ',
            command: '  pnpm lint  ',
            service: ' ',
            timeoutMinutes: '',
            composeFile: ' ',
          },
        ],
      }),
    );
    expect(result).toEqual({
      success: true,
      data: {
        enabled: true,
        composeFiles: ['.devcontainer/compose.yaml'],
        branches: ['main', 'develop', 'release'],
        skipBots: true,
        schedule: '0 6 * * 1',
        // Empty service and timeout take the defaults; no Compose file of its own.
        items: [{ name: 'lint', command: 'pnpm lint', service: 'dev', timeoutMinutes: 30 }],
      },
    });
  });

  it('sends null branches (every branch) and an empty list of checks', () => {
    const result = parseChecksForm(form({ branches: '  ', items: [] }));
    expect(result.success && result.data).toMatchObject({ branches: null, items: [] });
  });

  it('sends an empty schedule as none and refuses one that runs more than hourly', () => {
    expect(parseChecksForm(form({ schedule: '  ' }))).toMatchObject({
      success: true,
      data: { schedule: null },
    });
    expect(parseChecksForm(form({ schedule: '*/10 * * * *' }))).toEqual({
      success: false,
      errors: { schedule: 'Use one minute (0-59): scheduled checks run at most once an hour' },
    });
  });

  it('tells when a schedule runs next, in UTC', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(scheduleHint('0 6 * * 1', now)).toBe(
      'Next run Mon, 2 Nov 2026, 06:00 UTC, for the head of the default branch, whether or not pushes run the checks; GitHub shows them as launchway/<name>/schedule.',
    );
    expect(scheduleHint('', now)).toMatch(/^Optional: a cron expression/);
    expect(scheduleHint('0 6 * *', now)).toBe('minute hour day-of-month month day-of-week, in UTC');
  });

  it('starts new checks with the default service and timeout', () => {
    expect(newCheckItem()).toEqual({
      name: '',
      command: '',
      service: 'dev',
      timeoutMinutes: '30',
      composeFile: '',
    });
  });

  it('reports errors by form path', () => {
    const result = parseChecksForm(
      form({
        composeFiles: '',
        branches: 'main -bad',
        items: [
          { ...newCheckItem(), name: 'Quality', command: ' ', timeoutMinutes: '121' },
          { ...newCheckItem(), name: 'unit', command: 'pnpm test', service: 'Dev' },
          { ...newCheckItem(), name: 'e2e', command: 'x', composeFile: '/etc/compose.yaml' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual({
      composeFiles: 'Enter at least one Compose file',
      branches: '-bad: Must match ^[A-Za-z0-9._/-]+$ and must not start with -',
      'items.0.name':
        'Use 1-39 lowercase letters, digits and dashes, starting with a letter or digit',
      'items.0.command': 'Required',
      'items.0.timeoutMinutes': 'Must be at most 120',
      'items.1.service': 'Must be a lowercase Compose service name',
      'items.2.composeFile': 'Must be a relative path inside the repository',
    });
  });

  it('marks every check whose name is repeated', () => {
    const item = { ...newCheckItem(), name: 'test', command: 'pnpm test' };
    const result = parseChecksForm(form({ items: [item, { ...item, command: 'npm test' }] }));
    expect(result).toEqual({
      success: false,
      errors: {
        'items.0.name': 'Another check has this name',
        'items.1.name': 'Another check has this name',
      },
    });
  });

  it('rejects repeated branches and too many Compose files', () => {
    const result = parseChecksForm(
      form({
        branches: 'main main',
        composeFiles: Array.from({ length: 11 }, (_, n) => `compose.${n}.yaml`).join('\n'),
      }),
    );
    expect(result.success === false && result.errors).toEqual({
      branches: 'Branch names must be unique',
      composeFiles: 'Must be at most 10',
    });
  });

  it('asks for whole minutes', () => {
    const result = parseChecksForm(
      form({ items: [{ ...newCheckItem(), name: 'a', command: 'x', timeoutMinutes: '1.5' }] }),
    );
    expect(result.success === false && result.errors).toEqual({
      'items.0.timeoutMinutes': 'Enter whole minutes',
    });
  });
});
