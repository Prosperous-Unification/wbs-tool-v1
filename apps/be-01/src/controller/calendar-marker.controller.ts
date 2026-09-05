import { isHexTriple, isIsoDate, isMarkerName, validateCustomColor } from '@wbs/domain';
import { Elysia, t } from 'elysia';

import { callerGuard } from '../middleware/caller';
import type { AuthService } from '../service/auth.service';
import type {
  CalendarMarkerRefusal,
  CalendarMarkerService,
} from '../service/calendar-marker.service';
import { statusForRefusal } from './refusal-status';

/**
 * Built per controller, not per module: Elysia writes `additionalProperties`
 * into the schema object it is handed when the route's validator compiles, so a
 * module-level one is shared mutable state between apps — `step.controller.ts`
 * carries the same note and `auth.controller.ts` carries the failure that
 * taught it.
 *
 * **The client-supplied marker id is `markerId` on the wire, not `id`**, and the
 * name is forced rather than chosen. This route's path is
 * `/api/projects/:id/calendar-markers`, so `id` on this API already means the
 * project. `openapi-tools.ts` derives one MCP tool per operation from
 * `apps/be-01/openapi.json` and flattens path and body inputs into a single
 * argument object, and its `claim()` throws rather than ship a tool where one
 * input silently overwrites the other. Renaming the *path* parameter instead is
 * not available: memoirist refuses two different parameter names in the same
 * position, so `:projectId` here would mean renaming `:id` across every
 * `/api/projects/:id/...` route in be-01. `markerId` is also what the `PATCH`
 * and `DELETE` paths already call this same value, so the create is now the
 * only route that ever called it anything else.
 *
 * The **domain** field stays `id` (`NewCalendarMarker.id`, `CalendarMarker.id`):
 * inside the service there is no project id to collide with, and the seam is the
 * one mapping line in the `POST` handler.
 */
const createBody = () =>
  t.Object({
    markerId: t.Optional(t.String()),
    date: t.String(),
    name: t.String(),
    color: t.Optional(t.Union([t.String(), t.Null()])),
  });

/**
 * One `PATCH` for both edits, with the body deciding which.
 *
 * Rename and recolour are one route because they are one resource's two
 * columns, and separating them would give the axis chip two URLs for "change
 * this marker". They still take body-specific branches inside it — which is
 * exactly why task 4.6's structural negative is injected on the **recolour**
 * branch specifically.
 */
const patchBody = () =>
  t.Object({
    name: t.Optional(t.String()),
    color: t.Optional(t.Union([t.String(), t.Null()])),
  });

/**
 * The marker routes' own default is **422**, and it is stated here because
 * `statusForRefusal(reason, otherwise)` takes each route's default as an
 * argument: `forbidden` is 403, `not_found` 404 and `taken` 409 through the
 * shared arms, and everything a marker route refuses on its own — a malformed
 * body, a date that is not an `IsoDate`, a fill under the contrast bar — is the
 * request itself being wrong rather than a conflict with the project as it
 * stands (spec.md's refusal table; task 4.5 tests it row by row).
 */
const MARKER_ROUTE_DEFAULT = 422;

/**
 * Every refusal these routes answer goes through here, the body ones included.
 *
 * Not two ladders — a hard-coded 422 beside the shared one would make the
 * default unfalsifiable: `taken`, `not_found` and `forbidden` all leave through
 * their own arms, so changing {@link MARKER_ROUTE_DEFAULT} would move no status
 * at all and task 4.5's first negative could not be watched failing anything.
 */
const statusFor = (reason: CalendarMarkerRefusal | BodyProblem['reason']): number =>
  statusForRefusal(reason, MARKER_ROUTE_DEFAULT);

