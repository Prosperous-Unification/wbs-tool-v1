## Context

Measured on 2026-09-06 in throwaway worktrees against `a91f831b`, with every
package at its newest. What the numbers said, and what this design does about it:

| axis                                            | trial result                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| TypeScript 7 `tsc --build --force`, 22 projects | clean once `baseUrl` is gone and `paths` are relative                                           |
| Bun 1.4.2, every `bun:test` suite               | 1598 + 1469 pass; v1 lockfile left alone                                                        |
| drizzle rc.4                                    | 22 be-01 failures: constraint errors arrive wrapped in `DrizzleQueryError`, SQLite's in `cause` |
| jose 6                                          | one type, `KeyLike` removed                                                                     |
| @elysiajs/openapi 1.4.16                        | emits OpenAPI 3.1.2; freshness test flags it                                                    |
| Vitest 5 / Vite 8                               | 22 `vi.fn<[], R>` sites, `--minWorkers` gone, `rollupOptions` → `rolldownOptions`               |
| TanStack Table 9                                | 540 type errors in `wbs-table.tsx`, build fails on removed row-model exports                    |
| React 19 + jsdom 30 + RTL 16                    | ~8 unexplained jsdom failures outside the table cascade                                         |
| ESLint 10                                       | eslint-plugin-react crashes on `getFilename`; `settings.react.version` pinned bypasses it       |
| Playwright 1.63                                 | 292 pass; 1 width pin fails identically on main                                                 |

## Goals / Non-Goals

**Goals:** land every bump with the existing tests as the arbiter, and turn the
three pins that can drift into tests that fail on drift.

**Non-Goals:** see proposal.md.

## Decisions

**Two TypeScript packages.** `@typescript/native` → `npm:typescript@7.0.2` owns
`node_modules/.bin/tsc`; `typescript` → `npm:@typescript/typescript6@6.0.2` is
what `require('typescript')` answers, for typescript-eslint. `tsc6` is that
package's only bin, so the two do not collide. The editor keeps TS 6 through
`typescript.tsdk`; TS 7 in the editor needs the native-preview extension. When
TS 7.1 ships an API and typescript-eslint takes it, the alias collapses to one
package again — a version bump, nothing structural.

**Table 9 is ported, not shimmed.** `useLegacyTable` exists and is deprecated;
using it defers the same work to a worse moment. `useTable` with
`tableFeatures({ rowExpandingFeature, expandedRowModel: createExpandedRowModel() })`
and whichever else `wbs-table.tsx` turns out to touch; the `ColumnMeta` module
augmentation gains the `TFeatures` parameter.

**Constraint translation walks `cause`.** `isWriteLockBusy` already does, for
the same reason and with the same depth bound; `isForeignKeyViolation` and
`isUniqueViolation` join it rather than matching the wrapper's text.

**Pins as tests.** `.bun-version` is the one source; CI reads it through
`setup-bun`'s `bun-version-file`, the Dockerfiles cannot, so a test asserts every
`FROM oven/bun:` tag equals it. `ENGINE_IMAGE` is built from
`@dagger.io/dagger`'s installed version. `settings.react.version` is asserted
equal to `react`'s installed version. All three live in one
`tools/tool-devsync/src/toolchain-pins.test.ts`, each with a fault that was watched failing.

**Nx core only.** `@nx/vite` and `@nx/vitest` are dropped rather than migrated:
no target uses their executors, and their `packageJsonUpdates` are what drag TS
6, Vite and Vitest through `nx migrate` on a schedule that is not ours.

## Risks / Trade-offs

- Vitest 5 clears mock history before every test by default. A test that read a
  count across tests would go red; that is the test being right.
- ESLint 10's React pin is a workaround for an upstream bug; the test that ties
  it to the installed React is what stops it going stale.
- h2puni's dagger CLI and engine move with the SDK; a prod dry-run is the check.
