import {
  CANONICAL_PLAN_INPUT_SCHEMA_VERSION,
  type CanonicalPlanInput,
} from './canonical-plan-input';

/**
 * A stored plan-input body this reader cannot bring forward.
 *
 * Three distinguishable causes, because they call for different answers and a
 * single "unsupported version" would hide which one happened:
 *
 * - `from-the-future` — the body was written by a newer build. Nothing here can
 *   invent the down-conversion; design.md says a schema that *removes* a field
 *   needs a rule written at that change, not guessed at now.
 * - `no-upgrade-path` — the version is older than this reader's and no step is
 *   registered for it. That is an incomplete {@link PLAN_INPUT_UPGRADES} table,
 *   which must fail loudly rather than pass an old shape through as if it were
 *   current: silently accepting it is how a removed field comes to read as
 *   `undefined` and compare as a change nobody made.
 * - `not-a-version` — the header's number is not a positive integer at all.
 */
export type PlanInputNormaliseFailure = 'from-the-future' | 'no-upgrade-path' | 'not-a-version';

export class PlanInputVersionError extends Error {
  constructor(
    readonly reason: PlanInputNormaliseFailure,
    readonly storedVersion: number,
    readonly readerVersion: number = CANONICAL_PLAN_INPUT_SCHEMA_VERSION,
  ) {
    super(
      `plan input body at schema version ${String(storedVersion)} cannot be normalised ` +
        `to ${String(readerVersion)}: ${reason}`,
    );
    this.name = 'PlanInputVersionError';
  }
}

/**
 * One step forward: version *n* to version *n+1*, over the parsed body.
 *
 * A step receives a value it may not modify and returns a new one. The
 * non-mutation rule is what keeps normalisation compatible with the
 * immutability requirement seen from the reader: the stored bytes are never
 * rewritten, and a step that edited its argument would let a caller who parsed
 * once and stored later write a body it never read.
 */
export type PlanInputUpgrade = (body: Record<string, unknown>) => Record<string, unknown>;

/**
 * The upgrade table, keyed by the version each step reads.
 *
 * **Empty today, and that is a statement rather than an omission:** version 1 is
 * the only version that has ever existed, so there is no *n* to *n+1* step to
 * write. When `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` moves to 2, a step keyed `1`
 * lands with it — and until it does, a version-1 body against a version-2 reader
 * fails `no-upgrade-path` loudly instead of arriving half-converted.
 */
export const PLAN_INPUT_UPGRADES: ReadonlyMap<number, PlanInputUpgrade> = new Map();

/**
 * Bring a stored plan-input body forward to the version this build reads.
 *
 * **Forward only, in memory, and the stored bytes are never touched** (task
 * 7.4). The argument is the *parsed* body and the return is a new value; this
 * function has no access to the bytes and no way to write them, which is the
 * structural half of the guarantee. The other half is that no step may modify
 * its argument, asserted directly.
 *
 * At the reader's own version this is the identity — the same value back, not a
 * copy, because a copy would quietly hide a step that had mutated it.
 */
export function normalisePlanInputForward(
  body: unknown,
  storedVersion: number,
  readerVersion: number = CANONICAL_PLAN_INPUT_SCHEMA_VERSION,
  upgrades: ReadonlyMap<number, PlanInputUpgrade> = PLAN_INPUT_UPGRADES,
): CanonicalPlanInput {
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new PlanInputVersionError('not-a-version', storedVersion, readerVersion);
  }
  if (storedVersion > readerVersion) {
    throw new PlanInputVersionError('from-the-future', storedVersion, readerVersion);
  }
  let current = body;
  for (let version = storedVersion; version < readerVersion; version += 1) {
    const step = upgrades.get(version);
    if (step === undefined) {
      throw new PlanInputVersionError('no-upgrade-path', storedVersion, readerVersion);
    }
    current = step(current as Record<string, unknown>);
  }
  return current as CanonicalPlanInput;
}
