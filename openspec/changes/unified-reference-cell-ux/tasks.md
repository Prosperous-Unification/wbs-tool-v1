## 1. Restore the multi-team reader and scheduler before the writer

- [ ] 1.1 Port the current-main version of `poolIds`, joint-window search, narrowest-pool width and binding `capacityTeamId` from PR #67's behavior — tests: `schedule-joint-capacity.test.ts` multi-round, blocking-union, binding-team and unsized-team cases; negative: one-pass joint search makes the re-ask case fail.
- [ ] 1.2 Prove sets of zero/one preserve current scheduling — tests: `schedule-identity.test.ts` 1,000-plan differential and committed capacity oracle; negative: bypass the one-pool path and observe the pinned `eventsVisited`/identity failure.
- [ ] 1.3 Thread binding-team payload/words through current fe-01 geometry without first-member inference — tests: `work-item.service.test.ts` payload and `gantt-geometry.test.ts` binding-team/tie words; negative: derive from `teamIds.at(0)` and observe the non-first binding case fail.

## 2. Make the work-item team write set-valued and reversible

- [ ] 2.1 Add mutually exclusive `teamIds` and legacy `serviceTeamId` request arms, whole-set validation and atomic unknown-team refusal — tests: controller/service cases for absent, empty, deduplicated, unknown and mixed payloads; negative: remove the mixed-payload refusal and observe order-dependent state.
- [ ] 2.2 Replace `work_item_team` rows transactionally, maintain the legacy scalar projection, and journal the whole prior set for undo/redo — tests: repository and undo cases covering two→three, remove-middle, clear→inherit, duplicate/restore and stale revision; negative: journal only `.at(0)` and observe undo lose a sibling.
- [ ] 2.3 Widen fe-01's `ProjectApi.patch` contract and fakes to `teamIds` while retaining legacy coverage — tests: `wbs-api.test.ts` exact JSON and plan-card/table fake round trips.

## 3. Build the shared directory reference-set interaction

- [ ] 3.1 Add `ReferenceSetStrip`/`ReferenceSetSheet` and adapters for Teams, Tags and Services — tests: new `reference-set-field.test.tsx` for quiet leading `+`, chip naming/removal, duplicate exclusion, inherited context, Arrow/Enter/Escape/Tab and create selection.
- [ ] 3.2 Replace the three desktop cell shells without changing their directories or writers — tests: watched-red `wbs-table.test.tsx` cases for exact full-set patches, two-team reload state, independent dimensions and inherited-whole override.
- [ ] 3.3 Replace PR #156's three phone field shells with the shared sheet and full own-team set — tests: watched-red `plan-cards.test.tsx` cases for add/create/remove-middle/final-own-member and focus/close behavior at 390×844.

## 4. Make dependency overflow pointer-reachable and narrowly interactive

- [ ] 4.1 Extend `DependsCard` rows with pointer-only targets wired to existing dependency hover state while keeping `HoverCard` passive — tests: `depends-card.test.tsx`/`wbs-table.test.tsx` assert passive surface, target-only pointer events, no tab stop, owner→row narrowing→owner widening→outside clear; negative: set the whole card to pointer events and fail the passive-surface assertion.
- [ ] 4.2 Preserve the dependency-specific picker, bulk-number/refusal logic and full accessible description while adopting the shared strip tokens — tests: existing dependency keyboard suite plus a three-dependency full-list description case; negative: narrow the card list to visible chips and observe the third dependency disappear.
- [ ] 4.3 Add Chromium hit-testing for cell→third card row travel, exact row/line tint, empty-card click-through and stale-state cleanup — test: `e2e/hover-cards.spec.ts`; negative heads with target pointer events removed and with whole-card pointer events enabled MUST fail distinct assertions.

## 5. Close parity, rollback and delivery gates

- [ ] 5.1 Add desktop and 390×844 Chromium round trips for Teams/Tags/Services/Depends on, three-value overflow, reload, inheritance and light/dark paint — tests: `e2e/mobile.spec.ts` and focused reference-cell spec; each new geometry/paint check gets a withheld-style or clipped-value red head.
- [ ] 5.2 Run on h2puni: focused watched reds/greens, full `bunx nx run-many -t test lint typecheck build`, format, strict OpenSpec validation and migration lint; paste decisive output and every injected fault into `verify.md`.
- [ ] 5.3 Rollback rehearsal: revert the implementation on a database copy and prove existing singleton rows/read API remain valid; no migration is expected. Reapply and prove multi-team sets plus all four reference cells reload.
- [ ] 5.4 Push the exact head, require green `gate` and `pixels`, exact-head Sol xhigh and Gemini full-diff reviews, fix every Critical/Important finding, then hand the prod-mode `service/schedule.ts` merge to main-session review.
