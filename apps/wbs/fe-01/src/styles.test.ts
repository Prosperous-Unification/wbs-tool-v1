// @vitest-environment node
//
// Same reason as `vite-config.test.ts`: importing the real `vite` pulls in
// esbuild, which refuses to load where `new TextEncoder().encode('') instanceof
// Uint8Array` is false — and under jsdom it is. This file runs a Vite build, so
// it needs the node realm twice over.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every CSS asset a finished Vite build emitted, joined.
 *
 * @throws When there is none, rather than letting an assertion about the
 * absence of preflight pass against a bundle that holds nothing at all.
 */
function cssOf(built: Awaited<ReturnType<typeof build>>, what: string): string {
  // `build` is overloaded: a watcher for `build.watch`, one bundle or an array
  // of them otherwise. Neither call below sets a watcher, so this is a shape
  // check on a union the compiler cannot collapse.
  const outputs = (Array.isArray(built) ? built : [built]) as Rollup.RolldownOutput[];
  const css = outputs
    .flatMap((bundle) => bundle.output)
    .filter((chunk): chunk is Rollup.OutputAsset => chunk.type === 'asset')
    .filter((asset) => asset.fileName.endsWith('.css'))
    .map((asset) => (typeof asset.source === 'string' ? asset.source : ''))
    .join('\n');
  if (css.trim() === '') throw new Error(`${what} emitted no CSS; there is nothing to assert on`);
  return css;
}

/**
 * `src/styles.css` alone, compiled by the Tailwind plugin over the same source
 * tree, and never written to disk.
 *
 * A real build rather than an assertion about the text of the stylesheet: what
 * is being checked is which rules come out the other end — that the tracer class
 * written in `app.tsx` is found by the scanner and emitted, and that nothing
 * from Tailwind's base layer is. A string test over `styles.css` would compare
 * the file against a paraphrase of itself and pass with the scanner switched
 * off.
 *
 * This one wires the plugin itself, so it says nothing about whether the app's
 * own config wires it — see {@link cssFromShippedConfig}, which is the check
 * that does.
 */
async function cssFromStylesheetAlone(): Promise<string> {
  return cssOf(
    await build({
      configFile: false,
      root: appRoot,
      logLevel: 'silent',
      plugins: [tailwindcss()],
      build: {
        write: false,
        rollupOptions: { input: resolve(appRoot, 'src/styles.css') },
      },
    }),
    'the stylesheet build',
  );
}

/**
 * The whole app, built through the real `vite.config.ts` — the plugin list this
 * repository actually ships, not one this file assembled.
 *
 * The distinction is the entire point. {@link cssFromStylesheetAlone} passes
 * `tailwindcss()` in itself, so with the plugin deleted from `vite.config.ts`
 * all five of its assertions stay green while `nx run fe-01:build` ships a
 * bundle with no utilities in it. Watched 2026-08-09: the plugin removed, `1
 * failed | 6 passed`, and the one that failed was this pair.
 *
 * `e2e/tailwind.spec.ts` would catch the same fault — `vite dev` reads this
 * same config — but it is not in the gate this repository runs before a commit.
 * `nx run-many -t test lint typecheck build` is; the browser suite is CI's
 * separate `pixels` job and needs a chromium. Inside the gate, this is the only
 * check on the production wiring.
 *
 * `write: false` over the config's own `outDir`, so `dist/apps/fe-01` is never
 * touched by a test run.
 */
async function cssFromShippedConfig(): Promise<string> {
  return cssOf(
    await build({
      configFile: resolve(appRoot, 'vite.config.ts'),
      root: appRoot,
      logLevel: 'silent',
      build: { write: false },
    }),
    'the app build through vite.config.ts',
  );
}

const stylesheet = await cssFromStylesheetAlone();
const shipped = await cssFromShippedConfig();

