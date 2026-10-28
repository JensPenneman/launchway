import { expect, type Page, test } from '@playwright/test';
import {
  FAILED_CHECK_RUN_ID,
  MAIL_APP_ID,
  RUNNING_CHECK_RUN_ID,
  TRAIL_APP_ID,
  useScenario,
} from './support.js';

const runRow = (page: Page, name: string, text: string) =>
  page
    .getByRole('row')
    .filter({ hasText: `launchway/${name}` })
    .filter({ hasText: text });

test('lists the check runs of an app page by page and filters them', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}`);
  await page.getByRole('tab', { name: 'Checks' }).click();
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(21); // header + first page of 20
  await expect(runRow(page, 'quality', 'PR #42')).toContainText('running');
  await expect(runRow(page, 'e2e', 'failed')).toContainText('main');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(34);

  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'failed' }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Filter by check' }).click();
  await page.getByRole('option', { name: 'test' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('launchway/test');
});

test('shows where queued runs wait and which result a same-tree run reused', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks`);
  await expect(runRow(page, 'test', 'PR #42')).toContainText('behind 1 run');
  await expect(runRow(page, 'e2e', 'PR #42')).toContainText('behind 2 runs');
  const copy = runRow(page, 'test', 'main').filter({ hasText: 'same tree' }).first();
  await copy.getByRole('button', { name: 'Logs' }).click();
  const drawer = page.getByRole('dialog', { name: /Check test/ });
  await expect(drawer).toContainText(/Same tree as [0-9a-f]{7}, passed in 3m 12s/);
  await expect(drawer).toContainText(
    'No output: this run reused the result of a run of the same tree',
  );
  await drawer.getByRole('button', { name: 'The run of the same tree' }).click();
  await expect(drawer.getByRole('log', { name: 'Log output' })).toContainText('Test Files');
});

test('opens the log of a run from the list and from its URL', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks`);
  await runRow(page, 'e2e', 'failed').getByRole('button', { name: 'Logs' }).click();
  await expect(page).toHaveURL(new RegExp(`check=${FAILED_CHECK_RUN_ID}`));
  const drawer = page.getByRole('dialog', { name: /Check e2e/ });
  await expect(drawer.getByRole('log', { name: 'Log output' })).toContainText(
    'draws the elevation profile',
  );
  await expect(drawer.getByTestId('log-state')).toContainText('Finished');
  await expect(drawer).toContainText('pnpm install --frozen-lockfile && pnpm exec playwright test');
  await expect(drawer).toContainText('The command exited with code 1');
  await expect(drawer.getByText('failure', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/check=/);

  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks&check=${RUNNING_CHECK_RUN_ID}`);
  const running = page.getByRole('dialog', { name: /Check quality/ });
  await expect(running.getByRole('log', { name: 'Log output' })).toContainText('biome check');
  await expect(running.getByTestId('log-state')).toContainText('Live');
  await expect(running.getByRole('button', { name: 'Cancel check' })).toBeVisible();
});

test('runs a check by hand and follows it until it passes', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks`);
  await page.getByRole('button', { name: 'Run checks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run the checks of Trail' });
  await expect(dialog.getByRole('button', { name: 'Run 3 checks' })).toBeDisabled();
  await dialog.getByLabel('Branch, tag or commit').fill('main');
  await dialog.getByRole('checkbox', { name: 'test', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'e2e', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Run quality' }).click();

  const drawer = page.getByRole('dialog', { name: /Check quality/ });
  const log = drawer.getByRole('log', { name: 'Log output' });
  await expect(log).toContainText('Exited with code 0', { timeout: 10_000 });
  await expect(drawer.getByTestId('log-state')).toContainText('Finished');
  await expect(drawer).toContainText('The command exited with code 0');
  await expect(drawer.getByText('success', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  const newest = page.getByRole('row').nth(1);
  await expect(newest).toContainText('launchway/quality');
  await expect(newest).toContainText('manual');
  await expect(newest).toContainText('succeeded');
});

test('cancels a running check and runs it again', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks`);
  await runRow(page, 'quality', 'running').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel check' }).click();
  await expect(page.getByText('quality cancelled')).toBeVisible();

  const pullRequestRuns = runRow(page, 'quality', 'PR #42');
  await expect(pullRequestRuns).toContainText('cancelled');
  await pullRequestRuns.getByRole('button', { name: 'Re-run' }).click();
  await expect(page.getByText(/^Re-running quality on/)).toBeVisible();
  await expect(pullRequestRuns).toHaveCount(2);
  await expect(pullRequestRuns.first()).toContainText('succeeded', { timeout: 10_000 });
  await expect(pullRequestRuns.last()).toContainText('cancelled');
});

