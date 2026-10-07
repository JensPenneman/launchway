import { expect, test } from '@playwright/test';

test('creates an API token and shows it once', async ({ page }) => {
  await page.goto('/settings?tab=tokens');
  await expect(page.getByRole('row', { name: /GitHub Actions deploy/ })).toBeVisible();
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Backup script');
  await dialog.getByLabel('write').check();
  await dialog.getByRole('button', { name: 'Create token' }).click();
  await expect(dialog.getByText(/^lwy_[0-9A-Za-z]{43}$/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /Backup script/ })).toContainText('write');
});

test('invites a user and changes a role', async ({ page }) => {
  await page.goto('/settings?tab=users');
  await page.getByRole('button', { name: 'Invite' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('dialog').getByText(/\/invite#lwyi_/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('list', { name: 'Open invitations' }).getByRole('listitem'),
  ).toHaveCount(2);

  await page.getByRole('combobox', { name: 'Role of Kim Laurent' }).click();
  await page.getByRole('option', { name: 'viewer' }).click();
  await expect(page.getByText('Role changed')).toBeVisible();
});

test('renders the DNS provider form from its JSON Schema', async ({ page }) => {
  await page.goto('/settings?tab=dns');
  await page.getByRole('button', { name: 'Add provider account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Cloudflare' }).click();
  await expect(dialog.getByLabel('API token')).toHaveAttribute('type', 'password');
  await expect(dialog.getByLabel('Account ID (optional)')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add account' })).toBeDisabled();
  await dialog.getByLabel('Name').fill('Cloudflare (work)');
  await dialog.getByLabel('API token').fill('cf-token-value');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('list', { name: 'DNS provider accounts' })).toContainText(
    'Cloudflare (work)',
  );
});

test('connects GitHub with a token and offers the GitHub App flow', async ({ page }) => {
  await page.goto('/settings?tab=github');
  await expect(page.getByRole('button', { name: 'Create GitHub App' })).toBeVisible();
  await page.getByRole('button', { name: 'Add token' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Side projects');
  await dialog.getByLabel('Token').fill('not-a-token');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog.getByText('Must be a GitHub token')).toBeVisible();
  await dialog.getByLabel('Token').fill(`github_pat_${'A'.repeat(30)}`);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('list', { name: 'GitHub connections' })).toContainText(
    'Side projects',
  );
});

test('lands on the GitHub tab after the GitHub App callbacks', async ({ page }) => {
  await page.goto('/settings/github?connection=gh_01k70000000000000000000001');
  await expect(page).toHaveURL(/\/settings\?tab=github$/);
  await expect(page.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
});

test('saves platform settings and shows the rendered Caddyfile', async ({ page }) => {
  await page.goto('/settings?tab=platform');
  await page.getByLabel('Public URL').fill('not a url');
  await page.getByRole('button', { name: 'Save platform settings' }).click();
  await expect(page.getByText('Enter a valid URL')).toBeVisible();
  await page.getByLabel('Public URL').fill('https://ops.example.com/path');
  await page.getByRole('button', { name: 'Save platform settings' }).click();
  await expect(page.getByText(/Must be an origin such as/)).toBeVisible();
  await page.getByLabel('Public URL').fill('https://ops.example.com');
  await page.getByRole('button', { name: 'Save platform settings' }).click();
  await expect(page.getByText('Platform settings saved')).toBeVisible();

  await page.getByRole('tab', { name: 'Edge' }).click();
  await expect(page.getByTestId('caddyfile')).toContainText('ops.example.com {');
  await expect(page.getByTestId('caddyfile')).toContainText('reverse_proxy trail-web:8080');
});

test('shows passkeys and sessions on the account page', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('list', { name: 'Passkeys' })).toContainText('MacBook Touch ID');
  await expect(page.getByRole('list', { name: 'Sessions' })).toContainText('Safari on macOS');
  await page.getByRole('button', { name: 'Rename YubiKey 5C' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Office key');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' })).toContainText('Office key');
});
