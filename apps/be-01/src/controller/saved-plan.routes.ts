import { callerGuard } from '../http/caller';
import { checkedBody } from '../http/elysia/hand-parsed-body';
import { COMPARE_QUERY } from '../http/elysia/query-schemas';
import {
  isFieldBag,
  noContent,
  ok,
  respond,
  type Route,
  type RouteHandler,
  type RouteResponse,
} from '../http/route';
import type { AuthService } from '../service/auth.service';
import type { Broadcaster } from '../service/broadcast';
import type { ProjectService } from '../service/project.service';
import { canEdit } from '../service/project.service';
import type {
  SavedPlanService,
  SavedPlanSideRef,
  SavedPlanTouchResult,
} from '../service/saved-plan.service';
import { UnknownSavedPlanBodyVersionError } from '../service/saved-plan-integrity';

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
 * **A wrapper per handler rather than an `.onError` on the instance**, which is
 * `work-item.routes.ts`'s `refusing` and for its reason: a route list has no
 * error boundary to hang this on, because the boundary was a property of the
 * Elysia instance the six routes shared. Anything this does not recognise is
 * **rethrown**, not flattened — the old handler returned `undefined` to say "not
 * mine" and Elysia carried the error on; a `throw` is the same sentence in the
 * shape a plain function has.
 */
function refusingUnknownBodyVersion(handler: RouteHandler): RouteHandler {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      if (!(error instanceof UnknownSavedPlanBodyVersionError)) throw error;
      return respond(501, {
        error: 'unsupported_body_version',
        savedPlanId: error.savedPlanId,
        body: error.body,
        version: error.version,
        supported: error.supported,
      });
    }
  };
}

/**
 * The two bodies Elysia validated, checked by hand for `project.routes.ts`'s
 * reason: a route module cannot declare a validator to a framework it does not
 * import.
 *
 * **Save and rename disagree about a missing name, and the disagreement is the
 * point** — it was two schemas on the old instance for the same reason it is two
 * functions here. A rename with no name is a caller asking for nothing and is
 * refused; a save with no name is assumption A-1's normal path and gets the
 * server's timestamp ({@link SavedPlanService.save}). `minLength: 1` applied to
 * any name a caller *did* send on either route, so `""` was a 422 on both and
 * never a silent default. {@link nonEmptyName} is that shared half.
 *
 * **The status stays 422**, which is what Elysia answered for a schema failure
 * and the one thing about these checks a client can observe. `refuses an empty
 * name rather than defaulting it` asserts it directly.
 *
 * **Unknown properties are dropped, not refused**, as everywhere else on this
 * branch: Elysia stripped them before the handler saw the body, so both
 * functions read the one key they know and pass nothing else on.
 */
type NameCheck = { refused: true } | { refused: false; name: string | undefined };

const nameRefused = { refused: true } as const;

/** The shared half: absent is `undefined`, a non-empty string is itself. */
function nonEmptyName(value: unknown): NameCheck {
  if (value === undefined) return { refused: false, name: undefined };
  if (typeof value !== 'string' || value.length === 0) return nameRefused;
  return { refused: false, name: value };
}

/** The save body: `{ name?: string }`, where absent is A-1's normal path. */
function saveNameFrom(body: unknown): { name: string | undefined } | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const checked = nonEmptyName(body['name']);
  if (checked.refused) return respond(422, { error: 'invalid_body' });
  return { name: checked.name };
}

/** The rename body: `{ name: string }`, where absent is a caller asking for nothing. */
function renameNameFrom(body: unknown): { name: string } | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const checked = nonEmptyName(body['name']);
  if (checked.refused || checked.name === undefined) {
    return respond(422, { error: 'invalid_body' });
  }
  return { name: checked.name };
}

const isRefusal = (parsed: object): parsed is RouteResponse => 'status' in parsed;

/**
 * The compare route's two sides, checked here as well as declared to the
 * document — {@link COMPARE_QUERY} says why both.
 *
 * Without this an absent `left` reaches {@link sideRef} as `undefined` under any
 * binder that does not validate the schema, and the service is asked for a saved
 * plan whose id is not a string.
 */
function sidesFrom(query: Record<string, string>): { left: string; right: string } | RouteResponse {
  const left = query['left'];
  const right = query['right'];
  // Truthiness rather than `=== undefined || === ''`: `Record<string, string>`
  // types an absent key as `string`, so the explicit undefined comparison is an
  // ESLint error (`no-unnecessary-condition`) while the value it guards against
  // is genuinely reachable at run time. `!left` covers both.
  if (!left || !right) return respond(422, { error: 'invalid_query' });
  return { left, right };
}

