import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health/live', (route) =>
    route.fulfill({ json: { status: 'ok', version: 'e2e' } }),
  );
});

test('renders the app shell and navigates between pages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('Online, version e2e');

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const label of ['Overview', 'Apps', 'Domains', 'Nodes', 'Settings', 'Audit log']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }

  await nav.getByRole('link', { name: 'Apps' }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible();

  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('API tokens')).toBeVisible();
});

test('switches to the dark theme and remembers it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('shows the setup page without the app shell', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Set up Slipway' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});
