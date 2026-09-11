# Dual optimized scheduler verification

## 2026-09-09T00:20:00Z — slice 8b second review round: jitter, the card, the names

Dany, on the cue as shipped in the round below: the pill "jitters when switch happens + the
whole header toolbox jitters as a result"; the card "looks ugly — need separate the
explanations + the reorder vs time", plus Pri-against-Time and an explanation of the
algorithm; and `PRI` should be `Pri` with the three schedules explained on the card.

- Local, in the merge worktree: fe-01 jsdom **2585 pass / 2 fail** (the two `plan-mermaid`
  timezone cases that fail on `main` here too); `contracts`, `domain`, `core` and
  `runtime-portable` test targets green — `contracts:test` is the one CI caught and this round
  fixed, see below; ESLint, `tsc --build --force` and Prettier clean.
- Browser, `CI=1 E2E_PORT_SHIFT=1900`: `optimization-cue.spec.ts` 8/8,
  `project-settings.spec.ts` + `hints.spec.ts` 10/10, `hover-cards.spec.ts` + `gantt.spec.ts`
  85/85 (`hint.tsx` and `hover-card.tsx` are shared, so both suites are part of this round's
  evidence rather than a courtesy).

### What CI caught that no local run had

`contracts:test` failed on `must have required property 'finishDays'` /
`'sameOrderAsFast'` at `work-item-response.test.ts:180`. The wire schema is **in
`libs/contracts`** and I had run `domain`, `be-01` and `fe-01` and not the project I changed.
The fixture carries both fields now, and `nx run-many -t test` over every library project is
what was run before believing it.

### Failure proof table (R5), this round

| Check                                                                     | Injected fault                                                                | Observed failure                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optimization-cue.spec.ts` a switch moves nothing else on the toolbar row | `w-[11.5rem]` removed from `PILL`, so the box is the width of its words again | `the toolbar moved under a switch: Starts · Expected: 1049.55 · Received: 1192.48` — the start-date control **143px** to the right of where it was, because the pill shrank by that much when its saving went. |

### Measured, not reasoned about

- **The width was chosen from the browser, twice.** `w-56` (224px) was the first guess and it
  pushed the toolbar to a second row at 1600 — a fix that cost a line. The pin is the pill's
  own measured widest instead, 184px (`11.5rem`), so the row wraps exactly where it wrapped
  before. A fixed slot for the schedule's name was tried inside it and reverted: it cost the
  saving 38px and truncated `· Pri 3 days earlier` at the width the pill is pinned to fit.
- **The card was read before it was believed.** Screenshotted at 1600: four blocks, the
  Pri-against-Time line, the four algorithm lines and the run's identity, ~410px wide and
  inside the window.

### Not ours: `rendering-baseline.spec.ts`

CI's `pixels shard 4/4` failed on main's own new spec — `an editor that left the row window
can commit, escape, and hold a refusal`, on a project name that arrived as
`endering 100/2/sparse`, its first character lost. That is the race `create-project.ts`'s own
docstring describes: the create **re-arms** the rename a round trip later, and a re-arm
landing between the first keystroke and the second wipes it.

Established rather than assumed: the same file fails **on unmodified `origin/main`** in a
control worktree — `a broad Find renders no more than its two filter-sensitive cells per row`,
`Expected: "Row 0000 half-typed" · Received: " half-typedRow 0000"` — while the case CI failed
on passes locally on both trees. Neither is touched by this change: nothing here goes near the
header, the picker, the rename or focus. The shard was re-run and passed.

**Corrected 2026-09-09, and the correction is the point.** This entry called the local failure
"keystrokes interleaved the same way ... one class of race" with CI's. It is not a race at
all. Measured in this suite's own Chromium on darwin: `press('End')` leaves
`selectionStart` at **0** in a focused `<textarea>` — macOS gives that key to the document —
so the text that follows is typed at the **start** of the field. `Meta+ArrowRight` moves it to 8. A deterministic platform difference, diagnosed as a race because its output looks like one,
and written down here as one before it was measured. The fix and its evidence are in
`measured-rendering`'s verify.md; the rule it belongs under is R5's
"instrument before you believe a mechanism".

## 2026-09-08T22:40:00Z — slice 8b review round: the fact, the dot, the menu

Dany, on the shipped pill: the reading must use the **project-fact** mechanic (no wait ring —
"this is project inf, not tool inf") and carry all of the metadata; pressing the pill opened a
menu **cropped by the screen**; and the state dot "looks like weird grey margin because it is
grey on grey".

- Same host and same commands as the entry below; `bin/h2puni-gate.sh` still exits 127 on
  macOS, so the whole gate is CI's.
- Browser, `CI=1 E2E_PORT_SHIFT=1900`: `optimization-cue.spec.ts` 7/7,
  `project-settings.spec.ts` 4/4, and — because `HoverCard` and `MenuControl` are shared —
  `gantt.spec.ts` + `hints.spec.ts` + `hover-cards.spec.ts` 91/91.

### Failure proof table (R5), this round

| Check                                                       | Injected fault                                | Observed failure                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optimization-cue.spec.ts` open menu stays on screen        | `menuShift` returning `0` unconditionally     | `the menu is cropped on the right at 1600: 1400px + 359px · Expected: <= 1600 · Received: 1758.77`. With the clamp the same box opens at x=1233.                                                                                                                                          |
| `optimization-cue.test.tsx` no dot with nothing to indicate | `dotState`'s `null` arm replaced by `'ready'` | both cases red on `expected <span data-cue-dot="ready" …(2)></span> to be null`.                                                                                                                                                                                                          |
| `actions-menu.test.tsx` `menuShift` arithmetic              | —                                             | Written as cases rather than by injection: jsdom lays nothing out, so the function is asserted against the figures directly, including the measured 1600px case and a box wider than its window. A first draft returned `-0` for a box already at the gutter and was caught by `toBe(0)`. |

