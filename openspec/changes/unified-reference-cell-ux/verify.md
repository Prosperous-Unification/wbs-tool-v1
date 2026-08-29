# Verification Contract

**Change**: `unified-reference-cell-ux`
**Implementation owner**: TASK-182, strict `openrouter/deepseek/deepseek-v4-flash-0731`
**Planning baseline**: `origin/main@06bcd64f`, PR #156 merged as `b508f870`

## 1. Structural validation

- [ ] `bunx @fission-ai/openspec@1.3.0 validate unified-reference-cell-ux --strict --json` on h2puni reports valid.
- [ ] Proposal, delta spec, design, tasks and this contract describe the same four fields and multi-team meaning.

## 2. Required watched failures

| Check                  | Fault to inject                                               | Test that must observe it                                                       |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| joint pool fixpoint    | stop after the first pool round                               | `schedule-joint-capacity.test.ts` re-ask case                                   |
| single-pool identity   | route a singleton through changed semantics that alter visits | `schedule-identity.test.ts` plus capacity oracle                                |
| binding team           | read `teamIds.at(0)` instead of search output                 | non-first binding-team geometry/service case                                    |
| mixed patch refusal    | allow `teamIds` and `serviceTeamId` together                  | controller exact 400 and unchanged-state case                                   |
| atomic team validation | validate before the repository transaction                    | unknown-among-known changes no scalar, join or revision                         |
| whole-set undo         | journal only the first team                                   | undo of middle-member removal loses sibling                                     |
| patch field journal    | omit `teamIds` from `fieldsOf`                                | `teamIds`-only patch creates no inverse                                         |
| structural restore     | restore only `serviceTeamId`                                  | duplicate/delete undo loses the second membership                               |
| stable projection      | project the request-order first id                            | equivalent request orders expose different scalar ids                           |
| last-writer-wins       | merge a stale client's members                                | later replacement is not the exact stored set                                   |
| own-vs-effective write | derive next ids from inherited effective set                  | clear/add inheritance case copies ancestor labels                               |
| passive overlay        | enable pointer events on the whole card                       | DOM passive-surface assertion and Chromium empty-space click-through            |
| interactive row        | remove pointer events from dependency rows                    | Chromium cell→third-row reachability                                            |
| complete list          | derive overlay entries from visible chips                     | third dependency absent from description/card                                   |
| hover cleanup          | omit owner leave or stale-id guard                            | Chromium outside-leave retains tint                                             |
| palette paint          | point card line at the grid-surface tint                      | two-palette direction assertion                                                 |
| beneath-row takeover   | drop `entersThroughDependsCard` from the cell/pill enters     | Chromium padding crossing over a dependent row; jsdom enter at a corridor point |

### Observed through task 1

- Joint-pool fixpoint: one-pass search failed the re-ask case before restoration.
- Single-pool identity: bypassing the fast path failed `eventsVisited` at 4 versus 2 before restoration.
- Binding team: projecting `teamIds.at(0)` made the service payload case fail on `team-alpha` versus the engine-selected `team-beta`; restored head passed 1/1.
- Geometry: the non-first binding-team suite passed 123/123 and the full fe-01 suite passed 1,759/1,759 before the service payload assertion landed.

### Observed through task 2.1

- Request arms: the pre-implementation route run failed 3/61 on whole-set `teamIds`, mixed scalar/set refusal, and unknown-member validation.
- Restored controller, service, and OpenAPI freshness suites passed 150/150; be-01 lint and typecheck also passed at `e470bb6`.
- Mixed requests return the stable 400 `cannot_send_both_teamIds_and_serviceTeamId`; unknown sets leave state unchanged; OpenAPI records `teamIds` with `maxItems: 10`.

### Observed through task 2.2

- Repository set semantics failed 3/28 under missing atomic validation/projection behavior, then passed 29/29; the whole-set journal mutant failed 1/79, then passed 79/79.
- Structural insertion failed 1/29 when explicit memberships were not inserted, then passed 29/29; legacy rows still fall back to the projected scalar.
- The second-member structural mutant failed exactly the new multi-team duplicate-redo and delete undo/redo guards (79 pass, 2 fail); restored `7447f55` passed 81/81 and be-01 typecheck.
- Removing the legacy scalar fallback failed exactly the old-journal singleton restore guard (81 pass, 1 fail); restored `4015713` passed 82/82. Both commits passed touched lint and format; no local build or test ran.
- PATCH remains exact whole-set last-writer-wins; unknown-among-known validation leaves the scalar, joins, and revision unchanged.

### Observed through task 2.3

