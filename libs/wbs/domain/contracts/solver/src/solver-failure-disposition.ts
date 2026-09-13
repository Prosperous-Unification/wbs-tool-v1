/**
 * The seam between a *diagnosis* and a *disposition*.
 *
 * Three modules in this directory refuse things and each publishes its own
 * failure vocabulary: `parseSolverResponse` (four framing codes),
 * `revalidateSolverResult` (eleven placement/objective codes) and
 * `solverPreflight` (two pre-spawn codes). Every one of those lists documents
 * itself as "diagnosis, not disposition" — and until this module existed the
 * disposition itself lived only in those doc comments, so the coordinator that
 * has to write `failureReason` into the `optimized_schedule_cache` row had
 * fifteen tokens and a prose rule to re-derive.
 *
 * `failureReason` is a CHECK-constrained column
 * (`openspec/changes/dual-optimized-scheduler/design.md`, cache identity), so
 * getting the mapping wrong is not cosmetic: it is an insert the database
 * rejects, or worse, a plausible token that sends the repair to the wrong
 * engineer.
 *
 * The trap this module exists to close: `objective-overflow` is a member of
 * BOTH `SOLVER_PREFLIGHT_FAILURES` and `SOLVER_REVALIDATION_FAILURES`, and the
 * two mean opposite things. Before the spawn it is the coordinator's reason
 * verbatim — nothing ran, the request cannot be carried by the wire's integers,
 * and `objective-overflow` is exactly what the row records. After the spawn it
 * is a diagnosis of a response that came back wrong, and the row records
 * `invalid-output`. A mapping written by matching the token to the column's
 * vocabulary — which the token does match — is wrong in one of the two
 * directions and looks right in both.
 *
 * Each seam maps through a `Record` over its own failure union rather than a
 * conditional, so a code added to any of the three lists is a type error here
 * until somebody decides what it means. A conditional would have defaulted it
 * silently, which is how a token reaches the column with nobody having chosen
 * it.
 */

import { SOLVER_PARSE_FAILURES, type SolverParseFailure } from './parse-solver-response';
import {
  SOLVER_REVALIDATION_FAILURES,
  type SolverRevalidationFailure,
} from './revalidate-solver-result';
import { SOLVER_PREFLIGHT_FAILURES, type SolverPreflightFailure } from './solver-preflight';

/**
 * The coordinator's `failureReason` vocabulary, verbatim from the CHECK
 * constraint in `design.md` and the requirement in
 * `specs/scheduler-optimization/spec.md`. This is the whole of what a
 * `status='failed'` cache row may carry; nothing in this directory may widen
 * it, because the database refuses anything else.
 *
 * Four members are produced elsewhere and never by this directory's seams:
 * `timeout`, `no-solution` and `oom` are properties of a run (the budget
 * expired, stage 1 ended UNKNOWN with no incumbent, the memory scope recorded
 * an OOM kill), and `internal-error` is the fault of everything that is not a
 * solver answer — including our own request builder, below.
 */
export const SOLVER_FAILURE_REASONS = [
  'timeout',
  'invalid-output',
  'no-solution',
  'internal-error',
  'oom',
  'horizon-overflow',
  'objective-overflow',
] as const;
export type SolverFailureReason = (typeof SOLVER_FAILURE_REASONS)[number];

/**
 * Framing. Every one of the four is `invalid-output`: the process ran and what
 * came back was not one well-formed response line, which is the definition of
 * output that cannot be used.
 */
const PARSE_DISPOSITIONS: Readonly<Record<SolverParseFailure, SolverFailureReason>> = {
  'empty-output': 'invalid-output',
  'not-one-line': 'invalid-output',
  'malformed-json': 'invalid-output',
  'schema-violation': 'invalid-output',
};

/**
 * Pre-spawn. Both codes are the coordinator's reason verbatim — the spec calls
 * them "the two pre-spawn reasons" and requires the row and the failure event
 * to be written exactly as a spawned failure's are, although no process ever
 * started. `solver-preflight.ts`'s own header says the same thing from the
 * other side: "the failure token is the thing the cached row records".
 *
 * The identity here is a coincidence of vocabulary, not a rule that tokens pass
 * through. Read `REVALIDATION_DISPOSITIONS` before assuming it generalises.
 */
const PREFLIGHT_DISPOSITIONS: Readonly<Record<SolverPreflightFailure, SolverFailureReason>> = {
  'horizon-overflow': 'horizon-overflow',
  'objective-overflow': 'objective-overflow',
};