/**
 * A v4 UUID and nothing else (task 4.6a).
 *
 * The version nibble and the variant nibble are both pinned, because a v1 UUID
 * is the same length and the same alphabet — a shape check that only counted
 * hex digits and hyphens would accept one, and a v1 carries a MAC address and a
 * timestamp that a marker id has no business publishing.
 *
 * **This does not make the marker and work-item id spaces disjoint**, and
 * nothing does: task 4.4 lets a client name its own id, so it can name one a
 * `work_item` row already uses. What forbids a marker reaching work-item code
 * is route-family disjointness (task 4.6), not the shape of the id.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One row of the spec's refusal table: the code it answers with, and the field it blames. */
interface BodyProblem {
  reason: 'malformed' | 'contrast';
  field: 'markerId' | 'date' | 'name' | 'color';
}

/**
 * The `name` rows of the table, which are one row: empty and over
 * `MARKER_NAME_MAX` are the same refusal at the two ends of one bound.
 *
 * `isMarkerName` from the domain rather than a length check here, and the
 * difference is not stylistic: the cap is counted in **code points** so an
 * emoji costs one, and `name.length` counts UTF-16 units. The composer refuses
 * over-long names before sending, so a second spelling here would be a second
 * rule free to refuse a name the composer offered.
 */
function nameProblem(name: string): BodyProblem | null {
  return isMarkerName(name) ? null : { reason: 'malformed', field: 'name' };
}

/**
 * The two `color` rows, in the order the table has to answer them.
 *
 * **Shape first, contrast second, and they are different codes.** A typo is
 * `malformed`; a well-formed fill too dark to sit on some backdrop is
 * `contrast`. Folding them together would answer a mistyped colour with a
 * contrast measurement, and `validateCustomColor` states the shape as a
 * precondition it does not check — handed `#f0` it throws, which at a
 * boundary is a 500 blaming the server for the client's typo.
 *
 * Absent and `null` are both **automatic** and neither is a colour, so neither
 * has anything to measure.
 */
function colorProblem(color: string | null | undefined): BodyProblem | null {
  if (color === undefined || color === null) return null;
  if (!isHexTriple(color)) return { reason: 'malformed', field: 'color' };
  if (!validateCustomColor(color).ok) return { reason: 'contrast', field: 'color' };
  return null;
}

/**
 * What is wrong with a create body, or `null`.
 *
 * A **typed 4xx, never a throw.** An inbound body is untrusted data at the
 * boundary, which is the modelled path this repo's Elysia rule names; R5's
 * "malformed trusted data throws" governs data already inside the trust
 * boundary and does not reach here. Answering a client's malformed date with a
 * 500 blames the server for the client's mistake.
 *
 * Checked before the service is called at all, so a refused body writes
 * nothing — "refused" and "unchanged" are two claims, and the second is the one
 * a validate-after-write breaks.
 */
function createProblem(body: {
  markerId?: string;
  date: string;
  name: string;
  color?: string | null;
}): BodyProblem | null {
  if (body.markerId !== undefined && !UUID_V4.test(body.markerId))
    return { reason: 'malformed', field: 'markerId' };
  // `isIsoDate` rather than a regexp of this file's own: it rejects
  // `2026-02-31`, which matches the shape and is not a day, and it is what
  // `projectService.patch` already answers `startDate` against. A second
  // spelling would be a second rule free to disagree with the one the rest of
  // the API applies.
  if (!isIsoDate(body.date)) return { reason: 'malformed', field: 'date' };
  return nameProblem(body.name) ?? colorProblem(body.color);
}

/**
 * The refusal body for a state the **service** decided, with the field its row
 * of the table names.
 *
 * `forbidden` is the one row whose field is absent, and that absence is part of
 * the contract rather than an omission: the refusal is about the caller, not
 * about a member of the body. `taken` and `not_found` both blame the `markerId`
 * — the one already stored, or the one that resolves to nothing this project
 * owns. `markerId` rather than `id` because that is what every marker request
 * calls this value: the path parameter on `PATCH` and `DELETE`, and the create
 * body property (see {@link createBody}). `id` on this API means the project.
 */
