import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import type { DriveableMediaQueryList } from '../vitest.setup';
import { DARK_CLASS, DARK_QUERY, paletteFor, rememberedTheme, THEME_KEY } from './lib/theme';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const indexHtml = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

/**
 * The inline script `index.html` runs before the first paint, as text.
 *
 * Found by its **body** and not by its opening tag: `index.html` carries a
 * second `<script>`, the module that loads the app, and a pattern loose enough
 * to allow attributes would take whichever came first. Matching on `THEME_KEY`
 * appearing inside it names the one script this file is about, whatever
 * attributes it has grown.
 *
 * That last part is the point. An earlier version matched a bare `<script>`
 * only, which meant adding `type="module"` — the deferral this whole file
 * exists to refuse — did not fail `is not deferred…` but killed the import
 * instead: a red, and a red about the wrong thing, naming no fault a reader
 * could act on. Watched, and recorded in
 * `openspec/changes/dark-mode/verify.md`.
 *
 * @throws When there is no such script, rather than running an empty string and
 * reporting that the bootstrap agrees with the module. A check that passes on
 * its subject's absence is no check at all.
 */
function bootstrapScript(): string {
  const html = readFileSync(indexHtml, 'utf8');
  for (const found of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    if (found[1].includes(THEME_KEY)) return found[1];
  }
  throw new Error(`${indexHtml} carries no pre-paint script naming ${THEME_KEY}`);
}

const script = bootstrapScript();

/** Runs the bootstrap against this jsdom document, and says what it painted. */
function runBootstrap(): 'light' | 'dark' {
  // A test, and the boundary is named: this is the production script being
  // executed as itself. Importing it is impossible — it is an inline element of
  // an HTML document — and paraphrasing it here would be a check comparing this
  // file with itself.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function(script)();
  return document.documentElement.classList.contains(DARK_CLASS) ? 'dark' : 'light';
}

const platform = (): DriveableMediaQueryList =>
  window.matchMedia(DARK_QUERY) as DriveableMediaQueryList;

beforeEach(() => {
  localStorage.removeItem(THEME_KEY);
  document.documentElement.classList.remove(DARK_CLASS);
  platform().setMatches(false);
});

/**
 * The pre-paint bootstrap in `index.html`, held to the module it duplicates.
 *
 * The duplication is deliberate — see the comment above the script — and this
 * is the price of it: every stored value the module has an answer for is put
 * through both, and they have to agree. Watched failures are in
 * `openspec/changes/dark-mode/verify.md`.
 */
describe('the palette applied before the first paint', () => {
  /**
   * Pins the document mechanism; Browser Use Cloud is the oracle for whether Chromium stays quiet.
   *
   * Proof: removing the link at 04a01c63 failed this case on h2puni while the other 14 passed.
   */
  itDom('declares the intentional empty favicon', () => {
    const html = readFileSync(indexHtml, 'utf8');
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    expect(parsed.querySelector('link[rel~="icon"]')?.getAttribute('href')).toBe('data:,');
  });

  itDom('reads the key the module writes, by name', () => {
    // Not a paraphrase of the logic: the literal string. A bootstrap reading
    // `wbs.theme2` would agree with the module on every case below, because
    // both would see an empty store.
    expect(script).toContain(THEME_KEY);
    expect(script).toContain(DARK_QUERY);
  });

  itDom('is not deferred past the paint it exists to get in front of', () => {
    const html = readFileSync(indexHtml, 'utf8');
    const opener = /<script([^>]*)>[\s\S]*?wbs\.theme/.exec(html);
    expect(opener?.[1]?.trim(), 'the bootstrap grew an attribute that defers it').toBe('');
  });

  for (const stored of [
    null,
    '"system"',
    '"light"',
    '"dark"',
    '"midnight"',
    '{not json',
  ] as const) {
    for (const machineIsDark of [false, true]) {
      itDom(
        `agrees with the module: stored ${stored ?? '(nothing)'}, machine ${machineIsDark ? 'dark' : 'light'}`,
        () => {
          if (stored !== null) localStorage.setItem(THEME_KEY, stored);
          platform().setMatches(machineIsDark);

          const painted = runBootstrap();

          // `rememberedTheme` reads the same bytes and drops the key when it
          // cannot use them; the bootstrap deliberately writes nothing, so it
          // is read here **after** the run, from what the module would have
          // made of the same store.
          expect(painted).toBe(paletteFor(rememberedTheme(), machineIsDark));
        },
      );
    }
  }
});