- Omitting `teamIds` from the HTTP PATCH body failed exactly one new `wbs-api.test.ts` guard; restored `8b28eaa` passed 25/25.
- Dropping the full set in the plan-card API fake failed its focused round-trip guard; restored `2fd1646` passed, with fe-01 typecheck plus touched lint/format green. No local build or test ran.

### Observed during task 3.1

- Before `reference-set-field.tsx` existed, its focused suite failed at module resolution. The restored shared strip/sheet passed 6/6 at `67d54f4`.
- A combined named mutant re-offered selected ids, passed `addButtonLabel` to `CreatablePicker`, and left a pending remove control enabled. It failed 4/6 on duplicate selection, the second `+`, pending disablement, and the ambiguous add focus path; restored code passed 6/6.
- Omitting the strip's grid contract failed the new cell identity/Tab-routing guard 1/7. Restored `e37de6d` passed 7/7 with touched lint and fe-01 typecheck green. Task 3.1 remains open for outcome semantics and concrete directory adapters. No local build or test ran.
- The legacy team create writer replaced an existing membership: the new round-trip guard failed with `['team2']` instead of `['team1', 'team2']`. Restored `a57c517` patches the whole `teamIds` set, projects the first member in the API fake, and passed all 522 table tests plus 7/7 reference-set tests, touched lint, format, and fe-01 typecheck on h2puni.
- The shared dev checkout reset from the task branch during the first read, so this evidence was produced in detached worktree `/home/puni1/wbs-dev/task182-n15` at the same `48ba9ed` parent and pushed fast-forward to the task branch. No build or test ran on h1claw.
- Widening the six `PlanCardsProps` directory writers to `Promise<CommitOutcome>` first failed fe-01 typecheck with six TS2322 errors because every table adapter still returned `void`. Restored `9a2bf77` returns `run(...)` from all six writers and adapters; fe-01 app/e2e typecheck, touched lint, and format passed on h2puni. Existing desktop/card handlers explicitly discard outcomes until the shared strip/sheet replaces them in the next behavioral chunk.
- The choose/create outcome guard failed 2/8 before `f2e6544`: a refused take cleared `New team`, and a pending take left the combobox enabled. Restored code awaits the adapter outcome, closes only on `landed`, retains refused/unsent typing, and synchronously suppresses a second take. Focused reference-set 8/8, fe-01 app/e2e typecheck, touched lint, and format passed on h2puni. Task 3.1 remains open for the concrete Teams/Tags/Services adapters.
- The Teams shared-strip watched red first patched `['team2']` instead of preserving `['team1', 'team2']`; restored `07f0451` passed 9/9. Services then passed its 14/14 focused family at `6884187`, preserving inherited/mismatch words and whole-set writes.
- The first complete desktop-family run exposed six legacy Teams compatibility faults at 524/530. Restored `c89afdf` passed all watched cases 7/7 and the complete reference-set/table run 530/530.
- Tags moved to the same `ReferenceSetStrip` adapter at `b04cc01`. The complete reference-set/table run passed 530/530; fe-01 app/e2e typecheck, touched lint, and format passed on h2puni. Teams, Tags, and Services now share one desktop strip while retaining their existing directories and `Promise<CommitOutcome>` writers, completing tasks 3.1 and 3.2. No build or test ran on h1claw.

### Observed during task 3.3

- The 390×844 Teams watched guard first failed because the phone sheet had no `data-reference-set="team"` and exposed only one scalar value. The shared `ReferenceSetSheet` restoration exposes every selected team as an independently removable chip.
- Phone `PlanCardsProps` now sends whole sets through `setTeams(row, teamIds)` and passes the current set to `createTeam`. The 390×844 suite covers two selected teams, refused typed input retention, pending double-tap suppression, landed close, inherited reveal, and Tags/Services create/remove through the same sheet.
- Remote `plan-cards.test.tsx` passed 109/109 and `reference-set-field.test.tsx` passed 8/8 after the standalone dialog contract was restored. The complete table suite passed 522/522 during the combined gate; fe-01 app/e2e typecheck, touched lint, and format are green with one pre-existing hook warning and zero lint errors. No build or test ran on h1claw.

### Observed during task 4.1

- Before `dependencyPointerRegion` and dependency-row targets existed, the new focused suite failed 3/3: the rectangle helper was absent and neither interactive row target could be found. Restored `6bc430f` keeps the `HoverCard` surface at `pointer-events:none`, opts only its unfocusable rows into pointer events, and removes the passive document listener on unmount.
- The table guard preserves the card and whole-set tint when owner `mouseleave` reports the underlying element reached through passive padding; a document move outside the owner/row corridor then clears the card and tint. Clearing synchronously on owner leave fails this transition before the row can be reached.
- Remote `depends-card.test.tsx` plus the complete `wbs-table.test.tsx` passed 527/527 in 79.35s. The focused bridge/hover family passed 14/14; fe-01 typecheck, touched lint, format, and pre-commit hooks passed on h2puni with one pre-existing hook warning and zero lint errors. No build or test ran on h1claw.

