# Verify — local write invalidation

## Section 1 — explicit completed-operation contract

Verified on 2026-09-13 from `origin/main` `c61b370d`.

| Check                                                                                                    | Result                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Baseline `plan-read-and-write.test.tsx` + `plan-refresh.test.ts`                                         | 2 files, 67 passed                                    |
| Focused Section 1 suite: `local-write.test.ts`, `plan-read-and-write.test.tsx`, `plan-refresh.test.ts`   | 3 files, 69 passed                                    |
| Fast-tier manifest guard plus `local-write.test.ts`                                                      | 2 files, 6 passed                                     |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:test --skip-nx-cache`                        | 106 UTC files / 2697 passed; 2 zoned files / 3 passed |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache`                   | succeeded                                             |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:lint --skip-nx-cache`                        | succeeded                                             |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate local-write-invalidation --strict --json` | 1 change passed, 0 failed                             |

The first full-suite attempt was sandbox-blocked at
`playwright-config.test.ts > lets a shifted browser login reach authentication through the configured backend origin` with `spawnSync bun EPERM`; its child had produced the expected `401`. The complete result above is the same target rerun outside that process restriction.

### R5 proofs

| Check                                                     | Injected fault                                                             | Watched failure                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `keeps the completed prefix when a later request refuses` | Clear the gesture's completed-resource set when its second request rejects | `expected [] to deeply equal ['tree']`          |
| `refreshes a created tag after its attachment refuses`    | Replace refused-prefix invalidation with an empty resource list            | timed out with tag read count `1`, expected `2` |

The production-page case holds tag creation until the initial directory read is counted, rejects the subsequent attachment with the typed `unknown_tag` refusal, installs the covering directory answer, and asserts both that the picker offers the created tag and that the server row remains unattached. It supplies no socket subscription.

Browser tests and `bin/h2puni-gate.sh` are deferred to Task 3.3, where the packet explicitly requires the whole browser and host gates after all narrowing and race coverage is complete.

## Section 2 — narrow operation families

Verified on 2026-09-13 after rebasing the Section 1 commit onto `origin/main`
`0451b821`. That upstream commit changes only solver/devsync files and has no
frontend overlap.

