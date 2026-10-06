import { expect, test } from '@playwright/test';
import { TRAIL_APP_ID, useScenario } from './support.js';

test('viewers get read-only pages without secrets or actions', async ({ page }) => {
  await useScenario(page, 'viewer');
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Apps' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New app' })).toHaveCount(0);

  await page.goto(`/apps/${TRAIL_APP_ID}?tab=environment`);
  await expect(page.getByRole('row', { name: /DATABASE_URL/ })).toContainText('secret');
  await expect(page.getByRole('button', { name: 'Add variable' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Danger zone' })).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByRole('tab', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'API tokens' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Platform' })).toHaveCount(0);
});
