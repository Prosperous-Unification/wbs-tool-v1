/**
 * The most people a plan may claim are at work on one thing at once — the
 * ceiling on both a work item's parallelism and a project's capacity for a team.
 *
 * A product limit, honest about being one: above a thousand people on one work
 * item, or a thousand of one team on one plan, the number is not a plan. It is
 * emphatically **not** justified by floating-point — plan v1 argued from a
 * minimum effort of a sixth of a day, and `ThreePointEstimate` has no minimum at
 * all.
 *
 * It lives in `libs/domain` because **three** boundaries now state it — a work
 * item's parallelism, a team's size (until `capacity-per-project` removed that
 * route), and a project's capacity for a team — and fe-01 reads the number back
 * out of be-01's own refusal code rather than holding a fourth copy. Two copies
 * agreed by luck; the third is where they would have drifted, and a refusal
 * saying `at most 1000` beside a route that takes 500 is a refusal nobody can
 * act on.
 *
 * The floor is not here, and deliberately: it is `1` at every one of those
 * boundaries, but it is a **correctness** bound rather than a product one — a
 * slice's duration is its effort divided by its width, so a stored 0 is a plan of
 * `Infinity` dates. Each boundary states it beside the argument for why, because
 * a lone `1` imported from a constants file is a number nobody can defend.
 */
export const MOST_PEOPLE_AT_ONCE = 1000;
