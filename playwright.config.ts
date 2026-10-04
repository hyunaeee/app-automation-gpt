import { defineConfig, devices } from '@playwright/test';

const port=Number(process.env.PLAYWRIGHT_PORT||3001);
const baseURL=`http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    },
  }],
  webServer: {
    command: 'node server/index.mjs',
    url: `${baseURL}/api/config`,
    reuseExistingServer: !process.env.CI,
    env: { AI_PROVIDER:'openai', OPENAI_API_KEY: '', PORT:String(port), DATA_DIR: '.data/e2e' },
  },
});
