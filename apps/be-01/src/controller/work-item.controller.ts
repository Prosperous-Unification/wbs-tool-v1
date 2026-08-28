import {
  isIsoDate,
  type IsoDate,
  isRoleState,
  LONGEST_NOT_BEFORE_REASON,
  MOST_PEOPLE_AT_ONCE,
  type RoleState,
  ThreePointEstimate,
} from '@wbs/domain';
import { parseOrThrow, ValidationError } from '@wbs/validation';
import { Elysia } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import { handParsedBody } from '../openapi/hand-parsed-body';
import type { AuthService } from '../service/auth.service';
import type {
  CreateWorkItem,
  DeleteStrategy,
  MoveWorkItem,
  UndoOutcome,
  WorkItemRefusal,
  WorkItemService,
} from '../service/work-item.service';

/**
 * These routes validate their bodies by hand rather than with an Elysia schema.
 *
 * The reason is a rule the schema cannot express here: a request that carries a
 * `number` must be *refused*, and Elysia strips unknown properties before the
 * handler runs — so the same check written after `{ body: t.Object(...) }` never
 * fires and reads as though it works. Numbers are derived, and a client sending
 * one is working from an assumption this API does not hold; accepting and
 * ignoring it would let that assumption survive until the number silently moved.
 */
class BadRequest extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw new BadRequest('expected_object');
  return body as Record<string, unknown>;
}

function refuseDerivedFields(body: Record<string, unknown>): void {
  if ('number' in body || 'frozenNumber' in body) throw new BadRequest('number_is_derived');
}

function asIdOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new BadRequest(`${field}_must_be_id_or_null`);
  return value;
}

/** The largest own-team set one work item may carry in a single patch. */
export const MOST_TEAMS_ON_ONE_ITEM = 10;

/**
 * How many tags one work item may carry.
 *
 * A bound rather than none, and a generous one: the set is written whole on
 * every patch and read on every plan read, so an unbounded array is a request
 * body a client can make arbitrarily large and a join this row's every read
 * pays for. Fifty is far past what a taxonomy anybody maintains by hand looks
 * like — the directory itself is a typed list — and it is small enough that the
 * refusal is about a mistake rather than about a limit somebody hit honestly.
 *
 * Not in `libs/domain`: nothing about the number is a rule the two apps share,
 * and the engine never sees a tag at all.
 */
export const MOST_TAGS_ON_ONE_ITEM = 50;

/**
 * How many services one work item may deliver.
 *
 * {@link MOST_TAGS_ON_ONE_ITEM}'s argument at a tenth of the number, because the
 * two dimensions are not the same size of thing: a tag taxonomy is open and a
 * service directory is the handful of things an organisation ships. Ten is far
 * past a row that honestly delivers several and still small enough that hitting
 * it means a mistake.
 *
 * A separate constant and not a shared one — the caps move for different
 * reasons, and one number would tie a service list's bound to a taxonomy's.
 */
export const MOST_SERVICES_ON_ONE_ITEM = 10;

/**
 * The label set a patch names, whole, or `undefined` where it names none —
 * tags and, since task 10.2, services.
 *
 * **`[]` is a value and means "no tags"** — the one spelling of taking them all
 * off, and deliberately not `null`: there is no column to reset and no third
 * state, so a null arm would be a second spelling of the same fact.
 *
 * Every member must be a string, and the array must be an array: an object or a
 * bare string here is a client sending one id where the field takes a set, and
 * accepting it would write a row per character.
 *
 * Duplicates are **not** refused. The store deduplicates on the way in and the
 * primary key would refuse the pair anyway, so a payload naming one label twice
 * is a client being untidy rather than a request that means something else —
 * and a 400 for it would be this route inventing a rule the model does not have.
 */
function asOptionalLabelIds(
  value: unknown,
  field: string,
  /**
   * The dimension's own cap, handed in rather than read off a constant here:
   * this function serves two dimensions since task 10.2, and a shared bound
   * would make one of them refuse at a number chosen for the other.
   */
  most: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new BadRequest(`${field}_must_be_a_list_of_ids`);
  if (value.length > most) {
    throw new BadRequest(`${field}_must_be_at_most_${String(most)}`);
  }
  for (const each of value) {
    if (typeof each !== 'string') throw new BadRequest(`${field}_must_be_a_list_of_ids`);
  }
  return value as readonly string[];
}

function asOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${field}_must_be_text`);
  return value;
}

/**
 * The one number a recorded actual is, checked by hand for the reason at the top
 * of this file and for one of its own.
 *
 * **`0` is accepted and is not the same as absence.** A person typing zero is
 * saying the work took no days, which is a statement they made; the absence of a
 * row is nobody having said anything, and the way to express it is `DELETE`, not
 * this route with a zero in it. Every reading surface follows the same rule —
 * see `actual` in `schema.ts`.
 *
 * Negative days are refused: nobody spends minus a day, and the number would
 * subtract from a parent's roll-up and quietly shrink a branch's recorded total.
 * A non-finite one is refused because `NaN` stored as a real comes back as a
 * number that fails every comparison it is in, including its own.
 */
function parseActual(body: unknown): number {
  const raw = asRecord(body);
  const days: unknown = raw['days'];
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    throw new BadRequest('invalid_actual');
  }
  return days;
}

/**
 * The one number a figure in a unit other than days is, checked by hand for the
 * reason at the top of this file and for {@link parseActual}'s.
 *
 * **The body key is `value`, not `tokens` or `hours`.** The unit is in the
 * path — `/measures/token_actual/:roleId` — so a key naming one would be the
 * same fact twice, and the two could then disagree: `{"hours": 6}` sent to the
 * `token_actual` path is a request with two answers and no way to pick. One
 * route serves three metrics precisely because the number is the same shape in
 * all of them.
 *
 * The bounds are `parseActual`'s, and for its reasons: `0` is a statement that
 * the work cost nothing and is kept, absence is `DELETE`, a negative figure
 * would subtract from a parent's roll-up, and a non-finite one comes back out
 * of the column failing every comparison including its own. Nobody spends minus
 * a token either.
 *
 * `invalid_measure` rather than `invalid_actual`: a caller reading the refusal
 * has three routes it could have come from, and the one it names is the one it
 * came from.
 */
function parseMeasure(body: unknown): number {
  const raw = asRecord(body);
  const value: unknown = raw['value'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadRequest('invalid_measure');
  }
  return value;
}

/**
 * The one state a statement is, checked by hand for the reason at the top of
 * this file and for one of its own.
 *
 * **`not_started` is refused, and that is the point.** The absence of a
 * statement is the absence of a row: the way to say it is `DELETE` on this
 * path, never a third value in the column. Accepting it here would give two
 * spellings of "nobody has said" — one of which every reader would then have to
 * fold — and the whole design rests on there being one.
 *
 * `blocked` and `cancelled` are refused for the reason in `design.md` P2: each
 * is a question the engine must answer the day it reads this table, and it does
 * not read it yet. The `CHECK` on the column refuses them again, in the
 * database, so a body this function ever came to let through does not become a
 * row nothing folds.
 */
function parseProgress(body: unknown): RoleState {
  const raw = asRecord(body);
  const state: unknown = raw['state'];
  if (!isRoleState(state)) throw new BadRequest('invalid_progress');
  return state;
}

function parseCreate(body: unknown): CreateWorkItem {
  const raw = asRecord(body);
  refuseDerivedFields(raw);
  return {
    parentId: asIdOrNull(raw['parentId'], 'parentId'),
    afterId: asIdOrNull(raw['afterId'], 'afterId'),
    name: asOptionalText(raw['name'], 'name'),
    notes: asOptionalText(raw['notes'], 'notes'),
  };
}

function parseMove(body: unknown): MoveWorkItem {
  const raw = asRecord(body);
  return {
    parentId: asIdOrNull(raw['parentId'], 'parentId'),
    afterId: asIdOrNull(raw['afterId'], 'afterId'),
  };
}

/**
 * A calendar day, `null` to clear the constraint, or absent to leave it.
 *
 * Validated here rather than trusted: the column is text, and a date the
 * scheduler cannot parse would throw on every later read of the project — a
 * 422 on one request beats a plan nobody can open.
 */
function asOptionalDate(value: unknown, field: string): IsoDate | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isIsoDate(value)) throw new BadRequest(`${field}_must_be_a_date`);
  return value;
}

/**
 * Why the work is held back, `null` to take the words off, or absent to leave
 * them.
 *
 * **A blank is `null`, not `''`.** Emptying the field is how a reader takes a
 * reason off, and a stored empty string would be a second spelling of "nobody
 * has said" that every reader would then have to fold — the doctrine `actual`
 * and `role_progress` both state as "the absence of a row". Trimmed for the
 * same reason a band label is: a reason of three spaces is a reason of none,
 * and the difference between them is invisible on every surface that shows it.
 *
 * Bounded at {@link LONGEST_NOT_BEFORE_REASON}, and this is the only boundary
 * a value can enter through: the column is `text`, SQLite counts no characters,
 * and the migration argues why a `CHECK` on this table would answer 500 to the
 * outgoing release mid-swap. The bound is measured **after** the trim, so
 * trailing whitespace cannot spend it.
 *
 * The pair rule — a reason needs a date — is deliberately not here. It is a
 * question about the row as it will stand, and this function has only the
 * request; `WorkItemStore.patch` asks it inside the transaction that writes.
 */
function asOptionalReason(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequest(`${field}_must_be_text`);
  const trimmed = value.trim();
  // Proof: this throw deleted, so the value is taken as it arrives — **48 pass,
  // 1 fail** — and `refuses a reason that is not text, and one longer than a
  // sentence` failed on `Expected: 400, Received: 200`: 201 characters taken,
  // and nothing anywhere between a pasted paragraph and a hover card that
  // covers the chart it is explaining. Watched 2026-08-18.
  if (trimmed.length > LONGEST_NOT_BEFORE_REASON) {
    throw new BadRequest(
      `${field}_must_be_at_most_${String(LONGEST_NOT_BEFORE_REASON)}_characters`,
    );
  }
  // Proof: this normalisation replaced by `return trimmed` — **48 pass, 1
  // fail** — and `stores a blank reason as no reason at all, and trims the
  // rest` failed with `"startNoEarlierThanReason": ""` where `null` was owed:
  // two spellings of "nobody has said" in one column, one of which the pair rule
  // then refuses to let a reader clear the date beside. Watched 2026-08-18.
  return trimmed === '' ? null : trimmed;
}

