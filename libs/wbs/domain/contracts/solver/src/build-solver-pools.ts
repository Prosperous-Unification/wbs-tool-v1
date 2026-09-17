import type { SolverSlice } from './wire-types';

/**
 * The wire's `pools` map: how many slots each pool named by the request holds.
 *
 * The canonical `PoolSizes` is a `ReadonlyMap<string, number>` and the wire
 * carries an object, so this is a shape conversion with one real rule attached.
 *
 * **Only the pools the request actually names are emitted.** A project may
 * carry sizes for teams no slice in this plan is labelled with; sending them
 * would put entries on the wire that constrain nothing, change the request
 * bytes on an edit nobody made to this plan, and — because the request is
 * hashed as a cache key — invalidate a cached result for a team the plan does
 * not use. Absent means unstated, exactly as it does in `slotsOf`.
 */

/**
 * Every pool id any slice in the request names, once.
 *
 * Separated from {@link buildSolverPools} because the request builder needs the
 * same set for its own key-set checks and computing it twice invites the two
 * copies to disagree about, for instance, whether `poolIds` was deduplicated.
 */
export function poolIdsNamedBy(slices: readonly SolverSlice[]): Set<string> {
  const named = new Set<string>();
  for (const slice of slices) for (const poolId of slice.poolIds) named.add(poolId);
  return named;
}

/**
 * The `pools` object for a request, or a throw naming the missing size.
 *
 * **Invariant (4) of the schema's own cross-field list, enforced here because
 * JSON Schema cannot state it:** every pool id named by any slice has an entry.
 * This is `schedule.ts`'s `no size for pool ${poolId}` throw promoted to the
 * wire, and it fails **pre-spawn** for the reason that throw exists — a default
 * would be a capacity constraint silently not applied, and the solver would
 * then place the slice unconstrained and hand back a plan that overlaps the
 * pool the moment it was materialised. The re-validator would reject the
 * solver's own answer, and the fault would be read as the solver's.
 *
 * A pool with a **size below 1** is refused for the same reason rather than
 * clamped: `project_team_capacity.size` is `integer().notNull()` with the floor
 * enforced at be-01's boundary, so a zero here means two readings came apart,
 * and a pool of 0 slots is a plan of `Infinity` dates. Clamping it to 1 would
 * invent a slot nobody has.
 */
export function buildSolverPools(
  slices: readonly SolverSlice[],
  sizes: ReadonlyMap<string, number>,
): Record<string, number> {
  const pools: Record<string, number> = {};
  for (const poolId of [...poolIdsNamedBy(slices)].sort()) {
    const size = sizes.get(poolId);
    if (size === undefined) {
      throw new Error(`no size for pool ${poolId}`);
    }
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(
        `pool ${poolId} has a size that is not a whole number of slots: ${String(size)}`,
      );
    }
    pools[poolId] = size;
  }
  return pools;
}