const SAVE_BODY = checkedBody(
  'The plan’s name. Absent is the normal path and takes the server’s timestamp.',
  { type: 'object', properties: { name: { type: 'string', minLength: 1 } } },
);

const RENAME_BODY = checkedBody('The plan’s new name.', {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 } },
});

/**
 * Save, list, read, rename, delete and compare, over HTTP (tasks 6.1, 7.3b).
 *
 * **Two prefixes' worth of paths in one list, deliberately.** A plan is created
 * and listed inside its project — `/api/projects/:id/saved-plans` — and read,
 * renamed and deleted by its own id, `/api/saved-plans/:id`. Repeating the
 * project id on the second three would let a caller name a project the plan does
 * not belong to and still be answered, which is a URL that lies about what it
 * addressed. On the old instance this was one `prefix: '/api'` and six relative
 * paths; the route shape spells every path out (`Route.path`), so the two
 * prefixes are now visible in the list rather than in a constructor argument.
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
 * parameter by its position, `projectRoutes` already registered
 * `/api/projects/:id`, and a second name at that position throws at
 * `composeGeneralHandler` — a startup failure, not a 404. The name is therefore
 * the router's to choose, and only the JSDoc can say which id it is.
 *
 * **`projectRoutes`'s authenticated-read / authorised-write split, with one
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
 *
 * **A mutation announces itself, and the announcement is *here* rather than in
 * the service** (TASK-255). `saved_plans_changed` is published after the service
 * has answered, which is after its transaction has committed and after it has
 * let go of the write lock — the rule `PlanCommandRunner` states for itself and
 * the reason `DeferringBroadcaster` exists: a push to gw-01 is a network call
 * with a six-attempt 500ms→30s backoff behind it, and a lock held across one
 * lets a slow gateway stall every write in the process. Publishing from inside
 * the service would put it back inside both.
 *
 * `app.ts` hands this the shared `DeferringBroadcaster`, like every other
 * publisher. It handed over the inner broadcaster instead when TASK-255 shipped,
 * because the hold was instance state and a save committing while an unrelated
 * batch held was queued into that batch and dropped when it refused. TASK-256
 * made the hold per-caller, so a route that is not part of a batch is not
 * captured by one whatever is open at the time, and the special case went with
 * it.
 *
 * The announcement is deliberately **not** conditional on the caller: every
 * successful save, rename and delete publishes, including the actor's own. The
 * alternative — a broadcaster that knows who asked — would put an identity into
 * a transport contract that has never carried one.
 *
 * What the actor's client does with its own event is **re-read on it**, not drop
 * it as an echo; this comment said the opposite until Sol's Minor on PR 204.
 * The distinction is not pedantic, because the echo story implies the actor is
 * already up to date and there is nothing left to solve. There is: the actor
 * waits for their own event to reach gw-01 and come back before the row they
 * just created appears, at the one moment the shelf is most obviously wrong.
 * That is closed on the client and not here — `watchShelf` returns a `refresh`
 * for the call site to drive directly, and its superseded-answer guard is what
 * makes that refresh safe racing the broadcast (`fe-01`'s
 * `lib/saved-plan-shelf.ts`).
 *
 * Refusals publish nothing, and that is the whole of the ordering rule this
 * needs: the event is emitted on exactly the branches that changed the list.
 */