test('configures the checks of an app in its settings', async ({ page }) => {
  await page.goto(`/apps/${MAIL_APP_ID}?tab=checks`);
  await expect(page.getByText('No checks configured')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run checks' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Configure checks' }).click();
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const form = page.getByRole('form', { name: 'Check settings' });
  await expect(form.getByLabel('Compose files of the checks')).toHaveValue(
    '.devcontainer/compose.yaml',
  );
  await form.getByRole('button', { name: 'Add check' }).click();
  const check = form.getByRole('group', { name: 'Check 1' });
  await check.getByLabel('Name', { exact: true }).fill('Lint');
  await check.getByLabel('Command', { exact: true }).fill('npm ci && npm run lint');
  await expect(check.getByText(/^Use 1-39 lowercase letters/)).toBeVisible();
  await check.getByLabel('Name', { exact: true }).fill('lint');
  await expect(check).toContainText('launchway/lint');
  await expect(check.getByLabel('Service', { exact: true })).toHaveValue('dev');
  await expect(check.getByLabel('Timeout (minutes)', { exact: true })).toHaveValue('30');

  await form.getByRole('button', { name: 'Add check' }).click();
  const second = form.getByRole('group', { name: 'Check 2' });
  await second.getByLabel('Name', { exact: true }).fill('lint');
  await second.getByLabel('Command', { exact: true }).fill('npm test');
  await expect(second.getByText('Another check has this name')).toBeVisible();
  await second.getByLabel('Name', { exact: true }).fill('unit');
  await second.getByLabel('Timeout (minutes)', { exact: true }).fill('10');

  await form.getByLabel('Branches').fill('main, release');
  await form.getByLabel('Schedule (UTC)').fill('*/10 * * * *');
  await form.getByLabel('Schedule (UTC)').blur();
  await expect(form.getByText(/at most once an hour/)).toBeVisible();
  await form.getByLabel('Schedule (UTC)').fill('0 6 * * 1');
  await expect(
    form.getByText(/^Next run .* UTC, for the head of the default branch/),
  ).toBeVisible();
  await form.getByLabel('Run checks for pushes and pull requests').click();
  await form.getByRole('button', { name: 'Save check settings' }).click();
  await expect(page.getByText('Check settings saved')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save check settings' })).toBeDisabled();
  await expect(form.getByLabel('Branches')).toHaveValue('main, release');

  await page.getByRole('tab', { name: 'Checks' }).click();
  await expect(page.getByText('No check runs yet')).toBeVisible();
  await page.getByRole('button', { name: 'Run checks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run the checks of Mail server' });
  await expect(dialog.getByRole('checkbox', { name: 'lint', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'unit', exact: true })).toBeChecked();
});

test('viewers see the runs and their logs without actions', async ({ page }) => {
  await useScenario(page, 'viewer');
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=checks`);
  await expect(page.getByRole('row')).toHaveCount(21);
  await expect(page.getByRole('button', { name: 'Run checks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Re-run' })).toHaveCount(0);

  await runRow(page, 'e2e', 'failed').getByRole('button', { name: 'Logs' }).click();
  const drawer = page.getByRole('dialog', { name: /Check e2e/ });
  await expect(drawer.getByRole('log', { name: 'Log output' })).toContainText(
    'draws the elevation profile',
  );
  await expect(drawer.getByRole('button', { name: 'Re-run' })).toHaveCount(0);
});

test('saves the platform limits of checks', async ({ page }) => {
  await page.goto('/settings?tab=platform');
  const cpus = page.getByLabel('CPUs', { exact: true });
  await expect(cpus).toHaveValue('2');
  await cpus.fill('1.3');
  await expect(page.getByText('Must be a multiple of 0.25')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save check limits' })).toBeDisabled();
  await cpus.fill('1.5');
  await page.getByLabel('Memory (MiB)').fill('8192');
  await expect(page.getByText('2 services × 8.0 GiB = 16 GiB')).toBeVisible();
  const perApp = page.getByLabel('Queued per app');
  await expect(perApp).toHaveValue('30');
  await expect(page.getByLabel('Queued per node')).toHaveValue('100');
  // At least 10, the most checks an app may have: a commit queues all its checks or none.
  await perApp.fill('9');
  await expect(page.getByText('Must be at least 10')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save check limits' })).toBeDisabled();
  await perApp.fill('12');
  await page.getByRole('button', { name: 'Save check limits' }).click();
  await expect(page.getByText('Check limits saved')).toBeVisible();
});

test('shows whether a GitHub connection can report checks', async ({ page }) => {
  await page.goto('/settings?tab=github');
  const app = page.getByRole('status', { name: 'GitHub permissions of Launchway (example-org)' });
  await expect(app).toContainText('Grant in GitHub to show deployments and check results there');
  await expect(app.getByRole('list', { name: 'Missing on GitHub' })).toContainText(
    'statuses: write',
  );
  await expect(app).toContainText('Commit statuses to Read and write');
  await expect(
    page.getByText(
      'Deployments show on GitHub; pull requests can be previewed; checks report to GitHub as commit statuses.',
    ),
  ).toBeVisible();
});
