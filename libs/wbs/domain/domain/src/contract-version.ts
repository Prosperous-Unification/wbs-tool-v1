/**
 * The version of **Fast's own semantics** — everything a cached optimized
 * result silently assumes about how this engine turns a plan into dates.
 *
 * It is not the solver's version and not the wire's. `contractVersion` on the
 * wire is `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"`, and both halves are
 * needed because the Python package version describes none of this: durations,
 * the leaf expansion and `baselineOffsets` are produced by Bun and by this
 * library. A cache keyed on the solver alone would serve a row computed by a
 * different function.
 *
 * **Bump it for any change to:** Fast semantics, {@link ASSUMED_SLICE_WORKDAYS},
 * `snapWorkdays`, dependency reach, numbering semantics, resource tie-breaks,
 * the canonicalizer, {@link SOLVER_QUANTUM}, or the duration rule. The bump is
 * what evicts every pre-existing cached result; there is no migration of stored
 * schedules, because a stale row is not a row in an old shape — it is an answer
 * to a question nobody asked any more.
 *
 * **`8` because two independently developed fixes land together over version
 * `7`.** The deadline publication guard now includes deadlines in its Fast
 * baseline; the old guard could store a differently ordered baseline with
 * missing lateness under the same input hash the corrected guard reads. The
 * drift window also moved, and the bump is the only thing that evicts for that
 * change: `quantise` now snaps the `DRIFT` window in workday space **before**
 * multiplying by {@link SOLVER_QUANTUM} rather than only after. These are the
 * deadline, `snapWorkdays` and {@link SOLVER_QUANTUM} entries of the list above
 * and need no new rule or second version step while they first ship together.
 *
 * **The class that actually moves is narrower than `DRIFT` and saying otherwise
 * overstates it.** The old post-multiplication snap already cleaned a unit-space
 * offset below `DRIFT`, which is a *workday*-space offset below
 * `DRIFT / SOLVER_QUANTUM`. So the durations that report one unit less than they
 * used to are the ones in `(W + DRIFT/48, W + DRIFT)` — above a whole workday
 * only, because below one `ceil` already agreed. `1.0000000005` sits inside that
 * band, which is why it is the example.
 *
 * The usual reason a stale row stops being served is that its `inputHash`
 * changed. **That does not happen here.** `canonical-schedule-input.ts` hashes
 * `slices[].days` and `slices[].width`; `durationUnits` is derived downstream
 * and is not one of the hashed canonical entries. An input inside the band
 * therefore keeps its exact hash across this change, a `plan-infeasible` row
 * cached under the old rounding stays addressable, and `Retry` refuses to
 * re-solve a `plan-infeasible` hit. Without this bump that row is a sticky
 * "Plan infeasible" no user action clears, for a plan that now meets its
 * deadline. The version is the whole of the eviction rather than a second net
 * behind the hash.
 *
 * **The band is reachable, measured rather than argued.** Whole `days` cannot
 * land in it — every whole `days` 0…5000 over every legal `width` 1…1000 is
 * 5,001,000 ratios with zero hits inside the *wider* `(W, W + DRIFT)`, and so
 * none inside the band either; the nearest non-zero distance to a whole number
 * is `1e-3`, a million times `DRIFT`. But `roundDays` returns the combined
 * figure untouched under `ESTIMATE_ROUNDINGS`' `'exact'`, so a project on that
 * rounding puts an arbitrary double in: `days: 1.0000000005` over `width: 1`
 * gave `durationUnits` `49` before this change and `48` after.
 *
 * The number is also not free at this point: both request fixtures in the
 * golden corpus are checked in carrying `"8+0.1.1"`, and
 * `wire-contract-version.test.ts` in `libs/contracts` pins the constant to that
 * prefix — so a change here without a change there is a red test rather than a
 * cache that quietly keeps its old rows.
 *
 * The corpus re-key that makes an *unbumped* domain change fail is task 1.6 and
 * is not this constant's own guard: nothing here can notice that
 * `ASSUMED_SLICE_WORKDAYS` moved. Stated so the next reader does not mistake the
 * fixture pin above for that proof.
 *
 * **Since TASK-338 the number below is not only a human obligation.** CI's
 * `Corpus version lint` step reads both golden fixtures at the change's base
 * revision and at its head, and refuses a change whose stored `cases` moved
 * while this constant did not INCREASE
 * (`tools/tool-git-hooks/src/hooks/corpus-version-lint.ts`). What that buys and
 * what it does not, stated exactly, because the last version of this paragraph
 * was overstated and TASK-323 had to narrow it in place:
 *
 * - It covers the events the workflow subscribes to, and only those:
 *   `pull_request`, `push` to `main`, `merge_group` and `workflow_dispatch`. The
 *   boundary is chosen per event rather than inferred, so a multi-commit push is
 *   compared against what `main` held before it and not against its own
 *   penultimate commit, and a queued merge is compared against
 *   `merge_group.base_sha` — the target tip plus the entries ahead of it —
 *   rather than against `main`, which would re-attribute an earlier entry's
 *   fixture edits to this change. `merge_group` was the gap this paragraph used
 *   to name; TASK-351 closed it. The subscription is preparatory and honest
 *   about being so: measured 2026-09-08 this repository has no rulesets and no
 *   protection on `main`, so no queue can form and the trigger fires never. It
 *   is here so that enabling one later cannot silently drop the check.
 * - It does NOT prove the bump was made *because* of the semantic change. A
 *   version increase in the same change for an unrelated reason satisfies it.
 *   That is not a cache-safety hole — the corpus lands under a new version and
 *   the old rows are evicted either way — but the mechanism proves the two
 *   moved together, and nothing about the author's reason.
 * - It says nothing about the entries below that move neither eight plans nor
 *   six slices. There is no fixture for those, so there is nothing for a
 *   two-commit comparison to compare, and the next paragraph's last sentence
 *   still stands.
 * - There is no branch protection on this repository, so on a direct push to
 *   `main` the step reports after the commit has landed. It is preventive by
 *   merge discipline on pull requests and detective on direct pushes.
 *
 * **Two corpora enforce this list, and neither enforces all of it.**
 * `fast-golden-corpus.ts` is a VALUE guard over eight named plans as
 * `schedule()` renders them, and its cases are aimed one apiece at the entries
 * plan output depends on — {@link ASSUMED_SLICE_WORKDAYS}, `snapWorkdays`,
 * dependency reach, numbering, resource tie-breaks; each case's own comment
 * names which. Only the first of those has a watched red behind it, so read the
 * rest as aim rather than as proof. What IS measured is the other half: it is
 * **blind to {@link SOLVER_QUANTUM}**, because `schedule.ts` does not import
 * `solver-quantum` and no case there executes `quantise` — this bump's own
 * change left that corpus green.
 * `solver-quantum-golden-corpus.ts` covers the entry it cannot, over six named
 * slices as `durationUnits` renders them, and `1.0000000005` above is its first
 * case for the reason this comment already gives. Everything on the list that
 * moves neither eight plans nor six slices is still a human obligation, which
 * is what this paragraph exists to say out loud. What the two of them now buy
 * together with the lint above: a change that moves eight plans or six slices
 * cannot reach `main` **through a reviewed pull request** under an unchanged
 * version number — the suite reddens until the writer is run, and the lint
 * reddens until the number moves. On a direct push the lint reports after the
 * commit has landed, which is detection and not prevention.
 */
