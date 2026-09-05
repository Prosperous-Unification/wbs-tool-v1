import { configDefaults, defineConfig } from 'vitest/config';

import base from './vitest.config';

/**
 * The same suite, collected under a **different process timezone**.
 *
 * A calendar day on this product has no zone, and the client must never turn
 * one into an instant — task 4.3a. The fault that requirement is about is
 * `new Date(day + 'T00:00:00')`, which is **local** midnight, so under the
 * `TZ=UTC` the `test` target pins it returns the very day it was given and no
 * assertion can see it. Measured on the gate host, 2026-09-05, one probe file
 * and one line changed between the arms:
 *
 * - `TZ=UTC`, then `process.env.TZ = 'Pacific/Auckland'` assigned inside the
 *   case: `new Date('2026-08-19T00:00:00')` is `2026-08-19T00:00:00.000Z`,
 *   `getTimezoneOffset()` is `0`, and
 *   `Intl.DateTimeFormat().resolvedOptions().timeZone` is still `UTC`. The
 *   assignment does nothing — the zone is read once, before the file loads.
 * - `TZ=Pacific/Auckland` on the command line: the same expression is
 *   `2026-08-18T12:00:00.000Z`, offset `-720`, zone `Pacific/Auckland` — the
 *   day before, which is the fault.
 *
 * `vitest.config.ts` already records the first half of that against
 * `test.env`, which is why `TZ=UTC` lives on the command in `project.json`.
 * So a zone-sensitive case cannot be faked from inside a file: it needs a
 * runner that started under the zone, which is this config, chained after the
 * UTC one in the same `test` target. Chained rather than given a target of its
 * own so that `bin/h2puni-gate.sh` and `ci.yml` keep covering it without
 * naming it — both drive `nx run-many -t test` and neither names a config.
 *
 * Everything else is the base config's, `resolve.alias` above all: three
 * separate incidents on this suite came from a second copy of that map going
 * stale, and `vite-config.test.ts` compares it as a set for that reason.
 */
export default defineConfig({
  plugins: base.plugins,
  resolve: base.resolve,
  test: {
    ...base.test,
    include: ['src/**/*.zoned.test.{ts,tsx}'],
    // The base's `exclude` is what keeps this file's cases out of the UTC run,
    // so inheriting it here would collect nothing at all.
    exclude: [...configDefaults.exclude],
  },
});
