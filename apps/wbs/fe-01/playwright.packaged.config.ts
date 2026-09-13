import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * The **built** fe-01, served by the image's own web server.
 *
 * A configuration of its own rather than a project inside
 * `playwright.config.ts`, because it shares nothing with that file: no be-01,
 * no gw-01, no Vite. What it starts is `caddy:2-alpine` over
 * `dist/apps/fe-01` with **`apps/fe-01/Caddyfile`** — the exact file
 * `apps/fe-01/Dockerfile` copies to `/etc/caddy/Caddyfile`, mounted rather
 * than transcribed, because a transcription is a second copy that can agree
 * with the first while both are wrong.
 *
 * It exists for one line of that file. `try_files {path} /index.html` is what
 * makes a reload on `/directory` work against a static server that holds no
 * file of that name, and the dev server serves the same fallback for free — so
 * `bun run e2e` proves exactly nothing about it. See
 * `docs/adr/0004-the-signed-in-region-gets-a-router.md`.
 */
const repoRoot = process.cwd();
if (!existsSync(join(repoRoot, 'apps', 'fe-01', 'playwright.packaged.config.ts'))) {
  throw new Error(
    `The packaged gate must be run from the workspace root; this is ${repoRoot}. ` +
      `Use \`nx run fe-01:e2e-packaged\`, which builds first.`,
  );
}

const site = join(repoRoot, 'dist', 'apps', 'fe-01');
if (!existsSync(join(site, 'index.html'))) {
  // The whole point is to measure the artifact, so an absent one is refused
  // rather than served as an empty directory that would 404 for a reason
  // having nothing to do with the fallback under test.
  throw new Error(`${site} holds no index.html; run \`bunx nx run fe-01:build\` first.`);
}

/**
 * A port nothing else in this repository claims.
 *
 * 4200/4201 are Vite's, 3100/3200 the two services', and the shifted set a
 * second checkout's. This one is only ever held for the length of one run.
 */
const PORT = 4341;

export default defineConfig({
  testDir: join(repoRoot, 'apps', 'fe-01', 'e2e-packaged'),
  outputDir: join(repoRoot, 'apps', 'fe-01', 'test-results-packaged'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // `--rm` so a failed run leaves nothing behind, and both mounts read-only:
      // this container may not write to the artifact it is measuring.
      command:
        `docker run --rm -p ${String(PORT)}:80 ` +
        `-v ${site}:/srv/www:ro ` +
        `-v ${join(repoRoot, 'apps', 'fe-01', 'Caddyfile')}:/etc/caddy/Caddyfile:ro ` +
        `caddy:2-alpine`,
      // The root, not `/directory`: waiting on the address under test would
      // make the wait itself the assertion, and a 404 there is exactly what
      // this run has to be able to observe.
      url: `http://localhost:${String(PORT)}/`,
      // Never true. A reused container is one built from a `dist/` this run did
      // not produce, which is `install`'s "checksums verified against the local
      // build" fault in a different hat.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    },
  ],
});
