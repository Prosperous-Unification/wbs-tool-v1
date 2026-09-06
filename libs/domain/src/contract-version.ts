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
 * **`8` because the deadline publication baseline changed after cache writes
 * became reachable.** The pre-fix guard omitted deadlines from its Fast pass,
 * so it could store a differently ordered baseline with missing lateness under
 * the same input hash the corrected guard reads. The number is also not free at
 * this point: both request fixtures in the golden corpus carry `"8+0.1.1"`, and
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
