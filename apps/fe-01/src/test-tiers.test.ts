import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NODE_SUITES } from '../vitest.node-suites';

/** This file, by the path the list names it with — see {@link everySuite}. */
const SELF = 'src/test-tiers.test.ts';

/**
 * `apps/fe-01`, which is where both configs run and what the list is relative
 * to.
 *
 * `process.cwd()` and **not** `new URL('..', import.meta.url)`: this suite runs
 * in both tiers, and under jsdom Vite serves the module from a `/@fs/…` URL —
 * so the same expression that resolves correctly under `node` gave
 * `ENOENT: … scandir '/@fs/Users/…/apps/fe-01/src'`. Both configs set their cwd
 * here.
 */
const APP = process.cwd();

/** Every suite in the app, by the path the configs name it with. */
function everySuite(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(APP, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      // Itself excluded, for be-01's guard's own reason: this file quotes the
      // DOM globals in {@link DOM_EVIDENCE}, so it matches its own rule and
      // would read as needing a browser it does not.
      if (path === SELF) continue;
      if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk('src');
  for (const entry of readdirSync(APP, { withFileTypes: true })) {
    // The two at the root, which `vitest.config.ts`'s second include pattern is
    // for: `vite-config.test.ts` lives beside the config it describes.
    if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) found.push(entry.name);
  }
  return found.sort();
}

/**
 * What says a suite needs a browser: a component, a DOM matcher pack, or a
 * global only a browser has.
 *
 * **Deliberately generous.** A file that merely mentions `document` in prose is
 * read as needing one, and that is the safe direction to be wrong in: it leaves
 * a suite in the 69-second tier that could have been in the 1.9-second one.
 * Being wrong the other way puts a file in a tier it cannot run in, which is
 * what the tier's own run would then fail on.
 */
const DOM_EVIDENCE =
  /@testing-library|\bdocument\b|\bwindow\b|\blocation\b|WebSocket|localStorage|matchMedia|getComputedStyle|HTMLElement|\bnavigator\b|jsdom/;

/**
 * Suites whose need for a browser is **not** visible in them, found by running
 * the tier rather than by reading.
 *
 * `api.test.ts` names no DOM global; `websocketUrl` reads `location`, in
 * `api.ts`, and one case calls it. No rule over a file's own text can see that
 * — the need is one import away — so the honest thing is a short list with the
 * reason on it, and the tier's own run is what puts a file here: this one
 * arrived as `ReferenceError: location is not defined`, on the first run of
 * the tier that had it.
 */
const INDIRECT_DOM_SUITES: readonly string[] = ['src/lib/api.test.ts'];

/**
 * The third tier: suites `vitest.zoned.config.ts` collects and neither other
 * config does.
 *
 * They are DOM-free by nothing but coincidence — what puts a file here is the
 * zone its runner must have **started** under, which no rule over the file's
 * text could tell from a preference. The suffix is the mechanism for the same
 * reason the two configs disagree about exactly this pattern: a zoned suite
 * collected by the UTC run is a row of vacuous greens, because under UTC the
 * local-midnight fault these cases exist to catch returns the correct answer.
 */
const isZoned = (suite: string): boolean => /\.zoned\.test\.tsx?$/.test(suite);

const needsADom = (suite: string): boolean =>
  suite.endsWith('.tsx') ||
  INDIRECT_DOM_SUITES.includes(suite) ||
  DOM_EVIDENCE.test(readFileSync(join(APP, suite), 'utf8'));

/**
 * fe-01's two tiers, and the rule that keeps the fast one honest.
 *
 * The whole suite is a **69-second** jsdom run; `vitest.node.config.ts` runs
 * the DOM-free files under `node` in **1.9 seconds** for 341 tests, which is
 * an inner-loop answer. W1-4 asked for that selection to come from a
 * `*.dom.test.tsx` suffix across 55 files; it comes from
 * {@link NODE_SUITES} instead, and this file is the reason a list is allowed
 * to be the mechanism — it walks the directory rather than trusting the list,
 * exactly as `be-01`'s `test-tiers.test.ts` does.
 *
 * What this file cannot say is that a listed suite really runs under `node`;
 * only running it can, and `nx run fe-01:test:unit` is that run. What it does
 * say is that the list has not drifted from the files, which is the fault a
 * list has and a suffix does not.
 */
describe('fe-01’s test tiers', () => {
  it('lists every DOM-free suite in the fast tier, and only those', () => {
    // Proof, both directions, watched 2026-09-02. A `document.title` read
    // added to the listed `short-date.test.ts` failed on `expected
    // [ 'playwright-config.test.ts', …(18) ] to deeply equal
    // [ 'playwright-config.test.ts', …(17) ]` — a listed suite that now needs a
    // browser. And `pointed-row-store.test.ts` taken off the list failed the
    // other way, `…(17) to deeply equal …(18)`: a DOM-free suite paying jsdom
    // for nothing. The partition case failed with each of them too, on `80 to
    // be 79` and `78 to be 79`.
    const domFree = [
      ...everySuite().filter((suite) => !needsADom(suite) && !isZoned(suite)),
      SELF,
    ].sort();

    expect([...NODE_SUITES].sort()).toEqual(domFree);
  });

  it('partitions the suite — every file is in exactly one tier', () => {
    // be-01's own arithmetic: the two tiers add up to the whole, so nothing is
    // counted twice and nothing is dropped. A list is the one mechanism where
    // "dropped" is silent.
    const all = [...everySuite(), SELF];
    const zonedTier = all.filter(isZoned);
    const domTier = all.filter((suite) => suite !== SELF && !isZoned(suite) && needsADom(suite));

    expect(NODE_SUITES.length + domTier.length + zonedTier.length).toBe(all.length);
    expect(new Set(NODE_SUITES).size).toBe(NODE_SUITES.length);
  });

  it('names files that exist', () => {
    // A path typed wrong is a suite silently not run by the fast tier —
    // vitest's include patterns match nothing and say nothing.
    for (const suite of NODE_SUITES) {
      expect(() => readFileSync(join(APP, suite), 'utf8'), suite).not.toThrow();
    }
  });
});
