import { expect, test } from '@playwright/test';

test('renders the shell, navigates and subscribes to live updates', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('API online · mock');
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-state', 'live');

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const label of ['Overview', 'Apps', 'Domains', 'Nodes', 'Settings', 'Audit log']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Apps' }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible();

  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'API tokens' })).toBeVisible();
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

test('uses a menu for navigation on small screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('menuitem', { name: 'Nodes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nodes' })).toBeVisible();
});