| Check                                                                                                                        | Result                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Focused Section 2 suite: page writes, reference-set prefixes, cells, steps, settings, marker seam and local-write accounting | 7 files, 250 passed                                   |
| Five legacy team-picker regressions after moving server directory setup before the initial page read                         | 1 file, 5 passed, 119 skipped                         |
| `bunx nx run fe-01:test`                                                                                                     | 107 UTC files / 2706 passed; 2 zoned files / 3 passed |
| `bunx nx run fe-01:typecheck`                                                                                                | succeeded                                             |
| `bunx nx run fe-01:lint`                                                                                                     | succeeded                                             |
| Changed-file `bunx nx format:check --files=...` and `git diff --check`                                                       | succeeded                                             |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate local-write-invalidation --strict --json`                     | 1 change passed, 0 failed                             |

The full suite preceded the no-overlap rebase. Focused tests, lint, format and
OpenSpec were rerun on the rebased tree. The five team-picker cases formerly
added directory entries behind the mounted page, then used an unrelated tree
write as an implicit directory refresh. Their server fixtures now exist before
the page's initial directory response, matching the narrow-scope contract.

### R5 proofs

| Check                                                           | Injected fault                                   | Watched failure                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `estimate refreshes only tree without a socket`                 | Restore `ALL_RESOURCES` for the estimate request | Exact reads included tree, steps, six directory lists and markers instead of only tree |
| `estimate refreshes only tree without a socket`                 | Drop the estimate request's tree obligation      | The server-normalized `· 5` total never appeared                                       |
| `step rename refreshes tree and steps without a socket`         | Declare the rename tree-only                     | The Project Settings list never showed `Remove Build`                                  |
| `fully recovers when a peer already removed the refused step`   | Drop refused-step full recovery                  | Stale `Remove QA` remained visible                                                     |
| Five `keeps ... in the directory when attachment refuses` cases | Declare each create request tree-only            | All five received `['tree']`, expected `['tree', 'directory']`                         |
| `rereads a marker refused because a peer already deleted it`    | Return before refused-marker invalidation        | `chip('launch')` remained a marker span instead of becoming null                       |

At the Section 2 boundary, the Section 3 race, transport/ownership, browser and
host-gate work remained unverified and unchecked.

## Section 3 — cross-operation races and local gates

Pre-integration evidence was gathered on 2026-09-13 at `fbfc8792` plus the
Section 3 working tree, before `origin/main` advanced from `0451b821` to
`454edb99` with overlapping frontend compact-column work.

| Check                                                                | Result                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| Section 3 race/refusal/owner cases                                   | 1 file, 6 passed, 58 skipped                          |
| Full `plan-read-and-write.test.tsx`                                  | 1 file, 64 passed                                     |
| `bunx nx run fe-01:test`                                             | 107 UTC files / 2712 passed; 2 zoned files / 3 passed |
| `CI=1 E2E_PORT_SHIFT=2600 bun run e2e` on owned ports 5700/5800/6800 | 348 passed, 37 skipped, 0 failed; 20m35s              |
| `bunx nx run fe-01:typecheck`                                        | succeeded                                             |
| `bunx nx run fe-01:lint`                                             | succeeded                                             |
| Changed-file format and strict change OpenSpec validation            | succeeded; 1 change passed, 0 failed                  |

### R5 proofs

| Check                                                            | Injected fault                                         | Watched failure                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `starts a trailing tree read after the pre-write answer settles` | Reuse the generation of a tree read already in flight  | Exact tree-read count remained 1, expected 2; the later server row could not install  |
| `ambiguous transport failure has its exact recovery scope`       | Force the typed `WbsRequestError` failure branch false | Zero recovery reads, expected all nine API reads                                      |
| `does not spend an old API success against its busy replacement` | Send completed resources through `ownerRef.current`    | Replacement reads were `['tree']`, expected none while its own write remained pending |

Post-integration evidence was gathered on 2026-09-13 at `3493b059`, after
rebasing onto `454edb99`.

| Check                                                          | Result                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| Compact-column overlap suite                                   | 4 files, 229 passed                                   |
| Exact isolated keyboard-timeout control                        | 1 passed, 94 skipped                                  |
| Decisive rerun of `bunx nx run fe-01:test`                     | 107 UTC files / 2715 passed; 2 zoned files / 3 passed |
| `CI=1 E2E_PORT_SHIFT=3000 bun run e2e` on ports 6100/6200/7200 | 348 passed, 37 skipped, 0 failed; 18m54s              |
| `bunx nx run fe-01:typecheck`                                  | succeeded                                             |
| `bunx nx run fe-01:lint`                                       | succeeded                                             |
| Branch format check and `git diff --check`                     | succeeded                                             |
| Strict change and all-packet OpenSpec validation               | 1/1 and 82/82 passed                                  |

The first integrated full frontend run had one five-second timeout in the
unchanged keyboard chord test. The exact isolated case passed in 4.52 seconds,
and the complete decisive rerun passed all 2,718 tests. Nx reported the first
run as flaky.

Task 3.3 remains unchecked because `bin/h2puni-gate.sh <final-sha>` cannot run
on this `pop-os` host. The h2puni lane also needs a final committed SHA
reachable to its repository; this branch has not been pushed.

## Astra repair — complete recovery and owner-safe success

Verified on 2026-09-13 at the working tree based on `0e6a01bb`.

| Check                                                                                  | Result                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------- |
| Corrected RED selection for the three review findings                                  | 8 selected: 6 failed, 2 controls passed |
| Corrected GREEN selection                                                              | 8 passed, 63 skipped                    |
| `plan-read-and-write.test.tsx`                                                         | 71 passed                               |
| Owning write tests plus the complete `plan-table.test.tsx`                             | 2 files, 117 passed                     |
| Settings, team-picker, modal and dependency neighbours                                 | 4 files, 111 passed                     |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache` | succeeded                               |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:lint --skip-nx-cache`      | succeeded                               |
| Changed-file format, `git diff --check`, strict change OpenSpec                        | succeeded; 1 change passed, 0 failed    |
| Strict all-packet OpenSpec                                                             | 82 passed, 0 failed                     |

The final uncontaminated `bunx nx run fe-01:test` exited 1 after 7m13s. Nx
captured no Vitest body or named failure, so the result supplies neither test
counts nor a reviewable counterexample. The complete owning file and the
previously affected `plan-table.test.tsx` pass together above. No further broad
rerun was made while the coordinator reassigned the shared E2E lane.

The integrated browser result at `3493b059` remains the browser evidence. This
repair changes coordinator result classification and recovery scopes without
changing DOM structure, layout, browser transport or an E2E-visible workflow;
the production-page tests exercise its requests, toasts, focus and retained
drafts directly.

### Repair R5 proofs

| Check                                                                    | Injected fault                                          | Watched failure                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- |
| Capacity transport and malformed-response recovery                       | Force the shared ambiguous-failure classifier false     | Recovery reads were 0 instead of all 9                         |
| Multi-dependency transport, malformed response and mixed prefix recovery | Force the dependency ambiguous-failure classifier false | Recovery reads were 1 instead of all 9                         |
| Old Arrange completion stays out of its replacement                      | Remove the captured-owner success guard                 | The replacement received `Arranged by schedule.`               |
| Capacity success issues the real request before refresh                  | Replace the capacity setter with a no-op                | Recorded requests were `[]` instead of `[['p1', 'team-1', 3]]` |

The capacity negatives also assert the exact request, no read before its held
response settles, all-nine recovery after both typed failure shapes, retained
draft and visible error. Dependency negatives assert both ordered requests,
one toast, all-nine recovery for ambiguous failures, the successful prefix
remaining visible, and tree-only recovery for a modeled refusal. The owner
negative holds the old Arrange response across a same-project replacement and
its pending rename, then proves no old toast, read, focus or busy-state change;
a following same-owner Arrange remains the success control.

## Astra rereview repair — ownership during the covering read

Verified on 2026-09-13 from `c929b982`.

| Check                                                                                  | Result                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| New held-covering-read cases before the repair                                         | 1 failed, 1 control passed, 71 skipped |
| New held-covering-read cases after the repair                                          | 2 passed, 71 skipped                   |
| Complete owning file plus `plan-table.test.tsx`                                        | 2 files, 119 passed                    |
| Exact Astra rereview probe file against the repaired production tree                   | 5 passed                               |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache` | succeeded                              |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:lint --skip-nx-cache`      | succeeded                              |

The new negative holds Arrange's covering tree GET, replaces the API for the
same project, waits for all nine replacement reads, and then releases the old
GET. Before the pair check it received `['Arranged by schedule.']`, expected
no toast. The paired control renews the subscription coordinator while keeping
the project and API unchanged and still receives the valid success toast.

### R5 identity proof

Removing the post-refresh project/API check reproduced the stale success toast.
Replacing the check with captured-coordinator `isCurrent()` made the renewal
control receive `[]`, expected `['Arranged by schedule.']`. The production
check therefore uses the logical reader pair after refresh while retaining the
captured coordinator guard before refresh and in the busy-state cleanup.

The full frontend and browser targets were not rerun for this repair because
the shared E2E lane was occupied. The focused test includes the complete owning
and `plan-table` files; the prior integrated browser evidence and the suppressed
full-frontend failure remain recorded above. Task 3.3 remains open for the
publication-dependent exact-SHA h2puni gate.

## Publication integration

Verified on 2026-09-13 after merge commit `00d83d8f` integrated actual
`origin/main` `9b13f98e62a7cd880977e348421e992e8c4951a3`.

The merge had one content conflict, in `use-plan-fields.ts`. Its resolution
retains the accepted `write.perform(['tree'], ...)` invalidation around status
writes and main's optional `factStart` argument through the same production
call. Main's related completion prompt, status, deadline and layout changes are
otherwise unchanged.

| Check                                                                                                                                                    | Result                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Owning write tests plus plan-table, cell, settings, team, modal and dependency neighbours                                                                | 9 files, 365 passed        |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p fe-01 --parallel=2 --output-style=static`                                | 2 targets succeeded        |
| `CI=1 E2E_PORT_SHIFT=4300 bunx playwright test --config apps/fe-01/playwright.config.ts status.spec.ts deadline.spec.ts keyboard.spec.ts layout.spec.ts` | 79 passed, 0 failed; 4m12s |