const refusalBody = (reason: CalendarMarkerRefusal) =>
  reason === 'forbidden' ? { error: reason } : { error: reason, field: 'markerId' as const };

/**
 * A project's calendar markers.
 *
 * Its own controller rather than more routes on `projectController`, for
 * `stepController`'s reason: these write a list that belongs to a project and
 * the project routes write the project's own columns. The prefix is the same
 * because the resource is — a marker belongs to one project and is addressed
 * through it.
 *
 * Unlike the steps, the list has a **route of its own**: `GET
 * /api/projects/:id` answers with the plan a client schedules from, and markers
 * are drawn on the axis rather than scheduled. Slice 5 is the assertion that
 * they never enter that response at all, so reading them through it would be
 * the thing that slice refuses.
 */
export function calendarMarkerController(auth: AuthService, markers: CalendarMarkerService) {
  const signedIn = { caller: 'signed-in' } as const;
  return new Elysia({ prefix: '/api/projects' })
    .use(callerGuard(auth))
    .get(
      '/:id/calendar-markers',
      async ({ params, set }) => {
        const outcome = await markers.list(params.id);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return refusalBody(outcome.reason);
        }
        return { markers: outcome.value };
      },
      signedIn,
    )
    .post(
      '/:id/calendar-markers',
      async ({ params, body, user, set }) => {
        const problem = createProblem(body);
        if (problem !== null) {
          set.status = statusFor(problem.reason);
          return { error: problem.reason, field: problem.field };
        }
        // The one place the wire name and the domain name meet: `markerId` in,
        // `id` out. Spread-then-override would carry `markerId` into the
        // service's object as an extra member, so the two names are mapped
        // explicitly.
        const { markerId, ...rest } = body;
        const outcome = await markers.create(params.id, user.id, { ...rest, id: markerId });
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return refusalBody(outcome.reason);
        }
        set.status = 201;
        return { marker: outcome.value };
      },
      { ...signedIn, body: createBody() },
    )
    .patch(
      '/:id/calendar-markers/:markerId',
      async ({ params, body, user, set }) => {
        // Exactly one of the two, and the refusal is the controller's own: a
        // body naming neither asks for no change, and a body naming both asks
        // for two writes the store applies one at a time — which is a partial
        // apply the moment the second refuses. Both are the request being
        // wrong, so both take the routes' 422 default.
        // Narrowed by two explicit arms rather than one flag apiece: a flag
        // pair leaves the compiler unable to see that the second branch has a
        // colour, and the assertion that papers over it is exactly what would
        // survive a body shape changing underneath.
        const { name, color } = body;
        let outcome;
        if (name !== undefined && color === undefined) {
          // Validated **before** the write, not after it. The spec's
          // "SHALL NOT partially apply" is about exactly this: a rename that
          // stores the new name and then refuses it has answered 422 and left
          // the name behind, and "refused" and "unchanged" are two claims.
          const problem = nameProblem(name);
          if (problem !== null) {
            set.status = statusFor(problem.reason);
            return { error: problem.reason, field: problem.field };
          }
          outcome = await markers.rename(params.id, params.markerId, user.id, name);
        } else if (color !== undefined && name === undefined) {
          const problem = colorProblem(color);
          if (problem !== null) {
            set.status = statusFor(problem.reason);
            return { error: problem.reason, field: problem.field };
          }
          outcome = await markers.recolor(params.id, params.markerId, user.id, color);
        } else {
          set.status = statusFor('malformed');
          return { error: 'malformed' as const, field: 'body' };
        }
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return refusalBody(outcome.reason);
        }
        return { marker: outcome.value };
      },
      { ...signedIn, body: patchBody() },
    )
    .delete(
      '/:id/calendar-markers/:markerId',
      async ({ params, user, set }) => {
        const outcome = await markers.remove(params.id, params.markerId, user.id);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return refusalBody(outcome.reason);
        }
        set.status = 204;
        return null;
      },
      signedIn,
    );
}
