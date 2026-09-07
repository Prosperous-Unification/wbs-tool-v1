# TASK-348 — toolchain-2026-09

State dump written 2026-09-07T15:58Z at the request of the repository owner, so
the branch carries its own current state rather than leaving it in a PR
description written against an older head.

- **Branch:** `toolchain-2026-09`
- **PR:** [#248](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/248)
- **Head at dump:** `34d54c8169028be07aeb761a60d28f23e784e1e5`
- **Head author/date:** Dany Fedorov, 2026-09-07 18:42:31 +0300 — a merge of
  `origin/main` into the branch
- **Position:** 63 commits ahead of `origin/main`, 0 behind
- **Queue task:** TASK-348 (`backlog/tasks/task-348 - toolchain-2026-09-upgrade.md`),
  filed retroactively — the branch had no owning task, so it appeared in no
  lane's pick order and nothing was watching its CI.

## What the branch does

The whole toolchain moves in one gated change, OpenSpec
`openspec/changes/toolchain-2026-09` (intent, design, delta spec
`toolchain-versions`, tasks, verify), one commit per slice:

- **Bun 1.4.2** pinned once in `.bun-version`; CI reads it, a test holds the
  four Dockerfiles to it.
- **Nx 23.2** core only — `@nx/vite` and `@nx/vitest` dropped, no target used them.
- **TypeScript 7.0.2** for `tsc`, with the TS 6 API build under the `typescript`
  name for typescript-eslint. No `baseUrl`, relative `paths`, a test pins both
  majors.
- **Vite 8, Vitest 5, jsdom 30, React 19.2, TanStack Table 9,
  testing-library 16, react-hooks 7** — with the fix each needed
  (`autoResetExpanded: false`; the dependency card no longer overruled by its
  own listeners under React 19; `REFERENCE_SET_EDGE_FADE` without `calc()`).
- **drizzle 1.0.0-rc.4** (constraint matching walks `cause`), **jose 6**,
  **Elysia 1.4.30**, OpenAPI re-emitted at 3.1.2, the OpenTelemetry set.
- **ESLint 10** and plugins; eleven caught errors gained their `cause`, and the
  `void x;` idiom became an unused-vars policy.
- **Prettier 3.9.6** reformat (three `tasks.md` files it never settles on are
  excluded, with the reason), **lefthook 2**, **Playwright 1.63**.
- **dagger 0.21.9** — engine tag derived from the SDK, runbook held to it by a
  test; h2puni has the CLI, the engine image and Bun 1.4.2.

Not taken: oxlint/oxfmt (decided against), Elysia 2 beta, React canaries,
Vite 8.3 beta, Prettier 4 alpha.

## CI at this exact head — still running, and the run before it was red

Read from the runs rather than the PR body's prose:

| Run                                                                                           | Head                 | Result                                                 |
| --------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------ |
| [34139811510](https://github.com/Prosperous-Unification/wbs-tool-v1/actions/runs/34139811510) | `34d54c81` (current) | **in_progress** at the time of this dump               |
| 34134942049                                                                                   | `683d9f37`           | **failure** — `gate`, at the _Solver image smoke_ step |
| 34124024468                                                                                   | `88d4eaff`           | success                                                |

The failure at `683d9f37` is `NX Running target solver-image-smoke for project
be-01 failed`. The run at the current head was started by the `origin/main`
merge and had not finished when this was written, so **there is no green at
`34d54c81` yet** — the PR body's "local 22/22, h2puni gate green at `9b40ec18`"
describes a much earlier head.

## What remains

1. Read run 34139811510 to completion at `34d54c81`. If solver-image-smoke
   fails again, that is the gate to fix, not a flake to re-run — it already
   failed once at `683d9f37`.
2. **Prod-publish blocker carried from the PR body:** h2puni's `/tmp` is at 80%
   and the publisher refuses above 25%. This blocks the publish path at merge
   time, not the branch. Clear it or dispose it before merging.
3. The 1268px toolbar pin in `project-settings.spec.ts` is dispositioned in
   `verify.md` as failing identically on `main`; that disposition should be
   re-checked against current `main`, since `main` has moved a long way since it
   was written.
4. Merge, or record why it is being held.
