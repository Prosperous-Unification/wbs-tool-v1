<!--
INTENT. Hard cap: 400 words excluding these comments.
Interview: this session's scope decisions with Dany on 2026-09-06 — everything
newest, oxc excluded, dagger bumped on the host too. Trial measurements are in
design.md.
-->

## Why

The toolchain lags on every axis at once: Bun 1.3.14 in CI against 1.4.0 locally, Nx 22.7, TypeScript 5.9 with 7 stable, Vitest 1 under Vite 7, React 18, TanStack Table 8, drizzle on a beta behind the RC. Every new dependency is chosen against old peers, and the pins disagree with each other. Once is cheaper than piecemeal.

## What Changes

**Every dependency at its newest stable, RC where that is the line the repo is on**

- From: the versions in `package.json` at `a91f831b`.
- To: Bun 1.4.2, Nx 23.2, TypeScript 7.0.2 for `tsc` with the TS 6 API for ESLint, Vite 8, Vitest 5, React 19, TanStack Table 9, drizzle 1.0.0-rc.4, jose 6, ESLint 10, Playwright 1.63, dagger 0.21.9, and every minor behind them.
- Impact: nothing user-visible; gates, images and h2puni move together.

**Version pins become checks**

- From: Bun's version typed in six files, the dagger engine tag a literal, ESLint detecting React's version.
- To: one `.bun-version`, the engine tag derived from the SDK, the ESLint React pin equal to installed React, each with a test that fails when one side moves.
- Impact: drift that ships silently today fails the test tier.

**Tests that went red in the trial stay the arbiter**

- OpenAPI freshness, constraint translation and built chunks failed for real reasons. The code is made right; no test is loosened.

## Non-Goals

- oxlint / oxfmt. Decided against.
- Elysia 2 beta, React canaries, Vite 8.3 beta, Prettier 4 alpha.
- Rewriting `wbs-table.tsx` beyond Table 9's API.
- The pre-existing 1268px pin failure in `project-settings.spec.ts`, unless it is ours.

## Constraints

- No migration: blue/green shares one SQLite file.
- `bun.lock` stays at v1; the v2 migration is a later commit once every consumer runs 1.4.
- typescript-eslint requires TS `<6.1` and TS 7 has no compiler API until 7.1, hence two TypeScript packages.
- eslint-plugin-react 7.37.5 crashes on ESLint 10 unless `settings.react.version` is explicit.
- The dagger CLI on h2puni must equal the engine tag and the SDK.

## Capabilities

### New Capabilities

- `toolchain-versions`: the pins agree with each other, and a test says so.

### Modified Capabilities

- none

## Domain Terms

none

## Decisions Recorded

none — every choice reverses with a version bump.

## Impact

All apps, libs and tools; CI; four Dockerfiles; every tsconfig; `eslint.config.js`; `lefthook.yml`; the prod runbook; dagger on h2puni.
