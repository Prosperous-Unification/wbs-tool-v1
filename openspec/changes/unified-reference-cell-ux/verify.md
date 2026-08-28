# Verification Contract

**Change**: `unified-reference-cell-ux`
**Implementation owner**: TASK-182, strict `openrouter/deepseek/deepseek-v4-flash-0731`
**Planning baseline**: `origin/main@06bcd64f`, PR #156 merged as `b508f870`

## 1. Structural validation

- [ ] `bunx @fission-ai/openspec@1.3.0 validate unified-reference-cell-ux --strict --json` on h2puni reports valid.
- [ ] Proposal, delta spec, design, tasks and this contract describe the same four fields and multi-team meaning.

## 2. Required watched failures

| Check                  | Fault to inject                                               | Test that must observe it                                            |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| joint pool fixpoint    | stop after the first pool round                               | `schedule-joint-capacity.test.ts` re-ask case                        |
| single-pool identity   | route a singleton through changed semantics that alter visits | `schedule-identity.test.ts` plus capacity oracle                     |
| binding team           | read `teamIds.at(0)` instead of search output                 | non-first binding-team geometry/service case                         |
| mixed patch refusal    | allow `teamIds` and `serviceTeamId` together                  | controller exact 400 and unchanged-state case                        |
| atomic team validation | validate before the repository transaction                    | unknown-among-known changes no scalar, join or revision              |
| whole-set undo         | journal only the first team                                   | undo of middle-member removal loses sibling                          |
| patch field journal    | omit `teamIds` from `fieldsOf`                                | `teamIds`-only patch creates no inverse                              |
| structural restore     | restore only `serviceTeamId`                                  | duplicate/delete undo loses the second membership                    |
| stable projection      | project the request-order first id                            | equivalent request orders expose different scalar ids                |
| last-writer-wins       | merge a stale client's members                                | later replacement is not the exact stored set                        |
| own-vs-effective write | derive next ids from inherited effective set                  | clear/add inheritance case copies ancestor labels                    |
| passive overlay        | enable pointer events on the whole card                       | DOM passive-surface assertion and Chromium empty-space click-through |
| interactive row        | remove pointer events from dependency rows                    | Chromium cell→third-row reachability                                 |
| complete list          | derive overlay entries from visible chips                     | third dependency absent from description/card                        |
| hover cleanup          | omit owner leave or stale-id guard                            | Chromium outside-leave retains tint                                  |
| palette paint          | point card line at the grid-surface tint                      | two-palette direction assertion                                      |

### Observed through task 1

- Joint-pool fixpoint: one-pass search failed the re-ask case before restoration.
- Single-pool identity: bypassing the fast path failed `eventsVisited` at 4 versus 2 before restoration.
- Binding team: projecting `teamIds.at(0)` made the service payload case fail on `team-alpha` versus the engine-selected `team-beta`; restored head passed 1/1.
- Geometry: the non-first binding-team suite passed 123/123 and the full fe-01 suite passed 1,759/1,759 before the service payload assertion landed.

### Observed through task 2.1

- Request arms: the pre-implementation route run failed 3/61 on whole-set `teamIds`, mixed scalar/set refusal, and unknown-member validation.
- Restored controller, service, and OpenAPI freshness suites passed 150/150; be-01 lint and typecheck also passed at `e470bb6`.
- Mixed requests return the stable 400 `cannot_send_both_teamIds_and_serviceTeamId`; unknown sets leave state unchanged; OpenAPI records `teamIds` with `maxItems: 10`.

## 3. Remote gate output to record after apply

- [ ] Focused DOM suites: exact pass counts and watched-red messages.
- [ ] Focused Chromium suites: exact pass counts, red-head SHAs and restored-head SHA.
- [x] `bin/h2puni-gate.sh --all` at `00f850f` exited 0: Nx test, lint, typecheck and build succeeded for all 23 projects.
- [ ] Record format/OpenSpec/migration-lint summaries at the terminal head; OpenSpec CLI was unavailable in this worktree during run 8.
- [ ] GitHub `gate` and `pixels` run ids on the reviewed exact head.
- [ ] Sol xhigh and Gemini sealed artifact paths, models, verdicts, all findings and dispositions.

## 4. Acceptance evidence to record after deploy

- [ ] Desktop add/create/remove/reload for two Teams, three Tags, three Services and three Dependencies.
- [ ] 390×844 sheet parity for the same own sets plus inherited context.
- [ ] Light/dark screenshots or measured paint assertions showing no native grey button face or hidden third value.
- [ ] Pointer sequence cell → third overlay row → cell → outside, with exact lit-row sets at every step.
- [ ] `elementFromPoint` proof that empty card space delivers the underlying cell action.
- [ ] Rollback/reapply evidence on a database copy; no live database is modified by the rehearsal.

## 5. Completion gate

- [ ] Every task checkbox is complete and every check above has an observed failure proof.
- [ ] Worktree clean, branch pushed, CI green, exact-head reviews complete.
- [ ] Main-session review approves the measured dev-mode Flash trial before merge.
- [ ] Dev health reports the merged commit and TASK-183 is unblocked.
