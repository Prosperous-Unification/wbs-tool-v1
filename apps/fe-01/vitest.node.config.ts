import { defineConfig, type ViteUserConfig } from 'vitest/config';

import baseConfig from './vitest.config';
import { NODE_SUITES } from './vitest.node-suites';

/**
 * The DOM-free tier: the same aliases and the same plugins, without jsdom.
 *
 * Spread from `vitest.config.ts` rather than written out, because the aliases
 * are the one thing in that file that must never diverge — the comment there
 * counts three separate occasions on which a missing alias made files fail to
 * **collect** while the assertion count still looked healthy. A second config
 * repeating them would be a fourth.
 *
 * A spread and **not** `mergeConfig`, which was the first attempt: it
 * concatenates arrays, so `include` came out as the base's two patterns plus
 * these nineteen and the tier collected all 78 files under `node` — 11 files
 * failed on `document is not defined` and the run looked like a broken tier
 * rather than a config that had ignored its own list.
 *
 * `setupFiles` is emptied on purpose: the shared setup's first line is
 * `@testing-library/jest-dom/vitest`, which is a DOM matcher pack, and its
 * second half installs a `localStorage` on a `window` this tier does not have.
 *
 * What this tier is **not** is a second definition of what fe-01 tests. Every
 * file here runs in the full `test` target too, under jsdom, exactly as before.
 * {@link NODE_SUITES} is a fast subset, and `src/test-tiers.test.ts` is what
 * keeps it an honest one.
 */
// No guard on `baseConfig`'s shape, and that is deliberate. `defineConfig`'s
// return type widens to `UserConfigExport` — an object, a promise, or a factory
// — and spreading a promise would be an empty config and therefore a tier that
// runs nothing, so a shape check was written here. TypeScript resolves this
// import to a plain `ViteUserConfig` (the base calls the object-literal overload),
// which made every arm of that check unreachable: `no-unnecessary-condition` on
// the null test and `no-unnecessary-type-assertion` on the cast behind it. A
// check that cannot fail is worse than none, so the annotation below is the
// whole of it — the day the base becomes a factory, this line fails the build.
const base: ViteUserConfig = baseConfig;

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    environment: 'node',
    include: [...NODE_SUITES],
    setupFiles: [],
  },
});