export function savedPlanRoutes(
  auth: AuthService,
  plans: SavedPlanService,
  projects: ProjectService,
  announcements: Broadcaster,
): Route[] {
  const guard = callerGuard(auth);
  return [
    {
      method: 'POST',
      path: '/api/projects/:id/saved-plans',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params, body }, user) => {
          const named = saveNameFrom(body);
          if (isRefusal(named)) return named;
          const projectId = params['id'];
          // The project is read here rather than left to the service, because
          // the service's `no_project` cannot tell "there is no such project"
          // from "you may not write to it" — it never learns who is asking.
          const found = await projects.read(projectId);
          if (found === null) return respond(404, { error: 'not_found' });
          if (!canEdit(found.project, user.id)) return respond(403, { error: 'forbidden' });
          const outcome = await plans.save({
            projectId,
            name: named.name,
            createdBy: user.username,
            createdById: user.id,
          });
          if (outcome.outcome === 'saved') {
            await announcements.publish(projectId, { type: 'saved_plans_changed' });
            return respond(201, { savedPlan: outcome.record });
          }
          if (outcome.outcome === 'no_project') {
            // Reachable: the project can be deleted between the read above and
            // the capture. Answered as the truth a moment later, not as a 500.
            return respond(404, { error: 'not_found' });
          }
          if (outcome.outcome === 'snapshot_busy') return respond(503, { error: 'snapshot_busy' });
          return respond(409, { error: 'quota', refusal: outcome.refusal });
        }),
      ),
      documentation: { detail: { requestBody: SAVE_BODY } },
    },
    {
      method: 'GET',
      path: '/api/projects/:id/saved-plans',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params }) => {
          const projectId = params['id'];
          // The project is read for one reason: an unknown project and a project
          // with no saved plans both list as `[]`, and a client cannot tell a
          // mistyped id from an empty shelf.
          const found = await projects.read(projectId);
          if (found === null) return respond(404, { error: 'not_found' });
          return ok({ savedPlans: await plans.list(projectId) });
        }),
      ),
    },
    {
      method: 'GET',
      path: '/api/projects/:id/saved-plans/compare',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params, query }) => {
          const sides = sidesFrom(query);
          if (isRefusal(sides)) return sides;
          const projectId = params['id'];
          // The project's read rule, and it is not decoration here: `current` has
          // no id of its own, so this route is the one place a caller can ask for
          // a *restricted* project's live plan. `signed-in` above is half of the
          // rule; this read is the other half, and answers 404 before the service
          // learns a project id it would otherwise capture from.
          const found = await projects.read(projectId);
          if (found === null) return respond(404, { error: 'not_found' });
          const outcome = await plans.compare(projectId, sideRef(sides.left), sideRef(sides.right));
          if (outcome.outcome === 'compared') return ok({ diff: outcome.diff });
          if (outcome.outcome === 'corrupt') {
            // `read`'s 422, for `read`'s reason: the plan is there and the bytes
            // will not repair themselves on a retry.
            return respond(422, {
              error: 'corrupt',
              savedPlanId: outcome.savedPlanId,
              refusal: outcome.refusal,
            });
          }
          return respond(
            404,
            outcome.outcome === 'no_project'
              ? { error: 'not_found' }
              : { error: 'not_found', savedPlanId: outcome.savedPlanId },
          );
        }),
      ),
      preflight: guard.preflight('signed-in'),
      documentation: { query: COMPARE_QUERY },
    },
    {
      method: 'GET',
      path: '/api/saved-plans/:id',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params }) => {
          const outcome = await plans.read(params['id']);
          if (outcome.outcome === 'read') return ok({ savedPlan: outcome.plan });
          if (outcome.outcome === 'not_found') return respond(404, { error: 'not_found' });
          // 422 and not 404, because the plan is there and has to stay visible
          // to be deleted; and not 409, whose meaning in `refusal-status.ts` is
          // "would have worked a moment earlier and may work again" — damaged
          // bytes will not repair themselves on a retry.
          return respond(422, { error: 'corrupt', refusal: outcome.refusal });
        }),
      ),
    },
    {
      method: 'PATCH',
      path: '/api/saved-plans/:id',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params, body }, user) => {
          const named = renameNameFrom(body);
          if (isRefusal(named)) return named;
          const savedPlanId = params['id'];
          const outcome = await plans.rename(savedPlanId, user.id, named.name);
          if (outcome.outcome === 'touched') {
            await announcements.publish(outcome.projectId, { type: 'saved_plans_changed' });
            return ok({ savedPlanId, name: named.name });
          }
          return respond(statusForTouch(outcome.outcome), { error: outcome.outcome });
        }),
      ),
      documentation: { detail: { requestBody: RENAME_BODY } },
    },
    {
      method: 'DELETE',
      path: '/api/saved-plans/:id',
      handler: refusingUnknownBodyVersion(
        guard('signed-in', async ({ params }, user) => {
          const outcome = await plans.delete(params['id'], user.id);
          if (outcome.outcome === 'touched') {
            await announcements.publish(outcome.projectId, { type: 'saved_plans_changed' });
            return noContent();
          }
          return respond(statusForTouch(outcome.outcome), { error: outcome.outcome });
        }),
      ),
    },
  ];
}
