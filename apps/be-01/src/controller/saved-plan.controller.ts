import { Elysia, t } from 'elysia';

import { callerGuard } from '../middleware/caller';
import type { AuthService } from '../service/auth.service';
import type { ProjectService } from '../service/project.service';
import { canEdit } from '../service/project.service';
import type {
  SavedPlanService,
  SavedPlanSideRef,
  SavedPlanTouchResult,
} from '../service/saved-plan.service';
import { UnknownSavedPlanBodyVersionError } from '../service/saved-plan-integrity';

/**
 * A function rather than a constant, for `project.controller.ts`'s reason:
 * Elysia writes `additionalProperties` into the schema object it compiles, so a
 * module-level literal is shared mutable state between every app in the process.
 */
const planName = () => t.Object({ name: t.String({ minLength: 1 }) });

/**
 * The save body, where the name is **optional** — assumption A-1.
 *
 * Separate from {@link planName} rather than reusing it with `t.Optional`,
 * because rename and save disagree here and the disagreement is the point: a
 * rename with no name is a caller asking for nothing and is refused, while a
 * save with no name is A-1's normal path and gets the server's timestamp
 * ({@link SavedPlanService.save}). `minLength: 1` still applies to any name a
 * caller does send, so `""` is a 422 on both routes and never a silent default.
 */
const saveBody = () => t.Object({ name: t.Optional(t.String({ minLength: 1 })) });

/** {@link planName}'s reason, for the compare route's two query parameters. */
const compareSides = () =>
  t.Object({ left: t.String({ minLength: 1 }), right: t.String({ minLength: 1 }) });

/**
 * The literal `current`, or a saved-plan id — task 7.3b's two side pickers.
 *
 * The literal is reserved rather than looked up: a saved plan whose id happened
 * to be `current` would otherwise address the live plan, and an id space this
 * route does not control is not one to take a keyword out of by accident.
 */
function sideRef(side: string): SavedPlanSideRef {
  return side === 'current' ? { kind: 'current' } : { kind: 'saved', savedPlanId: side };
}

/**
 * The status a `SavedPlanTouchResult` other than `touched` is answered with.
 *
 * `snapshot_busy` is **503 and not 409**, and the separation is the service's
 * own (`SavedPlanSaveOutcome`): a quota refusal is a fact about the project that
 * will still be true in a second, and a held write lock is a fact about this
 * instant that a retry may find gone. Folding them into one status would offer
 * "try again" to a project at its hundredth plan, or withhold it here.
 */
function statusForTouch(outcome: Exclude<SavedPlanTouchResult['outcome'], 'touched'>): number {
  if (outcome === 'forbidden') return 403;
  if (outcome === 'not_found') return 404;
  return 503;
}

/**
 * The one error these routes catch: a stored body at a schema version this
 * build does not know. Gemini's F-02 on PR 202.
 *
 * **The finding is real and the mechanism the review named is not.**
 * `PlanInputVersionError` is unreachable from compare — `readOfStored` refuses
 * an unsupported version before anything normalises forward. What actually
 * escapes is {@link UnknownSavedPlanBodyVersionError}, thrown out of
 * `readOfStored`, caught by nobody, and answered **500** by Elysia. It reaches
 * every route that reads a stored plan, not compare alone: `GET
 * /saved-plans/:id` gets it too.
 *
 * **Answered here rather than folded into the read outcome, and 501 rather than
 * the 422 the first version of this repair proposed.** `saved-plan-integrity.ts`
 * argues the distinction and it is the whole of the fix: `corrupt` and the
 * schedule refusals are facts about *one record* — these bytes are damaged,
 * these dates belong to another project — and a route answers them about that
 * plan. An unknown body version is a fact about the **build**: every record at
 * that version is unreadable here and nothing about this one is wrong.
 * Answering `corrupt` would tell a reader their saved plan is damaged when the
 * plan is intact and the server is old, and would send an operator looking for
 * bytes that were never lost.
 *
 * 501 for the meaning HTTP already gives it — the server does not implement
 * what the request needs. Modelled, so R5's rule against unmodelled statuses
 * for anticipated database states is satisfied, and distinct from the 503 a
 * retry may clear: this one clears when the node is upgraded, not when it is
 * asked again.
 *
 * `undefined` for everything else, which is `work-item.controller.ts`'s
 * convention: an error these routes do not model must not be flattened into one
 * they do.
 *
 * A named handler and not an inline arrow, because inline it is a 30-line
 * comment inside a method chain and Prettier reparenthesises the whole builder
 * around it — 293 changed lines for a 45-line repair, and a diff nobody can
 * review is a worse gate than no diff at all.
 */
