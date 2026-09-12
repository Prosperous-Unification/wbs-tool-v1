import { defineConfig, devices } from '@playwright/test';

// Proof: an unused declaration in this root config made `core:lint` fail here
// with `@typescript-eslint/no-unused-vars`, proving the explicit lint input.
export default defineConfig({
  testDir: './testing',
  testMatch: 'portable-composition.spec.ts',
  outputDir: '../../tmp/core-portable-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
