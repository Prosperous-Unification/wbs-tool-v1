/**
 * The four closed sets a stored row is validated against, and the types they
 * name.
 *
 * They lived in `schema.ts` beside the columns that hold them, which is where
 * they were written and not where they belong: a person's **kind**, a measure's
 * **unit**, which **engine** planned a project and which **objective** it was
 * planned for are facts about the domain, and the `CHECK` constraint that
 * enforces one is the adapter's way of storing a fact it did not invent.
 *
 * Moving them is what lets the store ports live in the application ring at all
 * (`docs/2026-09-05-ports-and-adapters-plan.md` §2): a port that named these
 * would have had to import the drizzle schema to say what a person is.
 *
 * The membership is what matters and the order is what does not: each list is
 * the one a migration's `CHECK (… IN (…))` enumerates, and a value in one and
 * not the other is a row the database accepts and the read refuses, or the
 * reverse. `schema.ts` re-exports all four, so the columns and the vocabulary
 * cannot drift apart by being imported from two places.
 */

/**
 * The two engines {@link project.scheduleEngine} may name (tasks.md 3b.8).
 *
 * Declared here rather than beside {@link SOLVER_OBJECTIVES} because it is a
 * project vocabulary and not an optimizer-table one: no row in the four
 * optimizer tables stores an engine. The objective deliberately has no twin —
 * `project.schedule_objective` stores the same `'pri' | 'time'`
 * {@link SOLVER_OBJECTIVES} already names, so it is a fourth validated column
 * rather than a second vocabulary, and {@link isSolverObjective} reads it.
 *
 * The order matters to nothing and the membership matters to everything: it is
 * the list the migration's `CHECK (schedule_engine IN ('fast','optimized'))`
 * enumerates, and a value in one and not the other is a row the database
 * accepts and the read refuses, or the reverse.
 */
export const SCHEDULE_ENGINES = ['fast', 'optimized'] as const;
export type ScheduleEngine = (typeof SCHEDULE_ENGINES)[number];

/**
 * The closed set of units a {@link stepMeasure} can be in.
 *
 * Exported because every read and write path takes one of these as a parameter
 * rather than defaulting it — the cost of a discriminated table, paid on
 * purpose. `openspec/changes/token-tracking/design.md` D1.
 */
export const MEASURE_METRICS = ['token_estimate', 'token_actual', 'hours_actual'] as const;

export type MeasureMetric = (typeof MEASURE_METRICS)[number];

/**
 * The closed set of things a {@link person} row can be.
 *
 * Exported for the same reason {@link MEASURE_METRICS} is: the directory route
 * and the card take one of these as a value rather than a boolean, so the day a
 * third kind arrives it is a value added here and not a schema change.
 * `openspec/changes/token-tracking/design.md` D6.
 */
export const PERSON_KINDS = ['person', 'agent'] as const;

export type PersonKind = (typeof PERSON_KINDS)[number];

/**
 * `#/$defs/request.properties.objective` — the two independently solved runs,
 * and a key column of three of the four tables below.
 */
export const SOLVER_OBJECTIVES = ['pri', 'time'] as const;

export type SolverObjectiveName = (typeof SOLVER_OBJECTIVES)[number];

/** Every modeled failure stored for an optimization attempt. */
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
