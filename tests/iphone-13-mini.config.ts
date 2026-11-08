import { defineConfig } from '@playwright/test';
// @ts-expect-error Shared pinned WebKit runtime for CachyOS.
import { webkitOptions } from '../scripts/webkit.mjs';

export default defineConfig({
  testDir: '.', testMatch: 'iphone-13-mini.spec.ts', workers: 1,
  timeout: 45000, expect: { timeout: 15000 },
  outputDir: '../test-results/iphone-13-mini',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report/iphone-13-mini', open: 'never' }]],
  use: {
    browserName: 'webkit', launchOptions: webkitOptions(),
    colorScheme: 'light', serviceWorkers: 'block',
    trace: 'on', screenshot: 'only-on-failure',
  },
});