export const SCHEDULER_CONTRACT_VERSION = 9;

/**
 * The composite the **wire** carries and the **cache key** stores, from one
 * place.
 *
 * `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"` is written twice in the
 * pipeline today and the two writes are separated by a whole library boundary:
 * `build-solver-request.ts` composes it for the request, and
 * `publishedScheduleReaderOf` receives it as a caller-supplied string from a
 * composition root that does not exist yet (slice 6). If those two strings ever
 * differ by a character, every read of the cache misses forever, no row is ever
 * served, nothing throws, and no test fails — the plan simply never gets a
 * cached answer and looks slow rather than broken.
 *
 * So this is the one composer, and the composition root has one function to
 * call rather than a template literal to retype. Task 1.5's remaining clause —
 * "built where the cache key is built" — is what it exists for.
 *
 * The scheduler half moves when Bun changes either a published Fast schedule
 * or its independent solver re-validation; the solver half moves when the
 * Python package or the request facts it consumes change. TASK-508 changes
 * both halves, so durable rows written under `8+0.1.2` cannot be reused.
 *
 * `solverVersion` is the Python package's own version and this library never
 * invents one: it arrives from the spawn that is about to run, because the
 * string has to name the solver that actually produced the answer.
 */
export function contractVersionOf(solverVersion: string): string {
  return `${String(SCHEDULER_CONTRACT_VERSION)}+${solverVersion}`;
}