/**
 * Post-spawn. Ten of the eleven are `invalid-output`: the solver returned a
 * schedule that breaks a constraint it was given, or objective numbers that
 * disagree with its own offsets. `revalidate-solver-result.ts`'s header states
 * the rule — never `plan-infeasible`, because a solver that returns `feasible`
 * and breaks a constraint is a broken engine rather than an infeasible plan.
 *
 * `malformed-request` is the exception and is not a statement about the solver
 * at all. It fires on a request that cannot support a verdict — a duplicate
 * slice key, an edge naming no slice, a pool membership with no capacity, a
 * slice with no baseline offset — and every one of those is produced by
 * `buildSolverRequest`, which is ours. So the disposition is `internal-error`:
 * blaming the response would send the repair to the wrong side of the seam,
 * which is the whole reason the code was split out.
 *
 * ASSUMPTION 1 (run 11). The spec's `failureReason` vocabulary was written for
 * run outcomes and never names our own request builder, so no requirement text
 * picks between `internal-error` and `invalid-output` for this code.
 * `internal-error` is chosen because the fault is on our side of the seam and
 * the design already uses that reason for "not a solver answer" — an image
 * built without the package fails the spawn `internal-error`
 * (`specs/scheduler-optimization/spec.md`, packaging scenario). FALSIFIED BY: a
 * coordinator requirement in section 6/7 naming a different reason for an
 * unjudgeable request, or by `malformed-request` becoming reachable from a
 * solver-authored artefact rather than only from `buildSolverRequest`.
 */
const REVALIDATION_DISPOSITIONS: Readonly<Record<SolverRevalidationFailure, SolverFailureReason>> =
  {
    'malformed-request': 'internal-error',
    'offset-key-mismatch': 'invalid-output',
    'offset-domain': 'invalid-output',
    'edge-violated': 'invalid-output',
    'floor-violated': 'invalid-output',
    'pool-overcapacity': 'invalid-output',
    'assignee-double-booked': 'invalid-output',
    'objective-domain': 'invalid-output',
    'objective-overflow': 'invalid-output',
    'objective-regression': 'invalid-output',
    'objective-mismatch': 'invalid-output',
    'deadline-violated': 'invalid-output',
  };

/**
 * The solver process's own exit codes, verbatim from `libs/solver-py/src/
 * wbs_solver/cli.py`'s EXIT CODES block. Named here because the coordinator has
 * to turn one into a `failureReason` and a bare `70` at that call site is a
 * number nobody can check against the entrypoint that produced it.
 */
export const SOLVER_EXIT_CODES = {
  /** A response was written to stdout. Not a failure and never dispositioned. */
  ok: 0,
  /** The request was refused before solving: framing, encoding, shape. */
  badRequest: 64,
  /** A later-stage `INFEASIBLE`. Nothing on stdout, by contract. */
  solveFailed: 70,
  /**
   * CP-SAT refused the model, or answered a status the stage matrix has no row
   * for. Also nothing on stdout, and a different fault (TASK-310).
   */
  modelInvalid: 71,
} as const;

/**
 * Post-run, from the exit code alone. This is the fourth seam, and the only one
 * whose input is a number rather than a token, which is why it is not a member
 * of `SOLVER_FAILURE_DISPOSITIONS` below — that array is keyed by diagnosis
 * tokens and an exit code is not one.
 *
 * `solveFailed` is `invalid-output`, and that mapping is a requirement rather
 * than a preference. A **later-stage** `INFEASIBLE` is the one solver outcome
 * with no encoding on the wire (`solver-wire.v1.json`, the response
 * `$comment`), so the entrypoint "SHALL exit non-zero without emitting a
 * response, and the coordinator SHALL record that run as `invalid-output`"
 * (`openspec/changes/dual-optimized-scheduler/specs/scheduler-optimization/
 * spec.md`, the staged-lexicographic requirement; `design.md`'s `INFEASIBLE,
 * k > 1` row says the same). `70` is the code that path takes, and it is the
 * same disposition `empty-output` already earns from `PARSE_DISPOSITIONS`: the
 * process ran and what came back was not one well-formed response line.
 *
 * `badRequest` is `internal-error` and is NOT a statement about the solver. The
 * request was refused before solving, and every request is produced by
 * `buildSolverRequest`, which is ours — the same argument
 * `REVALIDATION_DISPOSITIONS` makes for `malformed-request`. Any other non-zero
 * code is a process that died without reaching either exit, which is also not a
 * solver answer.
 *
 * `modelInvalid` is `internal-error`, and TASK-310 is the decision that put it
 * on a code of its own. `70` used to carry the whole of `solve.py`'s
 * `ROW_STOP_INVALID`, which was a later-stage `INFEASIBLE` **and** a CP-SAT
 * `MODEL_INVALID` **and** any status the stage matrix does not know. The three
 * artifacts that require `invalid-output` — spec.md's staged-lexicographic
 * requirement, design.md's `INFEASIBLE, k > 1` row, and the response
 * `$comment` — all argue from the staging: a later stage's constraints are
 * satisfied by the previous incumbent, so the run answered and the answer has
 * no encoding. Not one of them mentions `MODEL_INVALID`, and `solve.py`'s own
 * comment calls it "not a matrix row … this package disagreeing with its
 * solver" — which is this module's definition of `internal-error` verbatim. So
 * nothing governed that branch; it inherited a disposition by sharing a row
 * constant. It is `internal-error` now, and the entrypoint emits `71` because
 * the exit code is the only evidence that reaches the cache row.
 *
 * ASSUMPTION (run 3). `cli.py` used to state the opposite rule — "the
 * coordinator distinguishes zero from non-zero and nothing finer: every
 * non-zero exit is `internal-error` to it" — and that docstring is amended in
 * this same commit. It was written before the response schema reserved
 * `infeasible` for a stage-1 proof; the three artifacts that name a disposition
 * for the later-stage row all name `invalid-output`, and a docstring is not one
 * of them. FALSIFIED BY: a coordinator requirement naming `internal-error` for
 * a solver that ran and answered nothing.
 */
