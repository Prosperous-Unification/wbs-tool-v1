/**
 * How far into a predecessor a dependency reaches — the project's answer to
 * "which of the predecessor's slices must finish before the successor starts".
 *
 * `whole-item` is the rule the tool shipped with and returned to on 2026-08-29:
 * a successor waits for the predecessor's **last** slice in step order, so a
 * dependency means the work item is finished. `anchor-slice` is
 * `dep-waits-on-first-role`'s rule (2026-08-11): the successor waits for the
 * predecessor's first estimated slice and the steps behind it run alongside it,
 * which is one team's hand-off convention rather than a fact about dependency.
 *
 * A two-member enum rather than a boolean, so the per-edge model the proposal
 * defers can add a third answer without every call site becoming a negation.
 * See `docs/adr/0010-a-dependencys-reach-is-a-projects-choice.md`.
 */
export const DEPENDENCY_REACHES = ['whole-item', 'anchor-slice'] as const;
export type DependencyReach = (typeof DEPENDENCY_REACHES)[number];

/**
 * Whether `value` is one of the two reaches — the boundary check for stored and
 * posted data.
 *
 * `dep_reach` is text and SQLite will hold `first-role` as happily as
 * `whole-item`, so every read of a stored reach passes through this and throws
 * on a miss rather than falling back. A plan scheduled by a rule nobody chose
 * is a wrong answer delivered confidently.
 */
export function isDependencyReach(value: unknown): value is DependencyReach {
  return typeof value === 'string' && (DEPENDENCY_REACHES as readonly string[]).includes(value);
}
