<!--
Ordered TDD slices; no separate plan. Every slice names the test that proves it;
every new check names the negative watched failing (R5). Order is the
dependency order of the toolchain: pins, Nx, TypeScript, backend, frontend
runtime, frontend table, lint, format/hooks/e2e/dagger, gate.
-->

## 1. Pins as checks

- [x] 1.1 `.bun-version` = 1.4.2; `tools/tool-devsync/src/toolchain-pins.test.ts` asserts every `FROM oven/bun:` tag (be-01, gw-01, fe-01, dev-src) equals it — test: the new file; negative: one Dockerfile tag edited to 1.3.14, test names the file and both versions
- [x] 1.2 CI reads `.bun-version` through `setup-bun`'s `bun-version-file` in both jobs; the test asserts no `bun-version:` literal remains in the workflow — test: same file; negative: a `bun-version: 1.3.14` literal put back
- [x] 1.3 `bun-types` 1.4.2 — test: `bunx nx run-many -t typecheck`

## 2. Nx 23.2, core only

- [x] 2.1 Drop `@nx/vite` and `@nx/vitest`; bump nx, @nx/eslint, @nx/eslint-plugin, @nx/js, @nx/workspace to 23.2.0; run `nx migrate --run-migrations` (expect only `.gitignore`); keep TypeScript at 5.9 for this slice — test: `every typecheck target compiles files`, `every cached target declares what it reads`, `nx format:check --all`, one `lint:fast`

## 3. TypeScript 7

- [x] 3.1 Remove every `baseUrl`, make every `paths` entry relative (base and fe-01's four configs) — test: `run-many -t typecheck` on TS 5.9 still green; `bun test apps/be-01/src/controller/work-item.controller.test.ts` still resolves `@wbs/*`
- [x] 3.2 `typescript` → `npm:@typescript/typescript6@6.0.2`, `@typescript/native` → `npm:typescript@7.0.2`; `toolchain-pins.test.ts` asserts `require('typescript').version` major 6 and `node_modules/.bin/tsc --version` major 7 — test: same file; negative: the two aliases swapped, test names the role that moved
- [x] 3.3 `run-many -t typecheck` under TS 7 across all 22 projects; `.vscode/settings.json` keeps `typescript.tsdk` on TS 6 and `extensions.json` recommends the native preview — test: typecheck targets; ESLint still parses through TS 6 (`lint:fast` on be-01)

## 4. Backend libraries

- [x] 4.1 drizzle-orm/kit 1.0.0-rc.4; `isForeignKeyViolation` and `isUniqueViolation` walk `cause` with the same depth bound as `isWriteLockBusy` — test: the 22 be-01 tests watched failing on `DrizzleQueryError: Failed query` before the fix, green after; unit negative in `constraint.db.test.ts`: a violation wrapped two levels deep is recognised, a wrapper whose `cause` names a different index is not
- [x] 4.2 jose 6.2.12; `KeyLike` → `CryptoKey` in `token-verifier.test.ts` — test: libs/auth, gw-01, mcp-01 suites; typecheck
- [x] 4.3 elysia 1.4.30, @elysiajs/openapi 1.4.16, typebox, arktype, openid-client, yaml, the five OpenTelemetry packages; re-emit `openapi.json` (3.1.2) — test: `the committed OpenAPI document is what the app serves right now`, mcp-01 suite against the re-emitted document

## 5. Frontend runtime

- [x] 5.1 Vite 8.2.2, @vitejs/plugin-react 6.1.1; `rollupOptions` → `rolldownOptions`; `vite-config.test.ts` reads the new key — test: `fe-01:build`, `the built chunks`; negative: `manualChunks` narrowed, test fails as its Proof says
- [x] 5.2 Vitest 5.0.0, coverage-v8 5, jsdom 30, @types/node 26; drop `--minWorkers`; 22 `vi.fn<[A], R>` → `vi.fn<(…: A) => R>` — test: all three fe-01 vitest suites green except the Table-9 cascade
- [x] 5.3 React 19.2.8, @types/react 19, RTL 16 (+ explicit @testing-library/dom), jest-dom 7, tailwind-merge 3; run the non-table suites and fix each remaining failure at its cause — test: named per failure in verify.md, none loosened
- [x] 5.4 TanStack Table 9.2.4: `useTable` + `tableFeatures`, row models as slots, `ColumnMeta` augmentation with `TFeatures`, `ExpandedState` import in `tree-search.ts` — test: full jsdom suite (2297) green; `fe-01:build`; typecheck
- [x] 5.5 eslint-plugin-react-hooks 7.1.1 with its compiler rules: each finding fixed or disabled at the line with the reason — test: `fe-01:lint`

## 6. Lint stack

- [x] 6.1 ESLint 10.10, @eslint/js 10, unicorn 74, typescript-eslint 8.69, jsdoc 64, simple-import-sort 14, tanstack plugins; `settings.react.version` = installed React; `toolchain-pins.test.ts` asserts the pin equals `react`'s version — test: `run-many -t lint` completes; negative: pin set to `18.3.1`, test names both
- [x] 6.2 New findings fixed: `preserve-caught-error`, `no-useless-assignment`, `no-meaningless-void-operator`, whatever unicorn 74 adds — test: `run-many -t lint` clean; the two pre-existing parse errors (`drizzle.config.ts`, `tools/capture-capacity-oracle.ts`) recorded, not hidden

## 7. Format, hooks, browser, dagger

- [x] 7.1 prettier 3.9.6 + plugin-tailwindcss 0.8.1; one mechanical reformat commit — test: `nx format:check --all`
- [x] 7.2 lefthook 2.1.12 — test: `lefthook run pre-commit --file …` runs all four hooks
- [ ] 7.3 @playwright/test 1.63 — test: `bun run e2e` on shifted ports; the 1268px pin failure compared against main and dispositioned in verify.md
- [x] 7.4 @dagger.io/dagger 0.21.9; `ENGINE_IMAGE` derived from the installed SDK version; `main.test.ts` asserts the image tag equals `v<sdk version>`; runbooks say 0.21.9; h2puni's CLI installed at 0.21.9 and the engine image pulled — test: `tool-dagger` suite; negative: `ENGINE_IMAGE` pinned back to v0.21.8, test names both; `bin/publish-release.sh` dry-run on h2puni

## 8. Gate

- [x] 8.1 `bunx nx run-many -t test lint typecheck build` and `nx format:check --all` locally in the worktree
- [x] 8.2 `bin/h2puni-gate.sh` on h2puni's build checkout at the branch head; output in verify.md
- [x] 8.3 `bunx @fission-ai/openspec@1.3.0 validate --all --json`; PR
