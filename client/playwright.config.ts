import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    headless: true,
    locale: 'ru-RU', // the specs look up Russian labels
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'],
    },
  },
});
