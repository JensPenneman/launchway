import { expect, test } from '@playwright/test';

test('filters the audit log and loads older events', async ({ page }) => {
  await page.goto('/audit');
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(51); // header + first page of 50
  await page.getByRole('button', { name: 'Load older events' }).click();
  await expect(rows).toHaveCount(65);

  await page.getByLabel('Filter by action').fill('settings.update');
  await expect(rows).toHaveCount(8);
  await page.getByRole('button', { name: 'Show details' }).first().click();
  await expect(page.getByText('"acmeEmail"')).toBeVisible();
});