/**
 * The guard every rule in the base layer has to carry, as it survives
 * minification.
 *
 * Written as a pattern rather than as the literal string in `styles.css`
 * because lightningcss rewrites what it is given — it drops the leading `*`
 * from `*:not(…)` and takes the space out after the comma — and a check that
 * compared source text to source text would be comparing the file with a
 * paraphrase of itself.
 */
const GRID_GUARD = /:not\(\s*\[data-grid]\s*,\s*\[data-grid]\s+\*\s*\)/;

/**
 * One rule's selector list, split into the individual selectors it names.
 *
 * On top-level commas only, tracked by paren depth: `:not([data-grid],
 * [data-grid] *)` carries a comma of its own, and splitting on every comma
 * would hand back two halves of a guard and call the first of them unguarded.
 *
 * This split is the whole check. Written without it — asking whether the guard
 * appears anywhere in the list — the assertion passed with
 * `button, input:not(…), select:not(…)` in the layer, because the list still
 * contained a guard. Watched 2026-08-09, on the first fault injected at it.
 *
 * @param list A rule's selector text, as the compiled stylesheet holds it.
 * @returns One entry per selector, trimmed.
 */
function eachSelector(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out.filter((selector) => selector !== '');
}

/**
 * Every selector the compiled `@layer base` blocks declare, one entry each.
 *
 * A brace walk rather than a regex over the whole layer: the assertion below is
 * about *each* selector, and a pattern that only proved the guard appears
 * somewhere in the layer would pass with one unguarded rule sitting next to a
 * guarded one — which is precisely the fault it is written to catch.
 *
 * @param css The compiled stylesheet.
 * @returns Each selector, from every rule of every `@layer base` block.
 * @throws When a block never closes, rather than silently returning the
 * selectors it managed to read out of a stylesheet it did not understand.
 */