The first browser attempt inside the filesystem sandbox was unavailable: the
backend dev server could not listen and reported `EPERM`. The identical command
was rerun with the required process permission on isolated ports 7400, 7500 and
8500, producing the result above. Vite reported transient websocket proxy
`EPIPE`/`ECONNRESET` messages while browser contexts closed; all selected tests
completed successfully.

Task 3.3 remains unchecked pending the publication-dependent exact-SHA h2puni
gate.

## Main closeout integration

Verified on 2026-09-14 after fast-forwarding to actual `origin/main`
`e82e6c0cea410abc8c29eff43468082709a12a58`. The fast-forward had no content
conflicts. Main's live-plan merge `c6db7193` changes backend, core and store
code only. The frontend integration retains immutable `PlanRowReadings` and
`PlanRenderRow` inputs, event-only `PlanLiveValues.run`, and the existing
`cellCards`, `attachCell`, `RunPlanWrite` and `LocalWrite.perform` signatures.

| Check                                                                                                                                               | Result                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Local-write, production-page, cell and keyboard focus suites                                                                                        | 4 files, 296 passed                                   |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run contracts:test --skip-nx-cache --output-style=static`                                         | 41 files, 392 passed                                  |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:test --skip-nx-cache --output-style=static`                                             | 108 UTC files / 2745 passed; 2 zoned files / 3 passed |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p fe-01 contracts --parallel=2 --skip-nx-cache --output-style=static` | 4 targets succeeded                                   |
| Serialized `CI=1 E2E_PORT_SHIFT=7800 bun run e2e` on ports 10900/11000/12000                                                                        | 366 passed, 37 skipped, 0 failed; 18m55s              |
| Strict change and all-packet OpenSpec validation                                                                                                    | 1/1 and 83/83 passed                                  |

The sandboxed full frontend run was not usable evidence because three tests
that spawn Bun received `EPERM`; the complete Nx target above passed when rerun
with process permission. The full browser gate used the production heavy-lock
library's explicit-path seam with `/tmp/wbs-heavy-work.lock`: this Pop!_OS host
does not have the canonical Linux wrapper directory `/home/puni1/.cache`, so
`bin/with-heavy-lock.sh` refused before starting. Transient Vite websocket
`EPIPE` and `ECONNRESET` messages appeared as browser contexts closed; the Nx
target completed successfully.

Task 3.3 remains unchecked. `bin/h2puni-gate.sh <final-sha>` still requires the
final committed SHA to be reachable on the h2puni host; this branch has not
been pushed.

## Astra P2 closeout repairs

Verified on 2026-09-14 after the live-plan snapshot integration.

The mounted production-page settings table now covers priority bands,
estimate arithmetic and optimization for both an ambiguous typed transport
failure and an invalid response. Each case holds the write answer, observes no
premature read, then observes all nine recovery reads, the retained draft and
the rendered failure. The corresponding success controls observe tree only.
Removing each panel's `onRefused` path made its ambiguous cases observe zero
reads instead of nine; all three faults failed before restoration.

The arrangement renewal case now observes the toolbar leave `aria-busy` and
its controls become usable after the accepted answer. Retaining the captured
coordinator check in cleanup left the toolbar busy and failed that assertion.
The separate replacement-owner case still holds a replacement rename and
proves an old arrangement cannot clear that pending state.

The dependency owner case holds an old dependency-list request, replaces the
same project's API, then holds a replacement rename. Settling the old request
must not clear replacement busy state, toast, or start reads; the replacement
answer is the finish control. Removing the API-owner guards cleared busy and
failed the mounted assertion before restoration.

The former hook-only reference proof was replaced by mounted page cases for
team, service, tag, type and person create-success followed by attach/assign
refusal. Each created name is visible in its picker without a socket, the
assignment remains unchanged, the refusal is rendered, and the exact reads
are tree plus the directory family. Removing each create's directory
obligation made all five visible picker assertions fail before restoration.

| Check                                                               | Result                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Complete owning production-page file after formatting               | 1 file, 88 passed                                                                            |
| Focused settings, toolbar, cell, keyboard and production-page batch | 10 files, 405 passed                                                                         |
| Full FE and contracts tests, uncached                               | contracts 41 files / 392 passed; FE 107 UTC files / 2755 passed and 2 zoned files / 3 passed |
| FE and contracts lint/typecheck, uncached                           | 4 targets succeeded                                                                          |
| Serialized production `keyboard.spec.ts` on ports 11300/11400/12400 | 19 passed, 0 failed; 1m                                                                      |
| Strict change and all-packet OpenSpec validation                    | 1/1 and 83/83 passed                                                                         |

The selected browser file exercises the changed toolbar busy and keyboard
usability surface. Ambiguous settings failures and replaced-owner completion
require controlled held requests, so their production-page tests provide the
direct negative evidence. Vite reported transient websocket `EPIPE` messages
while the browser context closed; all selected scenarios completed.

Task 3.3 remains unchecked pending Astra re-review and an exact committed-SHA
`bin/h2puni-gate.sh` run. This branch has not been pushed.
