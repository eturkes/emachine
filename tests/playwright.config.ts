import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export default defineConfig({
  testDir: '.', testMatch: ['client.spec.ts', 'terminal-touch.spec.ts', 'terminal-resize.spec.ts'], workers: 1,
  timeout: 45000, expect: { timeout: 15000 }, reporter: 'list',
  outputDir: '../test-results/browser',
  use: {
    headless: true, viewport: { width: 1360, height: 900 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { executablePath: execFileSync('chromiumfish', ['path'], { encoding: 'utf8' }).trim() },
  },
});