function baseLayerSelectors(css: string): string[] {
  const selectors: string[] = [];
  const opener = /@layer\s+base\s*\{/g;
  let found = opener.exec(css);
  while (found !== null) {
    let depth = 1;
    let at = found.index + found[0].length;
    let list = '';
    while (depth > 0) {
      // The end of the string rather than an `undefined` from the index: with
      // this project's TypeScript settings `css[at]` is typed `string`, so the
      // nullish check the walk actually wants is one the compiler calls dead
      // code — and a lint rule says so.
      if (at >= css.length) {
        throw new Error('an @layer base block in the compiled CSS never closed');
      }
      const char = css[at];
      if (char === '{') {
        depth += 1;
        if (depth === 2) {
          selectors.push(...eachSelector(list));
          list = '';
        }
      } else if (char === '}') {
        depth -= 1;
        list = '';
      } else if (depth === 1) {
        list += char;
      }
      at += 1;
    }
    opener.lastIndex = at;
    found = opener.exec(css);
  }
  return selectors;
}

/*
 * Proof, watched by injecting one fault at a time and reverting it. The runs
 * from 2026-08-09 are in `openspec/changes/shadcn-foundation/verify.md`; the
 * two the tailwind spike watched are in
 * `docs/plans/2026-08-08-tailwind-spike-verify.md`.
 *
 *   - `className="tracking-tight"` off the `h1` in `app.tsx`: 1 failed,
 *     `expected '@layer properties{@supports (((-webki…' to contain
 *     '.tracking-tight'`. The scanner is reading the app's markup rather than
 *     emitting a fixed set.
 *   - `source(none)` and the three `@source` lines out of `styles.css`: 1
 *     failed, `expected '…' not to contain '.tracking-widest'` — automatic
 *     detection walked up to the git root and found the name in a file that is
 *     not markup. That containment is the reason those lines exist.
 *   - the guard taken off one rule in `@layer base`: `scopes every rule in its
 *     base layer away from the grid` failed naming that selector.
 *   - the two imports replaced by `@import 'tailwindcss'`: `brings none of
 *     Tailwind's own preflight with it` failed on `text-size-adjust`.
 *   - `@layer theme, base, components, utilities;` reordered so `base` comes
 *     last: `gives its reset less weight than any utility` failed.
 *   - `tailwindcss()` out of `vite.config.ts`'s `plugins`: 1 failed, 7 passed —
 *     `expected '@layer theme,base,components,utilitie…' to contain
 *     '.tracking-tight'`, and only `the config this app is built with` saw it.
 *     The six tests above read the plugin-wired stylesheet directly and passed
 *     throughout, which is why that describe block exists. Re-watched
 *     2026-08-09 after the shadcn merge.
 */
describe('the Tailwind stylesheet this app ships', () => {
  it('compiles the tracer class written on the brand heading', () => {
    expect(stylesheet).toContain('.tracking-tight');
    expect(stylesheet).toContain('letter-spacing');
  });

  it('emits nothing for a utility no file under src asks for', () => {
    // A sibling of the tracer, so the pair differ in exactly one thing: whether
    // the app's markup uses it. This file is excluded from the scan by
    // `styles.css` — it was not at first, and naming the class here was enough
    // to put it in the bundle and fail this assertion on itself.
    expect(stylesheet).not.toContain('.tracking-widest');
  });

  // One assertion per test throughout, and the reason is worth restating:
  // `expect` throws on the first failure, so the second line of a
  // two-assertion test is never evaluated in the run that proves the first can
  // fail — a check nobody has watched break.
  it('brings none of Tailwind’s own preflight with it', () => {
    // `-webkit-text-size-adjust: 100%` on `html, :host` is preflight's opening
    // rule and appears nowhere else. The declarations this file's own reset
    // shares with preflight — `border-box`, `font: inherit` — stopped being
    // usable as the discriminator the moment there was a scoped reset to write,
    // which is why the marker is one preflight has and this app does not want.
    expect(stylesheet).not.toContain('text-size-adjust');
  });

  it('writes its reset into the base layer, where the layer order put it', () => {
    // The layer is now a block rather than the empty statement the tailwind
    // spike left. That inversion is deliberate: the slot existed for exactly
    // this.
    expect(baseLayerSelectors(stylesheet).length).toBeGreaterThan(0);
  });

  it('scopes every rule in its base layer away from the grid', () => {
    // The whole of the geometry promise, and the only mechanical check of it
    // there is. `layout.spec.ts` cannot see this fault — the table is styled
    // inline and an inline style outranks every layer — so a reset that leaked
    // into a `<td>` would be caught here and by `e2e/tailwind.spec.ts`, and by
    // nothing else in the repository.
    const unguarded = baseLayerSelectors(stylesheet).filter(
      (selector) => !GRID_GUARD.test(selector),
    );
    expect(unguarded).toEqual([]);
  });

  it('gives its reset less weight than any utility', () => {
    // Order in the compiled file, which is what the cascade reads for layers
    // declared by `@layer theme, base, components, utilities;`. A reset that
    // came out after the utilities would beat every `p-6` and `text-sm` in the
    // app regardless of specificity.
    expect(stylesheet.indexOf('@layer base{')).toBeLessThan(
      stylesheet.indexOf('@layer utilities{'),
    );
  });
});

describe('the config this app is built with', () => {
  it('wires the plugin, so a production build carries the tracer', () => {
    expect(shipped).toContain('.tracking-tight');
  });

  it('brings none of Tailwind’s own preflight through that config either', () => {
    // The same claim as `brings none of Tailwind's own preflight with it`, made
    // about the artifact that ships rather than a stylesheet compiled beside it.
    // A future `vite.config.ts` that pulled preflight in — a second CSS entry,
    // `@import 'tailwindcss'` — would be invisible to every other test here.
    //
    // `text-size-adjust`, not `border-box`, for the same reason the stylesheet
    // test above stopped using `border-box`: this app ships a *scoped* reset of
    // its own that sets `box-sizing: border-box`, so `border-box` is present in
    // a correctly wired build and cannot tell preflight apart. The marker has to
    // be one preflight has and this app's reset does not — `text-size-adjust` is
    // preflight's opening rule and appears nowhere in the scoped reset.
    expect(shipped).not.toContain('text-size-adjust');
  });
});
