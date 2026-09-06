## Scope and status

R7 implemented on `refactor/scoped-presence` in `.worktrees/refactoring-r7`, based on merged `362c29a8`. The sibling refactoring checkpoint was never edited. No shared wire schema, R4 parser, backend transport or authentication behavior changes. Ready for independent review; no commits or integration gate run by this slice.

## Commands and observations

- Baseline `bun test ./apps/gw-01/src/service/presence.test.ts ./apps/gw-01/src/fan-out.integration.test.ts ./apps/gw-01/src/presence-race.integration.test.ts`: **21 pass / 0 fail**, 3,044 assertions, 1.74s (`/private/tmp/r7-baseline.log`). Real sockets used approved loopback escalation.
- Mutation contract regression before implementation: **13 pass / 1 fail**; join returned undefined instead of [] (`r7-mutations-red.log`).
- Scoped delivery regressions against the old global broadcast: **14 pass / 3 fail**. Newcomer caused **1,000 frames to unrelated existing connections instead of 0**; move/disconnect also notified unrelated sockets (`r7-delivery-red.log`).
- Real socket wiring regression before app changes failed because no project roster arrived after the newly scoped service replaced the old broadcast signature (`r7-wiring-red.log`).
- Initial restored three-file service/socket/race scope: **26 pass / 0 fail**, 3,091 assertions (`r7-wiring-green.log`).
- Final `bun test ./apps/gw-01/src ./libs/contracts`: **342 pass / 0 fail**, 3,818 assertions, 32 files, **3.01s** (`/private/tmp/r7-final-scoped.log`). Explicit directory paths avoid TypeScript's emitted test copies. Includes R4 ingress, project-content isolation, both verification races, property tests and contracts/solver tests.
- `bunx tsc --build --force apps/gw-01/tsconfig.json libs/contracts/tsconfig.json`: **exit 0**, no diagnostics (`r7-typecheck.log`). Gateway root references production and spec projects.
- Four changed TypeScript files formatted and scoped ESLint run. The first lint invocation skipped Nx module-boundary rules because this isolated worktree had no cached graph. `NX_DAEMON=false bunx nx show project gw-01 --json` then built its graph successfully; final scoped ESLint exited **0**, without warnings or skipped rules (`/private/tmp/r7-lint.log`).
- `OPENSPEC_TELEMETRY=0 bunx openspec validate scoped-presence --strict --json`: **exit 0**, valid with zero issues. Final four-file/artifact Prettier check: **exit 0**.

## Failure-proof table

All faults ran the real production Presence and gateway call paths in the service and fan-out files; each exited 1 and was restored in finally before the next. Counts below are per mutation, not accumulated. Proof comments were written only after inspecting these outputs.

| Injected fault                                | Production-path observation                                                                                                                                 | Pass / fail |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Restore original all-connections broadcast    | Large newcomer case: expected 0 unrelated frames, received 1000. Socket newcomer case: unrelated counts [1,1,1,1] instead of [0,0,0,0] after ping barriers. | 20 / 4      |
| Omit old project from move return             | Remaining old-project observer grace receives no changed roster; affected-project return also misses old id.                                                | 21 / 3      |
| Remove same-project equality guard            | Repeated subscribe emits rosters during the immediate zero-count window, including through real sockets.                                                    | 21 / 3      |
| Omit connected unsubscribe reset in app       | Socket receives [] instead of one presence frame with empty users after leaving its current project.                                                        | 23 / 1      |
| Omit previous project from disconnect return  | Remaining tab receives no roster; real-socket observer times out with no updated roster.                                                                    | 20 / 4      |
| Retain empty project sets                     | Completed mutation sequence leaves index size 2 instead of 0.                                                                                               | 23 / 1      |
| Discard affected project on renamed-id rejoin | Remaining old-project member linus receives no updated roster.                                                                                              | 22 / 2      |
| Omit initial roster in app                    | Newcomer receives no frame instead of one empty initial roster.                                                                                             | 23 / 1      |
| Reset even after stale unsubscribe            | Real-socket unchanged-membership sample receives a frame instead of zero.                                                                                   | 23 / 1      |
| Omit member deletion from project index       | Existing two-tab test throws `presence: c1 is in project-hull but is not connected`; new disconnect delivery throws the same invariant for tab1.            | 16 / 8      |

Fault logs: `/private/tmp/r7-fault-*.log`; global-final is the final global run, where unrelated count assertions precede the initial-roster assertion. Temporary scripts `/private/tmp/r7-faults.py` and `/private/tmp/r7-extra-faults.py` restore source in finally. They are not repository artifacts.

## Limits

Full workspace, browser and merge checks remain parent-owned and were not run. No benchmark or replica support claim: the evidence is exact recipient counts, indexed production code and lifecycle correctness. Saved/reset roster content and closed-socket send isolation retain existing behavior.

## Independent review

Parent reviewer approved the frozen four-file implementation and artifacts with no actionable findings. Review covered affected memberships, indexed delivery, explicit initial/reset rosters, close/auth races and production fault oracles. Reviewer read evidence and source only; did not run additional tests. Integration gates remain pending.
