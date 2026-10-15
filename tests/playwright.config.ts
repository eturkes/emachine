import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Shared pinned WebKit runtime for the iOS input contract.
import { webkitOptions } from '../scripts/webkit.mjs';

export default defineConfig({
  testDir: '.', testMatch: ['client.spec.ts', 'projects.spec.ts', 'terminal-touch.spec.ts', 'terminal-resize.spec.ts', 'terminal-clipboard.spec.ts', 'terminal-input.spec.ts'], workers: 1,
  timeout: 45000, expect: { timeout: 15000 }, reporter: 'list',
  outputDir: '../test-results/browser',
  projects: [
    { name: 'chromium', use: { launchOptions: { executablePath: execFileSync('chromiumfish', ['path'], { encoding: 'utf8' }).trim() } } },
    { name: 'webkit-input', testMatch: 'terminal-input.spec.ts', use: { browserName: 'webkit', launchOptions: webkitOptions() } },
  ],
  use: {
    headless: true, viewport: { width: 1360, height: 900 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