function refuseUnknownBodyVersion({
  error,
  set,
}: {
  error: unknown;
  set: { status?: number | string };
}): unknown {
  if (!(error instanceof UnknownSavedPlanBodyVersionError)) return undefined;
  set.status = 501;
  return {
    error: 'unsupported_body_version',
    savedPlanId: error.savedPlanId,
    body: error.body,
    version: error.version,
    supported: error.supported,
  };
}

/**
 * Save, list, read, rename, delete and compare, over HTTP (tasks 6.1, 7.3b).
 *
 * **Two prefixes' worth of paths on one instance, deliberately.** A plan is
 * created and listed inside its project — `/api/projects/:id/saved-plans` — and
 * read, renamed and deleted by its own id, `/api/saved-plans/:id`. Repeating the
 * project id on the second three would let a caller name a project the plan does
 * not belong to and still be answered, which is a URL that lies about what it
 * addressed.
 *
 * **Compare is on the project prefix and that is not the same exception.**
 * `current` has no id of its own, so "the live plan" is only meaningful against
 * the project in the path — the id is load-bearing rather than repeated. The
 * rule the second prefix enforces structurally is therefore enforced here by a
 * check instead: a side naming a plan of another project answers `not_found`
 * (see {@link SavedPlanService.compare}).
 *
 * **The first parameter is `:id` and not the `:projectId` that would read
 * better**, because the router refuses to build otherwise: `memoirist` keys a
 * parameter by its position, `projectController` already registered
 * `/api/projects/:id`, and a second name at that position throws at
 * `composeGeneralHandler` — a startup failure, not a 404. The name is therefore
 * the router's to choose, and only the JSDoc can say which id it is.
 *
 * **`projectController`'s authenticated-read / authorised-write split, with one
 * exception that is the whole point of this task.** Reading is open to every
 * authenticated account; saving is an ordinary project write and asks
 * {@link canEdit}. Rename and delete do **not**: on an unrestricted project
 * `canEdit` is true for every authenticated account, so the ordinary rule would
 * let anybody relabel or destroy somebody else's permanent record. Those two go
 * through {@link SavedPlanService.rename} and {@link SavedPlanService.delete},
 * which carry the creator-or-owner rule.
 *
 * **The saver's identity comes from the resolved caller and never from the
 * body.** `createdBy` is `user.username` — a display name, stored by value —
 * and `createdById` is `user.id`, the reference the permission rule reads. A
 * body-supplied creator would let any caller mint a record naming somebody else
 * and, worse, hand themselves the right to rename it.
 */
