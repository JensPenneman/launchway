import { expect, test } from '@playwright/test';

test('lists domains with their DNS status and route', async ({ page }) => {
  await page.goto('/domains');
  await expect(page.getByRole('row', { name: /trail\.example\.com/ })).toContainText('verified');
  await expect(page.getByRole('row', { name: /mail\.example\.dev/ })).toContainText(
    'misconfigured',
  );
  await expect(page.getByRole('row', { name: /status\.example\.org/ })).toContainText(
    'http://host.docker.internal:7878',
  );

  await page.getByRole('button', { name: 'Verify status.example.org' }).click();
  const result = page.getByTestId('verification-result');
  await expect(result).toContainText('DNS is not ready');
  await expect(result).toContainText('status.example.org CNAME home.example.com');
});

test('manages the records of a zone', async ({ page }) => {
  await page.goto('/domains?tab=zones');
  await page.getByRole('button', { name: 'example.dev' }).click();
  await expect(page.getByRole('row', { name: /mail\.example\.dev/ })).toBeVisible();

  await page.getByRole('button', { name: 'Add record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('_acme-challenge.example.dev');
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'TXT' }).click();
  await dialog.getByLabel('Content').fill('verification-token');
  await dialog.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByRole('row', { name: /_acme-challenge/ })).toContainText(
    'verification-token',
  );

  await page.getByRole('button', { name: 'Delete TXT _acme-challenge.example.dev' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete record' }).click();
  await expect(page.getByRole('row', { name: /_acme-challenge/ })).toHaveCount(0);
});

test('shows the dynamic DNS state', async ({ page }) => {
  await page.goto('/domains?tab=ddns');
  await expect(page.getByTestId('public-ipv4')).toHaveText('203.0.113.45');
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText(/Public IPv4 203\.0\.113\.45 unchanged/).first()).toBeVisible();
  await expect(page.getByText('unchanged', { exact: true })).toBeVisible();
});
