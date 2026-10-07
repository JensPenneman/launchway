import { expect, test } from '@playwright/test';
import { INVITATION_TOKEN, MOCK_PASSWORD, useScenario } from './support.js';

test('first run: the setup wizard creates the owner and saves the platform URL', async ({
  page,
}) => {
  await useScenario(page, 'fresh');
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Launchway' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  await page.getByLabel('Name').fill('Dana Owner');
  await page.getByLabel('E-mail').fill('dana@example.com');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByLabel('Confirm password').fill('short');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByText('Must be at least 12 characters')).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill(MOCK_PASSWORD);
  await page.getByLabel('Confirm password').fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();

  await expect(page.getByLabel('Platform URL')).toHaveValue(/^http:\/\/127\.0\.0\.1/);
  await page.getByLabel('Platform URL').fill('https://deploy.example.net');
  await expect(page.getByLabel("Let's Encrypt e-mail")).toHaveValue('dana@example.com');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByText('Launchway is ready.')).toBeVisible();
  await page.getByRole('link', { name: 'Go to the overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('sign-in leads with passkeys and falls back to the password form', async ({ page }) => {
  await useScenario(page, 'signed-out');
  await page.goto('/nodes');
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fnodes$/);
  const passkey = page.getByRole('button', { name: 'Sign in with a passkey' });
  const password = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(passkey).toBeVisible();
  expect((await passkey.boundingBox())?.y).toBeLessThan((await password.boundingBox())?.y ?? 0);

  await page.getByLabel('E-mail').fill('alex@example.com');
  await page.getByLabel('Password').fill('wrong password');
  await password.click();
  await expect(page.getByText('The e-mail or password is incorrect.')).toBeVisible();

  await page.getByLabel('Password').fill(MOCK_PASSWORD);
  await password.click();
  await expect(page).toHaveURL(/\/nodes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Nodes' })).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('an invitation link creates the account', async ({ page }) => {
  await useScenario(page, 'signed-out');
  await page.goto(`/invite#${INVITATION_TOKEN}`);
  await expect(page.getByText('You were invited as member.')).toBeVisible();
  await page.getByLabel('Name').fill('Jo Newcomer');
  await page.getByLabel('E-mail').fill('jo@example.com');
  await page.getByLabel('Password (optional)').fill(MOCK_PASSWORD);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('an expired invitation explains what to do', async ({ page }) => {
  await useScenario(page, 'signed-out');
  await page.goto(`/invite/lwyi_${'b'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'Invitation unavailable' })).toBeVisible();
});
