import { isHexTriple, isIsoDate, isMarkerName, validateCustomColor } from '@wbs/domain';

import { tableRefusedBody } from '../http/body-doc';
import { callerGuard } from '../http/caller';
import { isFieldBag, noContent, ok, respond, type Route, type RouteResponse } from '../http/route';
import type { AuthService } from '../service/auth.service';
import type {
  CalendarMarkerRefusal,
  CalendarMarkerService,
} from '../service/calendar-marker.service';
import { statusForRefusal } from './refusal-status';

/**
 * What the document says about the create body, now that the handler checks it
 * instead of the framework.
 *
 * This route declared `t.Object({ markerId?, date, name, color? })` to Elysia,
 * which both validated the body and put a `requestBody` in the committed
 * document. The route shape carries no validator (`http/route.ts` says why), so
 * the check moved into {@link fieldsFrom} and {@link createProblem}, and the
 * schema stays here as
 * documentation — the mechanism `step.routes.ts` and `project.routes.ts`
 * already use for a body they parse themselves.
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
 * one mapping in the `POST` handler.
 */
const CREATE_BODY = tableRefusedBody('A new calendar marker on an absolute project date.', {
  type: 'object',
  required: ['date', 'name'],
  properties: {
    markerId: { type: 'string' },
    date: { type: 'string' },
    name: { type: 'string' },
    color: { type: 'string', nullable: true },
  },
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
const PATCH_BODY = tableRefusedBody('Exactly one of the marker’s two writable columns.', {
  type: 'object',
  properties: {
    name: { type: 'string' },
    color: { type: 'string', nullable: true },
  },
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
  field: 'body' | 'markerId' | 'date' | 'name' | 'color';
}

const refuse = (problem: BodyProblem): RouteResponse =>
  respond(statusFor(problem.reason), { error: problem.reason, field: problem.field });

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
 * The members a marker body may carry, read off an untyped body and typed as
 * what the handlers may use.
 *
 * **The two bodies do not carry the same set, and each route says which it
 * reads.** `markerId` and `date` are the create's alone; the `PATCH` writes two
 * columns and its path already names the marker. That is why {@link fieldsFrom}
 * takes the member names rather than reading all four — see the note there.
 *
 * `undefined` is "absent" and `null` is a value the wire may carry, so `color`
 * needs all three states — folding them would make `{"color": null}`, which
 * means *automatic*, indistinguishable from a body that never mentioned the
 * column and, on the `PATCH`, would turn a clear-the-fill request into the
 * refusal a body naming neither column gets.
 */
interface MarkerFields {
  markerId?: string;
  date?: string;
  name?: string;
  color?: string | null;
}

/** The members a route reads; anything else in the body is ignored. */
type MarkerField = 'markerId' | 'date' | 'name' | 'color';

/**
 * Each member's **type**, before any of them means anything.
 *
 * Elysia refused these against `t.Object` before the handler ran, and the
 * document's own note said so: `date: t.String()` is why the JSON number `7`
 * was a schema refusal rather than a date this file judged. The check has to
 * live here now, and it is deliberately the *same* refusal the field's own row
 * of the table gives — a `date` that is a number and a `date` that is `'7'` are
 * both `malformed`/`date`, which is what a client can act on. A generic
 * `invalid_body` for the first would answer one mistake in two spellings
 * depending on which of them the client made.
 *
 * A body that is not a field bag has no member to blame, so that one row blames
 * `body` — the spelling the `PATCH` already used for a body naming neither
 * column. `isFieldBag` rather than `typeof body === 'object'` because
 * `typeof [] === 'object'`: TypeBox refused a JSON array here and the
 * hand-written spelling it replaced across this app accepted one
 * (`http/route.ts` records where that reached a caller).
 *
 * **`reads` is the schema's property list, and passing it is what keeps
 * "everything else is ignored" true.** Elysia refused a member's type only
 * where the route's own `t.Object` named it, and stripped every other property
 * before the handler ran — so on the `PATCH`, whose schema names `name` and
 * `color` alone, `{"name":"x","date":123}` renamed the marker and answered 200.
 * A `fieldsFrom` that always read all four turned that into a 422 blaming
 * `date`, which is both a behaviour change and a contradiction of the
 * description `tableRefusedBody` publishes for that very route (Gemini's
 * Important, run 38). Each route now passes the members its schema declares,
 * and the two lists are the two schemas.
 */
function fieldsFrom(body: unknown, reads: readonly MarkerField[]): MarkerFields | BodyProblem {
  if (!isFieldBag(body)) return { reason: 'malformed', field: 'body' };
  const fields: MarkerFields = {};
  for (const field of reads) {
    const value = body[field];
    if (value === undefined) continue;
    if (field === 'color') {
      // Spelled as the positive case rather than an early return on the
      // negative, because the negative is a compound over `unknown` —
      // `!== null && typeof !== 'string'` — and the branch that follows it
      // would be narrowed by the complement rather than by a check anybody can
      // read. `color` is also the one member `null` is a value for.
      if (value === null || typeof value === 'string') fields.color = value;
      else return { reason: 'malformed', field };
      continue;
    }
    if (typeof value !== 'string') return { reason: 'malformed', field };
    fields[field] = value;
  }
  return fields;
}

/** What `POST` reads — {@link CREATE_BODY}'s properties, and nothing else. */
const CREATE_FIELDS: readonly MarkerField[] = ['markerId', 'date', 'name', 'color'];

/** What `PATCH` reads — {@link PATCH_BODY}'s two writable columns. */
const PATCH_FIELDS: readonly MarkerField[] = ['name', 'color'];

const isProblem = (parsed: MarkerFields | BodyProblem): parsed is BodyProblem => 'reason' in parsed;

/** A create body, checked and narrowed — or the row of the table it fails. */
interface NewMarkerBody {
  markerId?: string;
  date: string;
  name: string;
  color?: string | null;
}

/**
 * What is wrong with a create body, or the values the handler may write.
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
 *
 * The narrowed object is **built member by member rather than spread**, and
 * that is a rule the framework used to keep: Elysia stripped every property its
 * schema did not name before the handler saw the body. Nothing strips them now,
 * so a spread would carry whatever else a caller sent straight into
 * `NewCalendarMarker` and on to the store.
 */
function createProblem(fields: MarkerFields): NewMarkerBody | BodyProblem {
  if (fields.markerId !== undefined && !UUID_V4.test(fields.markerId))
    return { reason: 'malformed', field: 'markerId' };
  // `isIsoDate` rather than a regexp of this file's own: it rejects
  // `2026-02-31`, which matches the shape and is not a day, and it is what
  // `projectService.patch` already answers `startDate` against. A second
  // spelling would be a second rule free to disagree with the one the rest of
  // the API applies. An absent `date` fails it for the same reason a
  // present-but-wrong one does — `required` in the document, `malformed`/`date`
  // on the wire.
  if (fields.date === undefined || !isIsoDate(fields.date))
    return { reason: 'malformed', field: 'date' };
  if (fields.name === undefined) return { reason: 'malformed', field: 'name' };
  const problem = nameProblem(fields.name) ?? colorProblem(fields.color);
  if (problem !== null) return problem;
  const created: NewMarkerBody = { date: fields.date, name: fields.name };
  if (fields.markerId !== undefined) created.markerId = fields.markerId;
  if (fields.color !== undefined) created.color = fields.color;
  return created;
}

const isCreateProblem = (parsed: NewMarkerBody | BodyProblem): parsed is BodyProblem =>
  'reason' in parsed;

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
 * body property (see {@link CREATE_BODY}). `id` on this API means the project.
 */
const refusalBody = (reason: CalendarMarkerRefusal) =>
  reason === 'forbidden' ? { error: reason } : { error: reason, field: 'markerId' as const };

/**
 * A project's calendar markers.
 *
 * Its own route list rather than more routes on `projectRoutes`, for
 * `stepRoutes`'s reason: these write a list that belongs to a project and the
 * project routes write the project's own columns. The prefix is the same
 * because the resource is — a marker belongs to one project and is addressed
 * through it.
 *
 * Unlike the steps, the list has a **route of its own**: `GET
 * /api/projects/:id` answers with the plan a client schedules from, and markers
 * are drawn on the axis rather than scheduled. Slice 5 is the assertion that
 * they never enter that response at all, so reading them through it would be
 * the thing that slice refuses.
 *
 * **`:id` and not the `:projectId` that would read better**, for
 * `savedPlanRoutes`'s reason: memoirist keys a parameter by position,
 * `projectRoutes` already registered `/api/projects/:id`, and a second name at
 * that position throws at `composeGeneralHandler` — a startup failure rather
 * than a 404.
 */
export function calendarMarkerRoutes(auth: AuthService, markers: CalendarMarkerService): Route[] {
  const guard = callerGuard(auth);
  return [
    {
      method: 'GET',
      path: '/api/projects/:id/calendar-markers',
      handler: guard('signed-in', async ({ params }) => {
        const outcome = await markers.list(params['id']);
        return outcome.ok
          ? ok({ markers: outcome.value })
          : respond(statusFor(outcome.reason), refusalBody(outcome.reason));
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:id/calendar-markers',
      handler: guard('signed-in', async ({ params, body }, user) => {
        const fields = fieldsFrom(body, CREATE_FIELDS);
        if (isProblem(fields)) return refuse(fields);
        const created = createProblem(fields);
        if (isCreateProblem(created)) return refuse(created);
        // The one place the wire name and the domain name meet: `markerId` in,
        // `id` out.
        // Built with the absent members left **out**, not present as
        // `undefined`. `NewCalendarMarker` normalises both with `??` so the row
        // written is the same either way, but the old controller's spread over
        // a stripped body carried no `color` key when the client sent none, and
        // an argument that differs from the one it replaces is a difference
        // somebody has to re-derive (Gemini's Minor, run 38).
        const outcome = await markers.create(params['id'], user.id, {
          date: created.date,
          name: created.name,
          ...(created.markerId === undefined ? {} : { id: created.markerId }),
          ...(created.color === undefined ? {} : { color: created.color }),
        });
        return outcome.ok
          ? respond(201, { marker: outcome.value })
          : respond(statusFor(outcome.reason), refusalBody(outcome.reason));
      }),
      documentation: { detail: { requestBody: CREATE_BODY } },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:id/calendar-markers/:markerId',
      handler: guard('signed-in', async ({ params, body }, user) => {
        const fields = fieldsFrom(body, PATCH_FIELDS);
        if (isProblem(fields)) return refuse(fields);
        // Exactly one of the two, and the refusal is the routes' own: a body
        // naming neither asks for no change, and a body naming both asks for
        // two writes the store applies one at a time — which is a partial
        // apply the moment the second refuses. Both are the request being
        // wrong, so both take the routes' 422 default.
        // Narrowed by two explicit arms rather than one flag apiece: a flag
        // pair leaves the compiler unable to see that the second branch has a
        // colour, and the assertion that papers over it is exactly what would
        // survive a body shape changing underneath.
        const { name, color } = fields;
        let outcome;
        if (name !== undefined && color === undefined) {
          // Validated **before** the write, not after it. The spec's
          // "SHALL NOT partially apply" is about exactly this: a rename that
          // stores the new name and then refuses it has answered 422 and left
          // the name behind, and "refused" and "unchanged" are two claims.
          const problem = nameProblem(name);
          if (problem !== null) return refuse(problem);
          outcome = await markers.rename(params['id'], params['markerId'], user.id, name);
        } else if (color !== undefined && name === undefined) {
          const problem = colorProblem(color);
          if (problem !== null) return refuse(problem);
          outcome = await markers.recolor(params['id'], params['markerId'], user.id, color);
        } else {
          return refuse({ reason: 'malformed', field: 'body' });
        }
        return outcome.ok
          ? ok({ marker: outcome.value })
          : respond(statusFor(outcome.reason), refusalBody(outcome.reason));
      }),
      documentation: { detail: { requestBody: PATCH_BODY } },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:id/calendar-markers/:markerId',
      handler: guard('signed-in', async ({ params }, user) => {
        const outcome = await markers.remove(params['id'], params['markerId'], user.id);
        return outcome.ok
          ? noContent()
          : respond(statusFor(outcome.reason), refusalBody(outcome.reason));
      }),
    },
  ];
}
