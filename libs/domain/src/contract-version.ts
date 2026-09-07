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
 * **`8` because the drift window moved, and here the bump is the *only* thing
 * that evicts.** `7` was the deadline slice, where the seventh canonical
 * scheduling argument, the `deadlineUnits` wire field and the materialiser all
 * changed together. `8` is a far narrower change and is for that reason more
 * dangerous to skip: `quantise` now snaps the `DRIFT` window in workday space
 * **before** multiplying by {@link SOLVER_QUANTUM} rather than only after.
 * That is the `snapWorkdays` and {@link SOLVER_QUANTUM} entries of the list
 * above and needs no new rule.
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
 * golden corpus are checked in carrying `"8+0.1.0"`, and
 * `wire-contract-version.test.ts` in `libs/contracts` pins the constant to that
 * prefix — so a change here without a change there is a red test rather than a
 * cache that quietly keeps its old rows.
 *
 * The corpus re-key that makes an *unbumped* domain change fail is task 1.6 and
 * is not this constant's own guard: nothing here can notice that
 * `ASSUMED_SLICE_WORKDAYS` moved. Stated so the next reader does not mistake the
 * fixture pin above for that proof.
 */
export const SCHEDULER_CONTRACT_VERSION = 8;

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
 * `solverVersion` is the Python package's own version and this library never
 * invents one: it arrives from the spawn that is about to run, because the
 * string has to name the solver that actually produced the answer.
 */
export function contractVersionOf(solverVersion: string): string {
  return `${String(SCHEDULER_CONTRACT_VERSION)}+${solverVersion}`;
}
