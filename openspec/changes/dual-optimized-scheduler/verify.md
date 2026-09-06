# Dual optimized scheduler verification

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
