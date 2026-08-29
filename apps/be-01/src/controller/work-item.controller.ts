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
import {
  PLAN_COMMAND_KINDS,
  type PlanCommand,
  type PlanCommandKind,
} from '../service/plan-command';
import type { PlanCommandRunner } from '../service/plan-commands';
import type {
  CreateWorkItem,
  DeleteStrategy,
  MoveWorkItem,
  UndoOutcome,
  WorkItemService,
} from '../service/work-item.service';
import { BadCapacity, capacityOf } from './capacity.controller';
import { PLAN_COMMANDS_BODY } from './plan-command-schema';
import { BadLadder, ladderOf } from './priority-band.controller';

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
  constructor(
    public readonly reason: string,
    /** Which command of a batch, where the body was one. */
    public readonly at?: number,
    /** That command's kind, where it named a known one. */
    public readonly kind?: string,
  ) {
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

/** A string, or the field's `_must_be_text` refusal. */
function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BadRequest(`${field}_must_be_text`);
  return value;
}

/** An id, or the field's `_must_be_an_id` refusal; absent is allowed for a `…Ref`. */
function asOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${field}_must_be_an_id`);
  return value;
}

/** A boolean or absent, or the field's refusal. */
function asOptionalFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequest(`${field}_must_be_true_or_false`);
  return value;
}

/** Drops the fields whose value is `undefined`, so an absent field stays absent on the wire. */
function present<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/**
 * One command of a batch, validated exactly as the write it stands for was on
 * its own route — the same parsers, the same codes — with the batch's own
 * fields (`ref`, the `…Ref` names) checked beside them. This is the API's input
 * boundary for a batch; the services judge the rest, as they always did.
 *
 * @throws {BadRequest} carrying the command's index.
 */
function parseCommand(step: unknown, at: number): PlanCommand {
  if (typeof step !== 'object' || step === null) throw new BadRequest('expected_object', at);
  const raw = step as Record<string, unknown>;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(PLAN_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequest('unknown_kind', at);
  }
  try {
    return parseKind(kind as PlanCommandKind, raw);
  } catch (cause) {
    // The parsers' own refusals, given the index; a schema refusal from the
    // estimate's arktype check is the code its route answered with.
    if (cause instanceof BadRequest) throw new BadRequest(cause.reason, at, kind);
    if (cause instanceof BadCapacity || cause instanceof BadLadder) {
      throw new BadRequest(cause.reason, at, kind);
    }
    if (cause instanceof ValidationError) throw new BadRequest('invalid_estimate', at, kind);
    throw cause;
  }
}

function parseKind(kind: PlanCommandKind, raw: Record<string, unknown>): PlanCommand {
  const target = present({
    workItemId: asOptionalId(raw['workItemId'], 'workItemId'),
    workItemRef: asOptionalId(raw['workItemRef'], 'workItemRef'),
  });
  // Read only by the kinds that carry a role; eager, it would refuse a create.
  const role = (): { roleId: string } => ({ roleId: asText(raw['roleId'], 'roleId') });
  const ref = present({ ref: asOptionalId(raw['ref'], 'ref') });
  switch (kind) {
    case 'createWorkItem': {
      const created = parseCreate(raw);
      return present({
        kind,
        ...ref,
        parentId: created.parentId,
        parentRef: asOptionalId(raw['parentRef'], 'parentRef'),
        afterId: created.afterId,
        afterRef: asOptionalId(raw['afterRef'], 'afterRef'),
        name: created.name,
        notes: created.notes,
      });
    }
    case 'patchWorkItem': {
      const patchRaw = asRecord(raw['patch']);
      const patch = present({
        ...parsePatch(patchRaw),
        serviceRefs: asOptionalLabelIds(
          patchRaw['serviceRefs'],
          'serviceRefs',
          MOST_SERVICES_ON_ONE_ITEM,
        ),
        tagRefs: asOptionalLabelIds(patchRaw['tagRefs'], 'tagRefs', MOST_TAGS_ON_ONE_ITEM),
        teamRefs: asOptionalLabelIds(patchRaw['teamRefs'], 'teamRefs', MOST_TEAMS_ON_ONE_ITEM),
      });
      return {
        kind,
        ...target,
        patch: patch as PlanCommand extends { kind: 'patchWorkItem'; patch: infer P } ? P : never,
      };
    }
    case 'moveWorkItem': {
      const moved = parseMove(raw);
      return present({
        kind,
        ...target,
        parentId: moved.parentId,
        parentRef: asOptionalId(raw['parentRef'], 'parentRef'),
        afterId: moved.afterId,
        afterRef: asOptionalId(raw['afterRef'], 'afterRef'),
      });
    }
    case 'duplicateWorkItem':
      return { kind, ...target, ...ref };
    case 'deleteWorkItem': {
      const strategy = raw['strategy'];
      if (strategy !== undefined && !(typeof strategy === 'string' && isStrategy(strategy))) {
        throw new BadRequest('unknown_strategy');
      }
      return present({ kind, ...target, strategy });
    }
    case 'setEstimate':
      return { kind, ...target, ...role(), days: parseOrThrow(ThreePointEstimate, raw['days']) };
    case 'clearEstimate':
    case 'clearActual':
    case 'clearProgress':
      return { kind, ...target, ...role() };
    case 'setActual':
      return { kind, ...target, ...role(), days: parseActual(raw) };
    case 'setProgress':
      return { kind, ...target, ...role(), state: parseProgress(raw) };
    // The metric is text here and judged by the service, as the retired route
    // left it: `unknown_metric` is a 404 — a unit this release does not keep,
    // arriving where an id does — and a parser refusal would make it a 400.
    case 'setMeasure':
      return {
        kind,
        ...target,
        ...role(),
        metric: asText(raw['metric'], 'metric'),
        value: parseMeasure(raw),
      };
    case 'clearMeasure':
      return { kind, ...target, ...role(), metric: asText(raw['metric'], 'metric') };
    case 'setAssignee':
      return present({
        kind,
        ...target,
        ...role(),
        personId: asIdOrNull(raw['personId'], 'personId'),
        personRef: asOptionalId(raw['personRef'], 'personRef'),
      });
    case 'addDependency':
    case 'removeDependency':
      return present({
        kind,
        ...target,
        predecessorId: asOptionalId(raw['predecessorId'], 'predecessorId'),
        predecessorRef: asOptionalId(raw['predecessorRef'], 'predecessorRef'),
      });
    case 'freezeProject':
    case 'unfreezeProject':
      return { kind };
    case 'unfreezeWorkItem':
      return { kind, ...target };
    case 'setCapacity':
      return present({
        kind,
        teamId: asOptionalId(raw['teamId'], 'teamId'),
        teamRef: asOptionalId(raw['teamRef'], 'teamRef'),
        size: capacityOf(raw),
      });
    case 'setPriorityBands':
      return { kind, bands: ladderOf(raw) };
    case 'createTeam':
    case 'createTag':
    case 'createService':
      return { kind, ...ref, name: asText(raw['name'], 'name') };
    case 'createPerson':
      return present({
        kind,
        ...ref,
        name: asText(raw['name'], 'name'),
        teamIds: asOptionalLabelIds(raw['teamIds'], 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
        teamRefs: asOptionalLabelIds(raw['teamRefs'], 'teamRefs', MOST_TEAMS_ON_ONE_ITEM),
      });
    case 'patchTeam': {
      const patch = asRecord(raw['patch']);
      return present({
        kind,
        teamId: asOptionalId(raw['teamId'], 'teamId'),
        teamRef: asOptionalId(raw['teamRef'], 'teamRef'),
        patch: present({
          name: asOptionalText(patch['name'], 'name'),
          serviceIds: asOptionalLabelIds(
            patch['serviceIds'],
            'serviceIds',
            MOST_SERVICES_ON_ONE_ITEM,
          ),
        }),
      });
    }
    case 'patchPerson': {
      const patch = asRecord(raw['patch']);
      return present({
        kind,
        personId: asOptionalId(raw['personId'], 'personId'),
        personRef: asOptionalId(raw['personRef'], 'personRef'),
        patch: present({
          name: asOptionalText(patch['name'], 'name'),
          teamIds: asOptionalLabelIds(patch['teamIds'], 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
          kind: asOptionalText(patch['kind'], 'kind'),
        }),
      });
    }
    case 'patchTag':
      return present({
        kind,
        tagId: asOptionalId(raw['tagId'], 'tagId'),
        tagRef: asOptionalId(raw['tagRef'], 'tagRef'),
        name: asText(raw['name'], 'name'),
      });
    case 'patchService':
      return present({
        kind,
        serviceId: asOptionalId(raw['serviceId'], 'serviceId'),
        serviceRef: asOptionalId(raw['serviceRef'], 'serviceRef'),
        name: asText(raw['name'], 'name'),
      });
    case 'deleteTeam':
      return present({
        kind,
        teamId: asOptionalId(raw['teamId'], 'teamId'),
        teamRef: asOptionalId(raw['teamRef'], 'teamRef'),
        cascade: asOptionalFlag(raw['cascade'], 'cascade'),
      });
    case 'deletePerson':
      return present({
        kind,
        personId: asOptionalId(raw['personId'], 'personId'),
        personRef: asOptionalId(raw['personRef'], 'personRef'),
        cascade: asOptionalFlag(raw['cascade'], 'cascade'),
      });
    case 'deleteTag':
      return present({
        kind,
        tagId: asOptionalId(raw['tagId'], 'tagId'),
        tagRef: asOptionalId(raw['tagRef'], 'tagRef'),
        cascade: asOptionalFlag(raw['cascade'], 'cascade'),
      });
    case 'deleteService':
      return present({
        kind,
        serviceId: asOptionalId(raw['serviceId'], 'serviceId'),
        serviceRef: asOptionalId(raw['serviceRef'], 'serviceRef'),
        cascade: asOptionalFlag(raw['cascade'], 'cascade'),
      });
  }
}

/**
 * A command batch as the wire carries it: an object with a `commands` list, each
 * command validated by {@link parseCommand}.
 *
 * @throws {BadRequest} with `at` set, so the answer names the command.
 */
function parseBatch(body: unknown): PlanCommand[] {
  const record = asRecord(body);
  const list = record['commands'];
  if (!Array.isArray(list)) throw new BadRequest('commands_must_be_a_list');
  return list.map((step, at) => parseCommand(step, at));
}

/**
 * `statusFor`, widened to what a batch can refuse with: the work-item ladder,
 * the directory's `taken`/`in_use` (409, as `cycle` is), the runner's own
 * `unknown_ref`/`duplicate_ref`/`too_many_commands`/`missing_id`/`name_required`
 * (400), and the capacity/priority refusals that share `not_found`/`forbidden`.
 */
function statusForBatch(reason: string): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'not_found' || reason.startsWith('unknown_')) {
    return reason === 'unknown_ref' ? 400 : 404;
  }
  if (
    ['cycle', 'frozen', 'rolled_up', 'ancestor', 'too_large', 'taken', 'in_use'].includes(reason)
  ) {
    return 409;
  }
  return 400;
}

export function workItemController(
  auth: AuthService,
  workItems: WorkItemService,
  commands: PlanCommandRunner,
) {
  return new Elysia({ prefix: '/api' })
    .onError(({ error, set }) => {
      if (error instanceof BadRequest) {
        set.status = 400;
        if (error.at === undefined) return { error: error.reason };
        return error.kind === undefined
          ? { error: error.reason, at: error.at }
          : { error: error.reason, at: error.at, kind: error.kind };
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
      '/projects/:id/commands',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await commands.run(params.id, user.id, parseBatch(body));
        if (!outcome.ok) {
          set.status = statusForBatch(outcome.reason);
          // The refusal's own fields beside the code, as the single route
          // carried them: `taken`'s `name`, `in_use`'s `usage`.
          return { ...outcome.detail, error: outcome.reason, at: outcome.at, kind: outcome.kind };
        }
        return { results: outcome.results, undoable: outcome.undoable, redoable: outcome.redoable };
      },
      {
        detail: {
          summary: 'Apply a batch of commands to a project, all or none',
          description: `**The one way to write to a plan.** An ordered list of up to 200 commands — every
