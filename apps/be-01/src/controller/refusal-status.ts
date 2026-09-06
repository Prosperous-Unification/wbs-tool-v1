/**
 * The refusals that are **states of the plan** rather than faults in the
 * request, and are therefore 409.
 *
 * Every one of them would have worked a moment earlier and may work again: a
 * loop that a row has since been moved out of, a number that is frozen until
 * somebody unfreezes it, a name another team took. That is the whole of what
 * separates them from the 400s — a malformed request is wrong however long you
 * wait.
 */
const CONFLICTS = new Set([
  'cycle',
  'frozen',
  'rolled_up',
  'ancestor',
  'too_large',
  'taken',
  'in_use',
  // Switching a project on to an optimizer this deployment has not got. It is
  // the family's own definition rather than a stretch of it: the request is
  // well formed, nothing about it is wrong, and the same body is accepted the
  // moment a release wires the optimized reader in. A 422 would tell a settings
  // panel to correct a request that has nothing to correct.
  'optimizer_unavailable',
]);

/**
 * The refusals that are **422 whatever the route's own default is**: the
 * request parses, names rows that exist and asks for something this plan cannot
 * mean.
 *
 * Its own arm rather than a route default because the batch route's default is
 * 400 and every one of these arrives through it. A 400 would tell a client the
 * body was malformed, and a caller that fixed the syntax would send the same
 * request again; 422 says the syntax was fine and the value is the problem.
 *
 * `deadline_before_project_start` is the first: a deadline falling before the
 * project's day zero, so no placement of the work could meet it. It is what
 * `work-item-deadline` 6.1 names as the only deadline-specific rejection, and it
 * is decided in `WorkItemService.patch` rather than at the controller, which
 * holds the payload but not the project. It is not a {@link CONFLICTS} member — nothing about it is a state
 * that may pass on its own, and the same body sent an hour later is refused
 * identically unless somebody moves the project.
 */
const UNPROCESSABLE = new Set(['deadline_before_project_start']);

/**
 * The status a refusal code is answered with, given what **this** route says
 * for a code no shared arm claims.
 *
 * Four arms are shared by every route that refuses anything, and were written
 * out five times: as a ladder of `if`s in `statusForBatch`, as a three-deep
 * ternary in `step.routes.ts`, as another in `project.routes.ts`'s
 * PATCH, and twice inline. What each route does **not** share is its default,
 * which is why that is the argument: a malformed step body is 422, a batch with
 * a step nothing can parse is 400, an undo of an empty stack is 409, and a
 * patch of an absent project is 404.
 *
 * - `forbidden` is 403 rather than 404 for a restricted project: the caller may
 *   read it, so pretending it is absent would contradict the next GET.
 * - `unknown_ref` is 400 and not 404, and it is the one exception in the
 *   family: a `ref` naming nothing is a mistake **inside the batch the caller
 *   wrote**, not a row that has gone.
 * - `not_found` and every other `unknown_*` are 404 — they name a row, a step,
 *   a team or a person that is not there.
 * - {@link CONFLICTS} are 409.
 * - {@link UNPROCESSABLE} are 422, over any route default.
 */
export function statusForRefusal(reason: string, otherwise: number): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'unknown_ref') return 400;
  if (reason === 'not_found' || reason.startsWith('unknown_')) return 404;
  if (CONFLICTS.has(reason)) return 409;
  if (UNPROCESSABLE.has(reason)) return 422;
  return otherwise;
}
