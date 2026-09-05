# Refactoring plan — 2026-09-02

File-by-file review of `main` @ `3346bb15` for three kinds of refactoring — code reuse,
performance, and readability with DDD — ordered so that every step makes the repo cheaper
for an LLM agent to edit safely. Six read-only sweeps, one per area, each opening every
non-test file in scope; the sweeps' full ledgers are in
[`2026-09-02-refactoring-review/`](2026-09-02-refactoring-review/README.md). Nothing was
changed by the review.

This extends [`2026-08-30-sustainability-audit.md`](2026-08-30-sustainability-audit.md),
which is three days and 155 commits old. Where the audit's project-level findings still
hold they are cited by their audit id (R1–R6, D1–D7, C1–C7, L1–L8) rather than restated.
What is new here: the per-file ledgers, a performance axis the audit did not have, a
re-measurement of every number the audit gave, and an ordering built around three
agentic-workflow costs rather than around LOC.

Vocabulary: **module / interface / seam / adapter / depth / leverage / locality** as defined
in `.claude/skills/improve-codebase-architecture/LANGUAGE.md`; domain nouns from
`CONTEXT.md`.

**Current follow-up, 2026-09-06:** [§67](#67--review-follow-up--2026-09-06) adds eleven
implementation findings as ten ordered slices, including two defects in W2-1's completed
optimizations. The five design findings are incorporated in the
[ports-and-adapters plan §11](2026-09-05-ports-and-adapters-plan.md#11--repository-review-incorporated--2026-09-06).
Earlier measurements and completion entries below remain historical evidence, not proof
that these newly tested windows are covered. All §67 implementation slices are **not started**.

## 0 · What the review is optimising for

Three costs decide whether an agent can change this repo without breaking it. Every item
below is placed by which of the three it lowers.

1. **The read set.** How many lines must be loaded to change one concept. Today: one column
   in the plan table is ~165k tokens (`wbs-table.tsx`, 12,183 lines) plus ~230k for its test
   (`wbs-table.test.tsx`, 16,855 lines); one store in be-01 is ≥3,773 lines of barrel before
   the file itself; one command kind is seven files that do not link to each other.
2. **The honest check.** Whether the command an agent runs after an edit can fail. Today
   **18 of 23 `typecheck` targets compile nothing** (solution-style tsconfig, the fault
   CLAUDE.md records as R5 #16/#17, still live for every lib and every tool); the canonical
   gate runs `--skip-nx-cache` so cache-input mistakes are masked; there is no sub-minute
   test tier for be-01 or fe-01; Playwright runs 229 cases on one worker.
3. **One place per rule.** Whether a rule is stated once and enforced, or restated in prose
   at N sites. Today the write vocabulary is written in seven places, the "columns may depend
   on three values" rule ten times, the 401 guard 23 times, the localStorage trio eleven
   times, `stampFor` seven times, and three comments in be-01 assert things the code no
   longer does.

Performance is a fourth axis with its own section, because the review found real
algorithmic and I/O costs the audit did not look for — but it ranks after the three above
where they compete, because a performance fix made against a gate that cannot fail is the
repo's own recorded failure mode.

## 1 · Numbers, re-measured

| Measure                                    | Audit (08-30)               | Now (09-02)                                        | Source                            |
| ------------------------------------------ | --------------------------- | -------------------------------------------------- | --------------------------------- |
| `wbs-table.tsx` file / `WbsTable` fn       | 11,265 / 8,820              | **12,183 / 9,418**                                 | sweep C §0, with the commit table |
| `wbs-table.test.tsx`                       | 15,570 LOC, 552 cases, 182s | **16,855 LOC, 585 cases**                          | sweep C                           |
| `repository/index.ts` / `schema.ts`        | 1,903 / 1,429               | **2,017 / 1,756**                                  | sweep A                           |
| `libs/domain` tests                        | 128 in 0.2s                 | 145 in **0.29s**                                   | sweep F, measured                 |
| `apps/be-01` tests                         | 1,203 in 26.6s              | 1,261 in **55.8s**                                 | sweep F, measured                 |
| eslint be-01 cold / `--cache` warm         | 41s / 2.5s                  | **14.7s / 2.4s**                                   | sweep F, measured                 |
| eslint libs/domain cold / warm             | 12s / —                     | **5.3s / 1.3s**                                    | sweep F, measured                 |
| `nx format:check --all` vs prettier direct | 44s vs 14s                  | **18.9s vs 17.7s** — the audit's win is withdrawn  | sweep F, measured                 |
| `typecheck` targets compiling nothing      | (be/gw fixed)               | **18 of 23**                                       | verified by hand, §3 W0-1         |
| Write-vocabulary copies                    | 5                           | **7** (`DIRECTORY_KINDS`, `compensating.COMMANDS`) | sweep B                           |
| localStorage trio copies                   | 9                           | **11**                                             | sweep D                           |
| `live.current` keys / read sites           | —                           | 82 / 159                                           | sweep C                           |
| `listByProject` call sites in one service  | —                           | 44                                                 | sweep B                           |
| Per-command queries in a 200-write batch   | —                           | ~1,200, ~400 full-project scans, inside the lock   | sweep B, traced                   |
| Requests per write or peer frame, fe-01    | —                           | **8** (tree + steps + 5 directory lists + people)  | verified by hand                  |
| Playwright                                 | —                           | 229 cases, `workers: 1`, ~15 min of a 25 min cap   | verified by hand                  |

Audit findings whose status changed: **D3 is closed** (`tags-accumulate` merged; ADR 0008
exists on `main`). **D6 mutated** — the two controllers are no longer registered, but the
files keep `.controller.ts` names, register no route, and three comments still describe
registering them. **C1, C2, C3, D7, R5 hold** unchanged (`openspec/specs` absent;
`config.yaml:31` still says "There is no CI"; `AGENTS.md` is 475 lines; `BatchResult` /
`ItemState` / `result` in nine outcome types; 23 `userFromHeaders` sites).

## 2 · Findings the audit did not have

Defects and dead paths found by reading every file. These are not refactorings; they are
the reason Wave 0 exists, and most are under an hour each.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                                   | Verified      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------- |
| N1  | A `.derive()` computes `requestIdentity` — a JWT verify plus a `users.findById` — on **every** request including `/health`, and nothing reads it. Writes pay authentication three times.                                                                                                                                                                                                                            | `apps/be-01/src/app.ts:171–173`                                                         | ✔ grep        |
| N2  | Three indexes exist in the database and not in `schema.ts` (`actual_by_step`, `step_measure_by_step`, `step_progress_by_step`); `step.ts` comments claim to read through them; the next `drizzle-kit generate` drops them. Four indexes the `WHERE` clauses want are absent everywhere.                                                                                                                             | `drizzle/20260831120000_rename_role_to_step/migration.sql:74–78`, `schema.ts`           | ✔ diff        |
| N3  | `toProject` spreads `...rest`, so `updated_at` and `created_by` (a user id) reach `GET`/`PATCH /api/projects/:id`; its JSDoc claims the opposite. Two more bare reads break the folder's own column-list convention.                                                                                                                                                                                                | `repository/project.ts:74–146, :373`; `work-item.ts:547`; `directory.ts:127`            | sweep A       |
| N4  | Three services publish a broadcast **inside** the write lock and the outer transaction, against the runner's own watched invariant; a directory rename touching K projects does K sequential gw-01 pushes with up to ~63s of retry each, lock held.                                                                                                                                                                 | `capacity.service.ts:96`, `priority-band.service.ts:84`, `directory.service.ts:662–666` | sweep B       |
| N5  | `announceWorkItem`, `withAncestors` and the `work_items_changed` event are unreachable in production (every mutator runs inside `collect()`); the one-item path computes a full schedule and discards it.                                                                                                                                                                                                           | `work-item.service.ts:3945–3956`, `broadcast.ts:7–13, :108–125`                         | sweep B       |
| N6  | `libs/realtime` has **zero importers** (one path string in devsync); the live client is `fe-01/src/lib/project-stream.ts`. `contracts/ws.ts` types `resume_denied.reason` as `'out_of_range'` while gw-01 sends `'unavailable'`. Four `WsFrame` declarations.                                                                                                                                                       | `libs/realtime/**`, `libs/contracts/src/ws.ts:23`, `gw-01/ws.controller.ts:103`         | ✔ grep        |
| N7  | `parseOrThrow` puts `JSON.stringify(input)` in its thrown message, so be-01/gw-01 boot failures print `JWT_SIGNING_KEY_CURRENT`; mcp-01 refuses `defineConfig` for exactly this and says so.                                                                                                                                                                                                                        | `libs/validation/src/core.ts:15`, `apps/mcp-01/src/config.ts:44–48`                     | sweep E       |
| N8  | mcp-01's OAuth transaction store re-implements `libs/auth`'s less safely: verbatim binding key vs a sha256 digest, `!==` vs `timingSafeEqual`. Its caller passes verified claims the callee's signature does not accept, so every request verifies twice.                                                                                                                                                           | `apps/mcp-01/src/oauth.ts:316, :345, :170`, `caller-auth.ts:32`                         | sweep E       |
| N9  | `step.service.ts`'s fast-path predicate has drifted from the authoritative one in the store (omits actuals, progress, measures); no test compares them.                                                                                                                                                                                                                                                             | `step.service.ts:212` vs `repository/step.ts:373–380`                                   | sweep B       |
| N10 | Seven Nx targets read `bin/*.sh` and `deploy/compose/*` and declare none as inputs; editing `bin/dev-deploy.sh` invalidates nothing. Masked, not fixed, by `--skip-nx-cache` in the gate.                                                                                                                                                                                                                           | `bin/h2puni-gate.sh:9`, seven `project.json`                                            | ✔ grep        |
| N11 | The presence panel opens a **second** WebSocket by hand with no reconnect; one drop and the roster reads `(closed)`.                                                                                                                                                                                                                                                                                                | `components/presence/presence-panel.tsx:14–47`                                          | sweep D       |
| N12 | Every `ws.send` in gw-01 discards Bun's return value — no backpressure signal at all, including on the fan-out the metrics claim to count. gw-01's OTel `/metrics` is always empty; it serves a second hand-rolled snapshot instead.                                                                                                                                                                                | `apps/gw-01/src/app.ts`, `presence.ts:121`, `gateway-metrics.ts:46`                     | sweep E       |
| N13 | Stale text an agent will trust: `hand-parsed-body.ts:13` names eight routes none of which exist; `app.ts:181–192` and `history.controller.ts:49` register controllers that are gone; `plan-command-schema.ts:19` ships "The step (step)" to MCP clients; `openapi-tools.ts:199` says 40 of 51 operations (30, 27 without prose); mcp-01 README says 20 tools, its test asserts 22; `LLM_README` lists table `role`. | as named                                                                                | sweep B/E     |
| N14 | Dead code that reads as live: `repository/example.ts`, `fe-01/src/db/config.ts`, `components/smoke/**` (the only `d3` importers), `libs/scripts` (0 consumers), `tool-dagger/src/{be-01,gw-01,fe-01}.ts` (~220 LOC describing a retired tarball format), two SSH builders, `observability/metrics.ts`, `contracts/errors.ts`, `validation/branded.ts`.                                                              | as named                                                                                | sweep A/D/E/F |

## 3 · The plan

Five waves. Each wave is safe to start when the one above it has landed; items inside a wave
are independent unless a **needs** column says otherwise. Effort is one agent's, verified
per the R5 rule (negative watched failing, `Proof:` written from the output). Every item
that changes observable behaviour is an OpenSpec change; most Wave 0 items are fixes that
restore an already-precise spec and need none.

### Wave 0 — make the gate honest, remove the defects (≈ 3 days)

The cheapest wave and the one every later wave depends on: nothing below can be verified
until the type checks compile files and the cache reads the right inputs.

| Id    | Change                                                                                                                                                                                                                                                                                   | Files                                                                | Effort | R5 negative                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| W0-1  | **Done, 2026-09-02** — see §6. `tsc --noEmit -p <solution>` → `tsc --build --force` in the 18 vacuous `typecheck` targets, and `libs/auth` unified onto the same form so all 23 read one way. 12 latent type errors fixed, `@types/node` bumped 18.16.9 → 22.18.0, one guard test added. | 19 `project.json`; 7 source files; `package.json`                    | 1h + ? | `const x: number = 'no'` in `tools/tool-remote-scripts/src/swap.ts`, watched red                                     |
| W0-2  | **Done, 2026-09-02** — see §7. Nine targets across six projects read files outside their own project and declared none. Declared precisely, per target. `--skip-nx-cache` **kept** in the release gate, deliberately; see §7.                                                            | `nx.json` or 7 `project.json`; `bin/h2puni-gate.sh`                  | 2h     | edit `bin/dev-deploy.sh`, assert the shellcheck target re-runs                                                       |
| W0-3  | **Done, 2026-09-02** — see §8. Deleted. The waste was larger than N1 said: a read route resolved the caller twice, not once.                                                                                                                                                             | `app.ts:171–173`                                                     | 15m    | a counter on `AuthService.authenticate` per `/health`: 1 → 0                                                         |
| W0-4  | **Done, 2026-09-02** — see §16. Seven indexes declared, four created by an additive migration, and a diff test that would have caught the drift.                                                                                                                                         | `schema.ts`, `drizzle/`, new `schema-indexes.test.ts`                | 4h     | remove one declared index, watch the diff test name it                                                               |
| W0-5  | **Done, 2026-09-02** — see §15. All three closed; the leak was measured on the wire first, and one column list now serves two readers.                                                                                                                                                   | `repository/project.ts`, `work-item.ts`, `directory.ts`, `schema.ts` | 6h     | `created_by` asserted absent from `GET /api/projects/:id` body                                                       |
| W0-6  | **Done, 2026-09-02** — see §17. One `DeferringBroadcaster` the runner holds; the negative it needed did not exist and now does.                                                                                                                                                          | `plan-commands.ts`, the three services                               | 1.5d   | extend "lets go of the write lock before the broadcast leaves" to a directory command; today it proves nothing there |
| W0-7  | **Done, 2026-09-02** — see §10. Ten call sites moved to the surviving shape; `announceWorkItem`, `withAncestors` and `work_items_changed` deleted.                                                                                                                                       | `work-item.service.ts`, `broadcast.ts`                               | 4h     | deletion test — grep confirms one non-test reference each                                                            |
| W0-8  | **Done, 2026-09-02** — see §12. `parseOrThrow` stops echoing the input; a new `parseSecretsOrThrow` names paths only and `defineConfig` uses it.                                                                                                                                         | `libs/validation/src/core.ts`                                        | 2h     | watched failing against today's `core.ts:15`                                                                         |
| W0-9  | **Done, 2026-09-02** — see §11. One exported `stepIsInUse`, both callers route through it, two negatives watched.                                                                                                                                                                        | `step.service.ts`, `repository/step.ts`                              | 2h     | a step holding only actuals refused by the fast path                                                                 |
| W0-10 | **Done, 2026-09-02** — see §14. Five sentences corrected from the code; the README's tool count is now a test, watched failing two ways.                                                                                                                                                 | as named in N13                                                      | 2h     | the README test fails when a tool is added                                                                           |
| W0-11 | **Mostly done, 2026-09-02** — see §13. Nine modules and one whole library deleted. Two of N14's entries are **not** dead and were kept, with reasons.                                                                                                                                    | as named in N14                                                      | 3h     | deletion tests pass by construction; `tsc --build` (post W0-1) names any survivor                                    |
| W0-12 | **Done, 2026-09-02** — see §9. Both renamed with their tests, every reference rewritten, the orphan comments deleted, and `middleware/validate.ts` inlined into its one caller.                                                                                                          | `apps/be-01/src/controller/`, `middleware/`                          | 1h     | `openapi-document.test.ts` already guards the route table                                                            |

### Wave 1 — the test infrastructure that makes every later wave verifiable in seconds (≈ 6 days)

The audit's L2/L3 with what the sweeps added. Zero production change in this wave.

| Id   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Files                                                    | Effort | Needs |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ | ----- |
| W1-1 | **Recorders done, the six fakes refused, 2026-09-02** — see §18 and §62. The rich fake is in `src/testing/` and typechecks, which found 11 divergences from `ProjectApi`. The record-and-delegate monkey patch — **45 copies across nine test files**, not the eight `watchX` the row counted — is one typed `recordCalls(api, method, of?)`, with the delegation's own negative. Folding the six other fakes into it is **refused with the files' own words**: each is that file's spec and says so. | new; 7 test files                                        | 1.5d   | —     |
| W1-2 | **Done, 2026-09-02** — see §22. Eleven files, all 585 cases; the fe-01 suite goes 180s → **69s**.                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/fe-01/src/components/wbs/*.test.tsx`               | 0.5d   | W1-1  |
| W1-3 | **Done, 2026-09-02** — see §20 and §21. `inMemoryServices()` exists and **every in-memory suite** uses it, ~500 lines lighter. The audit's "24 files" was mostly T1 suites this harness cannot serve.                                                                                                                                                                                                                                                                                                 | new; 24 test files                                       | 2d     | —     |
| W1-4 | **Done, 2026-09-02** — see §23, §23.1 and §64. be-01 has guarded T0/T1 tiers and there is a root `test:unit` at 17s. fe-01's half is done **without the 55-file rename the row asked for**: `fe-01:test:unit` runs the DOM-free suites under `node` in **1.9s for 344 tests**, selected by a list that `src/test-tiers.test.ts` refuses to let drift. lefthook is still left alone, measured.                                                                                                         | every `project.json`, `vitest.config.ts`, `lefthook.yml` | 1d     | W1-2  |
| W1-5 | **Done, 2026-09-02** — see §19. A cached `lint:fast` on all 22 projects: 15.1s → 4.1s. The plan's lefthook half is **withdrawn**, measured worthless.                                                                                                                                                                                                                                                                                                                                                 | `project.json` ×N, `.gitignore`                          | 1h     | —     |
| W1-6 | **Investigated, not done, 2026-09-02** — see §24. The duplication is smaller than reported and the API-seeding idea conflicts with one spec's stated intent.                                                                                                                                                                                                                                                                                                                                          | `apps/fe-01/e2e/*`, `playwright.config.ts:165`           | 1.5d   | —     |

### Wave 2 — performance (≈ 10 days)

Ranked by cost removed per hour. Every item has a probe that can fail: a statement counter
through `db.ts`'s `logger` hook, a render-count spy in the shape `pointed-row-render-cost`
shipped, or a request counter on the fake API. **Inject the fault the check is about.**

| Id    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Files                                                                                                  | Effort | Probe                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| W2-1  | **Reopened, 2026-09-06 — §67 R1.** The deduplication (§25) and scope narrowing (§60) both shipped, but their overlap windows lose refreshes: a pre-edit GET is reused after a newer event, and a tree-only generation drops pending steps/directory. One invalidation coordinator fixes both before the generated client replaces this code.                                                                                                                                                                                                                                                                                                                                       | `lib/wbs-api.ts`, `lib/project-stream.ts:113`, `wbs-table.tsx:3671–3775`, `directory-page.tsx:256,342` | 1d     | "a peer edit costs 2 requests, not 8" — fails today                                |
| W2-2  | **Done, 2026-09-02** — see §28. All three memoised, with the label closures stabilised first, and a layout-count probe that took three attempts to stop being vacuous.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `wbs-table.tsx:10233, :10519, :10617`                                                                  | 0.5d   | `layOutGantt` call count across a keystroke: unchanged                             |
| W2-3  | **Two thirds measured and refused, 2026-09-02 — see §35.** `Promise.all` over the nine `tree()` reads buys **nothing** (`bun:sqlite` is synchronous: 14.40 ms either way), and the duplicate `deriveNumbers` is ~5% for a widened interface. The snapshot is the real item and is **architecture**, so it needs an OpenSpec change. Original: `PlanCommandRunner.execute` opens a plan snapshot before the loop; `contextFor`, `holdsStep`, the four `storedX` read it; mutators update it in place; the forward guards become pure functions of the snapshot. Also `tree()`'s 13 sequential awaits → `Promise.all`, and `schedule()` stops calling `deriveNumbers` a second time. | `work-item.service.ts` (44 `listByProject` sites), `plan-commands.ts:118–166`, `schedule.ts:1967`      | 4d     | statement count for a 200-command batch: ~1,200 → ~20                              |
| W2-4  | **Done, 2026-09-02** — see §27, §29 and §33. `dependsOn` and `topological` are linear. `eventAt` is **measured and refused**. `projectOntoWorkItems` is two loops instead of fourteen array allocations: ~8% faster, its `RangeError` cliff measured out of reach, and three defaults that read a broken index as a legal plan are now throws with all three faults watched.                                                                                                                                                                                                                                                                                                       | `work-item.service.ts:1531`, `schedule.ts:377–409, :729–735, :2130–2212`                               | 1.5d   | differential unchanged; `eventsVisited` bound now also counts moves                |
| W2-5  | **Done, 2026-09-02** — see §26 and §34. A freeze is one statement instead of one per row; a subtree delete is one `DELETE` rather than one per row, because SQLite checks an immediate foreign key at the end of the **statement**; and `removeAllFor` takes the whole doomed set, which also fixed a bump landing on a row already on its way out. Roughly `3N + 1` statements across `N + 1` transactions became 5.                                                                                                                                                                                                                                                              | `repository/work-item.ts:713–762`, `dependency.ts:90–111`, `work-item.service.ts:2258, :3520`          | 0.5d   | "a freeze costs one statement" via `db.ts`'s logger, as `project.test.ts:259` does |
| W2-6  | **Done, 2026-09-02** — see §53. `open?.sliceId` and `fullScreen` out of the 23-entry list via a mirror ref, behind the D4 probe on the new gesture; one `drawn` index for the four "is this bar drawn?" readers (**3.9×**) and for an arrow's obstacles by row (**3.1×**).                                                                                                                                                                                                                                                                                                                                                                                                         |
| W2-7  | **Half done, 2026-09-02** — see §56. `depHover` and `depFocus` are out of `WbsTable`'s state and in `dep-light-store.ts`: each `<tr>` asks "am I lit", an open card asks which entry is emphasised, and moving one row's light re-renders one row instead of the table (**4 → 1** row-equivalents, watched). The `hoveredCell`/`focusedCell`/`openCard` half is **deferred into W4-4**: its two remaining reads are `<td>` attributes (`aria-describedby`, the popover `zIndex`), so it needs the per-cell shell W4-4's restructure introduces, not a store on its own. `dropHint`/`widthOverrides`/`ganttHeightPx` untouched.                                                     | `wbs-table.tsx:3038–3067, :3248, :3284, :3309, :2845, :2857`, seven writer cells                       | 2d     | `flexibleCellStyle` call count across a hover: 0 delta                             |
| W2-8  | **One done, three refused with measurements, 2026-09-02** — see §54. A chart scroll reads **no** rect (the content width is the observers' job). The other three are already efficient, unsafe to cache, or bounded — each measured rather than assumed.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| W2-9  | **Done, 2026-09-02** — see §47 and §60. `addWorkdays` and `workdaysBetween` are closed form: **16.1× measured** at offset 250, behind a differential against the walk they replaced (3,500 exhaustive pairs plus 1,500 random). And `calendarScale` now remembers each whole workday's calendar offset for the life of one placement: **113 conversions became 12** on a 40-row plan, watched.                                                                                                                                                                                                                                                                                     |
| W2-10 | **Half done, 2026-09-02** — see §55. `/directory` and a vendor chunk are out of the first bundle: 796.82 kB became 511.85 + 269.37 + 15.43, with the `manualChunks` rule asserted both ways. `GanttPanel`/`PlanCards` are **refused** — a `lazy()` boundary there turns 2,063 synchronous assertions into `waitFor`s.                                                                                                                                                                                                                                                                                                                                                              |
| W2-11 | **Done bar a refusal, 2026-09-02** — see §57. The ⋯ menu's open id and the phone toolbar's open state are both out of the render path: opening `Plan actions` cost **5 card renders and now costs 0**, watched. The `PlanCard` shell itself is **refused with measurements**: at rest nothing else re-renders the list — a keystroke, a focus move and a field sheet are 0 renders each — and every prop the call site hands `PlanCards` is a fresh identity per render, so a `memo` shell would be a check that cannot fail until W4-4 stabilises them.                                                                                                                           | `plan-cards.tsx:1988–2557`                                                                             | 1.5d   | `cardTrioOf` spy delta when one menu opens                                         |
| W2-12 | **Original work done, 2026-09-02** — §24, §65, §66. **Follow-up, 2026-09-06: §67 R8.** The replay buffer's expiry fix stands, but its bounded-work claim is withdrawn: every record enumerates all subscription keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | as named                                                                                               | 1d     | each a one-line spy or count                                                       |
| W2-13 | **Done, 2026-09-02** — see §48. The roster rides the plan's own stream; the panel opens nothing and is presentational. It also fixes the caveat that panel documented — a dropped connection used to freeze the roster until a reload.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| W2-14 | **Original work done, 2026-09-02** — §49. **Follow-up, 2026-09-06: §67 R7.** Project rosters are indexed and frame outcomes counted, but every membership change still sends to all connections. Target delivery to affected projects; keep the deploy's `/metrics/snapshot`.                                                                                                                                                                                                                                                                                                                                                                                                      |

### Wave 3 — reuse: one implementation behind N names (≈ 12 days)

Each collapse is a **deletion test that passes**: remove the copies, route the callers, and
nothing else in the repo changes. Where the copy carries a comment saying "line for line" or
"deliberately shaped as a copy of", the comment is the bug report.

| Id    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Files                                                                                                                          | Effort | LOC out |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ------- |
| W3-1  | **Part done, part refused, 2026-09-02** — see §40. A satellite read is **one** statement (a join through `work_item`, where an id read plus `IN (…)` stood), and `rowsChanged` replaces five copies of `SELECT changes()` — one of which read `?? 0`. The one parameterised store is **refused**: three differences and a cast.                                                                                                                                                                                                                                                                              |
| W3-2  | **Done, 2026-09-02** — see §39. One `lib/remembered.ts` behind eleven copies, with `read`/`readAndDrop` and a **three-state** `Claim` (only one copy had the first, none had the second, and both are load-bearing). `rememberedText` for the one key stored as bare text; `project-page.tsx` deliberately not converted.                                                                                                                                                                                                                                                                                    |
| W3-3  | **Deferred to W4-4, 2026-09-02** — see §46. The four table columns it collapses are 263 of the lines W4-4 splits into `plan-columns/*`, and doing both means touching them twice. The adapter it would generalise (`ReferenceSetAdapter`) already exists and already holds the accumulate-vs-override rule.                                                                                                                                                                                                                                                                                                  |
| W3-4  | **Service half done, 2026-09-02** — see §41. Nine method bodies become one rule over a `NamedVocabulary<T>` descriptor; `directory-usage.ts`'s three lambdas become one. The store half is **refused** (a generic over a drizzle table needs a cast) and `plan-commands.ts`'s five triples wait for W4-3, as the plan itself says.                                                                                                                                                                                                                                                                           |
| W3-5  | **Done, 2026-09-02** — see §38. An Elysia macro `caller` resolving the identity once and handing the handler a non-null `user`; 23 five-line 401 blocks and the two scope checks are gone, the two cookie parsers are one, and `directory.controller.ts` is 69 → 40 lines. The injected fault found five of the six directory reads had **no** 401 negative; one case over all six now, watched.                                                                                                                                                                                                             |
| W3-6  | **Done, 2026-09-02** — see §42. `sentenceForRefusal` behind six fe-01 tables with the strings pinned first; one `FaultBoundary` where the class was written twice; `statusForRefusal(reason, otherwise)` behind be-01's five status tables — whose `unknown_ref` → 400 arm had **no test at all**.                                                                                                                                                                                                                                                                                                           |
| W3-7  | **Done, 2026-09-02** — see §37. One `Clock` with `stampFor`, built once in `services.ts`; the seven `private stampFor`, nine `now?` and six `newId?` are gone, `EventSequencer` is deleted, ADR 0012 gains its consequence line, and `clock.test.ts` guards the shape with both faults watched.                                                                                                                                                                                                                                                                                                              |
| W3-8  | **Done, 2026-09-02** — see §59. `@wbs/deploy-contract` carries `BUNDLE_FILES` and `bundleFilesFor(root)`, and the two copies it replaced disagreed about whether `remote` was absolute: the deploy checked dev's bundle and told the operator to run an installer that writes **prod's**. `install.ts` has `--env` (defaulting to `WBS_ENV`, so nothing that predates it moves), and both stale-bundle messages are built by `installCommandFor(host, layout)`, which names it. Three negatives watched. `sha256File`/`parseSha256sumOutput`/`assertCleanTree` are **left where they are**, with the reason. | `tools/tool-remote-scripts/src/lib/*`, `tools/tool-deploy/src/*`, `tool-dagger/src/lib/publish.ts`, `tool-smoke/src/health.ts` | 1d     | ~200    |
| W3-9  | **Done, 2026-09-02** — see §43. Fifteen hand-written frame literals become `ws-frames.ts`; the vocabulary was **wrong** in two places neither tier could see. The two socket clients no longer contradict each other about advancing the sequence. `tanstack-adapter.ts` deleted.                                                                                                                                                                                                                                                                                                                            |
| W3-10 | **Refused, 2026-09-02** — see §44. Adopting `InMemoryOidcTransactionStore` **changes two security behaviours** (a digested key, a timing-safe state compare), which is a hardening rather than a refactor, on the auth surface, with 24 capacity cases to move. It needs its own change with the negatives written first.                                                                                                                                                                                                                                                                                    |
| W3-11 | **Six done, two refused, 2026-09-02** — see §36. `isUniqueViolation` + `UNIQUE_INDEXES` with a pragma-and-live test the `role` rename would have failed, one `isWithin` where four copies stood, one `cleanName`, `STEP_COLUMNS` (whose "the type checks the list" comment could not fail and is now a test), one app fixture for the OpenAPI pair, one `forgetDraft`, a spread instead of 13 delegations, and `PlanRead` written once. Deleting `stepsOf` and `ProjectApi extends DirectoryApi` are **refused**, with reasons.                                                                              |

### Wave 4 — readability and DDD: knowledge lives with what it describes (≈ 18 days)

The structural moves. Each one turns a read set from "the file" into "the concept".

| Id   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Files                                                                                                                                                     | Effort | Needs                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- |
| W4-1 | **Measured and mostly refused, 2026-09-02** — see §30. The barrel is 70% JSDoc and 68 of its 76 types are store-port vocabulary. Four needless public names removed; the split is not warranted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `repository/index.ts`, every store                                                                                                                        | 2d     | W0-11                        |
| W4-2 | **Done, 2026-09-02** — see §31, §31.1 and §32. `derive-numbers`, `place-sibling` and the **schedule engine** are in `libs/domain`, with eight of its nine suites. `assumed-assignee.ts` and `roll-up.ts` still take repository types and did not move; `compensating.ts` stays by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/be-01/src/service/{schedule,dependency,derive-numbers,place-sibling,assumed-assignee}.ts` → `libs/domain/src/`, `revision.ts`                       | 2d     | W4-1                         |
| W4-3 | **The derivation is done; the registry is refused for this wave, 2026-09-02** — see §58. `PLAN_COMMAND_KINDS` is now `Object.keys` of a record checked `satisfies Record<PlanCommandKind, true>`, so the union and the enumeration cannot drift in either direction, and the commands document is checked **by kind** rather than by count — the count was blind to a kind described twice while another was described never. The descriptor rewrite itself needs an OpenSpec change: it moves the command vocabulary into `libs/contracts`, changes mcp-01's tool surface, and depends on Elysia 1.4's Standard Schema → JSON Schema export being verified first.                                                                                                                                                                                                                                                  | `libs/contracts/`, `plan-command.ts`, `plan-command-schema.ts`, `work-item.controller.ts:564–778`, `plan-commands.ts`, `apps/mcp-01/src/openapi-tools.ts` | 5d     | W3-4                         |
| W4-4 | **`WbsTable` concept split** into the fourteen modules sweep C maps with line ranges (`remembered-layout`, `use-plan-layout`, `use-column-set`, `use-plan-read`, `use-plan-filter`, `plan-toolbar`, `plan-export-actions`, `use-plan-keyboard`, `use-plan-structure`, `use-estimate-drafts`, `use-reference-sets`, `plan-columns/*` one file per column family with `columns` a 40-line registry, `plan-cell-props`, `plan-chart-input`), leaving ~1,000 lines of composition. Three things stay exactly as they are: `live` (the cells' contract), `PlanRow` and the pointed store, and the `columns` dep list — every extracted hook returns values read through `live`, never closed over in a cell. Give `live` an exported type so the "three deps" rule restated ten times becomes one declaration. Also: the 82-key `live` literal written twice (`:7070–7236`) becomes one local — 15 minutes, do it first. | `wbs-table.tsx`, 14 new modules                                                                                                                           | 4d     | W1-2, W2-2, W2-7, W3-2, W3-3 |
| W4-5 | **Done, 2026-09-02** — see §50. `useSettingsSection` is the five things all four panels held, and the two a new panel gets wrong — the withdrawal on unmount, and `busy` counting as unfinished — are the hook's now, both watched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W4-6 | **Done, and the rest refused, 2026-09-02** — see §51. The detail gesture's four pieces were 3,500 lines apart and are one file. The other two gestures the plan names are **already** adjacent (`fullScreen` at `:2350–2453`) or in another file — measured, not assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| W4-7 | **Done, 2026-09-02** — see §45. Nine outcome unions say `value`; `ItemState` → `WorkItemState`, `AuthResult` → `SignedIn`, and `BatchResult` → `AppliedCommand` because the plan's own suggestion **collides** with the existing `BatchOutcome`. `ProjectApi`'s eight bare verbs got their objects, compiler-driven, with the spec projects' pre-existing error counts as the evidence nothing else moved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| W4-8 | **The defects done, the rest left where the plan says, 2026-09-02** — see §52. `Service team`'s `_Avoid_` list forbade a word that is now a table, a route and an entity; eight settled nouns written down. One premise wrong: `Write lock` **does** exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| W4-9 | **Done, 2026-09-02** — see §52. Eight stubs replaced. `libs/domain`'s noun → module map is **asserted** by `readme.test.ts`, both faults watched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Not in this plan, on purpose

- **JSON-RPC envelope, Biome, oxlint, tsgo** — audit §7's verdicts stand; nothing changed.
- **Prettier direct instead of `nx format:check --all`** — withdrawn; re-measured at 17.7s vs
  18.9s on a different file set.
- **Memoising rows or cells while they depend implicitly on `live.current`** — refused by
  `pointed-row-render-cost`; a `memo` becomes silently stale on the first missed key.
  §67 R10 may replace those dependencies explicitly before adding viewport rendering;
  inserting memoization into the present contract remains out.
- **Generalising `effective-tag`'s walk into one a type dimension could reuse** — ADR 0009's
  absence is load-bearing. `effective-tag.ts:215`'s O(depth²) rebuild is a real cost and a
  fix must keep the ADR 0008 order, provenance and per-tag `fromId` shape, and re-watch its
  five `Proof:`s; it is deferred until a plan deep enough to feel it exists.
- **The knowledge pipeline** (audit #1: `openspec/specs`, archive-as-ingest, doc lint, the
  `AGENTS.md` ledger out to a doc) — still right, still compounding rather than per-edit; it is
  its own change and the OpenSpec archive trap (`openspec/specs` absent, MODIFIED deltas
  refused) is the first thing it has to solve.

## 4 · Order and totals

| Wave | Days | What an agent gets when it lands                                                                           |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------- |
| 0    | ~3   | `typecheck` compiles files; the gate reads the right inputs; six defects closed; the dead paths gone       |
| 1    | ~6   | a sub-second T0 in every project; `wbs-table` cases in four workers; a harness per app; e2e in ~5 min      |
| 2    | ~10  | a write is two requests and ~20 statements; a hover renders a card; the chart lays out on plan change only |
| 3    | ~12  | eleven rules stated once; ~3,700 LOC out; one envelope, one identity guard, one clock                      |
| 4    | ~18  | the read set for one concept is one module; the engine is a library; a command is one descriptor           |

Roughly fifty agent-days, in five PR-sized slices per wave. Waves 0 and 1 are the ones
whose absence has cost this repo the most — every entry in CLAUDE.md's ledger since
2026-08-09 was found by a browser, a screenshot, or running everything, because the gate
in front of it could not fail.

## 5 · Rules for agents that fall out of the review

Recorded here for `AGENTS.md`'s next edit, not added now.

- **A comment is a claim.** Three in be-01 assert facts the code no longer holds
  (`hand-parsed-body.ts:13`, `app.ts:181–192`, `directory.service.ts:653–657`) and one
  (`project.ts:373`) asserts the opposite of what its function does. Before building on a
  JSDoc sentence about _what calls this_ or _what this strips_, grep it.
- **`nx run <p>:typecheck` is a no-op for libs and tools until W0-1 lands.** The honest
  command is `bunx tsc --build <p>/tsconfig.json`.
- **A `.controller.ts` that registers no route, a `libs/*` with no importer, a `src/db/`
  the app does not use** — the tree carries dead signposts (N14). Check for an importer
  before editing what looks like the implementation.
- **The proofs are load-bearing and unindexed.** Dozens of `Proof:` comments name a test
  an edit must re-watch; there is no index from proof to test. Read the comment above the
  line before changing the line.
- **Cross-file contracts are `data-*` attributes and CSS variables found only by grep**
  (`data-modal-surface`, `data-grid`, `--cell-bg`, `data-plan-cards`). The writer never
  names the reader.

## Method

Six `Explore` sweeps on `main` @ `3346bb15`, each opening every non-test file in scope and
writing a per-file ledger (`file | LOC | role | reuse | performance | readability/DDD`)
with `file:line` anchors: A be-01 `repository/`; B be-01 `service/`, `controller/`, roots;
C the `WbsTable` cluster, section by section; D the rest of fe-01; E gw-01, mcp-01, every
lib; F tools, deploy, e2e, and the test infrastructure. Timings in §1 were measured by
sweep F on a Mac with the ESLint cache written to the scratchpad, never the repo. Claims
marked ✔ in §2 were re-checked by hand in the main session (grep or diff, output read);
the `startFloorByRow` render-body call, the eight-request `Promise.all`, the `<td>`
transition and the absence of `lazy()`/`manualChunks` were also confirmed by reading the
lines. Every other claim carries its sweep's `file:line` and was not independently re-read;
treat a ledger row as a lead with an address, not a verdict. Playwright and the fe-01
vitest suite were not run.

## 6 · Verify — W0-1, 2026-09-02

**What changed.** All 23 `typecheck` targets now run `bunx tsc --build --force <project>/tsconfig.json`.
Eighteen ran `tsc --noEmit -p` against a solution-style config (`"files": []`, `"include": []`,
`references` only), which loads the zero files the config names and exits 0; `libs/auth` already
built its lib project but checked its spec config separately, and was folded onto the same form so
every target reads one way.

The plan said to drop `--force` locally and keep it in CI. It is kept everywhere instead, matching
what be-01, gw-01, mcp-01 and fe-01 already do: `--force` is what makes a stale `.tsbuildinfo`
unable to produce a false green, which is the same failure class this item exists to close. Making
the local run incremental belongs with the test tiers in W1-4.

**The negative, watched twice.** With `const deliberatelyWrong: number = 'not a number'` appended
to `tools/tool-remote-scripts/src/swap.ts`:

| Command                                                                 | Result                                      |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| `bunx tsc --noEmit -p tools/tool-remote-scripts/tsconfig.json` (before) | **exit 0 in 0.156s** — compiled nothing     |
| `bunx nx run tool-remote-scripts:typecheck` (after)                     | **exit 1**, `swap.ts(1035,7): error TS2322` |

And through the guard test: with that one `project.json` put back to the `-p` form,
`tools/tool-devsync/src/workspace-typecheck.test.ts` failed on
`Expected value to be empty · Received: [ "tool-remote-scripts" ]`. That test walks every
`project.json` on disk rather than trusting a list, so a project added with the wrong form fails
there. It is the mechanism that stops R5's most-repeated fault recurring a fourth time.

**What the honest check found — 12 latent type errors in 7 projects**, none of which any command
in the repo could see:

| Project                        | Error                                                                                                                                              | Fix                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `tool-compose` (2)             | `readdir(..., { recursive, withFileTypes })` and `Dirent.parentPath` absent                                                                        | `@types/node` bump; the `parentPath` casts are now provably needless |
| `tool-observability-stack` (2) | the same two, duplicated verbatim in a second tool                                                                                                 | same                                                                 |
| `tool-smoke` (3)               | `Uint8Array` is generic over its buffer since TS 5.7; `WebSocket` headers                                                                          | annotate the accumulator; one cast naming Bun's gap from the DOM lib |
| `tool-bootstrap` (3)           | `process.env.PATH` under `noPropertyAccessFromIndexSignature`; `getuid()`                                                                          | `env['PATH']`; `process.getuid?.()`                                  |
| `tool-deploy` (2)              | a test literal missing `layout`, required since the `--env` work                                                                                   | `layout: envLayout('dev')` — the import was already there            |
| `tool-devsync` (1)             | `pkg.scripts.dev` under the same rule                                                                                                              | `pkg.scripts['dev']`                                                 |
| `libs/realtime` (2)            | the cast `WsControlFrame & Record<string, unknown>` made every `in` check succeed and every property `unknown`, so the data arm was never narrowed | a predicate reading the values, not the keys                         |
| `libs/scripts` (1)             | `unknown[]` passed to Bun's `$`                                                                                                                    | `Bun.ShellExpression[]`                                              |

**`@types/node` 18.16.9 → 22.18.0.** `bun-types@1.3.13` asks for `*`; the exact pin was the repo's
own. Bun 1.3.14 implements the `readdir` recursion and `Dirent.parentPath` that Node 18's types
predate, so two tools carried casts to work around types that were lying about the runtime. The
bump removed 4 errors and introduced 1 (`libs/scripts`, fixed above); the four apps stayed green.

**One resolution bug the bump did not cover.** `tools/tool-compose/src/tmpl.d.ts` declared
`*.tmpl` as an ambient wildcard. A wildcard only types the programs that _include_ the file
declaring it, and `@wbs/tool-compose` is consumed through a path mapping — so `tool-remote-scripts`
compiled `index.ts` inside its own program, where the wildcard was invisible and both text imports
were `TS2307`. The wildcard is replaced by one declaration beside each template
(`site.caddy.tmpl.d.ts`, `tier.compose.tmpl.d.ts`), found by _resolution_, so every consumer gets
it. Note for later: a path mapping means a consumer recompiles the dependency's source rather than
reading its `.d.ts`. Real project references would fix that class outright and are worth a look
when W1-4 touches the same files.

**One suite is red, and it was red before this change.** `nx run-many -t test` passes 22 of 23
projects; `tool-bootstrap` reports **53 pass / 7 fail**, all in one parameterised family
(`is caught somewhere in the environment product when disconnected by …`), timing out against
that family's own 60s budget. Three checks place it:

| Run                                                            | Result                     |
| -------------------------------------------------------------- | -------------------------- |
| Whole workspace, `--parallel=4`, a lint pass running beside it | 53 pass / 7 fail, 1,032s   |
| `tool-bootstrap` alone, nothing else on the machine            | **53 pass / 7 fail, 965s** |
| The same family with the test file reverted to `HEAD`          | **0 pass / 2 fail, 525s**  |

53/7 is exactly the quiet-`main` baseline `docs/2026-08-30-agent-loop-audit.md:402` records, and
the family fails identically on `HEAD`'s own copy of the file — so it is pre-existing and nothing
in this change causes it. The three edits here (`process.env.PATH` → `process.env['PATH']` twice,
`process.getuid()` → `process.getuid?.()`) are type-level only and cannot alter what a spawned
shell does.

**A correction to that audit, though.** It attributed these failures to starvation — "60s timeouts
after 293s of wall clock: starvation, not code" — and said explicitly that its own quiet baseline
was not evidence of "what a serialised machine would print". This run is that evidence: alone, on
an otherwise idle machine, the suite still prints 53/7 and still times out (276.9s for one case).
Whatever these seven are, they are **not** contention. They are worth their own investigation and
are not in this plan.

**Commands run and green:** `nx run-many -t typecheck --skip-nx-cache` (23 projects),
`nx run-many -t test --skip-nx-cache` (22 of 23 — see above), `nx run-many -t lint` on the eight
touched projects, `nx format:check --all`. `bin/h2puni-gate.sh` was **not** run — it exits 127 on this Mac,
which is a recorded local limitation, and `build` needs `shellcheck`. Playwright was not run: no
file in this change reaches the browser.

**Still out of the gate, deliberately.** be-01, gw-01 and mcp-01 point at `tsconfig.lib.json`, so
their _spec_ projects are still unchecked — CLAUDE.md records the pre-existing errors there as
their own change, and this one did not widen that scope.

## 7 · Verify — W0-2, 2026-09-02

**What the sweep undercounted.** It named seven targets reading `bin/` and `deploy/compose/`.
Walking every `*.test.ts` for a `'../../../…'` literal found **nine reads across six projects**,
and the ninth is the one worth the paragraph: `libs/domain`'s
`every name it can answer is one the migration seeds` reads
`apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql` to prove the domain's list and
the migration's seed are one fact. `libs/domain` does not depend on be-01 — the dependency runs the
other way — so that file was in no input of the task that reads it. An anti-drift check whose own
input is invisible to the thing deciding whether to run it is a check that cannot fail.

| Target                       | Declared now                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `tool-bootstrap:test`        | two `deploy/compose/` fragments the harness slices                                    |
| `tool-compose:test`          | `deploy/compose/**/*` (one candidate file, and a directory walk)                      |
| `tool-dagger:test`           | `bin/with-heavy-lock.sh`, `bin/heavy-lock-lib.sh`                                     |
| `tool-deploy:test`, `:build` | `bin/assert-no-prod-release.sh`                                                       |
| `tool-devsync:test`          | three `bin/dev-*.sh`, every `project.json`, and every `*.test.ts` the new guard scans |
| `tool-devsync:build`         | the four `bin/dev-*.sh` it shellchecks                                                |
| `domain:test`                | `apps/be-01/drizzle/*/migration.sql`                                                  |

**The fault, watched through Nx itself.** With `tool-devsync:test`'s `inputs` removed, warm the
cache, then append a line to `bin/dev-be-probe.sh`:

```
> nx run tool-devsync:test  [existing outputs match the cache, left as is]
```

Green, over a script no command read. With the declaration restored, the same edit runs the suite.

**The guard.** `tools/tool-devsync/src/workspace-targets.test.ts` (renamed from
`workspace-typecheck.test.ts`, which now holds both workspace-target rules) walks every suite,
resolves each `'../../../…'` literal, and fails on one no declared input covers. Watched failing
twice, once per project:

```
Received: [ "tool-devsync:test does not declare apps", "tool-devsync:test does not declare bin/dev-be-probe.sh", …
Received: [ "domain:test does not declare apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql" ]
```

**Deviation from the plan: `--skip-nx-cache` stays in `bin/h2puni-gate.sh`.** The plan said to
delete it once the inputs were right. Two facts found while doing the work argue against:

- **CI never had the problem.** `.github/workflows/ci.yml:99` runs `nx run-many` _without_
  `--skip-nx-cache`, but there is no `actions/cache` for `.nx` and no Nx Cloud, so every CI run
  starts cold and every task actually runs. The hole was only ever the local loop — which is where
  an agent lives, so fixing it was still worth doing.
- **That gate is the release gate on the build box.** It is the last thing run before a prod
  deploy, and its whole value is that it trusts nothing. Correct inputs make the cache safe _as far
  as we know_; `--skip-nx-cache` is what makes the release gate safe when we are wrong about that.
  Belt and braces on one command, run once per release, is the right trade. Making the _inner_ loop
  fast is W1-4's job and has a different risk profile.

**Commands run and green:** `nx run-many -t test lint typecheck --skip-nx-cache` for
`tool-devsync`, `domain`, `tool-deploy`, `tool-compose`, `tool-dagger`; `nx format:check --all`;
`nx show project` for all six, confirming Nx parses the new inputs. `tool-bootstrap` was not
re-run — only its `project.json` changed, its suite takes 16 minutes, and it carries the
pre-existing 53/7 recorded in §6.

The new typecheck target earned its keep immediately: it caught `TS18046` in the guard test above
(`.filter` on a union that needs a type predicate), which the old `-p` form would have reported
green.

## 8 · Verify — W0-3, 2026-09-02

The `.derive()` is deleted. `apps/be-01/src/app.test.ts` is new and states the rule two ways, both
watched failing with the derive restored:

| Case                                                     | With the derive | Without |
| -------------------------------------------------------- | --------------- | ------- |
| `GET /health` carrying a valid session — authentications | 1               | **0**   |
| `GET /health` — `users.findById` calls                   | 1               | **0**   |
| `GET /api/projects` — authentications                    | 2               | **1**   |

The second row is the point and N1 understated it: a _read_ route resolved the caller **twice**,
because the derive ran and then the handler asked again. A write route paid three times, since the
write-scope pre-filter asks as well.

**The token has to be real, and the first draft's did not.** `authenticate(null)` returns at its
first line without a `jwtVerify` or a lookup, so a probe sent with no token — or with the
`undefined` the first draft produced by reading `session.token` where the outcome carries
`session.result.token` — leaves `lookedUp` at zero whatever the app does. The fixture registers and
signs in a real account, and the counters are reset after that setup so only the request under test
is measured. This is `estimate-triple-visible`'s "assert in the window the fault lives in" in its
other form: a check must be able to observe the cost it claims to remove.

The read-route case is what keeps this fixed. Deleting a derive is easy to undo by writing another;
"one resolution per request that needs one" is the rule that fails when someone does.

**Green:** `be-01` test (1263 pass, 0 fail, 92 files), lint, typecheck.

## 9 · Verify — W0-12, 2026-09-02

Two files named `.controller.ts` registered no route and exported only a body parser, which is
what made D6 look closed when it had only moved. Both are renamed with their test files, and every
reference rewritten:

| Was                           | Is                        |
| ----------------------------- | ------------------------- |
| `capacity.controller.ts`      | `capacity-body.ts`        |
| `priority-band.controller.ts` | `priority-ladder-body.ts` |

`grep '\.controller\.ts'` now returns the route table, which is the point: an agent looking for
where a route is registered stops finding two files that cannot register one.

**Three comments deleted or corrected, all of which named things that do not exist.** `app.ts`
carried three blocks explaining a registration order for `capacityController` and
`priorityBandController`; two described controllers retired into command kinds, and the third —
the only rule still true — is rewritten onto the route it is actually about. `history.controller.ts`
repeated the same two names and now states the rule in its own terms. Inside the renamed files,
`capacity-body.ts` said "this route writes one field" of something that is now the `setTeamCapacity`
command's payload, and `priority-ladder-body.ts` cited `capacityController`'s reasoning by a name
that has not existed for two releases. Every argument is preserved; only the referents are fixed.

**`middleware/validate.ts` is inlined into `smoke.controller.ts`.** It exported `validateBody` and
`HttpError` and had exactly one caller, while reading like the app's validation boundary — a seam
no route ever took, since every route carrying domain input hand-parses for the reason
`hand-parsed-body.ts` states. Deleting it concentrates nothing and removes a thing an agent adding
a route will reach for and find does not fit. The deletion test passes: `smoke.controller.ts` now
calls `parseOrThrow` and catches `ValidationError` directly, four lines shorter, and says in its own
doc why it is the only route shaped this way.

**Green:** `be-01` test (1263 pass, 0 fail), lint, typecheck. No behaviour changed; no test needed
editing, which is itself the check that these were names rather than code.

## 10 · Verify — W0-7, 2026-09-02

**The unreachability, established before anything was deleted.** `announceWorkItem` and
`announceTree` both return early when a collector is installed, so the narrow event ships only on a
direct, uncollected call. Every production path is collected:

- The ten mutators that call it (`patch`, `rename`, the four `setX`, the four `clearX`) are reached
  from exactly one non-test place, `plan-commands.ts`, in the `applyAll` at `:309–422`.
- `applyAll` runs inside `workItems.collect(...)` at `plan-commands.ts:138`.
- The other entry, undo and redo, runs inside `workItems.collect(step)` at `:190` — `walk`, which is
  what the two undo routes call.

So the publish branch could not be reached, and `withAncestors` computed a full schedule to keep one
ancestor chain from it that was then thrown away.

**The deletion test is the suite.** Deleting the branch and pointing the ten call sites at
`announceTree` left `be-01` at **1260 pass, 3 fail** — and all three failures assert the shape
production never sends:

```
(fail) clearing estimates > tells the project's subscribers, with the ancestors whose totals moved
(fail) what a project subscriber receives > sends a narrow patch when an estimate changes, …
(fail) what a project subscriber receives > sends a narrow patch when a name changes
```

They are rewritten rather than deleted, because their intent is right and only their claim was
stale: a figure edit and a name edit must still reach subscribers. They now assert the whole tree
arrives, ancestors included, which is what a peer actually receives. Four more files used
`work_items_changed` as an arbitrary sample payload and take `tree_replaced` instead; the two
variants carry identical fields, so those substitutions are exact.

**`broadcast.ts:7–13`'s rationale is rewritten from what is true now.** It argued at length for two
shapes because "a cell edit touches one work item and its ancestors' totals, and that is a small
patch worth computing". The command bus retired that: a write arrives in a batch, the batch
announces once after it commits, and a batch is any set of rows at all — so there is no per-row
change left to describe. The comment now says that, and says the narrow shape survived unreachable
for two releases, so the next reader does not restore it.

**Green:** `be-01` 1263 pass, `gw-01` 59 pass, `fe-01` 2046 pass across 66 files; lint and typecheck
on all three; `format:check --all`. fe-01 is in the list on purpose — it is the consumer of these
events, and a shape it still expected would have failed there rather than in be-01.

## 11 · Verify — W0-9, 2026-09-02

The rule is `stepIsInUse(held)` in `repository/step.ts`, beside the transaction that is
authoritative for it. Both callers ask it: the removal transaction, and `StepService.remove`'s gate,
which had been written as `estimates > 0 || assignments > 0` and so let a step holding only recorded
days, only progress, or only measures walk past.

**The obvious check for this could not fail, and the existing suite proves it.**
`carries the figures that are not days into the refusal it shows a person` sets two measures and
asserts the refusal — and it passes with the gate broken, because the transaction refuses one layer
down and returns its own usage. The _outcome is identical either way_. That is why the drift
survived, and it is why a test asserting the answer would have been a check that cannot fail.

What actually differs is whether a transaction opens at all, which is the gate's whole purpose: a
reader is asked to confirm before one does. The new cases count store calls, and each assertion was
injected separately because neither sees the other's fault:

| Injected fault                                                  | Which assertion fired | Observed                                       |
| --------------------------------------------------------------- | --------------------- | ---------------------------------------------- |
| `actuals` term dropped from `stepIsInUse`                       | the outcome           | `toMatchObject · - "ok": false · + "ok": true` |
| gate put back to `seen.estimates > 0 \|\| seen.assignments > 0` | the store-call count  | `Expected: 0 · Received: 1`, both cases        |

The first failure is louder than the drift was: now that both callers share the function, a missing
term deletes the step rather than merely letting it past the gate. That is the collapse working — a
rule with one home cannot be half-wrong any more.

The service imports `stepIsInUse` from `../repository/step` rather than through the barrel, which is
the direction W4-1 is heading and the shape `event-log.ts` and `migrate-down.ts` already use.

**Green:** `be-01` 1265 pass, 0 fail (two new cases), lint, typecheck.

## 12 · Verify — W0-8, 2026-09-02

**The leak was bigger than N7 said.** `defineConfig` hands `process.env` — the whole environment —
to `parseOrThrow`, whose message opened with `JSON.stringify(input)`. So one mistyped `LOG_LEVEL`
printed every secret be-01 or gw-01 holds. Both declare `INTERNAL_AUTH_SECRET` and
`JWT_SIGNING_KEY_CURRENT` in the same schema as that literal union.

**Stripping the echo is not enough, and this was measured rather than assumed.** ArkType's summary
is safe for a type mismatch and quotes what it got for a literal union or a regex:

| Constraint                      | Summary                                       |
| ------------------------------- | --------------------------------------------- |
| `PORT: 'number'` given a string | `PORT must be a number (was a string)` — safe |
| `MODE: "'dev'\|'prod'"`         | `MODE must be "dev" or "prod" (was "sekrit")` |
| a regex                         | `TOKEN must be matched by … (was "sekrit")`   |

And no field of an ArkType error is reliably safe but the path: `actual` is the value, and for a
literal union `expected` carries the whole message including it. The `cause` carries `data` too.

So there are two functions, and the split is the interface:

- **`parseOrThrow`** — for a caller's own data (HTTP bodies, wire frames). Keeps the summary,
  drops the input echo. A body was being repeated back into the log in full; now it is not.
- **`parseSecretsOrThrow`** — names the failing paths, nothing else, and passes no `cause`. It
  trades the reason for a guarantee, which is the right trade when the value _is_ the secret: the
  schema sits next to the caller and says what each key must be.

`defineConfig` uses the second. Watched failing twice, against a schema in the shape be-01 and
gw-01 actually declare:

| Injected fault                                      | Observed                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `defineConfig` back on `parseOrThrow` with the echo | `Expected to not contain: "s3cret-signing-key-that-must-never-be-logged"` |
| the echo stripped, summary kept                     | `Expected to not contain: "verbose"`                                      |

The second injection is the one that matters: it is the fault a half-fix leaves behind, and the
case that catches it is a literal union because that is what a mistyped `LOG_LEVEL` is. The test
serialises the thrown error as well as its message, so a value surviving in `cause` fails too.

`apps/mcp-01/src/config.ts` refused `defineConfig` in writing over exactly this hazard. Its comment
is rewritten: the hazard is closed at the source, and what remains is its own narrower reason.

**Green:** `validation`, `config`, `be-01`, `gw-01`, `mcp-01`, `realtime`, `scripts` — test, lint,
typecheck.

## 13 · Verify — W0-11, 2026-09-02

Deleted, each with a clean deletion test — nothing outside itself referenced it, and removing it
concentrates no complexity anywhere:

| Gone                                                                   | Why it looked alive                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/be-01/src/repository/example.ts` + test + the `ExampleRepo` port | a store in the store folder, exported through the barrel                  |
| `apps/fe-01/src/db/config.ts` + test                                   | a directory called `db` holding a client-store design the app never built |
| `apps/fe-01/src/components/smoke/{d3-smoke,table-smoke}.tsx`           | framework tracers from the spike; the only `d3` importers                 |
| `libs/validation/src/branded.ts`                                       | `brandedString`, called by its own test only                              |
| `defineSchema`, `InferSchema` in `core.ts`                             | an identity function and an unused type, exported from the barrel         |
| `tools/tool-deploy/src/ssh.ts` + its test block                        | two builders whose only caller was that test                              |
| **`libs/scripts` entirely** (8 files, project, alias)                  | a `scope:shared` library with zero consumers                              |

`src/db/` is the one worth naming: a `DbConfig` with `mode: 'local' | 'server'`, a `wsUrl` and a
`getJwt`, which the app does not import. An agent asked about caching finds it before it finds that
there is no query library in the dependency list at all. That is what dead code that looks like
architecture costs, and it is why these go rather than sit behind a comment.

`tool-deploy/src/ssh.ts` is worse than unused. `buildSshInvocation` forces `user@host`, while
`deploy.ts` spawns `['ssh', host, …]` with no user at all and says why at `:282` — the ssh config
supplies it. Wiring the helper in would have broken the deploy; deleting it removes the trap.

**Two of N14's entries are not dead, and are kept.**

- **`libs/contracts/src/errors.ts`.** Its `ErrorCode` values are live — `gw-01`'s
  `ws.controller.ts` hand-writes `'invalid_payload'` and `'backend_unavailable'` as literals rather
  than importing them. That is an unused single source, not dead code, and wiring it up belongs to
  W3-9 with the rest of the socket vocabulary.
- **`tools/tool-dagger/src/{be-01,gw-01,fe-01}.ts`.** Reachable only through six Nx targets nothing
  else invokes — `bin/publish-release.sh` runs `main.ts`, not these. So the review's read is
  probably right. But they are release machinery, and CLAUDE.md requires an OpenSpec change for
  deploy safety. Left in place; it is its own change, not a line item in a cleanup.

`libs/validation/src/fixtures/` also stays: the review flagged `clock` and `frame` as dead, but
`makeTestDb` beside them has four be-01 consumers, so the module is live and only some exports are
in question.

**Green:** `validation`, `contracts`, `be-01`, `fe-01` (2043 tests), `gw-01`, `mcp-01`, `realtime`,
`tool-deploy`, `tool-devsync`, `tool-secrets` — test, lint, typecheck; `format:check --all`. The
workspace is 22 projects, from 23.

One thing the removal caught: `git rm -r libs/scripts` left the directory on disk, because an
untracked `coverage/` was in it — and `tool-devsync`'s `RESTART_PATHS coverage` failed on
`Expected to contain: "libs/scripts/project.json"`, reading the directory that still existed. The
test that walks the repo rather than trusting a list is what noticed.

## 14 · Verify — W0-10, 2026-09-02

Five sentences named things that do not exist. Each is corrected from the code rather than from
memory, and the two that carry a number are now checked or carry none.

| Sentence                    | Was                                                                                   | Is                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `hand-parsed-body.ts:13`    | "Eight routes … the six work-item writes, the capacity PUT and the priority-band PUT" | the two batch routes, plus a pointer to the test that reads the document |
| `plan-command-schema.ts:19` | `The step (step) this figure belongs to.`                                             | `The step this figure belongs to.`                                       |
| `openapi-tools.ts:199`      | "40 of be-01's 51 operations"                                                         | no count at all — see below                                              |
| `apps/mcp-01/README.md:15`  | "Twenty tools in all"                                                                 | "22 tools in all", asserted                                              |
| `LLM_README.md:17`          | table `role`                                                                          | table `step`                                                             |

**The counts were measured, not guessed.** The committed document holds **30** operations, **27** of
them without prose. The comment claimed 40 of 51 — wrong in both numbers, and describing an API two
renames ago. It carries no figure now, and says why: a number nothing checks is a number that goes
stale, and it was never the point of the sentence.

**`plan-command-schema.ts` was the costly one.** That string is the description an MCP client shows
a model for every one of the twelve step-carrying command kinds, and `(step)` is what the
`role → step` rename left where `(phase)` had been. `apps/be-01/openapi.json` is regenerated, since
it is committed and diffed against the app.

**The README's count is a test now.** `openapi-tools.test.ts` already asserted the tool names
against the derived list — which is why that README is the repo's good example — and the _count_
sat unchecked beside them at "Twenty" while this file asserted 22. Two tools could be added and the
sentence stay put. Watched failing two ways:

| Injected fault        | Observed                                           |
| --------------------- | -------------------------------------------------- |
| "Twenty tools in all" | `expect(received).not.toBeNull() · Received: null` |
| "20 tools in all"     | `Expected: 22 · Received: 20`                      |

The first failure is the interesting one: writing the number as a word is itself the drift, because
it takes the claim out of reach of anything that could check it.

**Green:** `be-01`, `mcp-01` — test, lint, typecheck; `format:check --all`.

## 15 · Verify — W0-5, 2026-09-02

**The leak was measured before it was fixed.** A throwaway probe against real SQLite compared the
keys a project goes in with to the keys it comes back with:

```
CREATE KEYS: createdAt,depReach,estimateMethod,estimateRounding,id,name,ownerId,
             pertWeights,restricted,revision,solutionRef,startDate
READ   KEYS: …same… + createdBy + updatedAt
```

`createdBy` is a user id, and `GET /api/projects/{id}` and `PATCH /api/projects/{id}` return that
row with no response schema, so both were on the wire. ADR 0012 says the audit columns are recorded
and not published; this is what made that true.

Three reads are fixed, and the third is a reuse win:

| Read                     | Was                              | Is                                           |
| ------------------------ | -------------------------------- | -------------------------------------------- |
| `project.ts` `toProject` | `...rest` spread the whole row   | `withoutAuditColumns(rest)`                  |
| `work-item.ts:547`       | a bare `.returning()`            | `.returning(WORK_ITEM_COLUMNS)`              |
| `directory.ts:127`       | a bare `select().from(workItem)` | `.select(WORK_ITEM_COLUMNS)` — the same list |

`WORK_ITEM_COLUMNS` is exported now and has two readers instead of one, which is what the folder's
convention wanted all along: the declared return type checks the projection is complete, and there
is one list to keep complete.

`toProject` is the read that could not name its columns — it is generic over the row it maps — so
`withoutAuditColumns` in `audit.ts` states the drop instead, beside the helpers that write those
columns. It rebuilds the object rather than copying and deleting, because a computed-key `delete` is
banned here and because building the answer states what it publishes.

**Two things the fix ran into, both worth knowing.** ESLint here does not set `ignoreRestSiblings`,
so the tidy "destructure the unwanted keys into `_`-prefixed names" idiom is an error — hence the
helper. And TypeScript will not prove `Omit<Omit<T, A>, B>` equals `Omit<T, A | B>` for a generic
`T`, so the declared return type is nested exactly as the body produces it, with a comment saying
why.

**The negative.** `project.test.ts` gains `carries the columns the Project type declares and no
others`, asserted against the created row's own keys rather than a second hand-written list — so a
column added to `Project` is not a column the test forgets. With `withoutAuditColumns(rest)` put
back to `...rest`, watched failing on `expect(received).toEqual(expected) · + "createdBy" ·

- "updatedAt"`.

The JSDoc on `stepsOf` cited `toProject` as the reason the audit columns could not reach a `Step`.
It was wrong about the mapper for as long as those columns have existed; it now says so, and says
what the mapper does today.

**Green:** `be-01` 1264 pass, 0 fail; lint; typecheck; `format:check --all`.

## 16 · Verify — W0-4, 2026-09-02

**The drift, measured.** A freshly migrated database holds 28 indexes; `schema.ts` declared 25. The
three it did not know about are `actual_by_step`, `step_progress_by_step` and
`step_measure_by_step`, created under their new names by `20260831120000_rename_role_to_step` and
never written back. Three reads in `step.ts` name them in comments as the reason they are fast, and
`drizzle-kit generate` diffs against `schema.ts` — so the next generate would have dropped all
three.

**The four new indexes were chosen from query plans, not from guesses.** `EXPLAIN QUERY PLAN` on a
migrated database, before the migration:

| Clause                           | Plan                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `assignment` by `person_id`      | `SCAN assignment`                                                  |
| `assignment` by `step_id`        | `SCAN assignment`                                                  |
| `estimate` by `step_id`          | `SCAN estimate`                                                    |
| `dependency` by `successor_id`   | `SCAN dependency`                                                  |
| `dependency` by `predecessor_id` | `SEARCH … USING INDEX dependency_pair` — the control               |
| `assignment` by `work_item_id`   | `SEARCH … USING INDEX sqlite_autoindex_assignment_1` — the control |

The two controls matter: they say the read is the problem rather than the table. `step_id` and
`person_id` are not prefixes of their primary keys, and `dependency_pair` is
`(predecessor_id, successor_id)`, so it answers one direction and not the one a subtree delete uses
once per work item. `work_item(service_team_id)` was on the review's list and is **not** added — the
column is marked for removal, and indexing a dying column buys a plan for one release.

`20260902120000_add_lookup_indexes` is additive (`CREATE INDEX` only, so both colours run against
one file through a swap) and ships its `down.sql`. The migration lint passes; `nx run be-01:build`,
which runs it, is green.

**Adding a migration means four ledgers, and they do not all run the same way.** Fifteen descending
lists in `migrate.test.ts`, three in each of `migrate-down.test.ts` and `identity-migration.test.ts`,
one in `project.test.ts` — plus **three ascending** lists in `migrate-down.test.ts`
(`readMigrationFolders` and `appliedNames` answer oldest-first). Two more assertions were hard-coded
against "which migration is newest" and "how many exist", and each is now derived:

- `does nothing when the target is already the newest applied` read the newest off disk instead of
  naming `AUDIT_COLUMNS`. It had named the role → step rename before that.
- `locks OIDC-only accounts during downgrade…` counted `migrations: 34`, with a comment saying the
  figure moves with every migration. It counts `readMigrationFolders(FOLDER).length` now. What it
  asserts is that a re-apply leaves the ledger complete rather than short, and a literal states that
  badly.

**The guard.** `schema-indexes.test.ts` diffs every index `schema.ts` declares against every index a
migrated database holds. Watched failing on exactly the 2026-09-02 state — with
`index('actual_by_step')` taken back out, `expect(received).toEqual(expected) · - "actual_by_step"`.
It carries a second case asserting the declared list is over twenty names and contains a known one,
because two empty lists are equal and a `getTableConfig` that threw for every export would make both
sides empty for the same wrong reason.

**Green:** `be-01` 1266 pass, 0 fail; lint; typecheck; build (the migration lint); `format --all`.

## 17 · Verify — W0-6, 2026-09-02

`PlanCommandRunner` states the rule: the lock covers the transaction and nothing after it, because a
push to gw-01 is a network call and `PushClient` retries a failing one for about a minute. Three
services it calls broke that rule from inside `applyAll` — `CapacityService.set`,
`PriorityBandService.set`, and `DirectoryService.announce` once per touched project, in sequence.

It was unsound as well as slow. Under ADR 0007 a batch runs in one outer transaction, so those
event-log inserts were savepoints inside it: a command refused at step nine rolled back the recorded
events for pushes that had already left the process.

**The fix is one mechanism instead of four conventions.** `DeferringBroadcaster` wraps the real
broadcaster; `buildServices` constructs it once and every service publishes through it, so there is
exactly one broadcaster object in the process and a batch cannot hold one while a service publishes
through another. The runner holds it for the length of the transaction and drains after the commit
_and_ after the lock — or drops the queue when it rolls back. Announcements carrying nothing but a
`type` are deduplicated, which turns forty `directory_changed` for one tag rename into one per
project.

**The hold sits inside `lock.run`, not around it, and an existing test found that.** `execute` runs
concurrently for every queued batch; only the lock makes one-at-a-time true. Held around the lock, a
second batch opened a hold while the first still waited for it:

```
error: a batch is already holding announcements
```

**An order-sensitive test had to be made deterministic first.** `lets go of the write lock before
the broadcast leaves` identified the held batch by counting pushes — `pushes === 1` — so it depended
on how many microtask turns each batch took to reach its announce. Adding one `await` between the
lock and the broadcast silently swapped which batch was held, and the test failed while proving
nothing about the lock. It now drives the held batch through its own runner, so the subject is fixed
by construction. Re-watched against its original fault, `announceTreeNow` moved back inside
`lock.run`: `this test timed out after 5000ms`.

**The new negative did not exist and is the point of the change.** `holds a directory command's
announcement until the lock is let go` renames a tag that is **on** a work item — a tag nobody uses
touches no project, queues nothing, and would pass whatever the runner did — and asserts a plan
batch gets through while that directory push is held open. Watched failing with `DirectoryService`
given the raw broadcaster, which is the shape that shipped: `this test timed out after 5000ms`.

`directory.service.ts`'s doc argued the opposite of what happened: "`recordEvent` opens a
transaction of its own, so it cannot be nested inside the write's". True of a directory route, false
of every directory command in a batch. It now says both, and says which one the code does.

**Green:** `be-01` 1267 pass, `gw-01` 59, `mcp-01` 106 — test, lint, typecheck, build;
`format:check --all`.

## 18 · Verify — W1-1 (first half), 2026-09-02

`apps/fe-01/src/testing/fake-project-api.ts` exists, holding the 674-line fake that lived inside
`wbs-table.test.tsx`. It is moved, not rewritten: it is a **model** of be-01's answers — it
renumbers on every write, accumulates tags down the tree, resolves assumed assignees, and refuses
what be-01 refuses — and that is why it is the one worth sharing.

**Moving it into `src/` put it inside `tsconfig.app.json`, and a compiler read it for the first
time.** A spec project is outside fe-01's typecheck target, so a fake could stop satisfying
`ProjectApi` and nothing would say so. It had, in eleven places:

| Divergence                                                                                                                                         | Count |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `ProjectApi` methods absent outright — `addWorkItemType`, `renameTag`, `removeTag`, `setEstimateArithmetic`, `setTeamCapacity`, `setPriorityBands` | 6     |
| required wire fields missing — `ProjectListEntry.startDate`, `SliceView.capacityTeamId`, `PersonView.kind`, `WorkItemView.dates`                   | 4     |
| a duplicated object key (`startNoEarlierThanReason`)                                                                                               | 1     |

The duplicate is the one to remember. The fixture carried a comment saying _"A duplicate `teamIds`
sat here until 2026-08-18 — harmless, and only because nothing typechecks this file"_ — and had
since re-acquired the same fault on a different key. A file that documents its own blind spot still
has the blind spot.

**Three tests were asserting a person be-01 never sends.** Adding `kind` to the fixture broke
`expected [ Array(1) ] to deeply equal [ Array(1) ]` in three cases whose literal person object had
no `kind`. Those assertions described the fake rather than the wire, and are corrected.

`listWorkItemTypes` answered a fresh `[]`, so a type added through the API vanished on the next
read. It reads a directory now, like tags and services.

**Green:** `fe-01` 2043 tests across 65 files, lint, typecheck; `format:check --all`. The one lint
warning in `wbs-table.tsx:4583` is pre-existing.

**Still open in W1-1:** the other six fakes (`gantt-panel`, `plan-cards`, `project-page`,
`wbs-api`, `page-shortcuts`, `app-router`) are not migrated. They are not copies of this one — they
have different signatures for different needs (`fakeApi(startDate, skew)`,
`fakeApi({refusePatch, dated})`) — so folding them in is a design job rather than a move, and the
two trivial ones may be right to leave alone. The recorded call log subsuming the eight `watchX`
wrappers is also still to do. What is done is the precondition for W1-2: the split files can import
one fixture instead of inheriting eleven copies of it.

## 19 · Verify — W1-5, 2026-09-02

All 22 projects gained `lint:fast`: the same rules and the same files, with
`--cache --cache-location .nx/eslintcache-<project>`. `lint` is untouched and stays uncached,
because a type change in one project can stale another's `no-unsafe-*` verdict and no gate may trust
that. Measured on be-01, through Nx:

| Command                        | One file changed |
| ------------------------------ | ---------------- |
| `nx run be-01:lint` (the gate) | 15.1s            |
| `nx run be-01:lint:fast`       | **4.1s**         |

**The plan's lefthook half is withdrawn, and it is worth saying why.** The proposal was to cache the
pre-commit lint too. Measured on a realistic staged set:

| Run                                 | Time  |
| ----------------------------------- | ----- |
| no cache, as lefthook runs today    | 2.93s |
| cached, nothing changed             | 1.20s |
| cached, **one staged file changed** | 2.72s |

The third row is the only one that happens. A pre-commit hook lints the staged files, and staged
files are by definition the ones that changed, so the cache misses on every one of them. The win is
0.2s and it is noise. The gain is entirely in the _whole-project_ case, where an agent re-lints
several hundred unchanged files to check the handful it touched — which is the inner loop this wave
is about.

**The cache does not hide a real error.** With `const unusedOnPurpose = 1;` appended to
`services.ts` and the cache warm, `nx run be-01:lint:fast` failed on
`233:7 error 'unusedOnPurpose' is assigned a value but never used`, and went green with it removed.
A fast lint that could not fail would be worse than no fast lint.

`LLM_README.md` names it as the inner-loop command and says `lint` is the gate. Getting it back
under its 150-line cap turned up one more stale figure that W0-10 missed: the index still described
mcp-01's README as "20 tools", the number that file no longer claims. It names no count now.

**Green:** `lint:fast` across all 22 projects; `lint` on be-01 and fe-01 unchanged;
`format:check --all`; `doc-caps`.

## 20 · Verify — W1-3 (started), 2026-09-02

`apps/be-01/src/testing/harness.ts` exports `inMemoryServices(overrides?)`, returning the
`WorkItemService`, **its stores**, and the recording broadcaster.

Handing the stores back is the whole difference from `testWorkItemService()`, which composed the
same graph and then discarded them — which is exactly why twenty-four files re-derived it by hand
instead of using it. A suite that seeds a plan or asserts on a row needs the store.

The graph is thirteen ports with three wiring rules that are easy to get subtly wrong, and the
harness is now the one place that knows them: the work-item store takes the **directory** so labels
resolve, the four satellite stores take the **work-item store** so figures follow a row through a
move, and `inMemorySubtrees` takes **all seven** because a subtree write touches every table at
once. `undo.test.ts:122` is what happens without one place that knows this — it passed a real
`SubtreeRepository(db)` into an otherwise in-memory graph, so one store spoke to SQLite while the
rest spoke to a Map.

Seven suites migrated, and `testWorkItemService()` now delegates rather than duplicating:

| File                                                                                                                                                    | Lines            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `estimate.test.ts`                                                                                                                                      | −38              |
| `actual.test.ts`                                                                                                                                        | −45              |
| `measure.test.ts`, `progress.test.ts`, `freeze.test.ts`, `broadcast.test.ts`, `plan-history.test.ts`, `review-findings.test.ts`, `work-item-fixture.ts` | the rest of −335 |

**Every one of them was wiring stores it never read.** `estimate.test.ts` declared and constructed
five it never touched; the others the same. That is what a hand-derived graph costs: nobody trims
it, because trimming means understanding the wiring again.

Overrides carry the real variation. Four suites wrap the command journal to keep the plan's history
rows where a case can read them, and pass `inMemoryServices({ journal })`; everything else is built
by the harness.

**Green:** `be-01` 1267 pass, 0 fail across 92 files; lint; typecheck; `format:check --all`.

**Still open:** seventeen files still build the graph by hand. Two of them — `tag-empty-diff` and
`service-empty-diff` — are T1 suites over real repositories and this harness does not apply; the
rest are in-memory and should follow. `undo.test.ts` is the one worth doing next, since it is the
file the audit named and the one with the leaked real repository.

## 21 · Verify — W1-3 finished, and two corrections, 2026-09-02

Every remaining in-memory suite is migrated: `live-plan-identity`, `work-item.service`,
`project.controller` and `work-item.controller`. Inside `work-item.service.test.ts`, three cases
built a second service to drive a store that fails on purpose — a rejecting `dependencies`, a
`projects` that answers differently on the second read, a short priority ladder. Two of them
re-derived the whole graph to change one port; all three are now
`new WorkItemService({ ...serviceOptions, <the one store> })`, which says what the case is about.

Around 500 lines are gone across fourteen files, and `be-01` holds at 1267 passing.

**Correction 1 — the audit's "24 test files hand-build `WorkItemService`" is misleading, and I
repeated it.** Counting real repositories per file: **twelve of the sixteen** remaining were
SQLite-backed suites wiring real repositories on purpose. An in-memory harness is the wrong tool for
those, and the honest figure for this item was never 24. What they want is a _T1_ harness over a
real `Drizzle` — which `buildServices()` nearly is, and which is a separate piece of work.

**Correction 2 — `undo.test.ts:122` does not leak a real repository into an in-memory graph.** The
review said it did, I put that in the harness's own JSDoc, and it is false. That suite wires real
repositories throughout and takes in-memory fixtures for exactly two ports, `capacity` and
`priorityBands`, which its cases never drive. It is a coherent T1 suite. The JSDoc now says so,
because a comment that cites a false example is worse than one that cites none — the next reader
would have gone looking for a bug that is not there.

The wiring rules the harness exists to hold are still real, and are stated without the false
example: get one wrong and nothing says so — the graph still constructs, the suite still runs, and
a label or a figure is simply never there to assert on.

**Green:** `be-01` 1267 pass, 0 fail; lint; typecheck; `format:check --all`.

## 22 · Verify — W1-2, 2026-09-02

`wbs-table.test.tsx` — 16,164 lines, 62 top-level `describe` blocks, 585 cases, run serially — is
eleven files named for what they are about: `plan-table`, `plan-structure`, `plan-cells`,
`plan-estimates`, `plan-keyboard`, `plan-dependencies`, `plan-chart-seam`, `plan-layout`,
`plan-filter`, `plan-toolbar`, `plan-read-and-write`.

| Measure             | Before | After   |
| ------------------- | ------ | ------- |
| whole `fe-01` suite | ~180s  | **69s** |
| test files          | 65     | 75      |
| tests               | 2043   | 2043    |

Zero production change, and all 585 cases still run — counted, not assumed.

**Three attempts, and the two failures are the point.**

The first split took "the header" to be everything above the first `describe`. It is not:
thirteen module-scope helpers, `rowFor` among them, are declared **between** describes, around line
5,070. Files that needed them got a `ReferenceError`.

The second pruned unused declarations with a regex for "a `const` up to a line starting `};`". Test
sources are full of brackets inside strings, so that regex ran past a declaration's end and ate
whole `describe` blocks — 8 of 62 vanished, and the only reason it was caught is that the counts
were checked after every step.

What worked: split on **top-level statement starts** rather than bracket counting, share every
module-scope statement with every file, then remove unused declarations **one at a time, located by
ESLint's own line numbers**, re-parsing after each removal and reverting any that breaks the file.
Slow — one ESLint run per removal — and it cannot eat a block it cannot see.

**Two couplings the split had to honour.** `keyboard-cheat-sheet.test.tsx` reads the behaviour
tests' _source text_ to prove every chord on the cheat sheet has a test, and it read
`wbs-table.test.tsx` by name; it names the eleven now, individually rather than by glob, for the
reason its own comment gives — a file that moves must throw, and a glob would quietly read ten of
eleven. And `POPOVER_ROW_LAYER` was pruned from `plan-cells` while still used in a case body; the
compiler named it (`TS2304`), which is the check that says a split lost something.

**Green:** `fe-01` 2043 pass across 75 files, lint, typecheck, build; `format:check --all`.

## 23 · Verify — W1-4 (be-01's half), 2026-09-02

be-01's 93 suites are two tiers, decided by a suffix. 43 suites that open SQLite became
`*.db.test.ts`; the rest keep `*.test.ts`.

| Target              | Suites | Tests | Time      |
| ------------------- | ------ | ----- | --------- |
| `be-01:test:unit`   | 51     | 662   | **12.7s** |
| `be-01:test:store`  | 42     | 607   | 43.3s     |
| `be-01:test` (both) | 93     | 1269  | 56.0s     |

662 + 607 = 1269 and 51 + 42 = 93, so the two tiers **partition** the suite rather than
overlapping or dropping anything. That arithmetic is the check that the split is honest.

An agent editing a service now has a 12.7s answer instead of a 56s one. Not the audit's "< 3s"
target, and it is worth saying why: bun spends roughly 0.25s starting each of the 49 files, so 12s
is close to the floor for this many files under this runner. Opening SQLite is what the tier
actually removes — `mkdtemp` plus a migration run is about 0.7s a file.

**The guard is `src/test-tiers.test.ts`**, which walks the directory rather than trusting a list: a
suite is named `.db.test.ts` when it opens a database and only then. Watched failing on
`Received: [ "repository/db.test.ts opens a database and is not named .db.test.ts" ]`.

**It caught its own first draft.** The detector originally counted `mkdtemp` as evidence of a
database, and on that evidence 43 files were renamed — including `deployed-commit.test.ts`, which
makes a temp directory to write a `HEAD` file into and never touches SQLite. The guard reported it
immediately (`is named .db.test.ts and opens no database`), the rule narrowed to the three real
openers, and that file is back in the fast tier. The check also matched _itself_, because it quotes
the opener names in its own regex; it excludes itself now, and says so.

**Green:** `be-01` 1269 pass across 93 files, lint, typecheck; `format:check --all`.

**Still open in W1-4:** fe-01's `vitest` `projects` so its pure suites run without jsdom, a root
`test:unit`, and lefthook running it. The eleven-file split from W1-2 is what makes fe-01's half
worth doing.

### 23.1 · The rest of W1-4, and two deviations

`bun run test:unit` is the inner-loop command: be-01's fast tier plus every lib, **17.2s** for 815
tests. `LLM_README.md` names it. fe-01 is deliberately **not** in it — a 69s jsdom suite is not a
fast tier, and putting it there would make this the command people stop running.

**Deviation 1 — fe-01's `vitest` `projects` is not done, and the reason is a measurement.** 18 of
its 73 suites import no DOM, and 16 of those run under `--environment node` in **1.8s** for 359
tests. The other two (`api.test.ts`, `project-stream.test.ts`) need `WebSocket` and `window`
despite touching no component. So the tier is real and worth having — but selecting it needs the
`*.dom.test.tsx` suffix across **55** files, which is the same class of mechanical rename that took
three attempts in W1-2. It is a change of its own, not a tail end of this one.

**Deviation 2 — lefthook does not run `test:unit`.** The plan said it should. Measured, the hook
currently costs about 7s (lint and format on staged files) and this would add 17s to every commit.
CLAUDE.md already records that lefthook is the bypassable half and CI is the gate, so the trade is
17s on every commit against a check the agent should be running before it commits anyway. Left out
on purpose rather than by omission.

**Green:** `bun run test:unit` 815 pass; `format:check --all`; `doc-caps`.

## 24 · Verify — W1-6 investigated, and the first of W2-12, 2026-09-02

**W1-6 is not done, and the reason is what the specs actually contain.** Seven `seedPlan`
functions exist, but they are not seven copies of one thing: each builds a different fixture — two
rows with long names for the wrap case, none at all for the mobile dialog case, a ramp of
priorities. What they genuinely share is a **three-line preamble** (`goto('/')`, wait for the
account button, `createProject`), and `createProject` is already a shared helper. So the reported
"`seedPlan` ×6" overstates it: extracting the preamble is worth about eighteen lines.

The plan's larger idea — seed through the API instead of the UI — conflicts with at least one
spec's stated intent: `layout.spec.ts` says in its own words that it must not be seeded behind the
table's back. That is a per-spec decision, not a sweep-wide substitution.

And `workers: 4` needs a measured proof that four writers against one SQLite file behave, which is
a 15-minute browser run per attempt. Chromium is installed here and the run is possible; it is not
something to assert without having done it. Left for its own change, with the finding recorded so
the next reader does not start from the overstated figure.

**Three of W2-12's cheap wins are done**, each verified by the tiers this wave built:

- **`push-client.ts`** serialised the payload **inside** the retry loop. The dominant payload is
  `tree_replaced` carrying a whole plan, and the loop runs up to six times over about a minute when
  gw-01 is down — so an unreachable gateway made be-01 re-serialise every row of the project six
  times. Once per push now.
- **`login-throttle.ts`** walked its whole map on **every** `canAttempt` and every `recordFailure` —
  up to 10,000 iterations per login attempt, so under the load the class exists to survive, the
  throttle was itself the O(n) cost. It prunes the two keys the attempt touches, plus one older
  entry when the map is full, which drains faster than attempts can arrive while it is full.
  `canAttempt` still refuses at the ceiling, so the bound holds whatever this drops.
- **`nameOf`** was `entries.find(...)` in **both** exporters, called per cell of every row: naming
  the steps and the people in a plan was O(rows × entries), twice over, in two copies that had to
  agree about what an unknown id reads as. One copy now, in `plan-export.ts`, indexing each list
  once in a `WeakMap` keyed by the list itself — so the callers keep reading
  `nameOf(plan.people, id)` and the index is built once per export. `UNKNOWN_NAME` stops being
  duplicated with it.

**Green:** `be-01` 1269 pass across 93 files, `fe-01` 2043 pass across 75; lint and typecheck on
both; `format:check --all`.

## 25 · Verify — W2-1 (the transparent half), 2026-09-02

`wbs-api.ts` keeps a map of the **GET requests in flight**, by path. Two callers asking for one URL
at the same moment get one request and share its answer. A refresh reads the plan and the five
global vocabularies together and is started by every write and every socket frame, so a held arrow
key — or a peer typing — used to issue the same eight reads again before the previous eight landed.

It is de-duplication and **not** a cache: the entry is dropped the moment its promise settles, so
the next read still goes to be-01. That is what keeps "the plan is replaced, never patched" true.
Three cases, each watched failing against the fault it names:

| Injected fault                                | Observed                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| the GET branch removed                        | `expected [ [ '/api/teams', …(1) ], …(1) ] to have a length of 1 but got 2`        |
| the `.finally` that drops the entry removed   | `expected [ [ '/api/teams', …(1) ] ] to have a length of 2 but got 1`              |
| the method check dropped, so writes share too | `expected [ [ '/api/projects/p1/opened', …(1) ] ] to have a length of 2 but got 1` |

The first asserts **inside the window the fault lives in** — the stubbed fetch never settles on its
own, because asserting after both promises resolve would give a count of 1 either way once the map
had emptied. The second says the window closes. The third says two writes to one path are two
writes however identical they look.

**The other half — narrowing which reads a write triggers — is not done, and the reason is a
finding.** The obvious move is to skip the five directory vocabularies on a plan write, since they
change on the order of days. But a plan write **can** change the directory: `createPerson` and
`createTag` are command kinds inside a plan batch, and the `@`-assignment flow mints a person. So
the scope is a property of the individual write, not of the path, and narrowing it safely means
auditing every call site of the write wrapper rather than flipping one flag. The socket path cannot
be narrowed at all today: `SubscriptionHandlers.onChange` takes no arguments, so fe-01 cannot tell a
`directory_changed` from a `tree_replaced` — the event type is on the wire and `project-stream.ts`
discards it. Both are real changes with real tests to write, and neither is a tail end of this one.

**Green:** `fe-01` 2046 pass across 75 files, lint, typecheck; `format:check --all`.

## 26 · Verify — W2-5 (the freeze), 2026-09-02

`setFrozenNumbers` wrote one `UPDATE` per row. A freeze names **every** work item in the project,
so a 2,000-row plan cost 2,000 statements — inside the outer transaction and therefore inside the
process-wide write lock, which is the cost ADR 0007 names as the first thing to revisit.

It is one statement now: `CASE id WHEN … THEN …` over one `IN` list. The numbers differ per row and
nothing else does, so one statement carries all of them. Built with `sql.join` rather than by
concatenation, so every id and every number goes in as a parameter.

**The proof counts statements, through drizzle's own `logQuery` hook** — the same seam
`project.db.test.ts`'s `costs one statement however many projects there are` uses. Three rows, so
"one" and "one per row" differ by more than the setup. With the loop restored it failed on
`expect(received).toHaveLength(expected)`, three where one is owed. The case also asserts each row
got **its own** number, because one statement that wrote nothing — or wrote the same number
everywhere — would count one too.

**The test's first draft was wrong in a way the repo cannot catch.** It passed `frozenNumber` as a
number, where `FrozenNumber.frozenNumber` says `string | null` and the column is `text`. The spec
project is outside be-01's typecheck target, so nothing objected; SQLite stored it as text and the
read is what said so. That is the same blind spot W1-1 found in fe-01's fixture, in a different app.

**Not done in W2-5:** `remove`'s per-row `DELETE` (its reverse ordering is load-bearing for
`parent_id`, so only the levels where that argument does not apply can batch) and
`DependencyStore.removeAllForMany`, which needs the `dependency(successor_id)` index W0-4 added and
a change at two service call sites.

**Green:** `be-01` 1270 pass across 93 files, lint, typecheck; `format:check --all`.

## 27 · Verify — W2-4 (two of four), 2026-09-02

Two quadratic passes on the plan-read path are linear:

- **`dependsOn`** filtered every row's stored predecessors down to the ones on this plan with
  `rows.some(...)` **inside** the map over `rows` — O(rows × edges × rows), on the read that every
  write and every socket frame performs. The project's ids are a `Set` built once.
- **`topological`** popped with `ready.shift()`, which is O(V) per pop and made the sort O(V²) in
  leaves. A moving head index instead. `canDepend` runs a whole sort per `addDependency` and
  `applyRestore` runs one per external edge, so restoring a branch with E edges over V leaves was
  O(E·V²).

The `shift()` needed an `undefined` guard and an index below `length` does not — this project does
not run `noUncheckedIndexedAccess`, and eslint's typed rule refuses the check as unreachable. It is
deleted with a note saying why, rather than left as a line whose removal nothing could observe.

**The gate for a change like this is the engine's own oracles, and they are why it was safe.**
`schedule-identity.test.ts`'s thousand-seed differential and the two captured oracles
(`capacity-migration-identity`, `priority-band-identity`) assert that the numbers do not move — 20
cases, green. The cycle refusals are separately green: `topological`'s `ScheduleCycleError` is what
`canDepend` refuses loops with, and twelve cycle cases pass.

**Not done:** `eventAt`'s `pool.events.splice()`, which makes profile construction O(E²) per pool
and whose aggregation-by-timestamp invariant carries its own watched proof; and
`projectOntoWorkItems`, which is O(parents × leaves) and spreads into `Math.min`/`Math.max` — a
plan with ~10⁵ leaves under one root would hit the argument-count limit and throw a `RangeError` no
branch handles. Both are real; both want their own change with the differential re-watched.

**Green:** `be-01` 1270 pass across 93 files, lint, typecheck; `format:check --all`.

## 28 · Verify — W2-2, 2026-09-02

`shownRows`, `ganttPlan` and `startFloor` are memoised. `GanttPanel` lays the whole chart out in
`useMemo(() => layOutGantt(plan), [plan])`, so an unmemoised `ganttPlan` meant every render of the
table re-laid-out every bar.

**Three things had to be stabilised first, and they were quadratic anyway.** `effectiveTeamLabelOf`,
`effectiveTagLabelOf` and `effectiveServiceLabelOf` were rebuilt on every render, so putting them in
a dependency list would have bought nothing. They are `useCallback`s now, and each did
`teams.find(...)` / `tags.find(...)` / `services.find(...)` **per row** while the chart's input calls
all three for every row it draws — naming a plan's labels was O(rows × directory), three times over.
They read `Map`s built once per directory read. `namedInTheTree` was a fresh `Map` per render too.

`startFloor` ran on **every** render — six index builds and a walk of every leaf — whether or not
the chart was open, to supply one hover sentence. It takes today as a plain `YYYY-MM-DD` so it can
be a dependency at all: a fresh `Date` each render would make the memo a no-op.

**The probe took three attempts, and the two failures are the useful part.**

1. A **Find** keystroke. It failed at 4 of 4 — correctly. Typing there narrows the shown rows, so
   the chart is entitled to be laid out again, and `search.visibleIds` is a fresh `Set` each time
   regardless. Wrong subject, not a wrong memo.
2. A keystroke in a **Name** cell. It passed — and **also passed with the memo removed**. That box
   is uncontrolled, so typing into it re-renders nothing at all, and the probe could not see the
   fault it was written for. This is the repo's own recorded failure mode: a check that cannot fail.
3. Opening a row's **⋯ menu** — `openMenuRowId` is a state of `WbsTable`, so the table renders, and
   no menu can move a bar. Watched failing on `expected 1 to be +0` with the memo taken back off.

A pointer on a bar was also considered and is not usable: since `pointed-row-render-cost` that
reading lives in an external store and does not render the table at all. All three rejections are
written into the test, so the next reader does not repeat them.

**Green:** `fe-01` 2047 pass across 75 files, lint, typecheck; `format:check --all`.

## 29 · Measured and refused — `eventAt`, 2026-09-02

The review called `pool.events.splice()` an O(E²) profile build and estimated ~4 million element
moves on a 2,000-slice single-pool plan. **Measured, it is not.** Instrumenting the splice to count
elements shifted, across every fixture the repo has:

| Fixture                                   | Inserts | Elements shifted | Shifted per insert | Longest pool list |
| ----------------------------------------- | ------- | ---------------- | ------------------ | ----------------- |
| `schedule-identity`'s thousand-seed sweep | 9,485   | 8,306            | **0.88**           | 17                |
| the captured capacity oracle              | 167     | 29               | **0.17**           | 12                |

Placement runs forward in time, so almost every new event belongs at or near the end and `splice`
does nothing. And `E` is small by construction: events are **aggregated by timestamp**, so a pool
holds one entry per distinct instant rather than one per slice — seventeen, at the widest this
repo's fixtures reach.

So the rewrite is refused, and that is the finding. It would add a `Map` and a lazily-sorted array
for no measured gain, and it would put the aggregation-by-timestamp invariant — which carries its
own watched proof at `schedule.ts:605–621` — at risk to buy nothing. A sorted-array insert is the
right structure for seventeen entries.

What would change this: a plan whose pool holds thousands of distinct instants. Nothing in the
product produces one today, and if one appears the measurement above is the thing to re-run rather
than a reason to have rewritten it in advance.

`projectOntoWorkItems` is **not** refused — it is O(parents × leaves) and spreads into
`Math.min`/`Math.max`, so a plan with ~10⁵ leaves under one root throws a `RangeError` no branch
handles. That is a correctness cliff rather than a constant factor, and it is still worth doing.

## 30 · Measured and mostly refused — the repository barrel, 2026-09-02

W4-1 proposed moving each store's own types next to its implementation, on the reading that
`index.ts` is 2,017 lines with nine single-consumer exports and five with none. Measured, that
reading does not hold.

| Measure                             | Value                       |
| ----------------------------------- | --------------------------- |
| lines                               | 2,006                       |
| **comment lines**                   | **1,403** (70%)             |
| blank                               | 85                          |
| declarations                        | ~518 lines                  |
| store ports                         | 16                          |
| exported types                      | 76                          |
| of those, **named by a store port** | **68**                      |
| the other 8                         | all have external consumers |

So the file is not a bag of stray types. It is sixteen store ports and the vocabulary they are
declared in, plus the JSDoc that explains it — which is R3 working exactly as intended and is what
the audit's own C7 calls the best documentation in the repo.

**The five "exports with no consumer at all" each have one:** `StepRemoval` is used by the port
union two lines below it (and fe-01 has a _different_ type of the same name, which is what made the
grep look empty), and the other four are referenced two or three times inside the barrel itself.
None was dead. What four of them were is **needlessly public** — used only within `index.ts` — so
`DirectoryWriteRefusal`, `ExternalRefWrite`, `OidcAccountIdentity` and `StepWriteRefusal` lost their
`export` keyword. `tsc --build` on both the lib and the spec project confirms nothing outside wanted
them.

**And moving the rest out would invert the dependency.** `TagWritten` is `DirectoryStore.renameTag`'s
return type: the barrel declares the port, the store implements it, so a barrel importing the type
from the store it defines the contract for is backwards.

**What is real about W4-1 is the caching, not the contents.** Seventy-two files import this module,
so touching it invalidates their typecheck — an ordinary cost of a shared contract, and one that
splitting per-store would not remove because the ports would still be shared. The other real cost,
the read set, is 70% prose: an agent pays 2,006 lines to reach one type, and the fix for that is
`W4-9`'s module README pointing into the file, not a split.

**Green:** `be-01` 1270 pass across 93 files, lint, typecheck; `format:check --all`.

## 31 · Verify — W4-2 (the two that could move today), 2026-09-02

`derive-numbers.ts` and `place-sibling.ts` are in `libs/domain/src/` with their suites. Both
imported **nothing at all** — they declare their own input shapes (`WorkItemPlacement`, `Sibling`)
and answer questions about a plan's shape rather than about storage: what number a work item takes
from where it sits, and where a new sibling goes.

| Project       | Tests before | after   |
| ------------- | ------------ | ------- |
| `libs/domain` | 145          | **167** |
| `apps/be-01`  | 1,270        | 1,248   |

22 moved, and the two figures reconcile exactly — which is the check that the move carried the
suites rather than dropping them.

Four consumers now read them through `@wbs/domain`: `work-item.service.ts`, `schedule.ts`,
`directory-usage.ts` and `review-findings.test.ts`. The domain barrel names them with the reason
they belong there, beside the note explaining why `effective-label` is deliberately absent — that
file is a curated list, not a re-export of the directory.

They also become testable where they are cheapest: `libs/domain`'s whole suite is 0.2s, against
be-01's fast tier at 12.7s.

**The rest of W4-2 needs the row-type mapping first.** `schedule.ts` is the prize — 2,212 lines
reading exactly three fields of `WorkItem` — and moving it means declaring `PlannedRow` in
`libs/domain` and flipping the type-import direction so `repository/index.ts`'s `WorkItem`
structurally satisfies it. `assumed-assignee.ts` needs a three-field `StepAssignment`; `roll-up.ts`
needs five named types; `compensating.ts` should stay, because it is the journal's vocabulary and
imports eighteen row types. That is the change this one clears the ground for.

**Green:** `libs/domain` 167 pass, `be-01` 1248 pass across 91 files, `fe-01` 2047 pass; lint and
typecheck on all three; `format:check --all`.

### 31.1 · `schedule.ts` no longer imports storage

The engine's one tie to the repository was `import type { WorkItem } from '../repository'`, used in
four signatures. It is gone: `PlannedRow` is declared in `libs/domain` beside `WorkItemPlacement`,
and `WorkItem` satisfies it structurally, so every caller passes the rows it already has and nothing
maps anything.

**The review said three fields; it is five, and the compiler said so.** `schedule.ts` calls
`deriveNumbers` on the way past, so the engine needs everything _numbering_ needs —
`id`, `parentId`, `position`, `frozenNumber` — plus the `priority` the leveller ranks by. The first
draft named `id`, `parentId` and `priority` alone and was refused on exactly that call:
`Type 'PlannedRow' is missing the following properties from type 'WorkItemPlacement': position,
frozenNumber`. `PlannedRow extends WorkItemPlacement` now, which is a better statement of the fact
anyway: the engine numbers the rows it schedules.

This is the part that mattered. The 2,212 lines are now pure planning with no storage type in them,
so the physical move into `libs/domain` is a `git mv` and an import rewrite rather than a design
question — and until it happens, nothing has been lost: the coupling the move exists to remove is
already gone.

**Green:** `libs/domain` 167 pass, `be-01` 1248 pass across 91 files, lint and typecheck on both;
`format:check --all`.

## 32 · W4-2 — the schedule engine moves into `libs/domain`

`schedule.ts` and eight of its nine suites are now `libs/domain/src/`. 7,559 lines, one
`git mv`, and no behaviour change: **1,415 tests before and 1,415 after**, redistributed
167 → 316 in `domain` and 1,248 → 1,099 in `be-01`.

The ninth, `schedule-assumed-duration.test.ts`, stays in be-01 because it also drives
`rollUp`, which still takes five repository types. It imports `schedule` across the seam
like any other caller.

### What made it a `git mv` rather than a design question

§31.1's decoupling. The engine imported one type from storage; once `PlannedRow` said what
it actually read, the file imported four sibling modules and nothing else. Everything in
this section is consequence.

### The engine reads five fields, and the suites were claiming eleven

Counted directly in the engine: `parentId` twice, `priority` twice, and **zero** reads of
`maxParallel`, `serviceTeamId`, `serviceId`, `startNoEarlierThan`, `projectId`, `revision`,
`name`, `notes`. `position` and `frozenNumber` are read one layer down, by the
`deriveNumbers` the engine calls.

The row factories built all fifteen. Switching their annotation to `PlannedRow` turned
TypeScript's excess-property check into the audit: ten errors, one per factory. Trimming
them to five surfaced the real finding.

**35 call sites passed a cause that had no effect.** `item('a', { maxParallel: 3 })` and
`item(id, { serviceTeamId: PLATFORM })` read as the setup for the assertion under them.
They are not: the engine learns width and pool membership from the **slice**
(`slice('a', DEV, 6, { width: 3 })`, `poolIds: [PLATFORM]`), which the suite's own comment
already said was "the adapter's reading". An agent changing `maxParallel: 3` to `1` would
expect the test to move and would watch nothing happen.

All 35 are deleted and all 149 engine cases stayed green, which is what proves they were
decorative. They cannot return: `Partial<Pick<PlannedRow, 'parentId' | 'priority'>>` makes
naming `maxParallel` a compile error.

### What keeps the engine here

`@nx/enforce-module-boundaries`. `domain` is tagged `runtime:isomorphic` and may depend
only on isomorphic libs, so a storage type cannot come back quietly.

**Proof, watched:** `import { verifyToken } from '@wbs/auth'` (auth is `runtime:bun`) failed
on `A project tagged with "runtime:isomorphic" can only depend on libs tagged with
"runtime:isomorphic"`, clean with it removed.

**And a defect found while proving it.** The same rule fires on a relative reach —
`import type { WorkItem } from '../../../apps/be-01/src/repository'` — but reports it as
`Error: ENOENT: no such file or directory, open '.../apps/be-01/src/index.ts'` with a stack,
because Nx's autofix tries to rewrite the path against a barrel an app does not have. Lint
still exits non-zero, so CI still blocks and the guarantee holds. Only the message is
useless. Recorded on `schedule()` so the next reader does not diagnose it as broken tooling.

### Green

| Target               | Result                              |
| -------------------- | ----------------------------------- |
| `domain` test        | 316 pass, 0 fail, 34,575 assertions |
| `be-01` test         | 1,099 pass, 0 fail across 83 files  |
| lint, typecheck      | both projects clean                 |
| `format:check --all` | clean                               |
| workspace `run-many` | green except `tool-bootstrap:test`  |

Fourteen JSDoc references to `service/schedule.ts` across `schema.ts` and the services now
name the new path.

**`tool-bootstrap:test` did not pass, and it is not this change.** It dies in
`configure-caddy-merge.test.ts` — a Caddy config merge, nothing to do with scheduling — and
run on its own against this same working tree it did not finish inside 500s either. This
change touches **zero** files under `tools/` (`git diff --name-only` says so), and
`tool-bootstrap` names neither `@wbs/domain` nor anything that moved. It is the pre-existing
failure already in the plan's landmines, unchanged. Stated rather than skipped: the whole
workspace gate was not green, and this is why.

## 33 · W2-4 — `projectOntoWorkItems`, and three defaults that hid a broken index

The item was proposed as a performance fix with a `RangeError` cliff behind it. The cliff is
not reachable, the speed-up is small, and the change is worth keeping for a third reason the
review did not name.

### The `RangeError` is real and out of reach

`Math.min(...xs)` does throw `RangeError: Maximum call stack size exceeded.` — measured in
this runtime at **between 500,000 and 1,000,000 arguments** (500k passed, 1M threw). The
parent loop spread every leaf under a row into eight such calls, so a plan with half a
million leaves under one parent would have crashed. Nothing this tool plans is that shape.
Recorded in the code and **not** treated as a defect.

### The speed-up is about 8%, not a multiple

Both versions timed alternately, best of 20 to 200 runs each, discarding a cold first pass:

| Plan                             | Before (best / median) | After (best / median) |
| -------------------------------- | ---------------------- | --------------------- |
| 220 rows, 600 slices             | 0.69 / 0.80 ms         | 0.63 / 0.77 ms        |
| 2,020 rows, 6,000 slices         | 10.84 / 15.71 ms       | 8.33 / 14.20 ms       |
| 20,020 rows, 60,000 slices       | 123.01 / 147.55 ms     | 113.82 / 138.64 ms    |
| 20,001 rows under **one** parent | 322.90 / 347.93 ms     | 317.31 / 346.07 ms    |

Never slower, consistently a few percent faster, and under a millisecond in absolute terms at
any size this tool sees. **A hypothesis that was wrong:** the flat shape costs roughly twice
the nested one at identical row and slice counts, and the spread was not why — removing it
moved that case by 2%. Whatever causes it is elsewhere in the engine and is not this item.

### What actually justified the change

Fourteen `beneath.map(...)` and `own.map(...)` allocations became two loops, and with them
went three defaults that were each reading a broken index as a legal plan:

- `index.leavesUnder.get(row.id) ?? []`
- `if (beneath === undefined) continue`
- `Math.min(...starts, Infinity) === Infinity ? 0 : …`, which conflated "no leaves" with
  "the minimum happens to be `Infinity`"

None can fire. `leafIds` is every row with no children, so a row reaching that loop has
children; `walk` returns `[id]` for a childless id and `flatMap`s its children otherwise, so
in a finite tree every non-leaf resolves to at least one leaf, each is a `leafId`, and the
leaf loop placed all of them. That is exactly R5's case: an invariant, so **throw**, because
reading a missing leaf as a zero-length span at day zero draws a silently wrong bar.

**First evidence that they were vacuous:** deleting the empty-parent floor outright left all
316 tests green.

**Proofs, watched 2026-09-02**, each injected into `indexTree` after its walk and run against
`schedule-shapes.test.ts`:

| Injected fault                                   | Failure observed                             |
| ------------------------------------------------ | -------------------------------------------- |
| delete every top-level row's `leavesUnder` entry | `no leaves indexed under P`                  |
| append `'ghost-leaf'` to every non-empty entry   | `leaf ghost-leaf under P was never placed`   |
| empty a top-level row's entry                    | `P is not a leaf and has no leaves under it` |

Under the defaults these replaced, all three faults were silent.

**Green:** `domain` 316 pass, 0 fail, 34,575 assertions — the thousand-seed differential and
both captured oracles among them. Lint and typecheck clean.

## 34 · W2-5 — the subtree delete, and a bump that landed on a doomed row

Both halves done. A subtree delete of N rows used to cost roughly **3N + 1** statements
across N + 1 transactions; it now costs **5**, whatever N is.

### The dependency N+1, and the wrongness inside it

`removeAllFor` took one work item id, and a subtree delete called it once per doomed row —
a transaction, a read and a write each, inside the outer transaction and therefore inside
the process-wide write lock (ADR 0007).

The interface now takes the whole doomed set, which is **smaller**, not larger: three call
sites, two of which were loops, and the third passes `[id]`.

**It was also answering wrongly.** The method's own contract says it bumps the surviving ends
and not the row on its way out, because moving a counter onto a row about to stop existing is
meaningless. From inside a single-id call a **doomed sibling is indistinguishable from a
survivor**, so an edge between two rows both being deleted bumped the far end anyway. Reading
the set is what makes that answerable.

The test is four rows: `a` and `b` doomed and joined to each other, `c` a survivor that loses
an edge, `d` untouched. It asserts revision **deltas**, not absolutes — adding an edge already
bumps both of its ends, so `b` and `c` do not start at zero and what the claim is about is
what the _removal_ moves.

**Proofs, both watched 2026-09-02** with the per-row loop restored:

| Half                                     | Failure observed                            |
| ---------------------------------------- | ------------------------------------------- |
| statement count                          | `Expected length: 3` · `Received length: 6` |
| survivor rule (count assertion silenced) | `Expected: 0` · `Received: 1` at `moved(b)` |

### The per-row DELETE, and the constraint that was not one

`remove` deleted one row per statement, deepest first, on the reasoning that
`work_item.parent_id` references `work_item.id` and so a parent cannot go before its child.

That is true statement by statement and **irrelevant inside one**. SQLite checks an immediate
foreign key at the **end of the statement**, not after each row, so a single
`DELETE … WHERE id IN (…)` naming a parent and its child is legal however SQLite visits them.
Measured against a self-referencing table before the change was written: ancestors-first,
leaves-first, and with `defer_foreign_keys` all succeeded. A 2,000-row plan is one statement
rather than 2,000.

The test hands the ids in **ancestors-first** order, exactly as `subtreeOf` produces them —
the arrangement the reversal existed for.

**Proof, watched 2026-09-02** with the per-row loop restored:
`expect(received).toHaveLength(expected)` · `Expected length: 2` · `Received length: 4`.

**Green:** `be-01` 1,101 pass across 83 files (two new), `domain` 316 pass, lint and typecheck
on both.

## 35 · W2-3 — two of its three parts measured and refused, the third needs an OpenSpec change

Not started as a code change. Two of the three things the row asks for were measured and are
not worth doing; the third is architecture and this repo requires an OpenSpec change for that.

### `tree()`'s sequential awaits → `Promise.all` buys **nothing**

Nine reads run one after another in `tree()`, and only three orderings are real: `project`
gates the null return, `assigned` needs `rows`, and the people filter needs `assigned`. The
other seven look like an obvious `Promise.all`.

They are not, because **`bun:sqlite` is synchronous.** A store method here is `async` with a
`await Promise.resolve()` and a synchronous body, so there is no I/O to overlap — the awaits
only defer to microtasks. Eight such reads over a 20,000-row table, best of 20 runs after a
warm-up:

| Shape            | Best     | Median   |
| ---------------- | -------- | -------- |
| sequential ×8    | 14.40 ms | 14.60 ms |
| `Promise.all` ×8 | 14.40 ms | 14.66 ms |

Identical. **Refused**, and worth keeping written down: "just parallelise the reads" is wrong
for every store in this repo for the same reason.

### The duplicate `deriveNumbers` is ~5%, and removing it costs the interface

`tree()` derives the numbers, then `schedule()` derives them again from the same rows.

| Plan        | `deriveNumbers` | whole `schedule` | duplicate as a share |
| ----------- | --------------- | ---------------- | -------------------- |
| 220 rows    | 0.05 ms         | 0.96 ms          | 5.5%                 |
| 2,020 rows  | 0.53 ms         | 11.45 ms         | 4.7%                 |
| 20,020 rows | 17.21 ms        | 112.26 ms        | 15.3%                |

Removing it means either handing the engine a pre-derived map — widening a pure engine's input
so a caller can save a step — or widening `Schedule`'s output with something that is not about
scheduling. Half a millisecond at the size this tool plans is not worth either. **Refused.**

### The plan snapshot is the real item, and it is architecture

The remaining part is the one that matters: `applyAll` dispatches each command to a
`WorkItemService` method that re-reads the plan to validate it, so an N-command batch reads
the plan N times inside one transaction and one write lock. A snapshot opened once before the
loop, updated in place by the mutators, is the fix.

It touches 44 `listByProject` call sites and changes how the service is composed, which
`CLAUDE.md` R4 puts behind an **OpenSpec change**: intent, one design interview, delta specs,
`tasks.md`, `verify.md`. **Not started** rather than half-done inline.

## 36 · W3-11 — the small collapses, and two of its premises refused

Eight sub-items were named. **Six done, two refused**, and one of the six turned out to be a
check that could not fail rather than a duplication.

**`isUniqueViolation(err, index)`.** Seven `err.message.includes('UNIQUE constraint failed: …')`
literals — five in `repository/directory.ts`, one in `step.ts`, one written inline in `user.ts` —
became one function plus `UNIQUE_INDEXES`, which names the seven indexes a repository translates
into a modeled refusal. The point is the check that did not exist: `constraint.db.test.ts` walks
every entry against a migrated database's `PRAGMA index_list`, **and** writes a real duplicate
through a one-column and a two-column index, so the message _format_ is asserted too. The
`role` → `step` rename broke exactly this once, silently, taking every duplicate step name from a
409 to an uncaught 500. Both faults watched: the pre-rename spelling fails the pragma case on
`Received: []` (a pragma on a table SQLite does not have answers an empty list rather than
throwing — which is why the assertion is `toContainEqual` and not a length) and the live case on
`expected false to be true`; the join narrowed from `', '` to `','` fails **only** the two-column
live case, with every pragma case green.

**`isWithin`.** `descendsFrom` in `work-item.service.ts` and `isWithin` in `dependency.ts` were
byte-identical under two names; `drag-drop.ts` held a third copy and `dep-graph.ts` a fourth over
a pre-built parent map. One `libs/domain/src/is-within.ts`, with `parentIndexOf` split out —
`canDepend` asked the question twice and built the index twice. Two semantics that were only in
one copy's JSDoc are now stated where the code is: the root counts as within itself (that is how
a drag into itself and an edge onto itself are refused) and an unknown id ends the walk as
`false` (that is how a cross-project id arrives at `canDepend`). fe-01 imports it as
`@wbs/domain/is-within` — seven config files, because the barrel would pull `schedule.ts` into
the browser bundle.

**`cleanName`.** Two identical copies, one `service/clean-name.ts`. The third rule with the same
tail (`work-item.controller.ts`) stays: it also enforces a length ceiling and belongs at the
request boundary.

**`STEP_COLUMNS`** replaces the four-column projection written five times (`listByProject`,
`findById`, `rename`'s `returning`, `ProjectRepository.stepsOf`), in the shape
`WORK_ITEM_COLUMNS` already set. And the comment all of them carried was a claim that cannot
fail: "the declared return type checks the list is complete" is true of a **missing** column and
false of an extra one, because a row with three extra properties is structurally assignable to
`Step`. A bare `select()` typechecks and publishes `created_by`. `what a step read publishes`
now asserts all four reads against the keys of the `Step` literal `add` builds, watched failing
on `- Expected - 0 · + Received + 3` with `.select()` put back — and taking a second, unrelated
assertion down with it.

**One app fixture.** `emit-openapi-cli.ts` and `openapi-document.test.ts` held byte-identical
thirteen-double `buildApp` literals, and they are the pair that must agree exactly: one writes
the committed document, the other fails until it is rewritten. `testing/app-fixture.ts` is the
one list, overrides spread last. Proof it is the same app: re-running the CLI leaves
`openapi.json` byte-identical.

**Three fe-01 collapses.** `forgetDraft`/`forgetNameDraft` were the same two lines under two
names, left over from when a team's size box lived on the directory page. `httpProjectApi`
spreads the directory client instead of forwarding thirteen methods one line at a time. And the
16-field `tree` payload was written twice — documented on `ProjectApi.tree`, bare as
`send<{…}>` — and is `PlanRead` once; the two field sets were verified identical before the
merge.

**Refused: deleting `stepsOf` from `ProjectRepository`.** The plan says four callers hold a
`StepStore`. None does — `ProjectService` takes only `projects: ProjectStore` and
`WorkItemService` has no step store either — so the change is a constructor widening across
every fixture plus `work-item.service.test.ts`'s deliberate `stepsOf` override, which is a test
about two reads answering differently. The duplication was the column list, and that is what got
collapsed.

**Refused: `ProjectApi extends DirectoryApi`.** The 13 shared members are real, but
`DirectoryApi` has eight more (the renames and removals the directory page owns), and extending
would put all eight on every `ProjectApi` fake — a wider port than any plan caller wants. The 13
delegation lines the item was counting are gone anyway, via the spread.

**Green:** be-01 616 store / 654 unit, fe-01 2047 across 75 files, domain 321, lint and typecheck
on all three, `prettier --check .`.

## 37 · W3-7 — one clock behind seven identical stamps

ADR 0012's sentence — an act reads the clock once, and every row it writes and every event it
records carries that one reading — was **seven** identical `private stampFor(actorId)` methods
over seven injected `now`s. Seven copies of a rule about reading a clock once is seven places
for a second reading to appear.

`service/clock.ts` holds it once: `Clock` with `now`, `newId` and `stampFor`, built by
`clockOf()` **once** in `services.ts` and handed to all seven services. `stampFor` is derived
from that `now` rather than injectable beside it, because a stamp whose instant came from
somewhere else is the drift the type exists to stop. `ReplayBuffer`, `RetentionTimer` and
`LoginThrottle` keep their own `now`, and the reason is written down: they age their own entries,
write no row, and in their suites the passage of time is the subject rather than a detail to hold
still.

`EventSequencer` is **deleted**. It was a pass-through that added a clock read — which is what a
`Clock` is — and the sequence numbers were always the log's own, assigned in one statement by
`DrizzleEventLogRepo.recordEvent`. `GatewayBroadcaster` takes the `EventLogRepo` and a clock. Its
two assertions moved to `event-log.db.test.ts`, where the behaviour actually lives.

`clock.test.ts` guards the collapse in `audit.test.ts`'s shape — a text read, because what has to
be refused is a shape no type can state — plus one case pinning the rule itself: one `stampFor`
costs exactly one reading of `now`. Both source cases watched: `now?: () => number` put back on
`CapacityServiceOptions` fails on `+ ["capacity.service.ts"]`, and so does a `stampFor` restored
there.

One test changed and it is an API change: `project.controller.test.ts`'s monotonic tick is
`clock: clockOf({ now })`. Test counts: 493 unit + 619 store, 1107 before and 1107 after — the two
moved.

## 38 · W3-5 — one identity guard, and the guard nobody could see break

Twenty-three handlers opened with the same five lines, and two then repeated a scope check.
`middleware/caller.ts` is the rule once, as an Elysia **macro**: `{ caller: 'signed-in' }` or
`{ caller: 'read-scope' }` per route, and the handler is handed a `user` already narrowed to
non-null — there is no `null` left to forget. A macro rather than a wrapper function because a
wrapper has to name the context type and would cost Elysia's inference of `params`, `query` and
`body` at every route; unnamed on purpose, because the suite builds many apps in one process with
their own `AuthService` and Elysia dedupes named plugins. `directory.controller.ts` went 69 → 40
lines with more prose in it than before.

**The injected fault found an untested guard.** With `{ caller: 'signed-in' }` taken off
`GET /api/teams`, all 30 cases in `directory.controller.db.test.ts` passed: five of the six
directory reads had no 401 negative at all (`GET /api/services` was covered only incidentally, by
a service-command case), so six identical guards could never be seen to break. One case over all
six now — the claim is "no read in this controller answers an anonymous caller", and a per-route
test is a list somebody has to remember to extend — watched failing on
`- "/api/teams": 401 · + "/api/teams": 200` with one guard off, and on all six with all of them
off. The `read-scope` half was watched too: weakened to `signed-in`, `refuses project exports
without read scope` fails on `Expected: 403 · Received: 404`.

The two cookie parsers became one, and it deliberately does **not** decode: the two readers want
different things of a malformed value — `tokenFromHeaders` treats an undecodable cookie as absent
so a Bearer header still gets its chance, while the origin check only asks whether a session
cookie is there. The copy in `auth.controller.ts` decoded every value to read none of them, so one
stray `%` threw a `URIError` out of `onRequest`: a 500 about a malformed request, which is the one
thing R5 says an Elysia route must not answer.

`openapi.json` was re-emitted after both changes and is byte-identical, which is the evidence that
no route or annotation moved.

## 39 · W3-2 — one `remembered`, and the two distinctions only one copy made

Ten `remembered*`/`remember*`/`forget*` families across four files each wrote out get-item, parse,
validate, drop-the-key, fall back. `lib/remembered.ts` holds it once. What makes it worth more
than the line count is that the eleven copies **did not agree**, and the two disagreements were
both real:

- **`read` against `readAndDrop`.** Dropping a key is a write, and a lazy `useState` initialiser
  is a function React calls during a render and StrictMode calls twice on purpose. `theme.ts` and
  `gantt-panel.tsx` had worked that out (cross-review, 2026-08-12); the other nine had one method.
- **`Claim` has three states.** `absent` and `refused` are different answers for the Gantt detail
  switch: nothing stored opens the arrows for a plan that has edges, a refused value does not.
  Watched — collapsed into `return hasEdges`, that switch's two storage cases fail on `expected
'true' to be 'false'` (`2 failed | 159 passed`).

Ranges belong **inside** the guard, which the height store proves: with the bounds dropped and
`typeof claimed === 'number'` left, `refuses a height below the floor` fails on `expected '10px'
to be ''` and the ceiling case on `expected '99999px' to be ''`, while the not-a-number case stays
green — so a range checked beside the guard would have been a check about a different fault.

`rememberedText` is the sibling for the settings modal, whose key is written as bare text:
switching it to JSON would write `"teams"` with quotes and silently forget the tab every existing
reader was on. The stored format is a compatibility fact, not a style choice.

**Not converted:** `project-page.tsx`'s remembered project id, with the reason in the file — its
claim is judged against the project list the load just fetched rather than against a shape, so
there is nothing to hand a guard built at module scope.

Two `Proof:` comments were rewritten and **re-watched** rather than reasoned about: `readAndDrop`
→ `read` fails theme's two storage cases and the Mermaid lane's two (`2 failed | 22 passed`).

**Green:** fe-01 2047 across 75 files, twice, cold. And a note for the next reader: three of these
tests time out at 5s on a loaded machine and pass in isolation. A full fe-01 run wants the box to
itself, and a run that races an edit reports failures in whatever files it caught mid-write.

## 40 · W3-1 — a satellite read in one statement, and a default for an unknown

The four satellite stores read a project in **two** queries: every work item id, then `IN (…)`
over the lot. That is one bound parameter per row, four times over per plan read, and a plan of
33,000 rows would have passed SQLite's parameter ceiling and had the read refused outright. One
statement now, joining through `work_item`; measured at 1 statement with no `in (` in the SQL.

`rowsChanged(reader, what)` replaces five copies of "how many rows did that statement change",
and the fifth was not a copy: `pruneBeyond` read `?? 0`, so an empty `SELECT changes()` would have
reported **nothing pruned** — a default for an unknown in the one place a caller acts on the
number, three files from `plan-event.ts`'s comment arguing against exactly that. It throws now.
There is no negative test and there cannot be one (`SELECT changes()` answers one row, always),
and the JSDoc says so rather than implying a check that could fail.

**Refused: the one parameterised satellite store.** The value columns, the key width
(`step_measure` carries a third) and the revision bump (unconditional for estimates, conditional
on `changes()` for the other three) all differ, so one store takes each as an option — and it
needs a cast to hand drizzle a table whose shape a generic does not know. The rules would be no
shorter and no longer typechecked. What was actually duplicated was the read shape and the
`changes()` block, and both are gone.

`reads a project's estimates in one statement, with no parameter per row` holds it, at twenty rows
because at two the fault differs by one statement. Both faults watched: the two-query shape fails
on `Expected length: 1 · Received length: 2`, and a one-element `IN` list wearing the join's
clothes on `Expected to not contain: "in ("`.

## 41 · W3-4 — nine bodies, one rule, and two halves left where they are

`DirectoryService` held add, rename and remove for tags, work item types and services — nine
bodies agreeing line for line: clean the name, refuse a blank one, mint an id, ask the store, turn
`taken` into a refusal carrying the **clean** name, announce to the projects the store named. One
rule now, in three private methods over a `NamedVocabulary<T>`, with the nine public methods
keeping their per-dimension JSDoc. The descriptor exists rather than a base class because the
store's three answers differ in exactly one thing: the field the written row arrives under.

`directory-usage.ts`'s three one-line lambdas became `usageOfLabelIn`, and each keeps the
documentation worth reading — not the line, but the arms they deliberately lack.

**Refused, both with reasons.** The store half means handing drizzle a table whose shape a generic
does not know: `.values()` and `.returning()` need a cast. `plan-commands.ts`'s five triples wait
for W4-3's command registry, which the plan itself says is where they land.

## 42 · W3-6 — one refusal lookup, one boundary, and an arm with no test

Six fe-01 tables each wrote out the same lookup: an exact-code table, a spelled-limit prefix, a
5xx arm, a grammatical fallback carrying the code. `lib/refusal.ts` is that shape once, with
`RefusalWords` as the data per surface — the codes are be-01's contract, the wording is a
presentation decision. The three surfaces that disagreed still disagree, and it is now an **absent
field** rather than a missing `if`. `refusal.test.ts` pins one sentence per surface first.

Order was the one thing six copies could have disagreed about: swapping the exact-code lookup and
the limit loop fails on `expected 'at most 9' to be 'exactly this'` — with all four real surfaces
green under that fault, which is why the case uses a code both rules claim.

Both error boundaries were the same class written twice, with two byte-identical `faultWords`.
`FaultBoundary` takes the fallback, the console line and a `resetKey` — a constant at the root, the
tree generation at the chart. `app-fault.tsx` carried a note saying the helper must not be shared
because the two say different things; that is true of the sentence, and the sentence is in each
boundary's own JSX.

be-01's five refusal→status tables became `statusForRefusal(reason, otherwise)`: four shared arms,
the default as the argument, because the default is the only part that differed. Every reason union
was checked against the shared arms first, so no status moved — and `openapi.json` re-emitted
byte-identical.

And its one exception, `unknown_ref` → 400 rather than 404, **had no test at all**: with the arm
deleted, 494 unit and 619 store tests stayed green. `answers 400 for a ref nobody minted, and 404
for a row that is not there` asks both codes of the same route now, watched failing on
`- 400 · + 404`.

## 43 · W3-9 — one realtime envelope, and a vocabulary that was wrong

Fifteen outbound frames were hand-written `JSON.stringify` literals — ten in gw-01's
`ws.controller.ts`, two in `presence.ts`, two in fe-01, one in `libs/realtime` — and the two tiers
agreed by having been written on the same afternoon. `libs/contracts/src/ws-frames.ts` builds every
one; `ws.ts` declares the parsers and re-exports the builders.

The vocabulary was not merely partial, it was **wrong**, and neither end could see it. gw-01 sends
`resume_denied` with `reason: 'unavailable'` when be-01 cannot be reached, against a parser
declaring `'out_of_range'` as the only reason; and an `error` frame naming the `subscription` it
refused, against an arm with no such field. fe-01 reads `type` and ignores the rest. `presence`,
`subscribe`, `unsubscribe` and `who` were not declared at all.

`the frames a builder writes` is a round trip — build, parse, hand it to the parser the other tier
judges an inbound frame with. Watched: `'unavailable'` removed fails on `reason must be
"out_of_range" (was "unavailable")`, and `code` renamed in the builder on `code must be a string
(was missing)`.

The builders import nothing, so fe-01 takes them as `@wbs/contracts/ws-frames` rather than through
the barrel, whose arktype validators are deliberately outside the browser bundle.

**And the two socket clients stopped contradicting each other.** `libs/realtime`'s
`createReconnectingWs` advanced the sequence **on the frame** — the mistake fe-01's live
`project-stream.ts` documents at length, because a refetch may fail and the table keeps the last
good tree on purpose. It takes a `seen(subscription, seq)` from its caller now, and both files say
which of them is live and which is scaffold. `tanstack-adapter.ts` is deleted: sixteen lines for a
TanStack DB this repo has never depended on.

## 44 · W3-10 — refused, because two of its three parts are hardenings

Adopting `libs/auth`'s `InMemoryOidcTransactionStore` in mcp-01 is not a refactor. That store
**digests** the browser binding before using it as a key, and compares the state with
`timingSafeEqual`; mcp-01's own map keys on the raw binding and compares with `!==`. Adopting it
changes both, which is the plan's own "two intentional hardenings, each with a watched negative" —
on the auth surface, with 24 capacity cases to move to a registry that does not exist yet.

That is a change of its own, with the negatives written before the code. What is left after the
hardenings are excluded is code motion inside a 608-line class (`DynamicClientRegistry`,
`LocalTokenIssuer`), which is worth doing and is W4-shaped rather than W3-shaped.

## 45 · W4-7 — the nouns, and one the plan got wrong

`result` is on AGENTS.md R2's banned list and **nine** be-01 outcome unions used it. All nine say
`value` now, because one type saying `value` beside eight saying `result` is worse than either.
`ItemState` → `WorkItemState` (`item` is on the same list), `AuthResult` → `SignedIn` (it is the
token and the identity, which is a thing).

**`BatchResult` → `BatchOutcome` is a collision**: that name is already the union describing the
whole batch. `BatchResult` is what one applied command produced, so it is `AppliedCommand`. The
wire field stays `results` — fe-01, mcp-01 and `openapi.json` read it.

`ProjectApi`'s eight bare verbs got their objects: `api.patch(id, …)` on an interface whose subject
is a project reads as "patch what?". `tree`, `steps`, `undo` and `redo` are left — two nouns and
two verbs that take the project.

All of it compiler-driven, and the interesting part is what the compiler **could not** see: two
fakes are cast to `ProjectApi` rather than typed as it, and the test run caught them as
`api.createWorkItem is not a function`. Two near-misses came from renaming by shape rather than by
type — `patch`'s own parameter is called `patch`, and `CardRowActionHandlers` has its own
`remove`/`duplicate`/`unfreeze` whose `remove` takes a row. Both reverted. The spec projects are
outside the typecheck gate, so their error counts were taken before and after (be-01 107, fe-01
98, unchanged both) as the evidence nothing else moved.

## 46 · W3-3 — deferred into W4-4, on purpose

The four `ReferenceSetStrip` columns it collapses are 263 of the lines W4-4 splits into
`plan-columns/*`, and the two changes would edit them twice. The abstraction W3-3 asks for mostly
exists already: `ReferenceSetAdapter` holds the accumulate-vs-override distinction (ADR 0008) and
the `type` kind's deliberate absence of both inheritance shapes (ADR 0009), and each column's
remaining difference is its **wording** — which is a per-surface decision, exactly as the refusal
tables in §42 turned out to be.

## 47 · W2-9 — `addWorkdays` is arithmetic, 16× measured

`addWorkdays` and `workdaysBetween` walked a calendar day at a time, allocating a `Date` per day —
weekends included, and then skipped. The scheduler calls the first per slice per read and the chart
calls it per bar: a 250-workday plan of 200 rows was a quarter of a million allocations a read.

Both are closed form: a weekday's position in Mon,Tue,…,Fri,Mon,… is `5 · weeks + weekday`, so two
of those subtract to a workday count and one inverts back to a date. **176ms against 2,833ms over
200,000 calls at offset 250 — 16.1×.**

Replacing arithmetic every date in the tool comes out of needs more than examples.
`workday.property.test.ts` holds the walk as its oracle — copied, not imported, because an oracle
that called the code under test proves nothing — and compares 3,500 exhaustive pairs, 1,000 random
`addWorkdays` cases, 400 `workdaysBetween` pairs including dates before `from`, and a round trip.
Two faults watched (the `+ 3` origin shift, and `workdaysBetween` reading the calendar difference),
and **one recorded as undetectable**: a `Math.min(days % 7, 4)` clamp changes nothing, because
`nextWorkday` has moved every input off a weekend already. A reader who adds it should know the
tests cannot tell them apart.

## 48 · W2-13 — one socket per browser

The presence panel opened a WebSocket of its own, per project: two connections per browser, two
`subscribe` frames, two entries in gw-01's fan-out, to be told the same thing by the same gateway
the table was already listening to. `subscribeToProject` gains `onPresence`, sends `who` **after**
the subscribe (`who` is answered with this connection's project, so the other order is answered
with nobody — F4), and asks only when somebody is listening. `ProjectPage` holds the roster because
it renders both halves of the screen; `PresencePanel` renders props.

It also fixes what that panel's JSDoc called a caveat and pinned rather than fixed: its socket did
not reconnect, so a drop froze the roster until a reload. Four of its seven cases were about frames
and are in the stream's suite now, with `StillSocket` and the `globalThis.WebSocket` swap.

## 49 · W2-14 — the frame nobody checked, and a scan per socket event

Twelve call sites wrote to a socket and **none read the number Bun answers with**: `0` for a frame
dropped because the socket is not open, `-1` for one enqueued behind backpressure. A dropped
`resume_ack` a client was waiting on looked exactly like a delivered one. `socketWriter` is the one
place that reads it, built once per connection so the twelve callers are untouched, and it counts
into the in-memory snapshot **and** into `libs/observability`'s `Counter` — whose first callers
these are.

`socket-writer.test.ts` is the plan's own probe and was _inexpressible_ before the seam existed:
there was no object to hand a fake socket to.

`Presence.list()` filtered every connection the gateway holds, and `broadcast()` calls it once per
distinct project — O(connections × projects) on the one class that runs on every socket event. A
per-project index now, which is two indexes over one fact, so `the two indexes never disagree`
walks a thousand random join/subscribe/move/leave sequences against the scan it replaced. Both
drift faults watched, each also caught by an existing case.

**Refused: deleting `/metrics/snapshot`.** The blue/green swap polls its `activeConnections` to
drain sockets before stopping the old colour, so it is deploy contract rather than debugging
leftover — and a `Counter` cannot be read back in-process, which is what the drain needs. The
reason is written where the route is. The unused `gwMetrics` singleton is deleted.

## 50 · W4-5 — the four panels' template

Steps, teams, priorities and estimating each held the same five things. `useSettingsSection` is all
five, and two of them are the ones a new panel gets wrong: the **withdrawal on unmount** (the modal
asks every section it has mounted, so one that never takes its claim back leaves the modal
un-closable over a form that is gone) and **`busy` counting as unfinished** (every panel had to
remember to put it in its own `dirty`). Both watched.

A locally-refused request now reads exactly as a refused one does — `section.refuse(code)` takes
be-01's word and reads the same table — and with the panels taking whole tables,
`stepRefusalSentence`, `capacityRefusalSentence` and `priorityBandRefusalSentence` had no
production caller left.

## 51 · W4-6 — the detail switch, and the two gestures that did not need it

The chart's detail gesture was four pieces 3,500 lines apart: the key and its storage at the top of
`gantt-panel.tsx`, the state at the middle, the mark gates and the switch near the bottom.
`gantt-detail.ts` is the gesture; what stays in the panel is what the panel draws. Both halves of
its rule moved with it — the read is the initial state, the drops are a mount effect — and so did
both watched proofs. 4,379 → 4,236 lines, no behaviour and no test changed.

**The plan's "same move for the other two gestures" is refused as written**, because it does not
apply: `fullScreen`'s state, refs and effects are already one block at `:2350–2453`, and the day
scale and the row names live in `wbs-table.tsx`. The detail switch was the scattered one.

## 52 · W4-8 and W4-9 — the glossary's defects, and eight READMEs

`Service team`'s `_Avoid_` list forbade **"service"**, which has been a table, a route and an
entity of its own since `services`. Fixed, and the nouns whose definitions an ADR or a shipped
behaviour already settles are written down: Service, Work item type (ADR 0009), Facet, Saved view,
Slack, Critical, Solution ref, and Phase recorded as **retired**. `Slack` carries the rename that
is owed rather than performing it — the scheduler's field is `float`, and `float` is on the tree
payload, so it is a contract change. The rest stay where the plan says they belong: the design
interview of whichever change next needs them.

**One premise was wrong:** `write-lock.ts` `{@link}`s `Write lock`, which exists (CONTEXT.md:836).

The eight "generated with Nx" stubs are gone, each in mcp-01's shape. `libs/domain`'s is the
noun → module map, and its rows are **asserted**: `readme.test.ts` checks every module it names and
every ADR it cites, because a README is the one artefact nothing else checks and it rots first.
Both faults watched.

## 53 · W2-6 — the marks stop re-rendering for things they do not draw

`open?.sliceId` and `fullScreen` were entries 15 and 28 of `marksOverLight`'s twenty-three-deep
dependency list, and **neither is drawn by a mark**: both are read in `onClick`, `onPointerLeave`
and `onFocus`. Opening one bar's facts card re-rendered every bar, arrow, flag and tick in the
chart to change nothing about any of them. A mirror ref in `wbs-table.tsx`'s `live` shape, and its
rule holds: anything a mark _draws_ stays in the list.

Getting the probe's oracle right took a measurement rather than a guess. `shortIsoDate` runs in
**both** a bar's `aria-label` and the card's own `barFacts`, so "no new date words" is not
available — the card is supposed to produce four. The number is the assertion: two bars cost two
each, so a re-render turns 4 into 8, which is exactly what putting `open?.sliceId` back produces.
`initialsOf` is the second oracle, on the bar-words' path alone, and stays at zero either way.

Then one `drawn` index where four readers each scanned every drawn bar — the two link filters, the
flag filter and `openBar`: **3.9×** for 100 links over 200 bars. It carries slice ids _and_ row
indexes, because the flag filter asks by row (a not-before holds the work item, not one of its
steps). And `arrowRoute` was handed **every** drawn bar per arrow and filtered it down to the two
rows the arrow joins: the same index answers that in two lookups, **3.1×**.

## 54 · W2-8 — one storm, and three that measurement says are not

The Gantt panel's `onScroll` measured the fold **and** the content row's width — a
`getBoundingClientRect` per scroll event, forcing a layout inside the frame that was drawing the
chart, for a width only a resize can change and that two `ResizeObserver`s already watch. It reads
no rect now; `reads no rect per scroll event, however many arrive` holds it at ten events, watched
failing on `expected 10 to be +0`.

The other three are refused, each for a reason that was measured:

- `plan-scroll-link.ts` is already a **binary search** (~7 rects for 100 rows, not 100), and the
  rects it reads are the ones a scroll moves — they cannot be cached. Only the node list could be,
  and a stale one after a row is added is a follower that scrolls to the wrong row.
  `alignmentMove` stays untouched, as the plan asks.
- `depends-card.tsx`'s `pointermove` reads N+1 rects where N is **one row's** dependencies
  (typically ≤5), and only while a hover card is open. Coalescing into a rAF costs six tests their
  synchronous assertions for a handful of reads on a transient surface.
- `plan-cards.tsx`'s rAF poll is bounded by the sheet's open animation (~12 frames, two rects
  each) and stops the moment it settles. Its 600-frame ceiling is the guard against an animation
  that never settles — the one case `transitionend` cannot answer, so the swap needs the poll as
  its fallback anyway.

## 55 · W2-10 — the first bundle, and the split that would cost the suite

One 796.82 kB JavaScript file, and `app.tsx` blocks on `fetchMe()` before it draws anything — so
every byte was in front of the login box and every deploy invalidated all of it. Now **511.85 kB
app + 269.37 kB vendor + 15.43 kB directory page** (160.85 + 85.77 + 3.79 gzipped): a cold load of
`/` is 15 kB lighter, and a release that touches neither React nor the router leaves 269 kB
cached.

The rule is asserted rather than the output — asserting the output means a 30-second build in a
unit suite — and what can go wrong is the regex. Both directions watched: widened to
`/node_modules\//` it puts `arktype` in `vendor` (which would invalidate the cached half on every
app change); narrowed to `react/` it loses `react-dom`.

**Refused: `GanttPanel` and `PlanCards`**, and not for bundle reasons. They render inside
`WbsTable`, which 2,063 jsdom tests render synchronously and then assert on; a `lazy()` boundary
turns every one of those assertions into a `waitFor`. That is a decision about the shape of the
whole suite, and it belongs to a change that says so.

## 56 · W2-7 — the dependency light leaves React state

`depHover` and `depFocus` were two `useState`s at the top of `WbsTable`, and the **address** was
the whole of the cost — the same cost `pointed-row-store.ts` was written for. The cells read their
live state through `live.current` and rely on every parent render reaching every cell, which is
what makes a `memo` impossible there and a store the only place a pointer-frequency reading can
live. So one pointer move across a dependency chip re-rendered every row, every cell and the whole
Gantt.

`dep-light-store.ts` holds both readings, the same resolution (`hover ?? focus`, total over
remembered state so a stale row or a deleted pill lights nothing) and the same functional writers
— every one of them is guarded on the row and the pill it belongs to, because a leave that lands
after the next enter must not undo it. Each `<tr>` shell subscribes for `data-dep-lit`; an open
`DependsCard` subscribes for which of its entries is emphasised. The `depLit` derivation in
`WbsTable` is gone.

**Notifying on the lit set alone was wrong**, and this is the one thing the extraction had to
learn: a row with exactly one dependency lights the same single row whether the pointer is on the
cell or on its one pill, so the set does not move while `pillFor` does — and a one-entry card's
emphasis sat at whatever it was when the card opened. `settle()` compares both.

The probe is `plan-dependencies.test.tsx`'s `narrowing to a pill re-renders the row whose light
moved and nothing else`, and where it measures is the point: **inside** an already-open card,
because entering the cell mounts the hover card and that is React state either way. With
`updateHover` routed back through a `WbsTable` `useState` — the shape this replaced — it failed on
`expected 4 to be less than or equal to 2`, the three rows and the heading re-rendered to move one
row's light.

**Deferred, not refused: the cell half.** `hoveredCell`, `focusedCell` and `openCard` are down to
two reads that a store cannot serve on its own, and both are attributes on the `<td>`:
`aria-describedby={openCard === startCell ? startCardId(row.id) : undefined}` and the popover
`zIndex` on a name cell whose card is open. Keeping those live needs a per-cell shell that
subscribes — which is exactly what W4-4's restructure introduces, and doing it before that
restructure means writing the shell twice. `dropHint`, `widthOverrides` and `ganttHeightPx` are
untouched for the same reason: they are read by the table's own layout, not by a row.

Both gates: 2,069 jsdom tests pass, and the browser gate is **282 passed** — the same 282 as the
pre-change baseline, run in this checkout on shifted ports.

## 57 · W2-11 — measured first, and most of it was already true

The plan's own check for this row — "`cardTrioOf` spy delta when one menu opens" — was answered by
§45's store, so what was left was the shell. Before writing it, the same oracle was pointed at
every gesture a reader makes on a phone: `cardIndentFor`, which each card calls exactly once per
render, counted across five cards.

| gesture, five cards on screen        | card renders |
| ------------------------------------ | -----------: |
| a keystroke in a card's Name box     |            0 |
| the focus moving to another card     |            0 |
| opening a card's Team sheet          |            0 |
| opening `Plan actions`               |    **5 → 0** |
| adding a work item (six cards after) |           23 |

**The toolbar sheet was the one real cost, and it is fixed.** `toolbarSheetOpen` was a `useState`
in `WbsTable`, so tapping one button re-rendered the plan behind the sheet — and a card's render
runs the estimate trio per step plus its slack, its mismatches, three label reads and a span read.
`plan-toolbar-sheet.tsx` owns that state now and the controls arrive as `children`, built by the
table's own render, so the sheet's re-render reuses that element tree untouched. `closingControlIn`
and `TAKES_THE_FOCUS` moved with it, and the effect that closed the sheet on every renderer change
is **deleted**: only the cards renderer mounts the sheet, so a window dragged wide unmounts it and
there is nothing left to close. Watched failing on `expected 5 to be +0` with the state put back in
`WbsTable` and read as a prop.

**Refused: the `PlanCard` shell.** Its only benefit is a `memo`, and a `memo` here cannot hold:
`rows` is rebuilt per render with fresh objects and fresh `toggleBranch` closures, and all twenty
of the writer props are inline arrows at the call site (`wbs-table.tsx:11671`). A shell wrapped in
`memo` over those props re-renders every time regardless — the shape R5 calls a check that cannot
fail — and stabilising twenty callbacks plus the row objects is the `live`-typed restructure W4-4
is for, not a card change. The 1,080-reader-calls figure in the row above was real and is now
spent only when the plan actually changes.

**Left open, named rather than fixed:** one write costs the list **~3.8 renders per card** (23
across six). That is the payload landing, the schedule arriving and the drafts settling, and
narrowing it is W2-1's other half — which read a write triggers — not this row's.

## 58 · W4-3 — the two checks under it, and why the registry waits

The row asks for one descriptor per kind in `libs/contracts` with `PlanCommand`,
`PLAN_COMMAND_KINDS`, `VARIANTS`, `parseKind` and `applyAll` all derived from it. That is a
contract change across three apps — mcp-01 derives its tool surface from the same document — and
it depends on verifying Elysia 1.4's Standard Schema → JSON Schema export before any of the
hand-written parsers can go. It needs an OpenSpec change of its own under R4, and it is refused
here rather than started.

What was done is the part that is provably behaviour-preserving and closes two checks that could
not fail:

- **`PLAN_COMMAND_KINDS` was a hand-written array typed `readonly PlanCommandKind[]`** — which
  type-checks perfectly when a kind is missing from it, because a subset of a union is a valid
  array of it. The consequence is silent: `parseCommand` refuses the new kind as `unknown_kind`,
  and the document's count check stays balanced because the document is short by one too. It is
  `Object.keys` of a record with `satisfies Record<PlanCommandKind, true>` now, which fails at
  that line in both directions. Watched: `deleteService` removed, `error TS1360 … does not satisfy
the expected type 'Record<"createWorkItem" | … | "deleteService", true>'`.
- **The document check counted.** `VARIANTS.length !== PLAN_COMMAND_KINDS.length` cannot see the
  two faults that matter, because both leave the totals equal: a kind described twice while
  another is described never, and a variant for a kind the API does not have paired with a real
  kind nobody wrote a sentence for. Either ships a command mcp-01 never tells a model about, which
  is the whole reason the document is generated. `documentComplaint(variants, kinds)` names what
  is undescribed, what is not a kind, and what is described twice; the module still throws it at
  load, and `plan-command-schema.test.ts` injects both faults on that same function. Watched
  against the old length rule: `Expected: "undescribed: setEstimate" · Received: "(silence)"`.

`parseKind`'s 36-arm switch is **already** exhaustive-by-typecheck — it has no `default` and must
return, so a new kind fails the build there. That is why the missing gate was the enumeration and
the document rather than the parser.

**Green:** be-01 1,122 tests across 86 files, lint, typecheck.

## 59 · W3-8 — the deploy contract, and the message that pointed at prod

The row's own headline was the duplication. The defect under it is worse than the row says, and it
is an **operator instruction that damages the environment it is not about**.

`tool-deploy` held `BUNDLE_FILES` with `remote` **relative** to the environment root and made it
absolute per layout, so a deploy of dev hashes dev's `bin/`. `tool-remote-scripts`' installer held
the same two files with `remote` **absolute**, built from a module-level `ROOT` that comes from
`WBS_ENV`, and had no flag to say which environment it meant. So when a dev deploy found dev's
bundle stale, it printed:

    "nx run tool-remote-scripts:install --host=h2puni --execute"

`WBS_ENV` is unset in an operator's shell, `envLayout` resolves that to prod, and following that
instruction overwrites **prod's** `swap.js` and `smoke.js` underneath a running prod deploy while
dev's bundle stays exactly as stale as it was. The deploy knew which environment it meant the whole
time.

One copy in `@wbs/deploy-contract` now — root-relative, with `bundleFilesFor(root)` making it a
path — `install.ts` takes `--env` through `envLayout` (so a typo throws rather than installing into
the live site), and both messages come from `installCommandFor(host, layout)`. The environment is
on the installer's own log line too, because a dry run is where an operator finds out.

Three negatives, all watched:

| Injected fault                                  | Observed                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| the `--env` arm removed from `parseInstallArgs` | `Expected: "dev" · Received: "prod"`, and the plan on prod's two paths |
| `--env` dropped from `installCommandFor`        | `Expected to contain: "--env=dev"`                                     |
| `--env=prd`                                     | throws `unknown WBS_ENV "prd"` rather than resolving to prod           |

**Left where they are, deliberately:** `sha256File` and `parseSha256sumOutput` are two copies of
eight lines that share no state and no vocabulary — moving them into a _contract_ module would make
it a utility bag, which is what the module was written not to be — and `assertCleanTree` reads
`tool-dagger`'s own git invariant, on the build host, with nothing on the server that could call
it. The row asked for all three; the argument for the vocabulary does not extend to them.

**Green:** the four deploy projects' lint, test and typecheck (`tool-deploy` 65, `tool-remote-scripts`
178 with the three new cases, `tool-dagger` 33, `tool-smoke` 47).

## 60 · W2-1 — the socket half, and the mapping's safety is be-01's

The row's other half: **narrowing which reads a socket frame triggers.** §25 left it with two
reasons, and only one of them was still true.

The blocker §25 recorded — "`SubscriptionHandlers.onChange` takes no arguments, so fe-01 cannot
tell a `directory_changed` from a `tree_replaced`" — was about this side's contract, not about the
wire. gw-01 forwards be-01's `ProjectEvent` **verbatim** as the frame's `message`
(`internal.controller.ts`, and `wsData` for every other frame), so the type was already arriving
and `project-stream.ts` was discarding it. `onChange` now carries it: `(changed: string | null)`,
with `null` for the two control frames that mean "read again" and for a `message` this side cannot
read.

`refresh` took eight requests for every event — the tree, the project's steps, and six global
vocabularies. It takes a `PlanReadScope` now, and `readScopeFor` maps the frame to one:

| frame said                                 | reads                  |
| ------------------------------------------ | ---------------------- |
| `tree_replaced`                            | the tree               |
| `step_added` `step_renamed` `step_removed` | the tree and the steps |
| anything else, or nothing                  | all eight              |

**The two narrow scopes are sound because of something be-01 does, not because of anything here.**
A plan batch can mint a person or a tag — `createPerson` and `createTag` are command kinds, and the
`@`-assignment flow mints a person — which is exactly why §25 refused to narrow on the _path_. What
makes narrowing on the _event_ safe is that such a batch holds the directory service's own
announcement and sends it after the commit (`plan-commands.ts`: `announcements.hold`, then
`send(pending)`), then announces the tree separately. Every fact that moved announces itself, so a
`tree_replaced` reader is not missing a directory change. `DirectoryService` is the only
`directory_changed` publisher in be-01.

`directory_changed` and the capacity events are deliberately **not** narrowed: a removed team takes
its assignments and its labels out of the tree with it.

Four cases in `plan-read-and-write.test.tsx`, counting requests through a wrapper around
`fakeProjectApi` so no other test's fixture changes. Each watched failing against the fault it
names:

| Injected fault                                           | Observed                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| the narrowing removed — `readScopeFor` always says `all` | `expected [ 'tree', 'steps', 'listTeams', …(5) ] to deeply equal [ 'tree' ]`      |
| `directory_changed` narrowed to the tree as well         | `expected [ 'tree' ] to include 'listPeople'`                                     |
| unknown treated as OK — the fallback returns `'tree'`    | `expected [ 'tree' ] to include 'listPeople'`, twice: the unknown kind and `null` |

The third is the R5 case and the reason the fallback is `'all'`: an event kind added to be-01 after
this build reads everything without anybody editing fe-01.

**Still not done, and still for §25's reason:** the _write_ path. A write knows its own scope, but
the scope is a property of the individual write rather than of the path, so narrowing it means
auditing every call site of the write wrapper. Unchanged by this.

**Left on the floor deliberately:** `internal.controller.ts` builds its data frame as an inline
literal instead of calling `wsData` — the sixteenth of the fifteen literals `ws-frames.ts` exists to
end. It is gw-01's file and one line, and it belongs with whoever is next in that app.

## 61 · W2-9's other half — the calendar is asked once per day, not once per mark

`calendarScale.startOf` converted a workday to a calendar offset on every call, and a chart calls
it for every bar's start, every bar's stop, every bracket's two ends, every arrow's two ends and
every person link's two ends. Rows share start days, so the marks outnumber the distinct questions
by an order of magnitude: **113 `addWorkdays` calls to answer fourteen questions** on a 40-row plan
spanning ten start days.

The scale keeps a `Map` from **whole** workday to calendar offset, built once per
`placeOnCalendar` and therefore incapable of outliving the placement it describes or growing past
the days in it. The whole part alone is the key, which is what makes it worth having — two marks a
third of a day apart share one entry and the fraction is added after the lookup. `Map.get` with an
`undefined` check rather than `??`, because a remembered offset of `0` is the right answer for day
zero.

Three cases, and the bound is the chart's own span rather than a figure — asserting `<= 113` would
be a statement about the fixture's size:

- `asks the calendar once per workday it draws on, not once per mark`, watched failing on `expected
113 to be less than or equal to 14` with the map removed.
- `places every mark exactly where an unremembered scale would` — the memo's only defence is being
  invisible in the answers.
- `remembers a fraction’s whole day without rounding the fraction away`, which is the one way a
  key on the whole part could go wrong: two marks inside day 3, two different `x`.

**Green:** the geometry's own 130 cases and `plan-mermaid`'s 50 (the other `calendarScale`
caller), fe-01 typecheck and lint.

## 62 · W1-1's remainder — one recorder, and six fakes that are not copies

The row asked for two more things. One was worth more than it looked; the other is refused, and by
the test files' own reasoning rather than mine.

**The recorded call log: 45 copies, not eight.** The plan counted the eight `watchX` wrappers. The
same five lines — bind the real method, replace it with a closure that pushes its arguments and
delegates, hand back the array — appear **45 times across nine test files**, most of them inline in
the case that needs them. `apps/fe-01/src/testing/record-calls.ts` is one typed
`recordCalls(api, method, of?)`: without `of` the entry is the whole argument tuple, **typed**,
where a hand-rolled `unknown[][]` was not; with it, every call site keeps the array shape it had, so
not one assertion changed. Seven files converted (`plan-table`, `plan-cells`, `plan-estimates`,
`plan-dependencies`, `plan-structure`, `plan-keyboard`, `project-page`) — 18 recorders gone.

The **delegation** is why this belongs in one place. A recorder that pushed and returned without
`perform(...)` makes every assertion built on it vacuous in the most expensive way: the request is
recorded, the assertion about it passes, the fake's plan never changes, and every later assertion
describes a screen nothing wrote to. All 45 got it right; the 46th is the one to worry about.
`records what it was asked and still performs it` is the negative, watched failing on `expected ''
to be 'Strip'` with the delegation removed.

`plan-read-and-write.test.tsx` is swept too, including the **eighth** copy of the pattern — the
`countingApi` written for W2-1's negatives, which wrapped all eight reads of one refresh and pushed
a name onto one shared array. Those eight names are a tuple now and the array is unchanged, so the
four assertions still tell one read from eight, which is the whole of what they are for.

Thirteen `.bind(api)` sites are **left**, and they are not recorders: they hold a promise open to
make a window, refuse one write kind, or delay a create. One `let reads = 0` counter is left too,
and for a reason worth writing down — its own `Proof:` quotes `expected +0 to be 1`, and a recorded
array would change that output and make a watched comment wrong for no gain.

**Refused: folding the six fakes into one.** `gantt-panel`'s is read-only over a fixed plan and
skews its reads on purpose; `plan-cards`' writes and refuses on demand; `project-page`'s is a list
of projects, not a plan. Two of the three say so in their own JSDoc — `plan-cards.test.tsx`'s reads
"Deliberately **not** `wbs-table.test.tsx`'s: that one is four hundred lines modelling renumbering,
undo stacks, step removal and assumed-assignee flips, and it is that file's spec." A shared fake
that served all three would have to model everything all three model, and every test in the
repository would then depend on a fixture whose behaviour is nobody's subject. What the shared one
is for is the files that want a **model of be-01** — and those already have it.

What the six do share is the risk `gantt-panel.test.tsx` was just caught by: a fake in a spec
project satisfies `ProjectApi` only as long as somebody runs `tsc -p tsconfig.spec.json` by hand.
Seven names had drifted there. That gate — the spec projects in `nx typecheck` — is its own change,
named in AGENTS.md, and it is worth more than one fixture.

## 63 · The spec projects are outside the typecheck gate — 218 errors nobody compiles

Found while clearing the five errors `d4b62a30` fixed: those five were not five, they were the
visible corner of a much larger number, and the gate cannot see any of it.

Measured on 2026-09-02, `tsc -p apps/<app>/tsconfig.spec.json --noEmit`:

| project | errors | what `nx typecheck` actually compiles                                        |
| ------- | ------ | ---------------------------------------------------------------------------- |
| be-01   | 107    | `tsc --build --force apps/be-01/tsconfig.lib.json`                           |
| fe-01   | 97     | `tsc --build --force apps/fe-01/tsconfig.app.json`, then `tsconfig.e2e.json` |
| gw-01   | 14     | `tsc --build --force apps/gw-01/tsconfig.lib.json`                           |

**Not one of those commands names a `tsconfig.spec.json`.** CI runs `run-many -t typecheck`, so CI
never compiles a test file either. The tests still pass — vitest strips types through esbuild
without checking them — which is why 218 errors can sit in the suite while every gate is green.
fe-01's count moved 94 → 97 during a single afternoon's work, so this grows on its own.

CLAUDE.md records this as a known and bounded exception: "The test projects are not in the gate
yet: 10 pre-existing errors, named in `teams-and-assignees/verify.md`, are their own change." Ten
was true when it was written. It is 218, which makes the sentence a claim rather than a
measurement, and the note in CLAUDE.md should be corrected to say so whoever reads it next starts
from the real figure — the same overstatement-in-reverse that §24 found in W1-6's `seedPlan ×6`.

This is the branch's own fault class wearing a fourth hat: a gate scoped to a place the fault is
not. `nx typecheck` was fixed twice for compiling **nothing** (be-01 and fe-01 on 2026-08-06,
gw-01 on 2026-08-09) by pointing it at `tsc --build --force` on a real project — and the project
it was pointed at was the source one, so the test files stayed uncompiled the whole time.

**Not attempted here, and it is not a tail end of anything.** Turning the spec projects on means
fixing 218 errors across roughly forty files first, or the gate goes red on its first run; and some
of them are the drift `d4b62a30` describes, where a fake's method names no longer match the
interface — real bugs in the tests' own scaffolding, each needing a reader who knows what the test
meant. Its own change, with the count re-measured at the start because it moves.

One thing worth doing before that change, and cheap: have `fe-01:typecheck` and the other two
**name** the spec project in a non-blocking second command, so the number is on screen in every
run instead of being discovered by accident twice a month.

## 64 · W1-4's fe-01 half — a list with a guard, not a rename of 55 files

§23.1 deferred this half for one reason: selecting the DOM-free suites needed a `*.dom.test.tsx`
suffix across **55 files**, "the same class of mechanical rename that took three attempts in W1-2".
The deferral was right about the rename and wrong about it being the only mechanism.

`fe-01:test:unit` runs `vitest.node.config.ts` — the base config spread, `environment: 'node'`,
`setupFiles: []`, and `include` from a nineteen-entry `NODE_SUITES` list: **19 files, 344 tests,
1.9s**, against 69s for the whole jsdom suite. Nothing is renamed and every one of those files
still runs in the full `test` target under jsdom, exactly as before.

The objection to a list is that it goes stale, and the answer is be-01's own: **a guard that walks
the directory rather than trusting the list**. `src/test-tiers.test.ts` classifies every suite by
the evidence in it — a `.tsx` extension, a testing-library import, or a browser global — and
asserts the list is exactly the DOM-free set, plus the arithmetic that the two tiers partition the
78 suites. Both directions watched: a `document.title` read added to the listed
`short-date.test.ts` failed on `…(18) to deeply equal …(17)`, and `pointed-row-store.test.ts` taken
off the list failed the other way; the partition case failed with each, on `80 to be 79` and `78 to
be 79`.

Three things the writing of it found, each worth more than the tier:

- **`mergeConfig` concatenates arrays.** The first cut merged `{ include: NODE_SUITES }` onto the
  base config and the tier collected all 78 files under `node` — 11 failed on `document is not
defined`, which reads as a broken tier rather than as a config that had ignored its own list. A
  spread replaces; `mergeConfig` appends.
- **The detector cannot see an indirect need, and only the run can.** `api.test.ts` names no DOM
  global; `websocketUrl` reads `location` in `api.ts`, one import away. It arrived as
  `ReferenceError: location is not defined` on the tier's first run and is now in a two-line
  `INDIRECT_DOM_SUITES` list with that sentence on it. The plan's own measurement had named this
  file as one of the two exceptions — a reader would have had to trust that; now the tier fails
  without it.
- **The guard matches itself**, because it quotes the DOM globals in its own rule — the same trap
  be-01's guard fell into and excludes itself for.
- **A guard on the base config's shape was written and then deleted**, which is the rule applying
  to itself. `defineConfig`'s return type widens to "object, promise, or factory", and spreading a
  promise is an empty config and therefore a tier that runs nothing — so the shape was checked
  before the spread. TypeScript resolves that import to a plain `UserConfig`, so every arm was
  unreachable: `no-unnecessary-condition` on the null test, `no-unnecessary-type-assertion` on the
  cast behind it. One annotation does the work, and the reasoning is written where the guard was.
- **And it has to run in both tiers, which is where `import.meta.url` stops being a path.** Under
  jsdom Vite serves the module from a `/@fs/…` URL, so `new URL('..', import.meta.url).pathname`
  gave `ENOENT: … scandir '/@fs/Users/…/apps/fe-01/src'` — three failures in the full suite from a
  file that passed under `node` minutes earlier. It reads `process.cwd()` now, which both configs
  set to the same place.

Two root-level files were added, so both are named in `fe-01:lint`'s explicit input list and in
`tsconfig.spec.json`'s `include` **in the same change** — §-recorded landmine: a lint target scoped
to a place the fault is not is a gate that cannot fail. Without the tsconfig entry the lint
refused them outright (`was not found by the project service`), which is the loud version.

`bun run test:unit` is deliberately **not** widened to include this tier in the same change: it is
a root script and one more thing to argue about, and the tier stands on its own.

## 65 · W2-12, two more — and one of them was a leak, not a cost

**`findEstimateGaps`' per-step counts were O(steps² × leaves)**: a `flatMap` over the steps, each
filtering every leaf, each of those calling `includes` on a list whose length is the step count. It
is one counting pass into a `Map` now, and the answer is the same list in the same order — `steps`
still decides the order and a step nothing is missing is still dropped. The readiness badge calls
this per render of the toolbar.

**The replay buffer was holding whole plans forever, and "lazy eviction" is why.** `record`,
`since` and `covers` each evict the subscription they are **about**. So a project edited a thousand
times and then closed keeps a thousand `tree_replaced` entries — whole plans, hundreds of rows each
— every one long past `maxAgeMs`, with nothing left that would ever ask about them again, and the
map keeps the name too. Nothing in the process sweeps a key nobody touches.

`sweepOneOther` evicts one **other** subscription per write and drops it when nothing is left,
rotating **by name** rather than by index because the key list moves as subscriptions come and go.
The intended bargain was bounded work per operation. **Correction, 2026-09-06 (§67 R8):** the
eviction count is bounded, but building/filtering all keys and finding the previous key is O(K)
per record. The sweep visits every subscription once per K writes across K live ones, so
an abandoned project drains within one lap of whatever traffic is left rather than never.

It changes no answer — `since` and `covers` evict before answering, and `oldestSeq` has no
production caller — so what it releases is memory no reader could reach. Which is also what makes
the check awkward: the store is private and every read path evicts, so the only public window into
retained state is `oldestSeq`. Three cases: the abandoned project swept by one write to a live one
(watched failing on `expected 0 to be null` with the sweep removed — the entry still held two
thousand seconds after it expired), the project being written to left alone (a write and the
`since` after it are one exchange), and the lap continuing when the key it swept last has been
deleted.

One `if (next === undefined)` was written and deleted in the same sitting: `noUncheckedIndexedAccess`
is off here, the index is in range by the check above it, and the branch was unreachable —
`no-unnecessary-condition` said so. The reasoning is where the branch was.

## 66 · W2-12's last five, and the two that were not there

**`plan-export.ts` printed a document in O(rows²), three times over.** A `find` over `plan.rows`
at three places, each called **per cell**: the inherited-label note on every labelled cell of every
row, the tag cell's note per tag, and `Depends on` per edge. `rowById` is `nameOf`'s own shape — a
`WeakMap` keyed on the row list — so the callers read the same way and the index is built once per
export. `undefined` stays a state rather than a fault: a row outside the document is exactly what
each of the three callers already has a sentence for.

**The mermaid comparator resolved each slice's section twice per comparison**, and in `outline`
mode `sectionOf` walks the row's ancestors — so an N log N sort did 2 N log N tree walks, and the
label pass did one more per slice. It is resolved once per slice before the sort now, and the same
value is reused for the label; the function is pure over the arguments the call site gives it.

**`priorities-panel.tsx` rebuilt the whole saved ladder inside its `.some()`** — a twelve-rung
ladder made twelve copies of itself to answer one question, on every render of the panel. Hoisted.

**The Gantt's pointed band scanned every row to draw one rectangle**, on the path a pointer moves
along. `labelsById` joins the `drawn` memo and the band is a conditional; `undefined` draws nothing,
which is what the `filter` achieved by finding no match — a row a search has narrowed away.

**The flexible cells' `{ minWidth }` was a fresh object per cell per render** — around 900
allocations on a 78-row plan for a value that takes one of a handful of numbers, and a new
identity every time, so nothing downstream could tell the layout had held still. Interned on the
**resolved number**, which is what makes staleness impossible: a dragged width is a different key
rather than an entry to invalidate. Watched failing on `expected { minWidth: 200 } to be
{ minWidth: 200 } // Object.is equality` with the interning removed, and a second case says a
dragged width gets its own object.

**Two of the twelve were not the fault the review described, and the code is the evidence:**

- `estimating-panel.tsx`'s `draftOfWeights(pertWeights)` is **not** computed inside a `.some()`.
  It is the receiver of `Object.entries(...)`, evaluated once before the predicate runs. Nothing to
  hoist. Its sibling in `priorities-panel.tsx` genuinely was inside the predicate, which is
  probably how the pair got written down together.
- `ReplayOrchestrator.replay`'s serial loop parallelises to **nothing**. Every `EventLogRepo` read
  is `await Promise.resolve()` followed by a synchronous `db.all(...)` on be-01's single
  connection, so `Promise.all` would run the same synchronous reads back to back with no
  concurrency at all — only a different microtask interleaving.

**Left to Dany:** `styles.css`'s 100ms `background-color` transition on every `<td>`. The review
asks for it shortened, dropped on the pinned columns, and behind `prefers-reduced-motion`. That is
a motion change, this repository's own record says settled rules get reversed once they are drawn,
and the palette browser cases measure computed colours that a transition moves mid-animation. It
wants his eye and a browser gate, not a refactor's judgement.

## 67 · Review follow-up — 2026-09-06

**Intent.** Correct inconsistencies exposed by overlapping requests and multi-team labels,
bound authentication/network work, and make plan reads and realtime delivery scale with the
project being used. Preserve focused edits, typed refusals, undo staleness and independent
saved-plan history. Package extraction does not by itself reduce query, rendering or traffic
costs. This update plans the fixes; it changes no runtime behavior and claims no new gate pass.

Review scope was current code at `main` `2c839252` plus the documentation branch at
`6dec1ec1`. The branch was documentation-only. Review IDs I1–I11 below identify implementation
findings; review D1–D5 identify design findings, distinct from the other plan's decision IDs.
The design findings are owned by that plan's §11, D24–D28 and ADR 0014/0015; they are not a
second implementation backlog here. Transient probe files are not prerequisites: the fault
arrangements and observed results needed to reproduce them are recorded below.

### Order, scope and proof discipline

1. R1 first, before replacing the frontend client. R2–R5 are independent correctness and
   admission fixes; land R2 before the store move and R3/R5 before the auth endpoint move.
2. R6–R9 remove global work and unbounded waits. Coordinate R6/R8/R9 with the other plan's
   Wave 2 so a seam has one owner. R4/R7 remain gateway-local; they do not add gw-01 to that
   plan's HTTP extraction.
3. R10 starts with a browser baseline and explicit row dependencies, after R1 and the
   relevant W4-4 extraction. Preserve W4-4's existing `live` contract during mechanical moves;
   changing it is R10's own observable architecture slice.
4. Each slice starts with its production-call-path negative, implements the fix, then injects
   the named fault and records the actual failure in its OpenSpec `verify.md` before writing
   `Proof:`. Requests that change behavior/contracts/architecture get their own OpenSpec
   change; only a fix restoring an already-precise spec may use R4's documented exception.
5. Run the touched suites and the workspace gate for each implementation change. Shared
   table/CSS work also runs the whole browser gate on ports verified to belong to this
   checkout. None of the checks below is claimed to have run against an implemented fix.

### Consistency slices — all not started

**R1 · I1 + I2 · One plan-refresh module owns invalidations.** Needs: before
`http-endpoint-port` Wave 1.4; folds into W4-4's `use-plan-read`. Estimated implementation
effort: 1–2 days, including browser regression coverage.

Files: `apps/fe-01/src/lib/{wbs-api,project-stream}.ts`,
`apps/fe-01/src/components/wbs/wbs-table.tsx`, their existing tests; extract the coordinator
beside `project-stream.ts`. The interface accepts an invalidation's resource scope and event
sequence; it owns the running read, pending scope union and installed resource generations.
The table consumes installed snapshots and stale status, not transport-promise ownership.

First hold a tree GET whose response contains sequence A, commit/notify B, then resolve A.
Require a trailing read to install B without a third event. Sharing a URL alone must not
merge invalidations across generations. Next hold `step_renamed`'s steps response, deliver
`tree_replaced`, then resolve the renamed step: it must install even if the tree has a newer
generation. Repeat for directory and initial full-load scopes; superseded/failed reads cannot
clear stale status or advance the stream beyond installed state. Preserve teardown and
cross-project guards. Only then route mutations and socket callbacks through the module and
remove URL-only deduplication/resource cancellation from their old sites.

Negatives: restore path-only sharing of the pre-edit GET; separately restore one generation
that drops the earlier wider scope. Both must fail in their held-response windows. Existing
observations: dedup served `[1, 1]` from one request; the mounted table kept `Dev` after the
peer renamed it. Removing the competing tree event made the latter control pass.

**R2 · I3 · Team removal stamps every affected work item once.** Needs: before store-port
wrapping/moves. Estimated effort: 0.5 day.

Files: `apps/be-01/src/repository/{directory,work-item}.ts`,
`repository/directory.db.test.ts`, and `service/undo.db.test.ts`. Seed a row with two teams
where the removed team is not the legacy `serviceTeamId`; create an undo entry, remove that
team through the production directory path, and require changed revision/audit fields and
the appropriate stale-undo refusal. Derive the affected set from `work_item_team`, bump/stamp
each surviving work item exactly once, and clean the legacy column separately in the same
transaction. Also cover removing the first team and a no-op/not-found removal.

Negative: restore revision filtering by the legacy singleton. Observed current failure:
`['aaa', 'team'] → ['aaa']` while revision stayed `1`; the existing single-team case missed it.

**R3 · I4 · Account-store faults remain server failures.** Needs: before auth's Wave 1 move.
Estimated effort: 0.5 day.

Files: `apps/be-01/src/service/auth.service.ts`,
`controller/{auth.integration,oidc.integration}.test.ts`. Use one valid token, first with a
healthy user store and then with a thrown lookup/identity-resolution fault. Require the
healthy response, modeled invalid-token response for bad credentials, and propagated server
failure for storage faults. Catch only modeled verification/claim failures; account
resolution runs outside that catch in both password-session and OIDC paths.

Negative: put account resolution back inside the broad catch. Observed through `/api/auth/me`:
the same valid token changed from 200 to 401 `invalid_token` when the repository threw.

**R4 · I5 · Validate decoded WebSocket frames at ingress.** Gateway-local, independent of
the HTTP extraction. Estimated effort: 0.5 day.

Files: `apps/gw-01/src/controller/ws.controller.ts`, `apps/gw-01/src/app.ts`, their unit and
integration tests; shared frame declarations in `libs/contracts` where applicable. Define
the ArkType inbound union, including resume-point value types, and validate decoded input
once before record indexing or control dispatch. `null`, numbers, strings, arrays and
malformed controls return `invalid_payload`; valid frames keep their behavior. The real
socket remains usable for a subsequent ping after a refused frame.

Negative: restore the unchecked `JSON.parse` cast. Direct production-handler probes for
`null`, `42` and `"text"` threw `TypeError` and sent no error frame; the real-socket regression
is still to be written, so process termination is not claimed.

### Traffic and query slices — all not started

**R5 · I6 · Reserve login capacity before password verification.** Needs: before auth's
Wave 1 move. Estimated effort: 0.5–1 day.

Files: `apps/be-01/src/controller/auth.controller.ts`,
`service/login-throttle.ts`, their tests and boot configuration if a global limit is added.
Reserve per-account/IP in-flight capacity before the first verification `await`; release it
on every success, refusal or thrown error while preserving the existing failure-window
semantics. Add a positive, bounded global verification limit at composition, with a small
injected cap in tests. Avoid turning capacity exhaustion into a storage or auth failure.

Negative: move reservation after verification. Hold 20 verifications for one username/IP and
assert the admitted count **while pending**, before releasing any. The current controller
admitted all 20 despite its five-failure limit, and later answered 401 to all. Also test that
settled/thrown attempts release capacity and that different accounts share the global cap.

**R6 · I7 · Query assignments and assigned names within the requested project.** Needs:
before the store move; complements W2-3 without reviving its rejected `Promise.all` change.
Estimated effort: 0.5–1 day.

Files: `apps/be-01/src/repository/directory.ts`, `service/work-item.service.ts`, store ports
and their fakes/tests. Add a project-scoped assignment projection and an indexed bounded
lookup for single work items. Join only assigned people/name fields for `tree()`, instead of
calling global `listPeople()` and reading every membership. Update callers and fakes together;
the interface must express project/single-row scope instead of requiring an arbitrary large
`IN` list. Confirm index use against the real migrated schema.

Negative: restore the unfiltered assignment query or the global people read. Populate many
unrelated projects and use the existing DB logger/query-plan seam to assert that their rows
are not scanned/materialized by a tiny plan read or one assignment write. Observed query for
one work item: `select work_item_id, step_id, person_id from assignment`, with no predicate.

**R7 · I8 · Send presence changes only to affected projects.** Gateway-local follow-up to
W2-14; the existing project-content isolation tests stay. Estimated effort: 0.5–1 day.

Files: `apps/gw-01/src/service/presence.ts`, `app.ts`, `presence.test.ts` and fan-out/presence
integration tests. Have join/move/leave mutations identify affected projects; notify their
members, send a newcomer its own initial state, and preserve connection-to-project lookup
for disconnects. A move notifies both old and new projects. Multiple tabs still deduplicate
names while retaining separate connections; unchanged membership does not broadcast globally.

Negative: restore `broadcast()` over every connection. With 1,000 connections across 100
projects, adding one connection with no project currently sends 1,001 frames. Assert that
unrelated sockets receive zero frames at that instant, without a retrying absence matcher.
Replica deployment still requires shared fan-out/presence; it is a later capacity change,
not something the package split silently enables.

**R8 · I9 · Make replay-buffer sweep work bounded, not just its eviction count.** Needs:
one owner with Wave 2's broadcaster/source changes. Estimated effort: 0.5 day.

Files: `apps/be-01/src/service/replay-buffer.ts`, `replay-buffer.test.ts` and broadcaster
tests. Keep a persistent map iterator or explicit rotation queue; do not materialize/filter
all keys or search for the previous key on every record. Preserve rotation through deletions,
per-subscription expiry and replay coverage. Measure expiry bursts before replacing array
shifts with a deque; add a byte budget as a separate behavior slice if retained whole-plan
payloads exceed the measured memory budget, not an unmeasured default.

Negative: restore the key-array sweep. Instrument work through the production record path
at 100, 1,000 and 10,000 subscriptions; visits per sweep must be bounded independently of K.
The current implementation visited exactly K keys. One local run of 1,000 records took
3.16/29.52/226.44 ms at those counts; this is not a production latency guarantee. Retain the
existing expiration negatives so optimizing work cannot silently keep abandoned payloads.

**R9 · I10 · Give gateway requests an overall deadline and bounded attempts.** Needs: one
owner with Wave 2's runtime injection. Estimated effort: 1 day for deadline coverage;
durable background delivery is a separate change if latency measurements justify it.

Files: `apps/be-01/src/service/{push-client,gateway-broadcaster}.ts`,
`apps/gw-01/src/service/forward-client.ts`, `apps/gw-01/src/app.ts` resume path, their tests.
Inject attempt/overall budgets and cancellation through the transport; every attempt,
backoff and response-body read must fit the overall budget. Handle modeled transient network
failures within that budget. Keep database commit and the write lock independent of gateway
delivery: a delivery failure cannot report an already-committed edit as refused. Bound any
later delivery worker's concurrency/queue and use the durable event log, never an unbounded
fire-and-forget promise per edit.

Negatives: omit cancellation from a hung header response and, separately, a stalled body;
remove the overall deadline so individually bounded retries exceed it. Use an injected clock
and literal advances, require termination at the configured deadline and no later attempt.
The current push supplied no abort signal and remained pending with `maxRetries=0`; that
probe demonstrates a missing application deadline, not an OS/network timeout measurement.

### Frontend rendering slice — not started

**R10 · I11 · Bound mounted cells and isolate search work.** Needs: R1 and W4-4's relevant
row/filter extraction. Estimated effort: 2–4 days after the browser baseline.

Files: `apps/fe-01/src/components/wbs/wbs-table.tsx`, the extracted `use-plan-filter` and
row/cell modules, `pointed-row-render-cost` tests and the keyboard/hover/browser suites.
Start by recording Chromium cold/warm mount and input-to-paint measurements at 100/500/1,000
rows, two/eight steps and sparse/dense dependencies; record concrete budgets in the change's
intent before optimizing. The review's 100-row jsdom fixture mounted 1,500 cells and one
Find keystroke called the production cell-style function 1,515 times (94 ms search, 560 ms
mount); the larger fixtures were not completed and these are not browser benchmarks.

Make each row/cell's render dependencies explicit, retaining peer-edit and focus behavior;
then isolate/defer filtering and virtualize by viewport with overscan and a pinned active
editor. Mounted cells must depend on visible rows/columns plus the explicit editor allowance,
not the total project size. Keep selection, keyboard traversal, drag targets, accessible
row numbering, variable row heights and table/Gantt row alignment correct. This is a new
contract-changing slice, not a memo wrapper around today's mutable `live` reads.

Negatives: restore full row mounting while retaining the fixed viewport, and restore search
state in the all-cells parent; count actual mounted cells/render calls and measure in the
browser. Inject a missed row dependency and require the peer-edit/focus regression to fail.
Run the full browser gate, including shared CSS, rather than only the new cost tests.

### Coverage and verification state

All eleven implementation findings map to R1–R10 above. The five remaining findings map to
the other plan's §11: repair deadlock → D28, announcement capture → D24, document capability
→ D25, missing reply statuses → D26, independent memory history → D27. That memory risk was
conditional on which tables the future source clones; no implemented memory-source data loss
was observed. Its fix makes that boundary explicit before the source is built.

Review evidence: 50 existing realtime tests passed (3,090 assertions), and 15 existing backend
tests passed (30 assertions); the new scoped-refresh reproduction failed and its control
passed. Repository/controller probes observed the revision, query, auth and login outcomes
above. Bun printed an internal `directory mismatch` diagnostic after the backend probes,
which completed with explicit output; the exit code alone was not used as proof. Full
workspace, browser, deployment and representative load gates were not run for that review.
This documentation update does not promote those observations into passing fix verifications.
