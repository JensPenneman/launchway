import { expect, test } from '@playwright/test';
import { EDGE_NODE_ID } from './support.js';

test('adds a node and shows its one-time join snippet', async ({ page }) => {
  await page.goto('/nodes');
  await expect(page.getByRole('row', { name: /pi-garage/ })).toContainText('offline');
  await page.getByRole('button', { name: 'Add node' }).first().click();
  await page.getByRole('dialog').getByLabel('Name').fill('attic-nuc');
  await page.getByRole('button', { name: 'Create join token' }).click();

  const join = page.getByTestId('join-instructions');
  await expect(join).toContainText('docker run -d --name launchway-agent');
  await expect(join).toContainText('LAUNCHWAY_JOIN_TOKEN=lwyn_');
  await page.getByRole('tab', { name: 'Compose' }).click();
  await expect(join).toContainText('launchway-agent:');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /attic-nuc/ })).toContainText('pending');
});

test('shows node details with Docker facts', async ({ page }) => {
  await page.goto(`/nodes/${EDGE_NODE_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('edge-01');
  await expect(page.getByTestId('docker-info')).toContainText('28.4.0');
  await expect(page.getByTestId('docker-info')).toContainText('32 GiB');
  await expect(page.getByRole('link', { name: 'Trail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make edge' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rotate' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate' }).click();
  await expect(page.getByText('New credential delivered to the agent')).toBeVisible();
});
