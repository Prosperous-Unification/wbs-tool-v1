import {
  createCalendarMarker,
  listCalendarMarkers,
  removeCalendarMarker,
  updateCalendarMarker,
} from '@wbs/contracts';
import {
  automaticColor,
  isHexTriple,
  isIsoDate,
  isMarkerName,
  validateCustomColor,
} from '@wbs/domain';

import { bind, EMPTY, type RequestFailure } from '../http/endpoint';
import { isFieldBag } from '../http/route';
import type { CalendarMarker } from '../repository';
import type {
  CalendarMarkerRefusal,
  CalendarMarkerRefused,
  CalendarMarkerService,
} from '../service/calendar-marker.service';

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
type BodyProblem =
  | { reason: 'malformed'; field: 'body' | 'markerId' | 'date' | 'name' | 'color' }
  | { reason: 'contrast'; field: 'color' };

function refuse(problem: BodyProblem) {
  // Proof: omitting color from this detail made the mounted contrast test return 500, expected 422.
  if (problem.reason === 'contrast')
    return { ok: false, status: 422, body: { error: 'contrast', field: 'color' } } as const;
  return { ok: false, status: 422, body: { error: 'malformed', field: problem.field } } as const;
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
  // Proof: bypassing contrast validation made the mounted dark-fill test return 201, expected 422.
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

/** The members whose types can receive a field-specific refusal. */
type MarkerField = 'markerId' | 'date' | 'name' | 'color';

/**
 * Classifies a rejected structural body using only the route's declared fields.
 * Wrong member types retain the existing field-specific refusal; an otherwise
 * valid body rejected for undeclared properties blames body in {@link classify}.
 * This does not admit or strip input: the strict request schema runs first.
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

/** What `POST` reads — {@link createCalendarMarker}'s properties, and nothing else. */
const CREATE_FIELDS: readonly MarkerField[] = ['markerId', 'date', 'name', 'color'];

/** What `PATCH` reads — {@link updateCalendarMarker}'s two writable columns. */
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
 * The narrowed object retains only declared create fields. The request schema
 * rejects undeclared properties before this semantic parser runs.
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

/** Keeps each modeled state paired with its existing HTTP status. */
function bareState(reason: CalendarMarkerRefusal) {
  switch (reason) {
    case 'forbidden':
      return { ok: false, status: 403, body: { error: reason } } as const;
    case 'not_found':
      return { ok: false, status: 404, body: { error: reason } } as const;
    case 'taken':
      return { ok: false, status: 409, body: { error: reason } } as const;
  }
}

/** A field is blamed only when the service says marker and the request named one. */
function stateRefused(outcome: CalendarMarkerRefused, named: boolean) {
  // Proof: removing the project subject branch added field: markerId to the direct missing-project reply.
  if (!named || outcome.about === 'project' || outcome.reason === 'forbidden')
    return bareState(outcome.reason);
  return outcome.reason === 'not_found'
    ? ({ ok: false, status: 404, body: { error: 'not_found', field: 'markerId' } } as const)
    : ({ ok: false, status: 409, body: { error: 'taken', field: 'markerId' } } as const);
}

/** Automatic color resolves at the wire boundary; storage retains null. */
const answered = (marker: CalendarMarker) => ({
  ...marker,
  // Proof: returning stored null made the mounted automatic-color create return 500, expected 201.
  color: marker.color ?? automaticColor(marker.id),
});

/** Shared pure semantic validation for PATCH and its structural-failure classifier. */
function patchProblem(
  fields: MarkerFields,
): { kind: 'name'; name: string } | { kind: 'color'; color: string | null } | BodyProblem {
  // Proof: allowing name with color returned 200 instead of 422 in the mounted undeclared-input test.
  if (fields.name !== undefined && fields.color === undefined)
    return nameProblem(fields.name) ?? { kind: 'name', name: fields.name };
  if (fields.color !== undefined && fields.name === undefined)
    return colorProblem(fields.color) ?? { kind: 'color', color: fields.color };
  return { reason: 'malformed', field: 'body' };
}

/** Retains field-specific body refusals; new undeclared fields blame the body. */
function classify(failure: RequestFailure, creating: boolean) {
  switch (failure.code) {
    case 'invalid_json':
      return { ok: false, status: 400, body: { error: 'invalid_json' } } as const;
    case 'invalid_params':
      return { ok: false, status: 400, body: { error: 'invalid_params' } } as const;
    case 'invalid_query':
      return { ok: false, status: 400, body: { error: 'invalid_query' } } as const;
    case 'invalid_body': {
      const fields = fieldsFrom(failure.rejected, creating ? CREATE_FIELDS : PATCH_FIELDS);
      if (isProblem(fields)) return refuse(fields);
      if (creating) {
        const created = createProblem(fields);
        if (isCreateProblem(created)) return refuse(created);
      } else {
        const problem = patchProblem(fields);
        if (isProblem(problem)) return refuse(problem);
      }
      return refuse({ reason: 'malformed', field: 'body' });
    }
  }
}

/** Binds axis annotations without entering work-item, revision or journal paths. */
export function calendarMarkerRoutes(markers: CalendarMarkerService) {
  return [
    bind(listCalendarMarkers, async ({ params }) => {
      const outcome = await markers.list(params.id);
      return outcome.ok
        ? { ok: true, status: 200, body: { markers: outcome.value.map(answered) } }
        : bareState(outcome.reason);
    }),
    bind(
      createCalendarMarker,
      async ({ params, body, principal }) => {
        const created = createProblem(body);
        if (isCreateProblem(created)) return refuse(created);
        const outcome = await markers.create(params.id, principal.id, {
          date: created.date,
          name: created.name,
          ...(created.markerId === undefined ? {} : { id: created.markerId }),
          ...(created.color === undefined ? {} : { color: created.color }),
        });
        return outcome.ok
          ? { ok: true, status: 201, body: { marker: answered(outcome.value) } }
          : stateRefused(outcome, created.markerId !== undefined);
      },
      { classifyRequestFailure: (failure) => classify(failure, true) },
    ),
    bind(
      updateCalendarMarker,
      async ({ params, body, principal }) => {
        const change = patchProblem(body);
        if (isProblem(change)) return refuse(change);
        const outcome =
          change.kind === 'name'
            ? await markers.rename(params.id, params.markerId, principal.id, change.name)
            : await markers.recolor(params.id, params.markerId, principal.id, change.color);
        return outcome.ok
          ? { ok: true, status: 200, body: { marker: answered(outcome.value) } }
          : stateRefused(outcome, true);
      },
      { classifyRequestFailure: (failure) => classify(failure, false) },
    ),
    bind(removeCalendarMarker, async ({ params, principal }) => {
      const outcome = await markers.remove(params.id, params.markerId, principal.id);
      return outcome.ok ? { ok: true, status: 204, body: EMPTY } : stateRefused(outcome, true);
    }),
  ] as const;
}