export function savedPlanController(
  auth: AuthService,
  plans: SavedPlanService,
  projects: ProjectService,
) {
  const signedIn = { caller: 'signed-in' } as const;
  return new Elysia({ prefix: '/api' })
    .use(callerGuard(auth))
    .onError(refuseUnknownBodyVersion)
    .post(
      '/projects/:id/saved-plans',
      async ({ params, body, user, set }) => {
        // The project is read here rather than left to the service, because
        // the service's `no_project` cannot tell "there is no such project"
        // from "you may not write to it" — it never learns who is asking.
        const found = await projects.read(params.id);
        if (found === null) {
          set.status = 404;
          return { error: 'not_found' };
        }
        if (!canEdit(found.project, user.id)) {
          set.status = 403;
          return { error: 'forbidden' };
        }
        const outcome = await plans.save({
          projectId: params.id,
          name: body.name,
          createdBy: user.username,
          createdById: user.id,
        });
        if (outcome.outcome === 'saved') {
          set.status = 201;
          return { savedPlan: outcome.record };
        }
        if (outcome.outcome === 'no_project') {
          // Reachable: the project can be deleted between the read above and
          // the capture. Answered as the truth a moment later, not as a 500.
          set.status = 404;
          return { error: 'not_found' };
        }
        if (outcome.outcome === 'snapshot_busy') {
          set.status = 503;
          return { error: 'snapshot_busy' };
        }
        set.status = 409;
        return { error: 'quota', refusal: outcome.refusal };
      },
      { ...signedIn, body: saveBody() },
    )
    .get(
      '/projects/:id/saved-plans',
      async ({ params, set }) => {
        // The project is read for one reason: an unknown project and a project
        // with no saved plans both list as `[]`, and a client cannot tell a
        // mistyped id from an empty shelf.
        const found = await projects.read(params.id);
        if (found === null) {
          set.status = 404;
          return { error: 'not_found' };
        }
        return { savedPlans: await plans.list(params.id) };
      },
      signedIn,
    )
    .get(
      '/projects/:id/saved-plans/compare',
      async ({ params, query, set }) => {
        // The project's read rule, and it is not decoration here: `current` has
        // no id of its own, so this route is the one place a caller can ask for
        // a *restricted* project's live plan. `signedIn` below is half of the
        // rule; this read is the other half, and answers 404 before the service
        // learns a project id it would otherwise capture from.
        const found = await projects.read(params.id);
        if (found === null) {
          set.status = 404;
          return { error: 'not_found' };
        }
        const outcome = await plans.compare(params.id, sideRef(query.left), sideRef(query.right));
        if (outcome.outcome === 'compared') return { diff: outcome.diff };
        if (outcome.outcome === 'corrupt') {
          // `read`'s 422, for `read`'s reason: the plan is there and the bytes
          // will not repair themselves on a retry.
          set.status = 422;
          return { error: 'corrupt', savedPlanId: outcome.savedPlanId, refusal: outcome.refusal };
        }
        set.status = 404;
        return outcome.outcome === 'no_project'
          ? { error: 'not_found' }
          : { error: 'not_found', savedPlanId: outcome.savedPlanId };
      },
      { ...signedIn, query: compareSides() },
    )
    .get(
      '/saved-plans/:id',
      async ({ params, set }) => {
        const outcome = await plans.read(params.id);
        if (outcome.outcome === 'read') return { savedPlan: outcome.plan };
        if (outcome.outcome === 'not_found') {
          set.status = 404;
          return { error: 'not_found' };
        }
        // 422 and not 404, because the plan is there and has to stay visible
        // to be deleted; and not 409, whose meaning in `refusal-status.ts` is
        // "would have worked a moment earlier and may work again" — damaged
        // bytes will not repair themselves on a retry.
        set.status = 422;
        return { error: 'corrupt', refusal: outcome.refusal };
      },
      signedIn,
    )
    .patch(
      '/saved-plans/:id',
      async ({ params, body, user, set }) => {
        const outcome = await plans.rename(params.id, user.id, body.name);
        if (outcome.outcome === 'touched') return { savedPlanId: params.id, name: body.name };
        set.status = statusForTouch(outcome.outcome);
        return { error: outcome.outcome };
      },
      { ...signedIn, body: planName() },
    )
    .delete(
      '/saved-plans/:id',
      async ({ params, user, set }) => {
        const outcome = await plans.delete(params.id, user.id);
        if (outcome.outcome === 'touched') {
          set.status = 204;
          return null;
        }
        set.status = statusForTouch(outcome.outcome);
        return { error: outcome.outcome };
      },
      signedIn,
    );
}