### Observed during task 4.2

- Before the shared tokens were applied, the new three-dependency guard failed because the dependency add button exposed no `data-reference-add` marker. Restored `06b1f035` shares the reference strip, add, and compact-chip tokens while retaining the existing dependency combobox, bulk-number parser, refusal rows, and add/remove endpoints.
- A visible-chip-only mutant narrowed the accessible description with `waitingFor.slice(0, 2)`. The watched guard failed on `Waiting for 010 - Strip, 020 - Sand` instead of the complete `Waiting for 010 - Strip, 020 - Sand, 030 - Paint`; restoring the full `waitingFor` list passed.
- Remote table, shared-strip, and dependency-card suites passed 536/536. fe-01 app/e2e typecheck, touched lint, format, and pre-commit hooks passed on h2puni with one pre-existing hook warning and zero lint errors. No build or test ran on h1claw.

### Observed during task 4.3

- The stale-state cleanup guard first failed 0/3 because pointer cancellation, scroll, and resize had no listeners. Restored `8a1892b` clears the owner/card tint on all three invalidations, captures nested scroll, and unregisters every listener with the card.
- The focused pointer-bridge suite passed 5/5; the combined table, shared-strip, and dependency-card run passed 537/537 in 80.46s. fe-01 app/e2e typecheck, touched lint, format, and pre-commit hooks passed on h2puni. Chromium owner-to-third-row travel and empty-card hit testing remain open in task 4.3. No build or test ran on h1claw.
- Chromium exposed a browser-only bridge fault: spreading the first `DOMRect` dropped its prototype-backed `left/top/right/bottom` edges, so the passive corridor became `NaN` and the card closed before the third row. The watched test failed on `the card closed while crossing passive padding`; restored `6da9d6b` copies all four edges explicitly and passed 1/1.
- Removing the corridor failed the same bridge assertion, removing row pointer events failed `the third dependency row target does not own its painted pixels`, and enabling whole-card pointer events failed `the empty card area intercepted the underlying action`. The restored focused Chromium run passed after format; scroll, resize, and pointer cancellation each clear the card and exact row tint before the test reopens it.
- Touched format, fe-01 typecheck, lint (one pre-existing hook warning, zero errors), diff check, and pre-commit hooks passed on h2puni. The shared serving checkout repeatedly reset to `origin/main`, so the exact-head gate and commit used the existing detached TASK-182 worktree and pushed `6da9d6b` fast-forward. No build or test ran on h1claw.

### Observed during task 5.1

- The new desktop reference-cell round trip first failed because the third
  Teams/Tags/Services chip had area but its centre hit-tested outside the chip.
  The inner chip group was one non-wrapping flex item, so it painted across the
  next table cell and that cell covered the value. Restored `863b75d` wraps the
  group within 100% of its cell; all three chips are visible and hit-testable.
- The same Chromium case adds a third value through each real picker, adds a
  third dependency, reloads, proves inherited context and light/dark paint,
  removes one value from each set, reloads again, and preserves both siblings.
  It passed 1/1; the focused shared-field unit suite passed 8/8, fe-01 app/e2e
  typecheck and touched lint/format/hooks passed on h2puni.
- CI run 33204455231's hover failure reproduced locally. Playwright's default
  cell-centre hover landed on the first dependency chip and correctly narrowed
  the tint, so the assertion asking for the whole set was aimed at the wrong
  surface. A proven passive-padding point now drives that test; restored head
  passed 1/1.
- The 390×844 matrix adds a third Team, Tag, Service and dependency through
  the real bottom sheets, reloads, checks all three values in light and dark,
  opens inherited child sheets, removes one member from every set, reloads
  again, and preserves both siblings. It passed 1/1 alone and 2/2 with the
  desktop case at `4087586`.
- Clipped-value red head `7aa5b99` capped the shared chip group at 20px with
  hidden overflow; Chromium failed `reference chip 1 is clipped or covered`.
  Restored head `6fe01f8` passed both Chromium cases 2/2. Prettier and both
  commits' touched lint/format/secrets hooks passed on h2puni. No build or test
  ran on h1claw.

### Observed after merge, 2026-08-29

