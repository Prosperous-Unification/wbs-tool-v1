import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * The repository root, which is where this config has to be run from.
 *
 * Relative paths in a Playwright config resolve against the config file for
 * some options and against the process's working directory for others — and
 * `webServer.cwd` is the second kind, which is the one that decides which
 * `.env` three servers read. Rather than guess, the working directory is
 * pinned: `bun run e2e` and `nx run fe-01:e2e` both run from the workspace
 * root, and anything else is refused here instead of starting a stack against
 * the wrong directory and failing forty seconds later on a signup 502.
 */
const repoRoot = process.cwd();
if (!existsSync(join(repoRoot, 'apps', 'fe-01', 'playwright.config.ts'))) {
  throw new Error(
    `The layout gate must be run from the workspace root; this is ${repoRoot}. ` +
      `Use \`bun run e2e\` (or \`nx run fe-01:e2e\`), never \`bunx playwright test\` ` +
      `from inside apps/fe-01 — the three dev servers are started relative to this path.`,
  );
}

const isCi = process.env['CI'] !== undefined;

/**
 * A SQLite file this run alone will ever open.
 *
 * Never `apps/be-01/local.db`. The spec signs up a throwaway account and
 * writes a plan through the UI, and doing that to a developer's own dev
 * database means their projects list grows a new "New project" on every run —
 * and, worse, that a fault only reproducible against *their* leftover state
 * would look like a gate that fails for one person. `tmp/` is gitignored, and
 * so is `*.db`.
 */
const runDatabase = join(repoRoot, 'tmp', `e2e-${String(Date.now())}.db`);
mkdirSync(join(repoRoot, 'tmp'), { recursive: true });

/**
 * One of the three servers under test, started from its own directory.
 *
 * `cwd` is load-bearing rather than tidy: bun reads the `.env` beside the
 * process's working directory, which is how each app gets its secrets, its
 * port, and — for gw-01 and be-01 — the shared signing key they have to agree
 * on. `env` here still wins over that file: a variable already in the
 * environment is not overwritten by a `.env` (checked against bun 1.3.14),
 * which is what makes the database override below effective.
 */
const server = (app: string, command: string, url: string, env?: Record<string, string>) => ({
  command,
  cwd: join(repoRoot, 'apps', app),
  url,
  env,
  // Fresh state in CI, and a running `bun run dev` reused locally. Playwright
  // waits for 2xx/3xx here, so be-01's 503 `{status:"migrating"}` and gw-01's
  // 503 `{status:"backend_unhealthy"}` both read as "not ready yet" rather
  // than as a server that is up — which is the whole reason all three URLs are
  // waited on instead of only Vite's. A signup against a be-01 that has not
  // migrated is a 500 the spec would report as a broken table.
  reuseExistingServer: !isCi,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
});

export default defineConfig({
  testDir: './e2e',
  // Named explicitly because CI uploads this exact path as the run's artifact,
  // and the screenshot the widths are judged from is written into it.
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCi,
  // Zero, deliberately. `.github/workflows/ci.yml` rules a retry out of the
  // gate for a reason that applies here twice over: a layout check people
  // re-run until it is green is a check that cannot fail wearing a different
  // hat. A flake in this spec is a bug in this spec.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCi
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL: 'http://localhost:4200',
    screenshot: 'only-on-failure',
    // On, not on-failure: the first runs of this gate are the ones nobody can
    // reproduce locally — there is no browser on the machine it was written on
    // — so a trace with DOM snapshots is the difference between one CI round
    // trip and five.
    trace: 'on',
    video: 'off',
  },
  // Chromium only. One engine that can lay a table out is the whole ask; three
  // would be three times the runtime for a check about this application's
  // geometry rather than about browser differences.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // After the spread, not in the top-level `use`: a project's options
        // win over the file's, and `Desktop Chrome` carries a 1280x720
        // viewport of its own that would silently replace this one.
        //
        // The default for tests that do not care, and the screenshot the
        // widths are judged by. Since 2026-08-08 the table is `width: 100%`
        // with a minimum of about 1106px for a two-role plan, so nothing
        // scrolls sideways here at all — the tests that need a scrolling frame
        // set their own narrow viewport, and the matrix sets 1280 and 1512.
        viewport: { width: 1400, height: 900 },
      },
    },
  ],
  webServer: [
    server('be-01', 'bun src/main.ts', 'http://localhost:3100/health', {
      DB_PATH: runDatabase,
      // Stated rather than inherited from `.env.example`: this file is brand
      // new, so it holds no schema at all, and a developer who turned startup
      // migration off locally would otherwise get a stack that boots and 500s
      // on the first write.
      MIGRATE_ON_STARTUP: 'true',
    }),
    server('gw-01', 'bun src/main.ts', 'http://localhost:3200/health'),
    server('fe-01', 'bunx vite', 'http://localhost:4200'),
  ],
});
