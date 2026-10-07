import { expect, test } from '@playwright/test';
import { MAIL_APP_ID, TRAIL_APP_ID } from './support.js';

test('lists apps', async ({ page }) => {
  await page.goto('/apps');
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole('row', { name: /Trail/ })).toContainText('running');
  await expect(page.getByRole('row', { name: /Mail server/ })).toContainText('not running');
});

test('creates an app through the wizard', async ({ page }) => {
  await page.goto('/apps/new');
  await page.getByRole('radio', { name: /Launchway \(example-org\)/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Search repositories').fill('status');
  await page.getByRole('radio', { name: /example-org\/status-page/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: /Dockerfile/ }).check();
  await expect(page.getByLabel('Build context')).toHaveValue('.');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByLabel('Name')).toHaveValue('status-page');
  await page.getByLabel('Name').fill('Status page');
  await page.getByRole('radio', { name: /nas/ }).check();
  await page.getByLabel('Deploy new releases automatically').click();
  await page.getByRole('button', { name: 'Create app' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Status page' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Deployments' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('deploys a release and follows the live log until it runs', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=deployments`);
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /v1\.4\.1/ }).check();
  await dialog.getByRole('button', { name: 'Deploy v1.4.1' }).click();

  const drawer = page.getByRole('dialog', { name: /Deployment v1\.4\.1/ });
  await expect(drawer).toBeVisible();
  const log = drawer.getByRole('log', { name: 'Log output' });
  await expect(log).toContainText('Queued v1.4.1 for trail');
  await expect(log).toContainText('All services are healthy', { timeout: 10_000 });
  await expect(drawer.getByTestId('log-state')).toContainText('Finished');
  await expect(drawer.getByText('running', { exact: true })).toBeVisible();

  const download = page.waitForEvent('download');
  await drawer.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('trail-v1.4.1.log');
});

test('edits environment variables and pastes a .env file', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=environment`);
  await expect(page.getByRole('row', { name: /DATABASE_URL/ })).toContainText('secret');

  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByRole('dialog').getByLabel('Key').fill('LOG_LEVEL');
  await page.getByRole('dialog').getByLabel('Value').fill('debug');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /LOG_LEVEL/ })).toContainText('debug');

  await page.getByRole('button', { name: 'Paste .env' }).click();
  const paste = page.getByRole('dialog');
  await paste
    .getByLabel('.env contents')
    .fill('# comment\nexport API_KEY="abc 123"\nNODE_ENV=staging\n');
  await expect(paste.getByText('2 variables, 1 overwrite existing keys')).toBeVisible();
  await paste.getByLabel('Mark all as secret').click();
  await paste.getByRole('button', { name: 'Save variables' }).click();
  await expect(page.getByRole('row', { name: /API_KEY/ })).toContainText('secret');
  await expect(page.getByRole('row', { name: /LOG_LEVEL/ })).toContainText('debug');
});

test('routes a new domain to a service and verifies it', async ({ page }) => {
  await page.goto(`/apps/${MAIL_APP_ID}?tab=domains`);
  await expect(page.getByText('No domains')).toBeVisible();
  await page.getByRole('button', { name: 'Add domain' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Host name').fill('webmail.example.dev');
  await dialog.getByLabel('Service').fill('roundcube');
  await dialog.getByLabel('Port').fill('8000');
  await dialog.getByRole('button', { name: 'Add domain' }).click();

  await expect(page.getByRole('link', { name: 'webmail.example.dev' })).toBeVisible();
  await expect(page.getByText('→ roundcube:8000')).toBeVisible();
  await page.getByRole('button', { name: 'Verify webmail.example.dev' }).click();
  await expect(page.getByTestId('verification-result')).toContainText('DNS points at Launchway');
});

test('deletes an app after typing its slug', async ({ page }) => {
  await page.goto(`/apps/${MAIL_APP_ID}?tab=danger`);
  await page.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Delete app' })).toBeDisabled();
  await confirm.getByLabel(/Type mailserver to confirm/).fill('mailserver');
  await confirm.getByRole('button', { name: 'Delete app' }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole('row', { name: /Mail server/ })).toHaveCount(0);
});

test('shows trusted mounts and lets an admin turn them off', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=settings`);
  await expect(page.getByText('trusted mounts', { exact: true })).toBeVisible();
  const toggle = page.getByRole('switch', { name: 'Trusted mounts' });
  await expect(toggle).toBeChecked();
  await expect(page.getByText('Trust only apps whose source you control.')).toBeVisible();

  await toggle.click();
  await expect(page.getByText('Trusted mounts disabled')).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('trusted mounts', { exact: true })).toHaveCount(0);
});

test('lists pull request previews and opens one by its number', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=previews`);
  const existing = page.getByRole('row', { name: /#42 Show elevation profiles/ });
  await expect(existing).toContainText('running');
  await expect(
    existing.getByRole('link', { name: /trail-pr-42\.preview\.example\.com/ }),
  ).toBeVisible();

  await page.getByLabel('Pull request number').fill('7');
  await page.getByRole('button', { name: 'Open preview' }).click();
  const opened = page.getByRole('row', { name: /#7 / });
  await expect(opened).toContainText('trail-pr-7.preview.example.com');
  await expect(opened).toContainText('running', { timeout: 10_000 });

  await opened.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close preview' }).click();
  await expect(opened).toContainText('closed');
});

test('saves the preview settings of an app', async ({ page }) => {
  await page.goto(`/apps/${TRAIL_APP_ID}?tab=settings`);
  const overrides = page.getByLabel('Environment overrides');
  await expect(overrides).toHaveValue('BASE_URL={{previewUrl}}');
  await overrides.fill('BASE_URL={{previewURL}}');
  await expect(page.getByText(/Unknown placeholder \{\{previewURL\}\}/)).toBeVisible();
  await overrides.fill('BASE_URL={{previewUrl}}\nDB_NAME=trail_{{prNumber}}');
  await expect(page.getByText('trail-pr-42.preview.example.com')).toBeVisible();
  await expect(page.getByLabel('Skip pull requests from bots')).toBeChecked();
  await page.getByLabel('Only pull requests with label').fill('preview');
  await page.getByRole('button', { name: 'Save preview settings' }).click();
  await expect(page.getByText('Preview settings saved')).toBeVisible();
});
