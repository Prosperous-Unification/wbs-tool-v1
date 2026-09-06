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
 */
export function statusForRefusal(reason: string, otherwise: number): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'unknown_ref') return 400;
  if (reason === 'not_found' || reason.startsWith('unknown_')) return 404;
  if (CONFLICTS.has(reason)) return 409;
  return otherwise;
}
