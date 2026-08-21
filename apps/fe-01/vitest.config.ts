import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // The same six the app is built with. `@wbs/domain/workday`,
  // `@wbs/domain/effective-team`, `@wbs/domain/effective-tag`,
  // `@wbs/domain/effective-service`, `@wbs/domain/label-mismatch` and
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
      '@wbs/domain/effective-team': resolve(__dirname, '../../libs/domain/src/effective-team.ts'),
      '@wbs/domain/effective-tag': resolve(__dirname, '../../libs/domain/src/effective-tag.ts'),
      '@wbs/domain/effective-service': resolve(
        __dirname,
        '../../libs/domain/src/effective-service.ts',
      ),
      '@wbs/domain/label-mismatch': resolve(__dirname, '../../libs/domain/src/label-mismatch.ts'),
      '@wbs/domain/priority-band': resolve(__dirname, '../../libs/domain/src/priority-band.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // The second pattern is not decoration: `vite-config.test.ts` lives beside
    // the config it describes, `src/**` never reached it, and so it had never
    // run once — its assertions went on reading `config.server` after the
    // default export became a factory, and nothing said so. It is also why that
    // file is not named `vite.config.test.ts`: vitest's default `exclude` ends
    // in `**/{…,vite,vitest,…}.config.*`, which swallows that name whatever the
    // include says.
    include: ['src/**/*.{test,spec}.{ts,tsx}', '*.{test,spec}.{ts,tsx}'],
  },
});
