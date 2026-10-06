import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Smoke tests against a production build that serves the API from MSW (`VITE_API_MOCK=1`,
 * fixtures in `src/mocks`). Built into `dist-e2e/` so the real `dist/` stays mock-free.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build --outDir dist-e2e --emptyOutDir && pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port ${PORT}`,
    env: { VITE_API_MOCK: '1' },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
