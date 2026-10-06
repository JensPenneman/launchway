import type { Page } from '@playwright/test';

/** Password of every user in the mock API (`src/mocks/handlers/auth.ts`). */
export const MOCK_PASSWORD = 'correct horse battery staple';

/** IDs of mock fixtures (`src/mocks/fixtures.ts`). */
export const TRAIL_APP_ID = `app_01k7${'1'.padStart(22, '0')}`;
export const MAIL_APP_ID = `app_01k7${'3'.padStart(22, '0')}`;
export const EDGE_NODE_ID = `node_01k7${'1'.padStart(22, '0')}`;
export const INVITATION_TOKEN = `slpi_${'a'.repeat(43)}`;

type Scenario = 'default' | 'fresh' | 'signed-out' | 'viewer';

/** Picks the mock API scenario before the app boots. */
export async function useScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('slipway-mock-scenario', value);
  }, scenario);
}
