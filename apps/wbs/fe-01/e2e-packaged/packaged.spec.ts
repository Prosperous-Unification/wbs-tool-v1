import { expect, type Page, test } from '@playwright/test';

/**
 * The packaged deep link: `/directory` asked of the built site, served by the
 * image's own web server.
 *
 * A directory of its own so the ordinary browser gate cannot pick it up:
 * `playwright.config.ts` starts three dev servers and knows nothing about a
 * Caddy on 4341, and this file starts no be-01 at all.
 *
 * What is under test is **one line of `apps/fe-01/Caddyfile`** —
 * `try_files {path} /index.html`. The static server holds no file called
 * `directory`, so without it a reload on the address this change introduced
 * answers 404 and the reader gets Caddy's not-found page instead of the app.
 * Vite serves that fallback for free, which is why no other spec in this
 * repository can see the fault.
 */

/** A session that never reached be-01, and the two reads the page makes. */
async function signedIn(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'u1', username: 'kat', scopes: ['read', 'write', 'editor'] },
      }),
    }),
  );
  await page.route('**/api/people', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        people: [{ id: 'p1', name: 'Kat', kind: 'person', teamIds: [] }],
      }),
    }),
  );
  await page.route('**/api/teams', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ teams: [] }),
    }),
  );
  for (const [path, body] of [
    ['tags', { tags: [] }],
    ['services', { services: [] }],
    ['work-item-types', { workItemTypes: [] }],
  ] as const) {
    await page.route(`**/api/${path}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    );
  }
  // The API is stubbed and the **serving** is the image's, which is the split
  // this file is for: nothing here claims anything about be-01, and everything
  // here claims something about the static server in front of the build.
  await page.addInitScript(() => {
    localStorage.setItem(
      'wbs.session',
      JSON.stringify({
        token: 'packaged',
        user: { id: 'u1', username: 'kat', scopes: ['read', 'write', 'editor'] },
      }),
    );
  });
}

test.describe('the built site, asked for an address it holds no file for', () => {
  test('answers the application rather than a not-found page', async ({ request }) => {
    const answered = await request.get('/directory');

    expect(answered.status(), 'the static server has no fallback for a client route').toBe(200);
    const body = await answered.text();
    // The app's own document, not merely "some 200": Caddy's error page is
    // also HTML, and a check that only read the status could not tell them
    // apart.
    expect(body).toContain('<div id="root">');
    expect(body, 'the served document is not the built index.html').toMatch(
      /<script[^>]+type="module"/,
    );
    // Proof: deleting the icon declaration from the built index.html makes
    // this packaged response return no match, while the source DOM test stays green.
    const icon = body
      .match(/<link\b[^>]*>/gi)
      ?.find((tag) => /\brel=(['"])[^'"]*\bicon\b[^'"]*\1/i.test(tag));
    expect(icon, 'the built document lost its intentional empty favicon').toMatch(
      /\bhref=(['"])data:,\1/i,
    );
  });

  test('draws the directory on a reload of /directory', async ({ page }) => {
    await signedIn(page);

    await page.goto('/directory');
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(page.getByLabel('Name of Kat', { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/directory');

    // And again through the browser's own reload, which is the gesture the
    // requirement is written about.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/directory');
  });
});

/*
 * PROVING THIS CAN FAIL — watched against the real container, the fault
 * injected into the file the container mounts, then reverted. Quoted in
 * `openspec/changes/directory-page/verify.md`.
 *
 * FAULT T — the fallback deleted.
 *   `apps/fe-01/Caddyfile`: the line `try_files {path} /index.html` removed,
 *   leaving `root`, `file_server` and `encode`.
 * Both tests fail. `answers the application rather than a not-found page` on
 * `expected 404 to be 200`, and `draws the directory on a reload of /directory`
 * on `Unable to find heading "People"` with Caddy's `404 page not found` in the
 * document instead. The vite-served suite is green through the same fault,
 * which is the reason this file exists.
 */
