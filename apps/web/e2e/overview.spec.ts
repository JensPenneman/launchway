import { expect, test } from '@playwright/test';

test('shows nodes, apps with their running release, deployments and domain problems', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('stat-nodes')).toHaveText('2/3');
  await expect(page.getByTestId('stat-apps')).toHaveText('2/3');
  await expect(page.getByTestId('stat-domains')).toHaveText('2');
  await expect(page.getByTestId('stat-previews')).toHaveText('1');

  await expect(page.getByRole('link', { name: 'Trail' }).first()).toBeVisible();
  await expect(page.getByText('v1.4.2').first()).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Recent deployments' }).getByRole('listitem'),
  ).toHaveCount(7);
  await expect(page.getByText('mail.example.dev')).toBeVisible();
  await expect(
    page.getByText('Resolves to 198.51.100.7, expected CNAME home.example.com'),
  ).toBeVisible();
});
