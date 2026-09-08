# Refactoring wave — handoff, 2026-09-02

Written by session `wbs-tool-v1-e3` on pausing. Its own file rather than a section of
`docs/2026-09-02-refactoring-plan.md`, because two sessions collided **inside** that file three
times in one afternoon and explicit git paths do not help when the collision is one file.

The plan doc stays the record of what was done and why; this is the state of the queue.

> **Superseded on 2026-09-07** by [`refactoring/tasks.md`](refactoring/tasks.md). Since this was
> written: W4-4 was executed and merged with §67's R1–R9 (squash `cbad68af`, PR #287); the spec
> projects' type errors are **0** and inside the gate (measured, `refactoring/verify.md`); the
> refusals table and the traps below still hold and are not restated there.

## Where the queue stands

Every row of `docs/2026-09-02-refactoring-plan.md` now reads **Done**, **Refused with a
measurement**, or **Deferred with a named blocker**. One row is neither, and it is the big one.

**Not started: W4-4**, the `WbsTable` split into the fourteen modules sweep C maps. Its own stated
first step **is** done — `e824b5a3`, the 80-field `live` literal written once instead of twice —
and the rest is not: the fourteen modules, and the exported `live` type that would turn the "three
deps" rule restated ten times into one declaration. Three things must stay exactly as they are
through it (the plan says so and every probe in this wave depends on it): `live` as the cells'
contract, `PlanRow` and the pointed store, and the `columns` dependency list.

**Deferred into W4-4**, so do them with it rather than before it:

- W2-7's cell half — `hoveredCell`, `focusedCell` and `openCard`. They are down to two reads and
  both are attributes on the `<td>`: `aria-describedby` for an open card, and the popover `zIndex`
  on a name cell. Keeping those live needs the per-cell shell W4-4 introduces; a store on its own
  cannot serve them, and building the shell twice is the cost of doing it early.
- W2-11's `PlanCard` shell — refused for now, and the reason is the same restructure. See below.
- W3-3, which the plan itself folded into W4-4.

**Also open, and each wants an OpenSpec change rather than a session tail:**

- **The spec projects' 218 type errors, outside every gate** (be-01 107, fe-01 97, gw-01 14,
  measured 2026-09-02). No `typecheck` target names a spec project, so CI has never compiled a
  test file in this repository. That is the _mechanism_ behind two bugs this wave shipped —
  `d4b62a30`'s seven stubs under names `ProjectApi` had renamed away, and §18's eleven divergences
  — so it would have caught both at the moment they appeared. AGENTS.md still says "10", which was
  true when it was written and is now a claim rather than a measurement.
- **W4-3's registry proper** — one descriptor per kind in `libs/contracts`. It changes a contract
  three apps read, changes mcp-01's tool surface, and depends on verifying Elysia 1.4's Standard
  Schema → JSON Schema export first. The two checks under it are done (`450d28ec`).
- **W2-1's write half** — narrowing which reads a _local_ write triggers. §25 has the finding:
  the scope is a property of the individual write, not of the path, because `createPerson` and
  `createTag` are command kinds inside a plan batch. The socket half is done (`07ed7cdc`).

## Refusals — do not re-open these without new evidence

Each was measured or read, not assumed. The section number is in the plan doc.

| What                                                        | Why it was refused                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §57 W2-11's `PlanCard` memo shell                           | Every prop the call site hands `PlanCards` is a fresh identity per render — fresh row objects, twenty inline writer arrows — so a `memo` re-renders regardless. It is a check that cannot fail until W4-4 stabilises them. Measured first: at rest a keystroke, a focus move and a field sheet each cost **0** card renders. |
| §58 W4-3's command registry                                 | A contract three apps read plus mcp-01's tool surface, and it depends on an unverified Elysia export. Needs R4's intent-first treatment.                                                                                                                                                                                     |
| §59 `sha256File`, `parseSha256sumOutput`, `assertCleanTree` | Two copies of eight lines that share no state and no vocabulary; moving them into a _contract_ module makes it a utility bag. `assertCleanTree` reads tool-dagger's git invariant on the build host with no server-side caller.                                                                                              |
| §62 the six other `ProjectApi` fakes                        | Each is its own file's spec and two say so in their JSDoc. A shared fake serving all three would have to model everything all three model, and every test in the repo would then depend on a fixture whose behaviour is nobody's subject.                                                                                    |
| §66 `ReplayOrchestrator.replay`'s serial loop               | Every `EventLogRepo` read is `await Promise.resolve()` then a **synchronous** `db.all(...)` on be-01's single connection. `Promise.all` runs the same synchronous reads back to back — no concurrency, only a different microtask interleaving.                                                                              |
| §66 `estimating-panel.tsx`'s `draftOfWeights`               | The review says it is computed inside a `.some()`. It is not: it is the receiver of `Object.entries(...)`, evaluated once. Its sibling in `priorities-panel.tsx` genuinely was, which is probably how the pair got written down together.                                                                                    |
| §66 `styles.css`'s 100ms `<td>` transition                  | A motion change. This repository's record is that settled rules get reversed once they are drawn, and the palette browser cases measure computed colours a transition moves mid-animation. Dany's eye and a browser gate, not a refactor's judgement.                                                                        |
| §35, §54, §55, §49, §41, §47                                | Six more, each with its measurement in the plan doc: `eventAt`, three of W2-8's four scroll reads, `GanttPanel`/`PlanCards` code-splitting, one of W2-14's, the directory store half, and the `Math.min` clamp that is **undetectable** by construction.                                                                     |

## Traps a fresh session should know before it believes any run

1. **The fe-01 jsdom suite is capacity-bound on this machine.** Under contention it reports
   **6–97** failures, and the tell is the ratio: every one is `Test timed out in 5000ms` with
   **zero** assertion failures. One wore a disguise worth remembering — `expected null not to be
null`, which is `planWithTheChartOpen`'s own `waitFor` for the first bar expiring, not a broken
   chart. Every affected file passes alone. Before believing red output, count timeouts against
   assertions.
2. **Two sessions in one checkout cost four things today**, all of them coordination: three swept
   plan-doc sections and one discarded gate run. Rules that worked — claim files by name, hand
   them back explicitly, the earlier section in a shared file keeps its number, write-and-commit
   as one command, and ask for the machine before a gate. A separate worktree would make all four
   impossible; it was rejected _today_ only because a fresh `bun install` competing for CPU costs
   more than one restart.
3. **A merge gate needs the tracked tree frozen, not just the runners quiet.** vitest imports a
   file when its suite starts, so an edit mid-run gives a verdict about a tree that never existed
   at any single moment. That is worse than contention because it looks clean.
4. **`bun run test:unit` (17s) and `nx run fe-01:test:unit` (1.9s)** are the inner loop now.
   `nx run <p>:lint:fast` is 4s.
5. **The plan doc is the one file two sessions always collide inside.** The proposal on the table
   is one file per verify section; that is the user's call.

## Not ours, and not to be committed by anyone tidying up

`CONTEXT.md`'s glossary edits (`Plan document`, `Import`, `Plan export` widened),
`docs/adr/0013-an-import-is-its-own-route-not-a-command-batch.md` and
`openspec/changes/plan-json-import/` are **Dany's own approved-but-unimplemented** import change,
written and agreed in a design interview earlier the same day. Six decisions are already settled
in that spec. It belongs in its own commit by whoever implements it — not swept into a refactoring
merge.