- Found by hand in Chrome on a plan where the row beneath an open card had
  dependencies of its own: the card's passive padding hit-tests to that row,
  its Depends on cell's `onMouseEnter` wrote `hoveredCell`, and 020's card
  became 030's on the way to it. It read as "the card closes for rows with
  fewer than three dependencies" — the height at which the card happened to
  stop covering such a row. The spec's `passive padding does not break
owner-to-row travel` scenario was already precise about this, so no new
  change; the fix is `entersThroughDependsCard` in `depends-card.tsx`, read by
  the cell's and the pill's enters.
- Red first: `e2e/deps-cell.spec.ts` `holds the card while the pointer crosses
its padding over the row beneath` failed on `the row beneath took the hover:
Expected ["030", …, "090"], Received ["040", "050"]`; `wbs-table.test.tsx`
  `leaves the open card alone when the row beneath it is entered through its
padding` on `expected 'What 030 waits for' to be 'What 020 waits for'`, and
  with the pill's guard alone removed on `expected ['020'] to deeply equal
['010']`. The band over a pill measured 0.9px in Chromium, so the pill guard
  is proved in jsdom alone and the Chromium case aims at the cell beneath.
- The first cut held every enter inside the bridge's region, owner included,
  and three existing cases failed (`narrows to the pill’s row…` and two more,
  `expected ['010', '020'] to deeply equal ['010']`): the owner's own pills
  enter at a point inside the owner. The owner's subtree is exempt now.
- Green: both jsdom suites 544/544; `deps-cell.spec.ts` + `reference-cells
.spec.ts` 11/12 in Chromium, the one failure (`picks the add button up off
the row it is hovered on`, `Expected: 0, Received: 42`) reproduced on the
  stashed `main` tree on the same Mac and is the host-specific red already
  noted in the session memory. fe-01 lint, typecheck and build passed. The
  same walk that switched the card in Chrome holds it after the fix.

## 3. Remote gate output to record after apply

- [ ] Focused DOM suites: exact pass counts and watched-red messages.
- [x] Focused Chromium suites: 2/2 at restored head `6fe01f8`; clipped-value red `7aa5b99` failed the named hit-test assertion.
- [x] `bin/h2puni-gate.sh --all` at `00f850f` exited 0: Nx test, lint, typecheck and build succeeded for all 23 projects.
- [x] `bin/h2puni-gate.sh --all` at `e57b3ae` exited 0: test, lint,
      typecheck and build succeeded for all 23 projects; Nx retried and passed the
      two reported flaky build tasks.
- [x] `bun run format:check --all` passed. The unscoped `bunx openspec`
      invocation reproduced the known package-resolution failure; the CI-pinned
      `bunx @fission-ai/openspec@1.3.0 validate --all --strict --json` passed
      76/76. Migration lint passed over every tracked drizzle SQL file.
- [ ] GitHub `gate` and `pixels` run ids on the reviewed exact head.
- [ ] Sol xhigh and Gemini sealed artifact paths, models, verdicts, all findings and dispositions.

## 4. Acceptance evidence to record after deploy

- [x] Desktop add/create/remove/reload for two Teams, three Tags, three Services and three Dependencies.
- [x] 390×844 sheet parity for the same own sets plus inherited context.
- [x] Light/dark screenshots or measured paint assertions showing no native grey button face or hidden third value.
- [x] Pointer sequence cell → third overlay row → cell → outside, with exact lit-row sets at every step.
- [x] `elementFromPoint` proof that empty card space delivers the underlying cell action.
- [x] Rollback/reapply evidence on a database copy; no live database is modified by the rehearsal.

### Rollback rehearsal

- Chromium's isolated `e2e-1787948452603.db` was WAL-checkpointed and copied;
  no live database was touched. The branch has no drizzle diff against main.
- A singleton rehearsal copy removed the two non-projected memberships while
  keeping every scalar projection. Rolled-back main head `33a251e` started
  without migrations and returned 200 from `/api/projects/:id/work-items`:
  five rows, all five singleton-compatible.
- Reapplied head `eba5946` read the untouched multi-set copy through the same
  endpoint: five rows, one multi-team row, plus the persisted tag/service sets.
  The restored 390×844 Chromium case then proved all four reference cells
  through add/remove/reload. No build or test ran on h1claw.

## 5. Completion gate

- [ ] Every task checkbox is complete and every check above has an observed failure proof.
- [ ] Worktree clean, branch pushed, CI green, exact-head reviews complete.
- [ ] Main-session review approves the measured dev-mode Flash trial before merge.
- [ ] Dev health reports the merged commit and TASK-183 is unblocked.
