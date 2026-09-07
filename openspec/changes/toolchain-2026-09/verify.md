# Verification Report

**Change**: `toolchain-2026-09`
**Verified at**: `2026-09-06` (gate output appended below when each run landed)
**Verifier**: Claude Fable 5.1, session `011WLwme2wa8FjBvBaBUsj2Z`, worktree `.claude/worktrees/toolchain-2026-09`

Everything ran under Bun 1.4.2 (a scratch install prepended to `PATH`; the box's own Bun is 1.4.0)
against branch `toolchain-2026-09`. Suite counts are the runs' own summary lines.

---

## 1. Structural Validation

- [x] `openspec validate --all --json` — `{"summary":{"totals":{"items":40,"passed":40,"failed":0}}}` at plan time; re-run in §5.

---

## 2. Task Completion

| Task | Reason incomplete                                                                                                                                  | Blocks archive? |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 7.3  | `project-settings.spec.ts`'s 1268px toolbar pin fails on this box on **main** too (Playwright 1.62 and 1.63 alike, four runs); dispositioned in §4 | no              |

---

## 3. Delta Spec Sync

| Capability           | Sync status | Note                                                                                                                                                 |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolchain-versions` | ✗ pending   | four requirements, each backed by a test in `tools/tool-devsync/src/toolchain-pins.test.ts` or `tools/tool-dagger/src/main.test.ts`; sync at archive |

---

## 4. Failure Proofs

Every row was **watched**, in the order written; the quoted text is the run's output.

| Check (file:line)                                                                                    | Fault injected                                                                   | Test that observed the failure                                                                                                                               | Result                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/tool-devsync/src/toolchain-pins.test.ts` — every `FROM oven/bun:` tag equals `.bun-version`   | `apps/be-01/Dockerfile` first stage back to `oven/bun:1.3.14-alpine`             | `every Bun image tag equals .bun-version`                                                                                                                    | `- [] / + [ "apps/be-01/Dockerfile: 1.3.14" ]`                                                                                                                               |
| same file — CI reads `.bun-version`                                                                  | `bun-version: 1.3.14` put back in the `pixels` job                               | `CI reads the file rather than a literal`                                                                                                                    | `Expected: 0 · Received: 1`                                                                                                                                                  |
| same file — the two TypeScripts                                                                      | no alias at all (tsc 5.9.3)                                                      | `the typescript package is the TS 6 API build`, `tsc on the workspace path is TypeScript 7`                                                                  | `Expected: "6" · Received: "5"`; `Received: "Version 5.9.3"`                                                                                                                 |
| same                                                                                                 | the two aliases swapped                                                          | same two                                                                                                                                                     | `Expected: "6" · Received: "7"`; `Received: "Version 6.0.3"` (a transitive TS owned `.bin/tsc`)                                                                              |
| same file — ESLint's React pin                                                                       | pin set to `18.3.1`                                                              | `the React version ESLint is told › is the one installed`                                                                                                    | `Expected: "19.2.8" · Received: "18.3.1"`                                                                                                                                    |
| `apps/be-01/src/repository/constraint.ts` — `messagesOf` walks `cause`                               | walk cut to the outer message                                                    | `patchTeam › answers 409 taken…`, `patchPerson › …`, `the service commands › …`, `finds the index name one cause down`, `finds a foreign key one cause down` | three 500s where a 409 was owed; `Expected: true · Received: false` ×2                                                                                                       |
| `apps/be-01/src/repository/constraint.db.test.ts` — the wrapped-error cases (production shape)       | the bump itself, before the fix                                                  | 23 be-01 tests                                                                                                                                               | `Received: "DrizzleQueryError: Failed query: …"` where `/UNIQUE/` and `/FOREIGN KEY/` were expected; controllers answered `JSON Parse error: Unexpected identifier "Failed"` |
| `apps/fe-01/src/components/wbs/reference-set-field.tsx` — `REFERENCE_SET_EDGE_FADE` without `calc()` | constant set to `''`                                                             | `keeps the truncation fade on the rested strip, and off the open one`; `fades and clips the rest line, and does neither while editing`                       | `expected '' to contain 'linear-gradient'`; `expected '' to contain 'linear-gradient(to left'`                                                                               |
| `apps/fe-01/src/components/wbs/plan-dependencies.test.tsx` — render cost on the pointer's real path  | a table `setHoveredCell` toggle on the pill's enter                              | `narrowing to a pill re-renders the row whose light moved and nothing else`                                                                                  | `expected 4 to be less than or equal to 2`                                                                                                                                   |
| `apps/fe-01/src/components/wbs/wbs-table.tsx` — `autoResetExpanded: false`                           | the line removed                                                                 | 69 jsdom tests, `types a three-level breakdown without touching the mouse` among them                                                                        | `expected [ '010' ] to deeply equal [ '010', '010.1' ]`, `expanded` read back as `{}` after the refetch                                                                      |
| `apps/fe-01/vite-config.test.ts` — the vendor chunk as a rolldown group                              | the group's `test` narrowed (Proof already on the test, re-run on the new shape) | `the built chunks`                                                                                                                                           | as its Proof states                                                                                                                                                          |
| `apps/fe-01/src/components/wbs/depends-card.tsx` — a pill under the pointer is the pill's to report  | the early return removed                                                         | `narrows to one pill when the pointer settles on it, from the cell` + three of `hover-cards.spec.ts` (Chromium)                                              | `- Expected - 0 / + Received + 1` (`['040','050']` for `['040']`)                                                                                                            |
| same file — a scroll inside the owner cell does not close the card                                   | the early return removed                                                         | `travels through passive card space to the third row…` (Chromium)                                                                                            | `the owner did not open its dependency card · Expected: 1 · Received: 0`                                                                                                     |
| `tools/tool-dagger/src/main.test.ts` — runbook names the SDK's dagger                                | runbook left at v0.21.8 with the SDK at 0.21.9                                   | both runbook cases                                                                                                                                           | `Expected to contain: "\`dagger\` v0.21.9"`; `… "registry.dagger.io/engine:v0.21.9"`                                                                                         |
| `tools/tool-dagger/src/main.ts` — `ENGINE_IMAGE` derived from the SDK                                | pinned back to the v0.21.8 literal                                               | `engineCreateArgs › pins the engine image…`, two `assertEngineContract` cases                                                                                | `engine image mismatch: expected registry.dagger.io/engine:v0.21.8`                                                                                                          |

Mechanisms that were **measured rather than assumed**, because the first theory for each was wrong:

- The jsdom mask fade: not `-webkit-` vs unprefixed (both survive), but jsdom 30 dropping any gradient
  with a `calc()` stop. Probed with three orderings under React; the `calc()` form vanished in all.
- The React 19 render-cost test: no `useState` in the table changed (a wrapped `useState` logged nothing),
  yet the table rendered once; RTL's `mouseEnter` is an enter-from-outside chain, and the pointer's real
  path (`mouseout` with the pill as `relatedTarget`) costs zero renders. The fault it guards still fails it.
- The four Chromium failures: bisected to the React 19 commit; three console probes in Chromium showed
  `settle(cell) → pill enter → settle(pill) → onPointEntry(null)` and `clear scroll target=SPAN inCard=false`
  — the card's effect-attached document listeners now run inside the gesture that opened the card.
  A first guess (guarding the cell's own write) was reverted after it changed nothing.
- Table 9's `autoResetExpanded` default: instrumented the row model, atom and `expanded` state at the
  failing assertion; `{}` after the refetch, with the core model still holding the child.

Pre-existing, not this change's, and not hidden:

- `apps/fe-01/e2e/project-settings.spec.ts` › `the toolbar keeps its 1280 budget with one settings
control`: `1268px of controls to lay out, against the 1265px this change left` — identical on `main`
  (Playwright 1.62, Chromium 151) and on this branch (1.63, Chromium 153), twice each. Font metrics on
  this box are the likely difference; the h2puni gate's `pixels`-equivalent will say.
- `apps/be-01/drizzle.config.ts` and `apps/be-01/tools/capture-capacity-oracle.ts` are outside every
  tsconfig and every lint target, as before this change.
- h2puni's `/tmp` was at 80% (6.1 GiB of 7.7 GiB) on 2026-09-06; `bin/publish-release.sh` refuses above 25%.

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [x] Where code distinguishes filesystem state, both absence AND unreadability were tested — n/a: the
      SDK-version read throws on absence (`Bun.file().json()` on a missing file) and on a malformed
      version; no check here branches on unreadability
- [x] No row relies on an exit code unless the tool's contract guarantees the effect

---

## 5. Gate Output

### Local, worktree `.claude/worktrees/toolchain-2026-09` at `9b40ec18`, Bun 1.4.2

- [x] `bunx nx format:check --all` — no output (clean)
- [x] `bunx @fission-ai/openspec@1.3.0 validate --all --json` — `{"items": 40, "passed": 40, "failed": 0}`
- [x] `bunx nx run-many -t test lint typecheck build --parallel=2 --skip-nx-cache`

```
 NX   Successfully ran targets test, lint, typecheck, build for 22 projects
  Run duration:      5m 55s
```

The first run of this gate, at `36526fd6`, ended `1 of 77 failed: tool-devsync:test` —
`every cached target declares what it reads` naming `tool-dagger:test does not declare
docs/runbook-prod-deploy.md`. Fixed in `9b40ec18` (§8.1's commit), which also declares the
reads that checker cannot see; the second run above is the whole gate again, not the one task.
Two earlier attempts were killed by this box for memory while other sessions' suites ran
beside them; `--parallel=2` is what fit.

### h2puni, `bin/h2puni-gate.sh` from `/home/puni1/wt-wbs-toolchain-2026-09` at `9b40ec18`, Bun 1.4.2

- [x] the canonical gate, host-wide lock taken, `--parallel=2`

```
gate-exit=0
 NX   Successfully ran targets test, lint, typecheck, build for 22 projects
  Run duration:      6m 27s
```

Three runs before this one, each with its reason: at `36526fd6` the same single
`tool-devsync:test` failure the local gate found (8m 26s); then twice at `9b40ec18` with one
red task, `tool-dagger:test`'s `refuses immediately with exit 75 while another heavy operation
owns the lock` timing out — because the driver script had exported
`HEAVY_LOCK_WAIT_SECONDS=3600` to queue behind two other agents' gates, and that variable reached
the test's own child `with-heavy-lock.sh`, which then waited instead of refusing. The suite
passed standalone on the host between those runs (49/0); the run above is the gate launched
without the variable. The build checkout `/home/puni1/wbs-build` was not used: it carried an
uncommitted edit and its `main` was held by another worktree.

The browser gate is not part of `bin/h2puni-gate.sh`; its run is §4's Chromium rows
(`bun run e2e` on this box: 288 passed, 1 skipped, 5 failed before §7.3; deps-cell + hover-cards
38/38 after; the 1268px pin pre-existing).

### After merging `origin/main` (56 commits) into the branch — head `59359d2a`

Four conflicts (be-01's Dockerfile, `tsconfig.base.json`, the calendar marker service,
`work-item-deadline/tasks.md`) and main's new code under this branch's rules — nine
`() => void (x += 1)` callbacks, one `void exhaustive;`, one caught error without its cause — are
in the merge commit's message. Thirteen module-boundary errors on the first whole-tree lint were a
stale Nx project graph that predated main's new `solver-supervisor-protocol` library; rebuilt, none.

- [x] Local: `nx run-many -t test lint typecheck build --parallel=2` — 81 of 82 tasks green;
      `solver-py:test` red for want of OR-Tools on this box, which CI installs from
      `libs/solver-py/requirements.lock`; with that lock in a scratch venv on `PATH` the target
      answers `Ran 193 tests … OK`. `nx format:check --all` clean, OpenSpec 40/40.
- [x] Browser, this box: `292 passed, 1 skipped, 1 failed` — the same `project-settings.spec.ts`
      pin (`1268.46875` against main's new `1265 + 2` allowance).
- [x] GitHub CI on `59359d2a`: `gate` pass (12m31s), `pixels` pass (21m21s) — the pin passes
      on the runner's fonts, which settles it as this box's.
- [x] h2puni: `bin/h2puni-gate.sh` at `59359d2a` — `Successfully ran targets test, lint, typecheck, build for 24 projects`, 6m 42s, with the solver venv on the driver's `PATH` (the run before it was red on `solver-py:test` alone).

Host note for main, not this change: h2puni's `python3` is PEP 668 externally managed and had no
OR-Tools, so `solver-py:test` — main's new target — is red in the canonical gate there for
everyone. A user venv at `/home/puni1/solver-venv` now carries the lock; `bin/h2puni-gate.sh`
itself does not put it on `PATH`.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree (after this report's own commit)
- [x] Relevant commits pushed to `origin/toolchain-2026-09`

**Commit range**: `a91f831b..HEAD` — sixteen slice commits, the merge of main, and this report

---

## Decision

- [x] ⚠️ PASS WITH WARNINGS — the `project-settings.spec.ts` 1268px pin fails on this box on `main`
      as well (§4), so it is not this change's to fix and does not block; h2puni's `/tmp` at 80%
      blocks the next publish, not this merge.

**Next step**: PR to `main`; after merge, h2puni's next `bin/publish-release.sh` builds with
dagger 0.21.9 against a fresh `wbs-dagger-engine` (the v0.21.8 one is set aside by name) — clear
`/tmp` first, and run the prod dry-run before executing.
