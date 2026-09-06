import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vitest/config';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // `vitest` bundles its **own** copy of vite (`vitest/node_modules/vite`), so
  // its `Plugin` and the one `@vitejs/plugin-react` is typed against are two
  // structurally different declarations of the same shape — `apply`'s parameter
  // is where they part. The cast names that boundary and nothing else: the
  // value is one React plugin either way, and `vite.config.ts` beside this file
  // needs no cast because it imports `defineConfig` from `vite` itself.
  plugins: [react()] as UserConfig['plugins'],
  // The same seven the app is built with. `@wbs/domain/workday`,
  // `@wbs/domain/assumed-duration`, `@wbs/domain/effective-team`,
  // `@wbs/domain/effective-tag`, `@wbs/domain/effective-service`,
  // `@wbs/domain/label-mismatch` and
  // `@wbs/domain/priority-band` are the pure modules and *not* the lib's index
  // barrel, which re-exports arktype-touching validators this bundle excludes —
  // see `vite.config.ts`.
  //
  // Every one of them has to be listed in **both** configs, and the day one is
  // not the suite fails to collect rather than failing an assertion: adding
  // `priority-band` here after `vite.config.ts` alone gave `Failed to resolve
  // import "@wbs/domain/priority-band"` on eight files at once.
  //
  // It happened again on 2026-08-20 with `effective-tag`, in exactly the shape
  // this comment describes: four tsconfigs and `vite.config.ts` updated, this
  // file forgotten, **7 files failed to collect and 820 tests still passed** —
  // a green-looking number beside a suite that had lost a seventh of itself.
  // The count is the tell, not the colour.
  //
  // **A third time, 2026-08-21**, adding `effective-service` and
  // `label-mismatch`: `tsconfig.base.json` and `vite.config.ts` updated, this
  // file forgotten, and the run read **8 files failed to collect, 835 assertions
  // passed**. Twice is a slip; three times is a checklist living in prose where
  // it should be an assertion, so `vite-config.test.ts` now compares the two
  // alias maps as sets rather than this comment asking a reader to remember.
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@wbs/domain/workday': resolve(__dirname, '../../libs/domain/src/workday.ts'),
      '@wbs/domain/assumed-duration': resolve(
        __dirname,
        '../../libs/domain/src/assumed-duration.ts',
      ),
      '@wbs/domain/effective-team': resolve(__dirname, '../../libs/domain/src/effective-team.ts'),
      '@wbs/domain/effective-tag': resolve(__dirname, '../../libs/domain/src/effective-tag.ts'),
      '@wbs/domain/effective-service': resolve(
        __dirname,
        '../../libs/domain/src/effective-service.ts',
      ),
      '@wbs/domain/label-mismatch': resolve(__dirname, '../../libs/domain/src/label-mismatch.ts'),
      '@wbs/domain/marker-color': resolve(__dirname, '../../libs/domain/src/marker-color.ts'),
      '@wbs/domain/is-within': resolve(__dirname, '../../libs/domain/src/is-within.ts'),
      '@wbs/contracts/ws-frames': resolve(__dirname, '../../libs/contracts/src/ws-frames.ts'),
      '@wbs/domain/priority-band': resolve(__dirname, '../../libs/domain/src/priority-band.ts'),
      // And a fourth: `dependency-reach.ts` is a two-member enum and its
      // guard, and the rule it holds — how far into a predecessor a
      // dependency reaches — is what be-01 schedules by. A second copy here
      // is a chart drawing an arrow out of a slice the engine never joined
      // the edge to.
      '@wbs/domain/dependency-reach': resolve(
        __dirname,
        '../../libs/domain/src/dependency-reach.ts',
      ),
      // And a fifth, for `external-refs`: `external-system.ts` holds the ordered
      // URL→system rules, and the deriving rule and the seeded vocabulary are
      // one fact (`EXTERNAL_SYSTEMS` is asserted against the migration's seed).
      // A second copy here is a paste that types itself as a system be-01 would
      // refuse to store.
      '@wbs/domain/external-system': resolve(__dirname, '../../libs/domain/src/external-system.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    /**
     * The clock every test reads, pinned.
     *
     * `plan-mermaid.test.ts` parses its own emitted gantt with the real Mermaid
     * lexer and asserts the `Date` that comes back, serialised with
     * `.toISOString()`. Mermaid builds that `Date` from a bare `YYYY-MM-DD` at
     * **local** midnight, so on a host at UTC+3 the same correct source parses
     * to `2026-09-03T21:00:00Z` where the test says `2026-09-04T00:00:00Z`, and
     * two cases fail for the tester's region rather than for the code.
     *
     * What is pinned here is the oracle, not a defect: the app emits a date
     * string, which carries no offset, and nothing a reader sees changes with
     * the host clock. CI has always run near UTC, so this makes every machine
     * agree with the gate people already trust instead of the other way round.
     *
     * It is a workaround, not the fix. Those two assertions compare a UTC
     * serialisation of a local-midnight `Date`; they should compare the local
     * calendar day. Until they do, an unpinned run of this suite means
     * something different in Kyiv than in CI.
     */
    // NOT set here: `test.env` writes `process.env` after the worker has
    // started, and the timezone is read once before a test file loads, so
    // `env: { TZ: 'UTC' }` changes nothing (watched: still 2 failed | 47
    // passed). It is on the `test` target's command in `project.json`, which
    // is before the process exists. Run this suite by hand the same way:
    // `TZ=UTC bunx vitest run`.
    setupFiles: ['./vitest.setup.ts'],
    // The second pattern is not decoration: `vite-config.test.ts` lives beside
    // the config it describes, `src/**` never reached it, and so it had never
    // run once — its assertions went on reading `config.server` after the
    // default export became a factory, and nothing said so. It is also why that
    // file is not named `vite.config.test.ts`: vitest's default `exclude` ends
    // in `**/{…,vite,vitest,…}.config.*`, which swallows that name whatever the
    // include says.
    include: ['src/**/*.{test,spec}.{ts,tsx}', '*.{test,spec}.{ts,tsx}'],
    // `*.zoned.test.*` belongs to `vitest.zoned.config.ts`, which the `test`
    // target runs a second time under a different `TZ`. It is excluded here
    // rather than named out of `include` because the two configs have to
    // disagree about exactly one thing, and a reader looking for what this run
    // does not collect should find it beside what it does. The defaults are
    // spread back in: dropping them would re-collect `node_modules` and, per
    // the note on `include` above, `vite-config.test.ts`'s neighbours.
    exclude: [...configDefaults.exclude, 'src/**/*.zoned.test.{ts,tsx}'],
  },
});