plan edit and every directory edit — applied in one transaction and recorded as one undo.
A later command may name what an earlier one created by its \`ref\` (\`parentRef\`,
\`workItemRef\`, \`teamRefs\`…). Directory commands are applied with the batch but are not
undoable.

A refused command refuses the whole batch and nothing is applied: the answer carries
\`{ "error": "<code>", "at": <index>, "kind": "<kind>" }\` with the status the code has on its
own — 400 for a malformed step, \`unknown_ref\`, \`duplicate_ref\`, \`too_many_commands\`;
403 \`forbidden\`; 404 \`not_found\` and the \`unknown_*\` ids; 409 \`cycle\`, \`frozen\`,
\`rolled_up\`, \`ancestor\`, \`too_large\`, \`taken\`, \`in_use\`.

Applied, it answers \`{ results: [{ index, ref?, id?, entity? }], undoable, redoable }\`: the
id of everything a command created, the entry a directory create or patch produced, and the
undo state as the tree read carries it. Read the tree afterwards for the plan as the batch
left it — numbers and dates are derived. A refused directory command carries its own fields
beside the code, as its route did: \`taken\` the surviving \`name\`, \`in_use\` the \`usage\`.`,
          requestBody: handParsedBody(
            'The commands, in order. Each names its `kind`; the fields are those of the write it stands for.',
            PLAN_COMMANDS_BODY,
          ),
        },
      },
    )
    .post(
      '/directory/commands',
      async ({ body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await commands.runDirectory(user.id, parseBatch(body));
        if (!outcome.ok) {
          set.status = statusForBatch(outcome.reason);
          return { ...outcome.detail, error: outcome.reason, at: outcome.at, kind: outcome.kind };
        }
        return { results: outcome.results };
      },
      {
        detail: {
          summary: 'Apply a batch of directory commands, all or none',
          description: `The directory — teams, people, tags, services — has no project, so its batches
have their own route: the same commands, the same all-or-none transaction, the same
\`{ "error", "at", "kind" }\` refusal, and no undo, because the directory has none. A plan
command (anything but the twelve directory kinds) is refused as \`project_required\` at its
index. Answers \`{ results: [{ index, ref?, id?, entity? }] }\`.`,
          requestBody: handParsedBody(
            'The directory commands, in order. Each names its `kind`.',
            PLAN_COMMANDS_BODY,
          ),
        },
      },
    )
    .post('/projects/:id/undo', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return answerUndo(await commands.undo(params.id, user.id), set);
    })
    .post('/projects/:id/redo', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return answerUndo(await commands.redo(params.id, user.id), set);
    });
}