/**
 * A priority of 1 or more, `null` to leave the work with no priority, or absent to leave it
 * as it is.
 *
 * Validated here rather than trusted, for the reason the date above it is: this
 * is the only gate in front of the column. A 0, a negative or a fraction stores
 * a order the leveller will honour and nobody could have meant — the queue comes
 * out in an order with no explanation on screen, which is worse than a refusal.
 * `Number.isSafeInteger` covers the fraction, the `NaN`, the infinity and the
 * value beyond what an integer column can hold, in one question; `typeof` is
 * asked first because `true` and `'2'` are not numbers and JSON lets them
 * through.
 *
 * No ceiling. "From 1 to infinity" was the ask, and how large a planner's own
 * scale runs is not this API's to decide.
 */
function asOptionalPriority(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // Proof: this throw deleted, so the value is taken as it arrives, and
  // `refuses a priority that is not a whole number of 1 or more` failed —
  // `0`, `-1`, `1.5`, `'2'`, `true` and `1e20` were each answered 200 and
  // stored, and the work item came back carrying `1e20` where its own 3 was
  // owed; watched 2026-08-11.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest(`${field}_must_be_a_whole_number_from_1`);
  }
  return value;
}

/**
 * How many people may be on one work item at once: a whole number of 1 to
 * {@link MOST_PEOPLE_AT_ONCE}, `null` to put it back to one at a time, or
 * absent to leave it.
 *
 * The floor is 1 and it is load-bearing rather than tidy. A 0 stored here is a
 * **width of 0**, and the engine's duration is `effort / width` — so a single
 * mistyped 0 turns every date in the plan into `Infinity`, and no screen
 * anywhere could say why. This validation is the whole of what stands between
 * that and the column.
 *
 * The ceiling is {@link MOST_PEOPLE_AT_ONCE}, and it moved into `libs/domain` in
 * `capacity-per-project`: three boundaries state it now, this file's copy and
 * `directory.controller.ts`'s agreed by luck, and the third would have been where
 * they drifted. The argument for the number is on the constant.
 *
 * `Number.isSafeInteger` covers the fraction, the `NaN`, the infinity and the
 * value beyond what an integer column can hold in one question — which is why
 * the ceiling's own negative uses `1001` and not `1e999`: `1e999` parses to
 * `Infinity`, `Number.isInteger(Infinity)` is false, and a range check deleted
 * under a `1e999` probe would stay green. That exact vacuous check has shipped
 * here before (`T1 column-widths-drag`).
 */
function asOptionalParallelism(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // Proof: this throw deleted, so the value is taken as it arrives, and
  // `refuses a parallelism that is not a whole number of 1 or more` failed on
  // the very first value — `[500, "0"]` where `[400, "0"]` was owed. The 500 is
  // the second half of the answer and is worth reading: a `0` written here
  // reaches `widthFor`, comes out as a width of 0, and `groupByWorkItem`'s
  // refusal throws — so **every read of that project 500s** until somebody
  // finds the row. Watched 2026-08-12.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequest(`${field}_must_be_a_whole_number_from_1`);
  }
  // Proof: `<= MOST_PEOPLE_AT_ONCE` deleted with the integer guard left in
  // place, and `refuses a parallelism above what a plan can mean` failed on
  // `Expected: 400, Received: 200` — a thousand and one people on one work
  // item, taken. Injected separately from the guard above because each is
  // invisible to the other's probe; watched 2026-08-12.
  if (value > MOST_PEOPLE_AT_ONCE) {
    throw new BadRequest(`${field}_must_be_at_most_${String(MOST_PEOPLE_AT_ONCE)}`);
  }
  return value;
}