/**
 * Keyed over the entrypoint's own codes rather than written as a chain of
 * comparisons, for the reason this module's header gives about the other three
 * seams: a conditional defaults a new code silently, and a silent default is
 * exactly how `MODEL_INVALID` spent its whole life dispositioned as
 * `invalid-output` with nobody having chosen it. `ok` is absent because it is
 * not a failure; `dispositionOfExitCode` throws on it.
 */
const EXIT_DISPOSITIONS: Readonly<
  Record<
    Exclude<(typeof SOLVER_EXIT_CODES)[keyof typeof SOLVER_EXIT_CODES], 0>,
    SolverFailureReason
  >
> = {
  [SOLVER_EXIT_CODES.badRequest]: 'internal-error',
  [SOLVER_EXIT_CODES.solveFailed]: 'invalid-output',
  [SOLVER_EXIT_CODES.modelInvalid]: 'internal-error',
};

/**
 * The same table widened to `number`, which is what a process exit actually is.
 * Indexing `EXIT_DISPOSITIONS` through a `keyof` cast would tell the compiler
 * every code is a declared one — the lookup could never be `undefined`, the
 * `??` below would be flagged unnecessary, and `137` would come back typed as a
 * `SolverFailureReason` it never had. Declaring the literal exhaustively and
 * reading it permissively keeps both halves honest.
 */
const EXIT_DISPOSITION_LOOKUP: Readonly<Partial<Record<number, SolverFailureReason>>> =
  EXIT_DISPOSITIONS;

export const dispositionOfExitCode = (code: number): SolverFailureReason => {
  if (code === SOLVER_EXIT_CODES.ok) {
    throw new Error('exit code 0 wrote a response; ask parseSolverResponse, not this seam');
  }
  // An unlisted code is a process that died without reaching any of the
  // entrypoint's exits, which is not a solver answer either.
  return EXIT_DISPOSITION_LOOKUP[code] ?? 'internal-error';
};

export const dispositionOfParseFailure = (failure: SolverParseFailure): SolverFailureReason =>
  PARSE_DISPOSITIONS[failure];

export const dispositionOfPreflightFailure = (
  failure: SolverPreflightFailure,
): SolverFailureReason => PREFLIGHT_DISPOSITIONS[failure];

export const dispositionOfRevalidationFailure = (
  failure: SolverRevalidationFailure,
): SolverFailureReason => REVALIDATION_DISPOSITIONS[failure];

/**
 * Every failure token this directory can produce, tagged with the seam that
 * produced it. Two seams share the token `objective-overflow`, so a bare token
 * does not identify a row — the pair does. Exported for the exhaustiveness
 * proof and for a coordinator that wants to enumerate the whole surface.
 */
export const SOLVER_FAILURE_DISPOSITIONS: readonly {
  readonly seam: 'parse' | 'preflight' | 'revalidation';
  readonly failure: string;
  readonly reason: SolverFailureReason;
}[] = [
  ...SOLVER_PARSE_FAILURES.map((failure) => ({
    seam: 'parse' as const,
    failure,
    reason: dispositionOfParseFailure(failure),
  })),
  ...SOLVER_PREFLIGHT_FAILURES.map((failure) => ({
    seam: 'preflight' as const,
    failure,
    reason: dispositionOfPreflightFailure(failure),
  })),
  ...SOLVER_REVALIDATION_FAILURES.map((failure) => ({
    seam: 'revalidation' as const,
    failure,
    reason: dispositionOfRevalidationFailure(failure),
  })),
];