### What the screenshots found, and nothing else did

Three faults, all found by rendering the thing and looking at it (CLAUDE.md: "look at the thing
you built"), none of them visible to 2,500 jsdom cases or to the seven browser assertions that
were already green:

- **A card anchored near the right edge measured 195px wide and eight lines tall.** A
  `position: fixed` card laid out at its mark's own left edge has only the room between that
  edge and the window: at x=1405 in a 1600px window it shrank to 195px, and
  `surfacePlacement` was then handed a width that had already been squeezed, so there was
  nothing left for it to clamp. It starts at `left: 0` for the unmeasured frame now and is
  moved in a layout effect, before paint. Re-measured: ~410px and four lines.
- **A long unbroken token did not wrap in any card.** 1396px of text inside a 388px phone card
  (`Expected: <= 388 · Received: 1396`), fixed once for every card by
  `overflow-wrap: break-word` on `HoverCard`'s box — `break-word` rather than `anywhere`, so a
  compact card is still the width of its words.
- **The menu popped a card over itself on every opening.** `MenuControl` focuses its first item
  as it opens, a refused item carries its reason as a `data-fact`, and the first item is Fast —
  so an active Fast covered the two rows underneath it. The active row is `✓ …` now, carries no
  fact, and asks for nothing when taken.

And one thing the measurement corrected rather than confirmed: the menu **was** already clamped
to 1592 when the screenshot was taken, and what looked like a clipped third item was the focused
item's own card drawn over it. Instrumented before believing the mechanism —
`{"left":1089,"right":1592,"scrollWidth":501,"clientWidth":501,"itemRight":1587,"innerWidth":1600}`.

## 2026-09-08T20:55:00Z — slice 8b, the cue and the suggestion

- Host: this Mac (`darwin`), branch `change/optimization-cue-and-suggestion`. The h2puni gate is
  **not** run here: `bin/h2puni-gate.sh` exits 127 on macOS, so the whole gate is CI's on this
  change and what follows is what was run locally, named exactly.
- Ran and green locally: `libs/domain` 596 pass / 0 fail; be-01 unit tier 896 pass / 1 skip / 0
  fail; be-01 store tier 1150 pass / 1 skip / 0 fail (**2 unhandled errors, pre-existing** — the
  same two appear on `main` from a stashed tree, a teardown-race `disk I/O error` on
  `solver_slot` and a deliberate push-failure log); fe-01 jsdom 2547 pass / 2 fail, both
  `plan-mermaid.test.ts` timezone cases that **also fail on `main`** here; ESLint clean on
  `apps/fe-01/{src,e2e}`, `apps/be-01/src`, `libs/domain/src`, `libs/contracts/src`;
  `tsc --build --force` clean on all four projects, tests included; Prettier clean;
  `openspec validate --all --json` 54/54.
- Browser gate, `CI=1 E2E_PORT_SHIFT=1900` (never the shared dev stack — `LLM_README.md`'s
  landmine): `optimization-cue.spec.ts` 6/6, `project-settings.spec.ts` 4/4, and the four
  geometry-sensitive suites `layout`/`mobile`/`plan-surface`/`hints` 85/85. The rest of the
  browser gate is CI's `pixels` job.

### Failure proof table (R5)

| Check                                                          | Injected fault                                                                                                      | Observed failure                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule-order.test.ts` differential + tie cases              | `denseRanks` giving every start its own rank (values paired with their index, stably sorted, position written back) | 3 red: `seed 52 · left {"slice-0":0.5,"slice-1":1.0104166666666667} · Expected: false · Received: true`, plus both named tie cases. Competition ranking was injected **first and passed, correctly** — it keeps one value per tie group, so it is the same weak order; the fault has to split a tie group. |
| `schedule-order.test.ts` corpus is about ties                  | —                                                                                                                   | Measured 324 of 400 seeded pairs draw a tie; the assertion pins `> 200` so a pool change that stopped drawing them fails.                                                                                                                                                                                  |
| `optimized-plan-read.test.ts` both-ready-behind-Fast           | the shipped `optimized === null ? … : comparedWithFast(…)` gate restored                                            | 2 red, the received `finishDays` losing `- "pri": 5, - "time": 8` and `- "pri": 5`.                                                                                                                                                                                                                        |
| `optimization-cue-reading.test.ts` suggestion rule             | `finish < onScreen` replaced by "outside the drift **or** reordered against Fast"                                   | 5 red: `expected 'pri' to be null` (reordered), `expected 'time' to be null` (later than the schedule on screen), and three sentence assertions.                                                                                                                                                           |
| `optimization-cue.test.tsx` pill wears only a saving           | the same loosened rule                                                                                              | 2 red on `expected <span …(2)></span> to be null`.                                                                                                                                                                                                                                                         |
| `optimization-cue.test.tsx` in-flight switch                   | `reading.activeLabel` replaced by a constant `'PRI'` — an optimistic pill                                           | `Expected: "Fast" · Received: "PRI"`.                                                                                                                                                                                                                                                                      |
| `actions-menu.test.tsx` roving index survives a shrinking menu | `focusAt`'s `Math.min` replaced by `active`                                                                         | `expect(element).toHaveFocus()` with `Received element with focus: <body>`. **Not** the throw the first draft of the comment guessed: the effect is keyed on the index, so an unchanged `active` never re-runs it. Both the comment and the JSDoc were rewritten from this output.                         |
| `wbs-api.test.ts` both new wire fields are required            | `finishDays` made optional in `libs/contracts`                                                                      | `promise resolved "{ workItems: [], seq: 1, …(17) }" instead of rejecting`.                                                                                                                                                                                                                                |
| `optimization-cue.spec.ts` 1280 toolbar budget                 | the pill's face given `reading.sentence` — the deleted banner in a pill's clothes                                   | `2082px of controls to lay out, against the 1563px this change left · Expected: <= 1565 · Received: 2081.92`.                                                                                                                                                                                              |
| `optimization-cue.spec.ts` no sideways scroll at 390px         | the same fault                                                                                                      | `Expected: <= 390 · Received: 719` — the cue 329px off the side of the screen.                                                                                                                                                                                                                             |
| `optimization-cue.spec.ts` card clear of the pill              | the anchor's `bottom` set to the pill's own `top`                                                                   | `the card is drawn over the pill · Expected: false · Received: true`.                                                                                                                                                                                                                                      |

### What the browser found that jsdom could not

- **The card's lines did not wrap.** `project-settings.spec.ts`'s phone case measured a
  192-character work item name laying out `1386px` of text inside a `348px` card
  (`Expected: <= 348 · Received: 1386`). The banner it replaced carried `break-words` and the
  card did not; both the row and the `<li>` carry it now. Twenty-one jsdom cases over the same
  component saw nothing, because jsdom lays nothing out.
- **`aria-describedby` is a list.** `HintLayer` appends its own `hint-card` id to whatever the
  focused element already points at, so the attribute reads `"_r_4_ hint-card"` and a
  `#_r_4_ hint-card` selector is a descendant selector matching nothing. Both browser suites
  split it now, and the phone case asserts `toContain` rather than `toBe`.
- **A `role="tooltip"` query is ambiguous on this pill**, for the same reason: the hint layer
  draws one too. The cue's card is located through the pill's own `aria-describedby`.

### Pins moved

- `optimization-cue.spec.ts` pins the 1280 toolbar row at **1563px** with the cue on it
  (measured 1562.97, one row, optimization on). `project-settings.spec.ts` keeps its own
  **1265px** pin, which is a fresh project where the toggle is off and the pill is not drawn —
  the two figures are about different bars and neither is derived from the other.

## 2026-09-06T21:18:13Z — real supervisor orphan process boundary

- Host: `h2puni`; exact tested branch bytes match head `dd86b47628dca2e690084c9c176531389beaad22`.
- `be-01:solver-image-smoke` built and ran the real packaged solver image, then a digest-pinned
  inert solver fixture through the production Unix listener, Docker driver and persistent
  systemd timer. The process proof passed 1/0 with 11 assertions in 9.65 seconds.
- Killing the bound coordinator container made socket EOF kill, wait, inspect and remove the
  exact managed child while its SQLite `running` slot remained counted. Killing the supervisor
  itself left the bound child running; the user-systemd timer stopped it at `childDeadlineAt`,
  and a restarted supervisor removed that already-stopped orphan before listening.
- The proof exposed three real boundary defects and now covers each: `docker ps` needed
  `--no-trunc` before strict full-id parsing; terminal delivery to a dead socket could skip
  timer/container cleanup; and SIGKILL leaves a stale Unix socket inode which restart must
  validate and unlink. The stopped-container sweep also distinguishes `Pid=0` from a failed
  kill of a still-live orphan.
- Watched negative: suppressing only the post-bind EOF kill failed the real process case at the
  child deadline (`received 1788729256111`, expected `< 1788729255690`). The systemd timer
  eventually stopped the child, proving the assertion detects prompt disconnect cleanup rather
  than accepting the deadline backstop as equivalent. The fault was reversed before the final
  positive run.
- Focused non-Docker gate: 19 passed / 1 environment-gated skip / 0 failed across command,
  listener, lifecycle and orphan suites (40 assertions); Prettier, ShellCheck, ESLint and both
  `tool-remote-scripts`/`be-01` typechecks passed. No build or autotest ran on h1claw.

## 2026-09-06T10:23:22Z — coordinator checkpoint

- Head: `910bfad057ebc4e59dfde279f4ed44810e34dc22`
- Host: `h2puni`, clean checkout `/home/puni1/t220-r25-final2.TsxGEY`
- Command: `NX_DAEMON=false PATH=/home/puni1/t220-venv/bin:$PATH VIRTUAL_ENV=/home/puni1/t220-venv bin/h2puni-gate.sh`
- Verdict: exit 0; Nx successfully ran `test`, `lint`, `typecheck`, and `build` for 24 projects.
- Decisive counts: be-01 1,582 passed / 0 failed; fe-01 2,213 passed / 0 failed; solver-py 191 passed / 0 failed. The remaining project test targets and every build, lint, typecheck, and format target were green.
- Checkout after the gate: clean and still at the exact head above.

Two earlier invocations are deliberately not terminal evidence. The first put
the locked Python virtual environment inside the checkout, so format checking
listed its dependency metadata and exited 1; the environment was preserved
outside the checkout. The second let the Nx daemon fail project-graph
calculation and return 0 without target evidence. Disabling the daemon produced
the complete authoritative run recorded above.

## 2026-09-06T10:36:06Z — transaction-owned event seam

- Head: `607cda22023e41d643c773dc09891785059e42cc`
- Host: `h2puni`, clean checkout `/home/puni1/t220-r25-final2.TsxGEY`
- Command: `bunx prettier --check` over the five changed files, then
  `NX_DAEMON=false bunx nx run-many -t test lint typecheck --projects=be-01 --parallel=1 --skip-nx-cache`
- Verdict: exit 0; be-01 1,668 passed / 0 failed, lint and typecheck green,
  and every changed file formatted.
- Watched negative 1: replacing `recordEventIn`'s supplied transaction writes
  with repository-database writes made the foreign-handle assertion fail
  (7 passed / 1 failed). Restoring the source returned the checkout to clean.
- Watched negative 2: making `pushRecorded` record again made the focused
  broadcaster suite fail (0 passed / 5 failed), including the expected
  sequence 0 becoming sequence 1. Restoring the source returned the checkout
  to clean.

The seam is now explicit: transaction owners call `recordEventIn`, commit, and
then make the best-effort socket push through `pushRecorded`; the convenience
`publish` path composes one durable record with one push.

## 2026-09-06T10:58:01Z — atomic optimized-result events

- Head: `f14c6d2bd1f566c6813596d386e6920b636eb682`
- Host: `h2puni`, clean exact-head checkout
  `/home/puni1/t220-r25-final2.TsxGEY`
- Command: `NX_DAEMON=false bunx nx run-many -t test lint typecheck
--projects=be-01 --parallel=1 --skip-nx-cache`, followed by scoped Prettier.
- Verdict: exit 0; be-01 1,671 passed / 0 failed across 139 files, lint and
  typecheck green, and all nine changed files formatted.
- The focused event suite passed 3/0: two cold-result variants each recorded
  and pushed once, a cache hit emitted nothing, an injected event-write crash
  rolled the cache insert back, and a process stopping before the push still
  left the event available through replay.
- Watched negative: splitting the cache insert and event record into separate
  transactions made the rollback proof fail 1/1: the cache count was 1 where
  zero was required. The fault was reversed and the checkout returned clean.

`schedule_optimized` now carries the full identity including `budgetMs`.
`storeOptimizedOutcomeAndRecord` writes the cache row and replay record in one
transaction only when a result is newly stored; the coordinator then invokes
the already-recorded best-effort push. The deferred failure-event path will
reuse the same transaction and push seam.

## 2026-09-06T11:05:30Z — four independent queue/admission/supervisor reds

- Head: `439b333b` for the added generation witness; the other three tests are
  unchanged from the exact-head `f14c6d2b` gate above.
- Removing only the dequeue generation comparison initially left the black-box
  test green because admission independently rechecks the same generation.
  A focused assertion now names the dequeue predicate itself; removing that
  one comparison fails the queue suite 4/1, receiving `hash-p-a` for the stale
  generation where `null` is required.
- Removing the project-ON recheck fails the same queue suite 4/1 by reserving
  the toggled-OFF entry instead of consuming it.
- Replacing the shared SQLite count with an owner-local count, the observable
  equivalent of an in-memory coordinator counter, fails the two-connection
  admission suite 0/1 by admitting the seventeenth seat.
- Dropping the post-bind disconnect kill fails the managed lifecycle suite 7/2:
  both socket EOF and output overflow reach wait without a preceding kill.

Every fault was reversed and each remote checkout was verified clean. These
are four separate assertions and four separate `Proof:` comments: no one
green case stands in for another fence.

## 2026-09-06T11:08:22Z — empty-plan coordinator guard

- Head: `068a89f2`; focused coordinator suite on h2puni passed 15/0, with
  lint and Prettier green for the changed test.
- Both zero slices and all-zero durations allocate no generation or slot, write
  no cache or event row, and call no spawner.
- Watched negative: deleting the coordinator guard failed the suite 14/1 when
  the empty plan reached the request builder. The fault was reversed and the
  remote checkout verified clean.

This closes the coordinator/cache/event portion of 6.9b. Its checkbox remains
open for the plan-read DTO's `idle` rendering, which belongs with slice 7.10.

## 2026-09-06T11:51:04Z — plan-read optimizer state checkpoint

- Head: `2600a3e9e646a529f912ce7d956c7065d536d91b`
- Host: `h2puni`, worktree `/home/puni1/t220-r27.o9jpyv`
- Gate: the full be-01 test run passed 1,675/0 across 140 files and typecheck
  passed; after correcting one import-order-only lint finding, be-01 lint,
  typecheck, and the corrected file's focused tests passed again.
- Contract proofs cover all seven variant states, disabled and zero-work
  identity without generation allocation, cold `pending`, metadata and Fast
  fallback in `tree()`, and comparison presence only for a ready selected
  variant.
- Watched negative: dropping `budget_ms` from the live-slot predicate made a
  failed row read `retrying` solely because a different-budget slot existed.
  The focused remote test failed 0/1 with that exact mismatch; the predicate
  was restored and the green gate above followed.

This is the service/coordinator half of 7.10. Its checkbox stays open until the
seven states are proven through the real controller payload, as that task
explicitly requires. Likewise 6.9b stays open until its controller-level
empty-plan payload proof lands.

## 2026-09-06T11:58:10Z — controller optimizer-state matrix

- Head: `fc3e7d3038724754a4a826b8ae74e6c4e27af6db`
- Host: `h2puni`, worktree `/home/puni1/t220-r27.o9jpyv`
- Focused real-controller payload test: 1/0, followed by be-01 lint and
  typecheck green.
- The HTTP payload matrix covers cold admission, durable queued work,
  retrying, failed with reason, corrupt with decoder message,
  plan-infeasible with effective-deadline items, partial success, and full
  hit. Every non-ready selection publishes Fast with no comparison; ready PRI
  publishes optimizer-bound slices and a real-domain comparison.
- The same route proves an initially empty project, and the transition after
  adding then deleting its only work item, both return empty arrays,
  `generation: null`, and two `idle` variants. The coordinator database proof
  immediately above owns the complementary no-allocation/no-row/no-event
  assertions.
- Watched negative: removing the `optimization` member from the tree return
  failed the controller proof 0/1 on its first empty-plan response. Restoring
  the member returned the same test to 1/0.

Together with the full-key database tests and seven-state mapper tests at
`2600a3e9`, this closes 6.9b and 7.10.

## 2026-09-06T12:12:00Z — absolute slot-deadline fence

- Heads: `1d0ad964` fixes the host timer calendar; `40c2d58f` passes the same
  absolute deadline through the launcher and clamps every CP-SAT stage to its
  remaining wall time.
- Host: `h2puni`, worktree `/home/puni1/t220-r27.o9jpyv`; no build or autotest
  ran on the queue-worker box.
- The full `tool-remote-scripts` gate passed 255/0 across 25 files, with lint,
  typecheck, and Prettier green. The full solver-py suite then passed 193/0,
  and scoped format checking was green.
- Watched host negative: the production builder's old
  `--on-calendar=@<seconds>.<milliseconds>` form was rejected by systemd 259,
  proving that the nominal persistent backstop never armed. The builder now
  emits an explicit millisecond-precise UTC instant.
- Actual host proof: without a timer the control container remained live past
  the child window; the corrected transient timer reached `Result=success`
  and made the matched container report `running=false`. The two exact test
  containers and both transient units were inactive/absent after cleanup.
- Watched inner-fence negative: before deadline propagation, the real launcher
  test observed only `--search-workers 2` in the solver argv and failed 11/1.
  The restored focused launcher, CLI, and deadline-clamp suites passed 12/0,
  18/0, and 9/0 respectively.

These runtime proofs complement the existing repository and two-coordinator
suites: admission stamps the child and admitted deadlines once, reclaim reads
the stored absolute admitted deadline rather than a deployment budget or
heartbeat, and every bind/heartbeat/release/outcome path is fenced by the
attempt token. This closes 6.11.

## 2026-09-06T12:18:06Z — durable optimization failure announcements

- Heads: `c933634f` adds the failure event and atomic record path; `9c8957f4`
  adds the pre-spawn integration proof.
- The seven typed reasons each produced one `failed` cache row with no schedule
  and one replay event carrying project, generation, input hash, objective,
  contract version, `budgetMs`, and the matching reason. The focused event
  suite passed 5/0 on h2puni; be-01 lint and typecheck were green.
- Both horizon-overflow variants were also exercised through the real
  coordinator: they launched zero children, durably recorded two failure
  events, and pushed both after commit.
- Watched negative: the previous success-only event predicate made the focused
  suite fail 3/1 with `committed.event` undefined for `timeout`; restoring the
  shared outcome transaction returned it to green.
- Existing coordinator and lifecycle suites provide the complementary path
  matrix: timeout, OOM, internal exit, invalid output, no solution, both
  preflight overflows, variant isolation, no automatic retry, and cancellation
  reaching no outcome write.

This closes 7.1 and 7.7. The remaining 7.4 clauses are covered across the
coordinator/lifecycle matrix, the atomic result-event tests, and the project
settings event test. Its Retry/hash-change clause cannot remain a prerequisite:
TASK-220's scope boundary explicitly defers 7.11, the only route that could
exercise it. At 2026-09-06T12:19:00Z the clause was therefore annotated as
deferred with 7.11 and 7.4 was closed without claiming a nonexistent Retry
proof.

## 2026-09-06T17:42:32Z — project selector and comparison UI

- Head: `f39af67ee6ff506b8e68b10cfec7236f21d0089f`; host: `h2puni`, worktree
  `/home/puni1/wbs-t221`. No build or autotest ran on the queue-worker box.
- Focused final suites passed 108/0 before the exhaustive-state refactor, then
  the three directly affected suites passed 27/0. FE typecheck passed;
  changed-file lint has no errors; scoped Prettier is clean.
- The first canonical `bin/h2puni-gate.sh` invocation at `85679bc1` ran the
  whole workspace and found one owned stale expectation: the toolbar test
  expected four settings tabs after Optimization became the fifth. That case
  was corrected and passed in the 108-test focused run. The final exact-head
  gate is CI.
- Watched project-ownership negative: capturing the initial settings value in
  component state failed both remount persistence and collaborator-event
  convergence (0/2); restoring the plan-read binding passed 2/2.
- Two independently verified terminal artifacts at `85679bc1` reported zero
  Critical findings. Their concrete stale-comparison, optional-payload,
  refusal, fractional-copy, exhaustiveness, disclosure, and regression-test
  findings were closed before the final focused proof above.

Slices 8.1, 8.2, and 8.5 are closed. Retry remains a route owned by TASK-268,
so the broader 8.3–8.4 checkboxes stay open rather than claiming an affordance
whose backend does not yet exist; lane-q TASK-222 already owns post-deploy QA.

## 2026-09-06T18:29:32Z — replacement CI after the browser assertion correction

- The final correction was exact head
  `8a9f0ae111f568ae8abede155ae0f4556d2d98e7`, `test: include optimization tab
in browser assertion`; its only changed path was
  `apps/fe-01/e2e/project-settings.spec.ts`.
- Replacement CI run `34050973411` completed green at that exact head. Gate
  job `101534415848` completed `SUCCESS` at `2026-09-06T18:24:49Z`; pixels job
  `101534415694` completed `SUCCESS` at `2026-09-06T18:29:11Z`.
- PR #246 then merged as
  `9a1f79e7eb9fea3b72cc00acd622c2bb2c9d07ba` at the section timestamp above.

This supersedes the prior section's statement that the exact-head gate was
still only CI-pending. The corrected assertion expects all five Project
Settings tabs, including Optimization; it records the browser-found stale
four-tab expectation rather than leaving the verification record one commit
behind the shipped tree.

## 2026-09-06T21:31:00Z — four independent eviction authorities

- Head under test: `4a86476afb89dbcc6537fdea0e6c0bae1264d3b2`; host: `h2puni`,
  worktree `/home/puni1/t268-r2-unit.kRzKqI`. No build or autotest ran on the
  queue-worker box.
- The four focused repository files passed 144/0 with 428 assertions before
  mutation. Each mutation below was applied, measured, and restored alone.
- Worker outcome: removing the attempt-token comparison made both the direct
  ownership case and reclaimed owner's late-store case red (2 failures).
- Allocation: suppressing its token-free older-generation eviction made the
  cold hash-change case red, together with two cross-release cases (3
  failures). The case separately asserts generation 2 and its new hash, so the
  successful generation CAS—not a child token—is its authority.
- OFF cleanup: suppressing the project-scoped queue delete made only the
  idempotent ON→OFF cancellation case red (1 failure). That case proves the
  epoch advances once while the queue is evicted, with no attempt token.
- Retirement: suppressing the token-free cache delete made the direct phase-2
  retirement and last-slot finisher red (2 failures). The direct case first
  observes the phase-1 `draining` marker that authorizes the deletion.

This closes 6.9c: weakening any one authority is observed independently, while
the allocation, OFF transition, and drain paths remain intentionally incapable
of presenting a worker attempt token.

## 2026-09-06T22:13:33Z — Retry marker replacement boundary

- Red head `e5d0e039` on h2puni: both the failed-marker and corrupt-row cases
  reached insert-only conflict and failed on `Expected: "stored" / Received:
"already-recorded"`; the focused file reported 63 pass / 2 fail.
- Exact green head `6e3beaee` on h2puni, worktree
  `/home/puni1/t268-r3-regate.4llPBj`: 65/65 tests and 242 assertions passed;
  scoped Prettier, be-01 fast lint, and be-01 typecheck were green. No build or
  autotest ran on the queue-worker box.
- A live slot may replace only a `failed`/`corrupt` row whose `createdAt`
  predates that slot. The replacement is stamped at or after the slot start, so
  a second outcome callback from the same attempt remains `already-recorded`.
  Ready and plan-infeasible answers remain insert-only.

This is the durable overwrite half of 7.3/7.11. The strict-order admission
transaction and HTTP route remain before either slice can be ticked.

## 2026-09-06T22:28:32Z — atomic Retry admission

- Red head `fe57f5da` on h2puni specified stale-input, retryability, live-key,
  and budget-key ordering; all seven new cases failed at the absent `retry`
  seam while the existing 16 coordinator cases passed.
- Exact green head `9810c133` on h2puni, worktree
  `/home/puni1/t268-r3-admission-pass.z69Olx`: the coordinator, cache, and
  queue files passed 93/93 tests with 429 assertions; scoped Prettier, be-01
  lint, and be-01 typecheck were green. No build or autotest ran on the
  queue-worker box.
- One SQLite transaction now applies stale hash → terminal retryability →
  exact full-key liveness → capacity admission. Failed/corrupt markers remain
  authoritative while a reserved or durable-FIFO Retry runs, and concurrent
  identical asks coalesce without launching twice.

This closes the coordinator half of 7.3/7.11. The authenticated HTTP route and
its response mapping remain.

## 2026-09-06T22:39:45Z — authorized Retry route

- Test-only head `d2df3834` left the existing 33 project-controller cases
  green while both new route cases failed at 404: the response/body matrix and
  restricted-project authorization had no endpoint to reach.
- Exact green head `89e7169b` on h2puni, worktree
  `/home/puni1/t268-r3-route-proof.l3eSnM`: the project controller, coordinator,
  and mounted-route suites passed 60/60 with 262 assertions; scoped Prettier,
  full be-01 lint, and be-01 typecheck were green. No build or autotest ran on
  the queue-worker box.
- `POST /api/projects/:id/optimization/retry` now rebuilds the current canonical
  input after the same `canEdit` check as settings PATCH, delegates to the
  atomic coordinator seam, and maps the specified stale/not-retryable/running
  409 bodies and accepted 202 body without rewriting state in the controller.
  The composition root passes the installed coordinator into the serving app.

Together with the retained-marker replacement and atomic-admission proofs
above, this closes 7.3 and 7.11.

## 2026-09-06T22:49:00Z — outcome-event negative controls

- Exact head `52e97e09` on h2puni, worktree
  `/home/puni1/t268-r3-event-negatives.mBUA6j`: the focused event suite passed
  5/5 with 48 assertions before and after two isolated mutations.
- Emitting `schedule_optimized` from `readPlan` for an `ok` cache hit made the
  exact no-hit-push assertion red at 3 received events versus 2 expected.
- Moving the cache write outside the event transaction made the injected
  event-write crash leave one cache row; the rollback assertion failed at 1
  received versus 0 expected. Each mutation was restored and the worktree was
  clean before the next.
- The same suite's two preflight failures remain the no-other-event proof for
  `schedule_optimization_failed`; the earlier success-only event mutation made
  that case red, as recorded in the durable failure-announcement section.

This closes 7.5 and 7.6. No build or autotest ran on the queue-worker box.

## 2026-09-07T02:01:44Z — optimization indicator accessibility follow-up

- Implementation head `a333cf64` passed the three focused component suites on
  `h2puni`: 3 files and 31 tests, all green. FE application and spec
  typechecks, changed-file ESLint, scoped Prettier, and strict OpenSpec 1.3.0
  validation also passed there. No build or autotest ran on the queue-worker
  box.
- The phone-width Playwright path passed at 390×844 using real Enter input,
  the card renderer, disclosure accessibility assertions, and viewport-bound
  checks. The first keyboard run passed 3/4 cases and exposed focus loss after
  controlled radio rerenders; exact head `686230bc` restores focus before each
  real ArrowRight/ArrowLeft input. Exact-head browser verification is delegated
  to CI because the `h2puni` root filesystem exhausted its inodes before the
  corrected rerun could create Vite's temporary config file.
- Watched negatives proved the tolerance and shared rendering requirements:
  replacing `withinDrift` with exact-zero comparison failed the epsilon case,
  while removing stale qualifiers, real-date formatting, persistent live-region
  identity, and compact fallback classes failed 7/21 indicator cases. Both
  mutations were restored byte-for-byte before the green runs.

This closes the TASK-294 follow-up clauses without claiming retry UI or backend
work. Lane-q TASK-222 remains the independent post-deploy QA owner.

## 2026-09-07T02:22:09Z — unmeetable-deadline render safety

- The first exact-head Anthropic review at `e138a8da` found one Critical: the
  legal `UNMEETABLE_DEADLINE_OFFSET` value `-1` reached `addWorkdays` and threw
  from React render. The corrected renderer names that state `Work item
deadline before project start`, and the stored-result decoder now rejects
  offsets below the domain sentinel.
- At exact source head `762b33c9` on h2puni, the three focused FE suites passed
  33/33 and the plan-infeasible DTO suite passed 4/4. Both FE typechecks,
  changed-file ESLint, scoped Prettier, and strict OpenSpec validation passed.
- Two independent watched controls went red: bypassing the renderer's sentinel
  branch threw through the focused unmeetable-deadline case (1/1 failed), and
  weakening the DTO floor admitted `-2` and failed exactly the malformed-item
  suite (3 passed, 1 failed). Both files were restored byte-for-byte.

The branch was then merged with current `origin/main`; CI and the terminal
re-review are the exact merged-head gates.

## 2026-09-07T03:47:16Z — TASK-294 final browser and scanner closure

- CI run `34076293626` first made the phone proof fail for the right reason:
  its aggregate pixels job ended with 294 pass / 1 fail because the reload
  raced the long-name command, leaving an empty textbox and an orphan deadline
  bullet in the uploaded accessibility snapshot.
- Head `e6b887e2` awaited that exact persisted command and corrected the strict
  locator exposed once the 192-character name really rendered. The focused
  h2puni Chromium case passed 1/1 with both card and document overflow checks.
  Rebase head `4d4bca43` repeated the same browser proof against current main.
- CI run `34078821695` supplied the scanner's watched red: the leaf module
  specifier `@wbs/domain/deadline-offsets` was reported as copy, making the FE
  gate fail 2,399 pass / 1 fail. Head `4e9cefb7` excluded import/export module
  specifiers by AST position and passed the focused h2puni set 36/36.
- Replacement run `34079682370` was green at that exact source head: gate job
  `101612516597` and pixels job `101612516483`, with 295/295 browser cases.
  Verified exact-head review artifact `task294-terminal-r5-opus.txt` recorded
  0 Critical, and PR #268 merged as `2c3be50b`.

These entries extend the TASK-294 sequence chronologically from the 02:01
accessibility checkpoint through the 02:22 render-safety checkpoint and this
terminal closure. No build or autotest ran on the queue-worker box.

## 2026-09-07T04:45:12Z — TASK-268 chunks 11–18 reconciliation

The task log and the two canonical Anthropic review artifacts were reconciled here so the durable
OpenSpec record covers the terminal implementation sequence rather than stopping before it:

- **Chunk 11 (`d6e198e3`)** added the full-identity infeasible event in the outcome transaction and
  rechecked optimization enablement before repairing a stale FIFO input. The test-only head failed
  three new cases; the focused green was 30/30 with 203 assertions. Isolated mutations proved both
  event rollback and the OFF-project generation/spawn refusal.
- **Chunk 12 (`e87b4c60`, code head `26208ee3`)** regenerated the committed OpenAPI document after
  CI correctly found the Retry operation missing. All five OpenAPI checks and scoped formatting
  passed on h2puni.
- **Chunk 13 (`3866ea42`)** made the browser source backend's deterministic caller id conform to the
  exact 12-lowercase-hex production protocol. The old id failed the focused case and the repaired
  seven-case suite passed.
- **Chunk 14 (`5dd640d4`)** made installed solver mappings authoritative for every deploy target,
  added the missing-config remedy and future-mapping refusal, and made the runbook's recursive
  solver pathspec and publish/materialize/install/deploy order exact. The test-only head failed
  three cases; 27/27 passed after repair.
- **Chunk 15 (`d8f96d25`)** introduced the durable external poller and exact-commit candidate loader.
  A broken candidate left HEAD at the base and a repaired successor advanced it; the combined
  tool-devsync suite passed 48/48 without installing host state.
- **Chunk 16 (`73df007a`)** recorded the decision to expose the Retry lifecycle action through MCP
  and updated the intentional tool count and README after CI found the drift. The focused MCP file
  passed 25/25 with 203 assertions.
- **Chunk 17** recorded exact-head CI `34068782169` green for both `gate` and `pixels` at
  `73df007a`; PR 253 remained open for the mandatory production review.
- **Chunk 18 (`973ec21f`)** repaired all five Important findings from canonical review artifact
  `task268-terminal-r3-opus.txt`: streamed first-use loader, isolated candidate/ref state, durable
  managed Bun, post-create cleanup, and h2puni real-orphan gate wiring. The pre-fix focused run was
  13 pass / 7 fail and the repair passed 20/20 with 52 assertions. The later exact-head approval
  artifact `task268-terminal-r6-opus.txt` verified those blockers closed at `d802d705`; its nine
  non-blocking follow-ups moved to TASK-312 rather than being silently claimed here.

Every cited build, test, lint, typecheck, formatting, and mutation run above was performed on
h2puni or CI. No build or autotest ran on the queue-worker box.

## 2026-09-09T09:04Z — terminal lint, prune-boundary, and refusal-order follow-ups

- `89fcd757` repaired the configured proof-lint failures: the two asynchronous
  stubs now return explicit resolved promises, empty listener callbacks return
  `undefined`, and the poller imports use the configured sort order. The one
  production-file hunk is inert callback style despite the commit's `test:`
  prefix; the production review accepted that provenance defect without a
  history rewrite.
- `7b7155d1` widened candidate pruning to include interrupted candidates. Its
  exact-head gate was CI run `34085674029`, where both `gate` and `pixels`
  passed, and canonical Anthropic review round 2 returned APPROVE with
  0 Critical and 0 Important findings.
- TASK-320 strengthened that proof at red head `510b2dc1`: the focused poller
  command failed 1/12 because a stale candidate
  survived the managed-Bun mismatch. At green head `42a4b5e5`, the same command
  passed 12/12 with 38 assertions, including a fresh interrupted candidate that
  survives the seven-day boundary and stale reclamation before the explicit
  version refusal. `shellcheck -s bash bin/dev-poll-sync.sh` also passed on
  h2puni. No build or autotest ran on the queue-worker host.