function parsePatch(body: unknown): {
  name?: string;
  notes?: string;
  startNoEarlierThan?: IsoDate | null;
  startNoEarlierThanReason?: string | null;
  priority?: number | null;
  serviceTeamId?: string | null;
  teamIds?: readonly string[];
  serviceIds?: readonly string[];
  maxParallel?: number | null;
  tagIds?: readonly string[];
} {
  const raw = asRecord(body);
  refuseDerivedFields(raw);
  if ('teamIds' in raw && 'serviceTeamId' in raw) {
    throw new BadRequest('cannot_send_both_teamIds_and_serviceTeamId');
  }
  return {
    name: asOptionalText(raw['name'], 'name'),
    notes: asOptionalText(raw['notes'], 'notes'),
    startNoEarlierThan: asOptionalDate(raw['startNoEarlierThan'], 'startNoEarlierThan'),
    startNoEarlierThanReason: asOptionalReason(
      raw['startNoEarlierThanReason'],
      'startNoEarlierThanReason',
    ),
    priority: asOptionalPriority(raw['priority'], 'priority'),
    serviceTeamId:
      'serviceTeamId' in raw ? asIdOrNull(raw['serviceTeamId'], 'serviceTeamId') : undefined,
    teamIds: asOptionalLabelIds(raw['teamIds'], 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
    // A plain read, and the `in` check the singleton needed is gone with it:
    // `null` was a value while this was a column, so absent and null had to be
    // told apart. The set has one spelling for taking the label off — `[]` — and
    // `undefined` for leaving it alone, which is what a plain read already gives.
    serviceIds: asOptionalLabelIds(raw['serviceIds'], 'serviceIds', MOST_SERVICES_ON_ONE_ITEM),
    maxParallel: asOptionalParallelism(raw['maxParallel'], 'maxParallel'),
    tagIds: asOptionalLabelIds(raw['tagIds'], 'tagIds', MOST_TAGS_ON_ONE_ITEM),
  };
}

/**
 * `cycle` is 409 rather than 400: the request is well formed and would be legal
 * against a different tree, so it conflicts with the current state rather than
 * being malformed. `strategy_required` is 400 — that request is incomplete.
 *
 * `too_large` joins the 409s for the same reason: a duplication refused for the
 * size of the subtree beneath it would have been legal against a smaller one,
 * and the request itself is fine. It is not 413 — nothing about the request
 * body is too big.
 *
 * `unknown_person`, `unknown_team`, `unknown_tag` and `unknown_service` join
 * `unknown_role` on 404: an id the directory no longer holds is a thing that is
 * not there, whichever of the request's ids named it.
 *
 * `has_children` falls through to **400**, which is the capacity plan's own
 * table (§5.1) and is a deliberate split from `rolled_up`'s 409 beside it. The
 * two refuse the same shape of row for different reasons: an estimate on a
 * parent would be *ignored or double-counted* — a legal request against a
 * tree that had no children yet — while a parallelism there is a field the
 * client should never have offered, because the cell for it is read-only on
 * every parent row. 400 says "do not send this"; 409 says "try again against a
 * different tree". Recorded in `design.md` because the two sitting side by side
 * will look like an oversight otherwise.
 */
const statusFor = (reason: WorkItemRefusal): number =>
  reason === 'forbidden'
    ? 403
    : reason === 'not_found' ||
        reason === 'unknown_role' ||
        reason === 'unknown_person' ||
        reason === 'unknown_team' ||
        reason === 'unknown_tag' ||
        reason === 'unknown_service' ||
        // The one refusal on this list that is not an id: a metric outside the
        // closed set names a unit this release does not keep, and it arrives in
        // the path exactly as an id does. `WorkItemRefusal` argues why that is
        // a 404 rather than the 400 the fallthrough would give it.
        reason === 'unknown_metric'
      ? 404
      : reason === 'cycle' ||
          reason === 'frozen' ||
          reason === 'rolled_up' ||
          reason === 'ancestor' ||
          reason === 'too_large'
        ? 409
        : 400;

/**
 * How an undo or a redo answers, in one place because the two routes must
 * answer identically.
 *
 * Both refusals are 409. Neither request is malformed and both would have
 * worked a moment earlier: an empty stack and a moved revision are states of
 * the plan, not faults in what was asked. `stale_undo` carries the `detail`
 * saying **which** row moved, because "that could not be undone" with no
 * reason is a dead end for the person reading it — the whole point of this
 * change is that a refusal says why out loud.
 */
function answerUndo(outcome: UndoOutcome, set: { status?: number | string }) {
  if (outcome.ok) return { done: outcome.result.done, detail: outcome.result.detail };
  if (outcome.reason === 'forbidden') {
    set.status = 403;
    return { error: outcome.reason };
  }
  if (outcome.reason === 'not_found') {
    set.status = 404;
    return { error: outcome.reason };
  }
  set.status = 409;
  return { error: outcome.reason, detail: outcome.detail };
}

const isStrategy = (value: string | null): value is DeleteStrategy =>
  value === 'cascade' || value === 'promote';

export function workItemController(auth: AuthService, workItems: WorkItemService) {
  return new Elysia({ prefix: '/api' })
    .onError(({ error, set }) => {
      if (error instanceof BadRequest) {
        set.status = 400;
        return { error: error.reason };
      }
      // The shared schema's refusal is a 400 here rather than a 500: the two
      // tiers validate with the same arktype schema, so this is a client that
      // bypassed fe-01 rather than a fault in either.
      if (error instanceof ValidationError) {
        set.status = 400;
        return { error: 'invalid_estimate' };
      }
      return undefined;
    })
    .get('/projects/:id/work-items', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const tree = await workItems.tree(params.id);
      if (tree === null) {
        set.status = 404;
        return { error: 'not_found' };
      }
      // Carried on the tree rather than fetched from a route of its own. The
      // tree is already read after every change this client makes and after
      // every event from anybody else, which is exactly when the answer can
      // have changed — a second endpoint would be a second round trip asking
      // the same question at the same moments. It is per **account**, which is
      // why it is added here and not inside `tree`: the broadcast reuses that
      // read and has nobody to answer for.
      return { ...tree, ...(await workItems.undoState(params.id, user.id)) };
    })
    .post(
      '/projects/:id/work-items',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await workItems.create(params.id, user.id, parseCreate(body));
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return outcome.result;
      },
      {
        detail: {
          summary: 'Add a work item to a project',
          description: `Its number is **not** part of the request: numbers are derived from the tree and
re-derived on every read, so a body naming \`number\` or \`frozenNumber\` is refused
rather than ignored.

Body refusals, all 400 and each carried as \`{ "error": "<code>" }\`:
\`expected_object\`, \`number_is_derived\`, \`parentId_must_be_id_or_null\`,
\`afterId_must_be_id_or_null\`, \`name_must_be_text\`, \`notes_must_be_text\`.`,
          requestBody: handParsedBody(
            'Where the row goes and what it is called. Every field may be absent.',
            {
              type: 'object',
              properties: {
                parentId: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The work item it goes under. Null or absent puts it at the top level.',
                },
                afterId: {
                  type: 'string',
                  nullable: true,
                  description:
                    'The sibling it is placed after; it must already sit under `parentId`. Null or absent puts it first in that group.',
                },
                name: { type: 'string', description: 'Its name. Absent leaves it unnamed.' },
                notes: { type: 'string', description: 'Free text shown on the row.' },
              },
            },
          ),
        },
      },
    )
    .patch(
      '/work-items/:id',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await workItems.patch(params.id, user.id, parsePatch(body));
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return outcome.result;
      },
      {
        detail: {
          summary: "Change a work item's own fields",
          description: `Every field is optional and an absent one is left alone; \`null\` where the field
allows it is the clear. Dates, floats and slices are **not** here — they are
computed from the tree, which is why \`number\` and \`frozenNumber\` are refused
rather than ignored. Re-read \`GET /api/projects/{id}/work-items\` afterwards: one
patch can move every date in the plan.

Body refusals, all 400: \`expected_object\`, \`number_is_derived\`,
\`name_must_be_text\`, \`notes_must_be_text\`, \`startNoEarlierThan_must_be_a_date\`,
\`startNoEarlierThanReason_must_be_text\`,
\`startNoEarlierThanReason_must_be_at_most_200_characters\`,
\`priority_must_be_a_whole_number_from_1\`, \`serviceTeamId_must_be_id_or_null\`,
\`teamIds_must_be_a_list_of_ids\`, \`teamIds_must_be_at_most_10\`,
\`cannot_send_both_teamIds_and_serviceTeamId\`,
\`serviceIds_must_be_a_list_of_ids\`, \`serviceIds_must_be_at_most_10\`,
\`maxParallel_must_be_a_whole_number_from_1\`,
\`maxParallel_must_be_at_most_1000\`. A parallelism on a row that has children is
\`has_children\`, also 400 — the cell is read-only on every parent. A patch that
would leave the row holding a reason with no \`startNoEarlierThan\` for it to be
about is \`not_before_reason_needs_a_date\`, also 400: **clearing the date clears
neither the words nor itself**, so send both as \`null\` in the one request.`,
          requestBody: handParsedBody('The fields to change. Send only the ones you mean.', {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'What the work item is called.' },
              notes: { type: 'string', description: 'Free text shown on the row.' },
              startNoEarlierThan: {
                type: 'string',
                nullable: true,
                description:
                  'A calendar day, `YYYY-MM-DD`, before which this work may not start. Null lifts the constraint. A shape-valid non-day like `2026-02-31` is refused.',
              },
              startNoEarlierThanReason: {
                type: 'string',
                nullable: true,
                maxLength: LONGEST_NOT_BEFORE_REASON,
                description:
                  'Why the work may not start yet, in the planner’s own words — *“waiting on client sign-off”*. Words about `startNoEarlierThan` and nothing else: it is not a status, it holds nothing back on its own, and no date moves because of it. Meaningless without a date and refused without one, so clearing `startNoEarlierThan` means sending this as null in the same request. A blank is stored as null; whitespace is trimmed.',
              },
              priority: {
                type: 'integer',
                nullable: true,
                minimum: 1,
                description:
                  'A whole number from 1, lower being more important. There is no ceiling — how far a planner’s own scale runs is not this API’s to decide. Null leaves the work unprioritised.',
              },
              teamIds: {
                type: 'array',
                items: { type: 'string' },
                maxItems: MOST_TEAMS_ON_ONE_ITEM,
                description:
                  'The teams whose people do this work, by id from `GET /api/teams`, as the whole own set. `[]` clears the own set and reveals inherited teams; omit the field to leave it alone. Duplicate ids are accepted and stored once. An unknown id refuses the whole patch with 404 `unknown_team`. Do not send this together with legacy `serviceTeamId`.',
              },
              serviceTeamId: {
                type: 'string',
                nullable: true,
                description:
                  'Legacy one-release spelling for the row’s own team. Null clears it. Do not send together with `teamIds`.',
              },
              serviceIds: {
                type: 'array',
                items: { type: 'string' },
                maxItems: MOST_SERVICES_ON_ONE_ITEM,
                description:
                  'The services this work delivers, by id, as the whole set — a patch replaces it rather than adding to it. `[]` clears the label, which puts the row back to inheriting its ancestors’ services; omit the field to leave the dimension alone. Independent of `serviceTeamId` beside it: a team is who does the work, a service is what the work is part of. An id the directory no longer holds refuses the whole patch with 404 `unknown_service`.',
              },
              maxParallel: {
                type: 'integer',
                nullable: true,
                minimum: 1,
                maximum: 1000,
                description:
                  'How many people may be on this work item at once, 1 to 1000. Null puts it back to one at a time. The floor is correctness, not taste: duration is effort ÷ width, so a 0 would make every date in the plan `Infinity`.',
              },
            },
          }),
        },
      },
    )
    .put(
      '/work-items/:id/assignees/:roleId',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        // `null` clears the assignment; anything else must be an id. A person
        // who is not in the directory is refused by the foreign key rather than
        // by a lookup here, which two concurrent requests could both pass.
        const raw = asRecord(body);
        const personId = asIdOrNull(raw['personId'], 'personId');
        const outcome = await workItems.assign(params.id, user.id, params.roleId, personId);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { assigned: true };
      },
      {
        detail: {
          summary: 'Assign a person to one role on one work item, or clear the assignment',
          description: `\`roleId\` must be a role of the project this work item belongs to; one that is not
is \`unknown_role\`, 404. An id the directory no longer holds is refused by the
foreign key rather than by a lookup here, because two concurrent requests could
both pass a lookup.

Body refusals, both 400: \`expected_object\`, \`personId_must_be_id_or_null\`.`,
          requestBody: handParsedBody('Who does this role here.', {
            type: 'object',
            properties: {
              personId: {
                type: 'string',
                nullable: true,
                description:
                  'The person, by id from `GET /api/people`. Null — or an absent field — clears the assignment.',
              },
            },
          }),
        },
      },
    )
    .post(
      '/work-items/:id/move',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await workItems.move(params.id, user.id, parseMove(body));
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { moved: true };
      },
      {
        detail: {
          summary: 'Move a work item under a new parent, or to a new position among its siblings',
          description: `A move that would put a row inside its own subtree is \`cycle\`, 409 — the request is
well formed and would have worked against a different tree. A frozen work item is
\`frozen\`, also 409. Numbers are re-derived afterwards, so every row's number may
change.

Body refusals, all 400: \`expected_object\`, \`parentId_must_be_id_or_null\`,
\`afterId_must_be_id_or_null\`.`,
          requestBody: handParsedBody('Where the work item goes.', {
            type: 'object',
            properties: {
              parentId: {
                type: 'string',
                nullable: true,
                description: 'The work item it goes under. Null moves it to the top level.',
              },
              afterId: {
                type: 'string',
                nullable: true,
                description:
                  'The sibling it goes after; it must already sit under `parentId`. Null puts it first in that group.',
              },
            },
          }),
        },
      },
    )
    .post('/work-items/:id/duplicate', async ({ params, headers, set }) => {
      // No body is read: what is copied and where it lands are the rule, not
      // the caller's to choose. A body would be options nobody has asked for
      // yet, and every one of them would have to survive forever.
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.duplicate(params.id, user.id);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return outcome.result;
    })
    .post('/projects/:id/undo', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return answerUndo(await workItems.undo(params.id, user.id), set);
    })
    .post('/projects/:id/redo', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return answerUndo(await workItems.redo(params.id, user.id), set);
    })
    .post('/projects/:id/freeze', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.freeze(params.id, user.id);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { frozen: true };
    })
    .post('/projects/:id/unfreeze', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.unfreezeProject(params.id, user.id);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { unfrozen: true };
    })
    .post(
      '/work-items/:id/dependencies',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        // Parsed by hand rather than through Elysia's `body` schema: Elysia strips
        // unknown properties before the handler, so a typo'd field name would
        // arrive as an absent one and the route would answer 200 having done
        // nothing. The same reason the create route parses its own body.
        const parsed: unknown = body;
        const predecessorId =
          typeof parsed === 'object' && parsed !== null && 'predecessorId' in parsed
            ? parsed.predecessorId
            : undefined;
        if (typeof predecessorId !== 'string' || predecessorId === '') {
          set.status = 400;
          return { error: 'predecessor_required' };
        }
        const outcome = await workItems.addDependency(params.id, user.id, predecessorId);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { ok: true };
      },
      {
        detail: {
          summary: 'Make this work item wait for another',
          description: `What the wait means: this work starts no earlier than the predecessor's **first
estimated role** — its anchor — not its finish. A blank leading role is stepped
over, and a wholly unestimated predecessor falls back to its own finish.

An edge that would close a loop is \`cycle\`, 409. A missing, empty or non-string
\`predecessorId\` is \`predecessor_required\`, 400.`,
          requestBody: handParsedBody('The work item this one waits for.', {
            type: 'object',
            required: ['predecessorId'],
            properties: {
              predecessorId: {
                type: 'string',
                description: 'The predecessor, by work item id. Must not be empty.',
              },
            },
          }),
        },
      },
    )
    .delete('/work-items/:id/dependencies/:predecessorId', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.removeDependency(params.id, user.id, params.predecessorId);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { ok: true };
    })
    .post('/work-items/:id/unfreeze', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.unfreeze(params.id, user.id);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { unfrozen: true };
    })
    .put(
      '/work-items/:id/estimates/:roleId',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const days = parseOrThrow(ThreePointEstimate, body);
        const outcome = await workItems.setEstimate(params.id, user.id, params.roleId, days);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { estimated: true };
      },
      {
        detail: {
          summary: 'Set one role’s three-point estimate on one work item',
          description: `**Days, and fractions are real** — half a day is an estimate, and rounding it up is
a lie the plan then carries. The project turns the three into the one number it
plans with, by default PERT: \`(optimistic + 4 × realistic + pessimistic) / 6\`,
weighted four times on the figure somebody actually thought about, and fractional
on purpose. A \`2 / 3 / 10\` estimate expects 4 days, not 6.

An estimate on a row that has children is \`rolled_up\`, 409 — a parent's figures
are sums. A \`roleId\` that is not a role of this project is \`unknown_role\`, 404.
A body that is not three ordered non-negative numbers is \`invalid_estimate\`, 400.

Validated by the same shared schema fe-01 uses rather than by hand, so this is
the one body-carrying route whose refusal is a shared-schema refusal.`,
          requestBody: handParsedBody(
            'Three durations in days for this role on this work item, ordered `optimistic ≤ realistic ≤ pessimistic`.',
            {
              type: 'object',
              required: ['optimistic', 'realistic', 'pessimistic'],
              properties: {
                optimistic: {
                  type: 'number',
                  minimum: 0,
                  description: 'Days, if no unknown unknowns appear.',
                },
                realistic: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Days, the best guess — not the midpoint of the other two, which is why it is checked to sit between them.',
                },
                pessimistic: {
                  type: 'number',
                  minimum: 0,
                  description: 'Days, if every unknown you can sense does appear.',
                },
              },
            },
          ),
        },
      },
    )
    .delete('/work-items/:id/estimates/:roleId', async ({ params, headers, set }) => {
      // Guarded exactly as the PUT above, and for the same reason: taking a
      // trio away changes the plan as much as writing one does. Clearing an
      // estimate that is not stored answers 200 rather than 404 — the
      // estimate is what the request addresses, and its absence is the
      // outcome asked for. A missing work item is still 404.
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.clearEstimate(params.id, user.id, params.roleId);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { cleared: true };
    })
    .put(
      '/work-items/:id/actuals/:roleId',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const days = parseActual(body);
        const outcome = await workItems.setActual(params.id, user.id, params.roleId, days);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { recorded: true };
      },
      {
        detail: {
          summary: 'Record the days one role actually spent on one work item',
          description: `**Reporting only. This moves no date.** The plan's dates come from the
three-point estimates through the scheduler, and no part of the engine reads this
number: an item recorded as having taken 8 days against an estimate of 5 leaves
every successor exactly where it was. The reason is that the model has no
completion state — there is no started, finished or percent-done anywhere — so
"took 8 days" and "8 days so far" are the same row, and they mean opposite things
for whatever comes next. The tool reports the drift; a person decides whether to
re-estimate.

**One number, per role, on a leaf.** An actual on a row that has children is
\`rolled_up\`, 409 — a parent's recorded days are the sum of its descendants'.
A \`roleId\` that is not a role of this project is \`unknown_role\`, 404.
A body without a finite \`days\` of 0 or more is \`invalid_actual\`, 400.

**Zero is a statement and absence is not.** Recording 0 says the work took no
days. Saying nobody has recorded anything is \`DELETE\` on this path — never a
zero, which is the rule every figure in this API follows.`,
          requestBody: handParsedBody('The days this role spent on this work item.', {
            type: 'object',
            required: ['days'],
            properties: {
              days: {
                type: 'number',
                minimum: 0,
                description:
                  'Days actually spent. Fractions are real, as they are for an estimate. 0 means the work took no days, which is not the same as never having said.',
              },
            },
          }),
        },
      },
    )
    .put(
      '/work-items/:id/progress/:roleId',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const state = parseProgress(body);
        const outcome = await workItems.setProgress(params.id, user.id, params.roleId, state);
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { stated: true };
      },
      {
        detail: {
          summary: "Say where one role's work on one work item has got to",
          description: `**Reporting only. This moves no date.** Marking a role \`done\` changes no
bar, no successor and no critical path: the plan's dates still come from the
three-point estimates through the scheduler, and nothing in the engine reads this.
What it changes is whether the figure beside it can be read at all — 8 days spent
against 5 estimated is *"overran by 3"* when the role is done and *"is 3 over so
far"* when it is not, and those are different sentences about the same two
numbers.

**Three states, and only two of them are written here.** \`in_progress\` and
\`done\` are rows; **not started is the absence of a row**, so the way to say it
is \`DELETE\` on this path. A body whose \`state\` is anything else — including
\`not_started\` — is \`invalid_progress\`, 400. There is no \`blocked\` and no
\`cancelled\`.

**Per role, on a leaf.** A statement about a row that has children is
\`rolled_up\`, 409 — a parent's state is folded from its descendants'. A
\`roleId\` that is not a role of this project is \`unknown_role\`, 404.

**A work item's own state is derived and never stored.** It is \`done\` when every
role with work on the row says so, \`not_started\` when none of them has said
anything, and \`in_progress\` for every disagreement in between — including one
role finished while another has said nothing, which is an unfinished item.

**What \`done\` makes true:** an actual on a role marked done is **final** — the
whole of what that role spent, not a running count.`,
          requestBody: handParsedBody('Where this role has got to on this work item.', {
            type: 'object',
            required: ['state'],
            properties: {
              state: {
                type: 'string',
                enum: ['in_progress', 'done'],
                description:
                  'Where the work has got to. Not started is the absence of a statement — DELETE this path rather than sending it.',
              },
            },
          }),
        },
      },
    )
    .delete('/work-items/:id/progress/:roleId', async ({ params, headers, set }) => {
      // Guarded exactly as the PUT above. Clearing a statement nobody made
      // answers 200 rather than 404, for the reason the estimate's DELETE
      // gives. Worth being plain about what it means: this does not say the
      // work was undone, it says nobody has spoken about it — which is the
      // third state, spelled the only way it is ever spelled.
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.clearProgress(params.id, user.id, params.roleId);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { cleared: true };
    })
    .delete('/work-items/:id/actuals/:roleId', async ({ params, headers, set }) => {
      // Guarded exactly as the PUT above. Clearing days that were never
      // recorded answers 200 rather than 404, for the reason the estimate's
      // DELETE gives: the record is what the request addresses and its absence
      // is the outcome asked for. A missing work item is still 404.
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.clearActual(params.id, user.id, params.roleId);
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { cleared: true };
    })
    .put(
      '/work-items/:id/measures/:metric/:roleId',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const value = parseMeasure(body);
        // `params.metric` is a string and stays one all the way into the
        // service, which narrows it. Checking the set here as well would put
        // the closed set in two places that must agree, and the one that
        // decides is the one beside the write.
        const outcome = await workItems.setMeasure(
          params.id,
          user.id,
          params.roleId,
          params.metric,
          value,
        );
        if (!outcome.ok) {
          set.status = statusFor(outcome.reason);
          return { error: outcome.reason };
        }
        return { recorded: true };
      },
      {
        detail: {
          summary: 'Record one role’s figure on one work item, in a unit other than days',
          description: `**Written by agents, not typed by people.** Dany, 2026-08-21:
_"Tokens are to be set by LLM. So they do not require a separate input to be
imputed by humans."_ This route is the product surface for token figures — there
is no cell in the grid to type them into, and the reading surfaces are columns
and roll-ups. Hours are the same shape and arrive the same way.

**Reporting only. This moves no date.** The scheduler plans in days against team
capacity, and nothing in the engine reads these numbers: tokens are not a
substitutable unit of capacity, so an item recorded as having taken 900k tokens
leaves every successor exactly where it was.

**Three units, one route.** \`metric\` is one of \`token_estimate\` (the tokens
a role's work is expected to take), \`token_actual\` (the tokens it took) and
\`hours_actual\` (the hours it took). Anything else is \`unknown_metric\`, **404**
— the path names a unit this release does not keep, which is a thing that is not
there rather than a malformed request.

**One number, per role, on a leaf.** A figure on a row that has children is
\`rolled_up\`, 409 — a parent's figure is the sum of its descendants'. A
\`roleId\` that is not a role of this project is \`unknown_role\`, 404. A body
without a finite \`value\` of 0 or more is \`invalid_measure\`, 400.

**Each metric stands alone.** Recording a \`token_actual\` leaves that pair's
\`token_estimate\` and \`hours_actual\` exactly as they were, and clearing one
clears one.

**Zero is a statement and absence is not.** Recording 0 says the work cost
nothing in this unit. Saying nobody has recorded anything is \`DELETE\` on this
path — never a zero.`,
          requestBody: handParsedBody(
            'The figure this role’s work cost, in the unit named by the path.',
            {
              type: 'object',
              required: ['value'],
              properties: {
                value: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'The figure, in the unit the path names. Fractions are accepted, as they are for days. 0 means the work cost nothing in this unit, which is not the same as never having said.',
                },
              },
            },
          ),
        },
      },
    )
    .delete('/work-items/:id/measures/:metric/:roleId', async ({ params, headers, set }) => {
      // Guarded exactly as the PUT above. Clearing a figure that was never
      // recorded answers 200, for the reason the estimate's DELETE gives; a
      // missing work item is still 404, and a **metric this release does not
      // keep is still 404** rather than a success — idempotence is about a row
      // that is not there, not about a unit that does not exist.
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await workItems.clearMeasure(
        params.id,
        user.id,
        params.roleId,
        params.metric,
      );
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { cleared: true };
    })
    .delete('/work-items/:id', async ({ params, request, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      // Read from the URL rather than Elysia's `query`, which types every value
      // as present — a request without `?strategy=` genuinely has none, and that
      // absence is what `strategy_required` exists to catch.
      const requested = new URL(request.url).searchParams.get('strategy');
      // An unrecognised strategy is refused rather than read as absent: the
      // caller asked for something specific, and cascade and promote destroy
      // different work.
      if (requested !== null && !isStrategy(requested)) {
        set.status = 400;
        return { error: 'unknown_strategy' };
      }
      const outcome = await workItems.remove(
        params.id,
        user.id,
        isStrategy(requested) ? requested : null,
      );
      if (!outcome.ok) {
        set.status = statusFor(outcome.reason);
        return { error: outcome.reason };
      }
      return { deleted: true };
    });
}
