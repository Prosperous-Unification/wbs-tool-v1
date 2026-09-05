export * from './assumed-duration';
export * from './capacity';
export * from './dependency-reach';
// Moved out of `apps/be-01/src/service/` on 2026-09-02. Both were already pure —
// neither imported anything at all — and both answer questions about a plan's
// shape rather than about storage: what number a work item takes from where it
// sits, and where a new sibling goes. `schedule.ts` reads the first of them.
export * from './contract-version';
export * from './derive-numbers';
// `effective-label` is deliberately absent: it is the walk the three dimensions
// share, not a fourth thing to read a plan with.
export * from './effective-service';
export * from './effective-tag';
export * from './effective-team';
export * from './estimate';
export * from './external-system';
// The eight Fast cases, published rather than left in a `.test.ts` because
// `libs/contracts` proves a property ABOUT them: that materialising the
// quantised baseline of each one is legal and never earlier than Fast. A corpus
// only one package can read is a corpus the wire boundary cannot be held to.
export * from './fast-golden-corpus';
// One upward walk, where four copies of it stood on 2026-09-02: two in be-01
// (`canDepend`'s `isWithin` and `moveWorkItem`'s `descendsFrom`, byte-identical
// under two names) and two in fe-01. It answers a question about a plan's
// shape and reads nothing else, like everything else in here.
export * from './is-within';
export * from './label-mismatch';
// The floor and deadline folds, published rather than left inside `schedule()`
// because the solver request builder must carry the very same numbers on the
// wire. The floor half was already wrong once for a month (2026-08-10).
export * from './leaf-constraints';
// A calendar marker's automatic colour, the eight-entry palette it draws from,
// and the twenty backdrops the 3:1 bar is measured against. Pure arithmetic
// over hex strings — the fills it measures live in fe-01's theme, and this
// module reads none of them at run time.
export * from './marker-color';
// The marker name cap, counted in code points so an emoji costs one. Its own
// module rather than a member of the colour one: the composer imports both and
// they share nothing but the object they describe.
export * from './marker-name';
export * from './not-before';
export * from './place-sibling';
export * from './priority-band';
// The dense rank the solver objective multiplies. Separate from
// `priority-band` because a band is what a priority is CALLED and this is what
// it is WORTH relative to the others in one plan.
export * from './priority-weight';
export * from './progress';
// The value a Saved plan's input body is, and the pure fold that produces it.
// Types and one pure function: the reads it is folded from live in be-01, and
// the hash is taken over this module's serialization.
export * from './saved-plan';
// Moved out of `apps/be-01/src/service/` on 2026-09-02, once its last storage
// type was gone. 2,212 lines of pure planning that read five fields of a row
// and answer a question about a plan's shape — which is what everything else in
// here is. It reads four of its neighbours and no repository.
export * from './schedule';
// The exact-input hash and the string it is taken over (tasks.md 1.1, 1.2) are
// NOT here, and this comment is the enforcement note rather than a description.
// `canonical-schedule-input.ts` imports `node:crypto`; this barrel is reachable
// from `apps/fe-01`, so a root re-export would put a Node builtin one
// `export *` away from a browser bundle. Run 42 exported it here anyway, when
// the plan read became the first caller outside this library, and Sol's M1 on
// PR 203 caught the contradiction: the module's own docstring said it was
// deliberately absent from the barrel while this line exported it.
// Both halves of that finding are closed the same way. The single-canonicaliser
// rule run 42 was protecting is real — a second canonicalisation written
// app-side is the copy that orders an argument differently and serves another
// plan's schedule — so the module still has exactly one implementation, and
// backend callers reach it by the explicit Node subpath
// `@wbs/domain/canonical-schedule-input` (tsconfig.base.json). One import, one
// canonicaliser, and no browser-reachable path to `node:crypto`.
// The real-domain scorer (tasks.md 4.11b, 4.12b), beside `schedule` because it
// reads nothing but a `Schedule` and exists so the publication guard's two
// sides are summed over the same slices in the same order.
export * from './score-real';
// The publication guard the scorer above exists for (tasks.md 4.11b). Here
// because step (a) is a `schedule()` call over the run's own canonical input:
// computing the Baseline anywhere else would mean a caller could satisfy the
// type while comparing against another plan's answer.
export * from './publication-guard';
// The cache payload's own seam (tasks.md 4.12), beside `schedule` because it is
// the inverse of what `schedule()` returns and nothing else may encode one: a
// `Map` renders as `{}` under `JSON.stringify`, so a second implementation would
// store a plan that reloads empty and type-checks all the way down.
export * from './schedule-cache-dto';
// The slice graph's edges — the intra-item step chain and the reach-decided
// join — beside the reach that decides one half of it. Here rather than in
// `schedule.ts` because the solver request builder must derive the same graph,
// and a second copy is the copy that gets the join backwards.
export * from './slice-edges';
// The grouping both `schedule()` and the solver request builder start from.
// One grouping, because an edge names its ends by leaf and POSITION and two
// groupings would disagree about which slice a position is.
export * from './slice-groups';
// The one place the solver's integer time axis is defined, and the only
// quantisation of `durationOf` anywhere. It lives here rather than in
// `schedule.ts` because the quantum is a fact about CP-SAT and not about the
// calendar: 2,212 lines of placement have no business knowing the wire's unit.
export * from './solver-quantum';
export * from './workday';
