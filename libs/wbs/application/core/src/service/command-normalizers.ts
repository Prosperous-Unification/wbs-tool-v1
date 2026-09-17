import type { commandDefinitions, PlanCommandKind } from '@wbs/contracts';
import {
  isIsoDate,
  type IsoDate,
  isSettableStatus,
  isStepState,
  LONGEST_NOT_BEFORE_REASON,
  MOST_PEOPLE_AT_ONCE,
  ThreePointEstimate,
} from '@wbs/domain';
import { parseOrThrow } from '@wbs/validation';

import { capacityOf } from '../http/capacity-body';
import { ladderOf } from '../http/priority-ladder-body';

interface StructuralCommandDefinition {
  readonly schema: { readonly infer: { readonly kind: string } };
}

type CommandInput<Kind extends PlanCommandKind> =
  (typeof commandDefinitions)[Kind]['schema']['infer'];

type InputWith<Fields extends PropertyKey> = {
  [Kind in PlanCommandKind]: [Fields] extends [keyof CommandInput<Kind>]
    ? CommandInput<Kind>
    : never;
}[PlanCommandKind];

/** One discriminator-preserving semantic normalizer for every structural definition. */
export type CommandNormalizerRecord<
  Definitions extends Record<string, StructuralCommandDefinition>,
> = {
  readonly [Kind in keyof Definitions & string]: (raw: Definitions[Kind]['schema']['infer']) => {
    readonly kind: Kind;
  };
};

/** A semantic command refusal for the HTTP boundary to contextualize with its index and kind. */
export class CommandNormalizationError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** Refuses a value that cannot safely supply the schema-named fields its caller reads. */
function assertRecord(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CommandNormalizationError('expected_object');
  }
}

function refuseDerivedFields(body: object): void {
  if ('number' in body || 'frozenNumber' in body) {
    throw new CommandNormalizationError('number_is_derived');
  }
}

function asIdOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new CommandNormalizationError(`${field}_must_be_id_or_null`);
  }
  return value;
}

/** The largest own-team set one work item may carry in a single patch. */
export const MOST_TEAMS_ON_ONE_ITEM = 10;

/**
 * How many tags one work item may carry. The whole set is written per patch and
 * joined on every plan read; fifty is generous for a maintained taxonomy while
 * keeping one request and its recurring read cost bounded.
 */
export const MOST_TAGS_ON_ONE_ITEM = 50;

/**
 * How many services one work item may deliver. A service directory is a closed
 * handful rather than an open taxonomy, so ten is independently bounded.
 */
export const MOST_SERVICES_ON_ONE_ITEM = 10;

/**
 * How many work item types one row may carry. A type vocabulary is a closed
 * handful such as Story, Bug, Spike, Epic and Task, so ten is independently bounded.
 */
export const MOST_TYPES_ON_ONE_ITEM = 10;

/**
 * How many external refs one work item may carry. Ref lists are open like tag
 * taxonomies and may accumulate many PRs, so they retain the larger bound.
 */
export const MOST_REFS_ON_ONE_ITEM = 50;

/**
 * How long a link's one-line display name may be. This text bound stays
 * separate from {@link MOST_REFS_ON_ONE_ITEM}, which counts refs rather than characters.
 */
export const MOST_CHARACTERS_IN_A_REF_NAME = 300;

/**
 * The refs a patch states, validated at this boundary and precise afterwards.
 *
 * Each entry must be an object with a `systemId` and a `url`, both non-empty
 * strings. A URL is **not** parsed here and not checked against `systemOfUrl`:
 * the caller may override a derived type deliberately (design D1), and refusing
 * a mismatch would make an override impossible. What the store still refuses is
 * a `systemId` the directory does not hold.
 *
 * `name` is optional on the wire and required off it. An entry that names none
 * becomes `''` here — the column's own spelling of "nobody has named this link"
 * — so nothing downstream carries an optional field and no insert can reach
 * SQLite with the column missing. An empty string sent deliberately is the same
 * fact and is accepted as it stands, which is what makes clearing a name
 * possible at all.
 *
 * **Both the type and the length are this function's to refuse, and that was
 * measured rather than assumed.** `plan-command-shapes.ts` declares the field as
 * `'name?': 'string'`, which looks like it would refuse a number before this
 * ran — it does not. Probed against `buildApp` on 2026-09-09: a ref entry
 * carrying an **unknown key** is refused by the shape (`{"error":
 * "invalid_body"}`), and a ref entry carrying `name: 7`, `true`, `{}`, `[]` or
 * `null` reaches this parser untouched. So the shape guards the *keys* and this
 * guards the *values*, and a name that is not text gets its own refusal because
 * answering `..._is_too_long` for `name: 7` would be a wrong reason reported
 * confidently. `takes a name per external ref, and bounds its length` in
 * `work-item.controller.test.ts` holds both boundaries, with the probe's own
 * answers written into it.
 *
 * @throws {CommandNormalizationError} for a non-list, an over-long list, an entry that is not
 * `{ systemId, url }`, a `name` that is not text, or one longer than
 * {@link MOST_CHARACTERS_IN_A_REF_NAME} — a malformed request, never a 500.
 */
function asOptionalExternalRefs(
  value: CommandInput<'patchWorkItem'>['patch']['externalRefs'],
): readonly { systemId: string; url: string; name: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CommandNormalizationError('externalRefs_must_be_a_list');
  }
  if (value.length > MOST_REFS_ON_ONE_ITEM) {
    throw new CommandNormalizationError('too_many_externalRefs');
  }
  return value.map((entry) => {
    assertRecord(entry);
    const systemId = entry.systemId;
    const url = entry.url;
    const name = entry.name;
    if (typeof systemId !== 'string' || systemId === '') {
      throw new CommandNormalizationError('externalRefs_entry_needs_a_systemId');
    }
    if (typeof url !== 'string' || url === '') {
      throw new CommandNormalizationError('externalRefs_entry_needs_a_url');
    }
    if (name !== undefined && typeof name !== 'string') {
      throw new CommandNormalizationError('externalRefs_entry_name_is_not_text');
    }
    if (name !== undefined && name.length > MOST_CHARACTERS_IN_A_REF_NAME) {
      throw new CommandNormalizationError('externalRefs_entry_name_is_too_long');
    }
    return { systemId, url, name: name ?? '' };
  });
}

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
function asOptionalIds(value: unknown, field: string, most: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CommandNormalizationError(`${field}_must_be_a_list_of_ids`);
  }
  if (value.length > most) {
    throw new CommandNormalizationError(`${field}_must_be_at_most_${String(most)}`);
  }
  for (const id of value) {
    if (typeof id !== 'string') {
      throw new CommandNormalizationError(`${field}_must_be_a_list_of_ids`);
    }
  }
  // Every member was checked above; Array.isArray alone retains unknown[].
  return value as readonly string[];
}

function asOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new CommandNormalizationError(`${field}_must_be_text`);
  }
  return value;
}

/**
 * Interprets recorded days without replacing the existing invalid_actual refusal.
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
function parseActual(body: CommandInput<'setActual'>): number {
  const days = body.days;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    throw new CommandNormalizationError('invalid_actual');
  }
  return days;
}

/**
 * Interprets a reported measure with the same numeric rules as {@link parseActual}.
 *
 * **The body key is `value`, not `tokens` or `hours`.** The unit is in the
 * path — `/measures/token_actual/:stepId` — so a key naming one would be the
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
function parseMeasure(body: CommandInput<'setMeasure'>): number {
  const value = body.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CommandNormalizationError('invalid_measure');
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
function parseProgress(body: CommandInput<'setProgress'>) {
  const state = body.state;
  if (!isStepState(state)) throw new CommandNormalizationError('invalid_progress');
  return state;
}

function parseStatus(body: CommandInput<'setStatus'>) {
  const status = body.status;
  if (!isSettableStatus(status)) throw new CommandNormalizationError('invalid_status');
  return status;
}

function parseOn(body: CommandInput<'setStatus'>): IsoDate | undefined {
  const on = body.on;
  if (on === undefined) return undefined;
  if (!isIsoDate(on)) throw new CommandNormalizationError('on_must_be_a_date');
  return on;
}

/** The day the work began, for a mark that says so; refused when it is not a calendar day. */
function parseFactStart(body: CommandInput<'setStatus'>): IsoDate | undefined {
  const factStart = body.factStart;
  if (factStart === undefined) return undefined;
  if (!isIsoDate(factStart)) throw new CommandNormalizationError('factStart_must_be_a_date');
  return factStart;
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
  if (!isIsoDate(value)) throw new CommandNormalizationError(`${field}_must_be_a_date`);
  return value;
}

/**
 * Why the work is held back, `null` to take the words off, or absent to leave
 * them.
 *
 * **A blank is `null`, not `''`.** Emptying the field is how a reader takes a
 * reason off, and a stored empty string would be a second spelling of "nobody
 * has said" that every reader would then have to fold — the doctrine `actual`
 * and `step_progress` both state as "the absence of a row". Trimmed for the
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
  if (typeof value !== 'string') {
    throw new CommandNormalizationError(`${field}_must_be_text`);
  }
  const trimmed = value.trim();
  if (trimmed.length > LONGEST_NOT_BEFORE_REASON) {
    throw new CommandNormalizationError(
      `${field}_must_be_at_most_${String(LONGEST_NOT_BEFORE_REASON)}_characters`,
    );
  }
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new CommandNormalizationError(`${field}_must_be_a_whole_number_from_1`);
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
 * The ceiling is {@link MOST_PEOPLE_AT_ONCE}, and it moved into `libs/wbs/domain/domain` in
 * `capacity-per-project`: three boundaries state it now, this file's copy and
 * `directory.routes.ts`'s agreed by luck, and the third would have been where
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new CommandNormalizationError(`${field}_must_be_a_whole_number_from_1`);
  }
  if (value > MOST_PEOPLE_AT_ONCE) {
    throw new CommandNormalizationError(`${field}_must_be_at_most_${String(MOST_PEOPLE_AT_ONCE)}`);
  }
  return value;
}

function parsePatch(body: CommandInput<'patchWorkItem'>['patch']) {
  assertRecord(body);
  refuseDerivedFields(body);
  if ('teamIds' in body && 'serviceTeamId' in body) {
    throw new CommandNormalizationError('cannot_send_both_teamIds_and_serviceTeamId');
  }
  return present({
    name: asOptionalText(body.name, 'name'),
    notes: asOptionalText(body.notes, 'notes'),
    startNoEarlierThan: asOptionalDate(body.startNoEarlierThan, 'startNoEarlierThan'),
    startNoEarlierThanReason: asOptionalReason(
      body.startNoEarlierThanReason,
      'startNoEarlierThanReason',
    ),
    deadline: asOptionalDate(body.deadline, 'deadline'),
    factStart: asOptionalDate(body.factStart, 'factStart'),
    factEnd: asOptionalDate(body.factEnd, 'factEnd'),
    priority: asOptionalPriority(body.priority, 'priority'),
    serviceTeamId:
      'serviceTeamId' in body ? asIdOrNull(body.serviceTeamId, 'serviceTeamId') : undefined,
    teamIds: asOptionalIds(body.teamIds, 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
    serviceIds: asOptionalIds(body.serviceIds, 'serviceIds', MOST_SERVICES_ON_ONE_ITEM),
    maxParallel: asOptionalParallelism(body.maxParallel, 'maxParallel'),
    tagIds: asOptionalIds(body.tagIds, 'tagIds', MOST_TAGS_ON_ONE_ITEM),
    typeIds: asOptionalIds(body.typeIds, 'typeIds', MOST_TYPES_ON_ONE_ITEM),
    externalRefs: asOptionalExternalRefs(body.externalRefs),
  });
}

/** A string, or the field's `_must_be_text` refusal. */
function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CommandNormalizationError(`${field}_must_be_text`);
  }
  return value;
}

/** An id, or the field's `_must_be_an_id` refusal; absent is allowed for a `…Ref`. */
function asOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new CommandNormalizationError(`${field}_must_be_an_id`);
  }
  return value;
}

/** A boolean or absent, or the field's refusal. */
function asOptionalFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new CommandNormalizationError(`${field}_must_be_true_or_false`);
  }
  return value;
}

type Present<Fields extends Record<string, unknown>> = {
  [Key in keyof Fields as undefined extends Fields[Key] ? never : Key]: Fields[Key];
} & {
  [Key in keyof Fields as undefined extends Fields[Key] ? Key : never]?: Exclude<
    Fields[Key],
    undefined
  >;
};

/** Drops only undefined-valued fields while retaining their optional keys in the return type. */
function present<Fields extends Record<string, unknown>>(fields: Fields): Present<Fields> {
  // Every retained entry preserves its original key and value; Object.fromEntries erases that relation.
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Present<Fields>;
}

function normalizedTarget(workItemId: unknown, workItemRef: unknown) {
  return present({
    workItemId: asOptionalId(workItemId, 'workItemId'),
    workItemRef: asOptionalId(workItemRef, 'workItemRef'),
  });
}

function target(raw: InputWith<'workItemId' | 'workItemRef'>) {
  return normalizedTarget(raw.workItemId, raw.workItemRef);
}

function step(raw: InputWith<'stepId'>) {
  return { stepId: asText(raw.stepId, 'stepId') };
}

function normalizedRef(value: unknown) {
  return present({ ref: asOptionalId(value, 'ref') });
}

function ref(raw: InputWith<'ref'>) {
  return normalizedRef(raw.ref);
}

type NamedInput = InputWith<'ref' | 'name'>;

function normalizeNamed<Kind extends NamedInput['kind']>(
  kind: Kind,
  raw: Extract<NamedInput, { kind: NoInfer<Kind> }>,
) {
  return { kind, ...ref(raw), name: asText(raw.name, 'name') };
}

/**
 * Pure semantic normalization for every structural command kind. Each return
 * retains its literal discriminator so {@link PlanCommand} can be inferred from this record.
 * Proof: adding `temporaryCommand` to the structural definitions without an entry here failed
 * core typecheck with TS2741 at this record.
 */
export const commandNormalizers = {
  createWorkItem(raw: CommandInput<'createWorkItem'>) {
    refuseDerivedFields(raw);
    const parentId = asIdOrNull(raw.parentId, 'parentId');
    const afterId = asIdOrNull(raw.afterId, 'afterId');
    const name = asOptionalText(raw.name, 'name');
    const notes = asOptionalText(raw.notes, 'notes');
    const priority = asOptionalPriority(raw.priority, 'priority');
    return present({
      kind: 'createWorkItem' as const,
      ...ref(raw),
      parentId,
      parentRef: asOptionalId(raw.parentRef, 'parentRef'),
      afterId,
      afterRef: asOptionalId(raw.afterRef, 'afterRef'),
      name,
      notes,
      // Absent stays absent for the service's middle rung; explicit null stays unprioritised.
      priority,
    });
  },
  patchWorkItem(raw: CommandInput<'patchWorkItem'>) {
    const patchRaw = raw.patch;
    assertRecord(patchRaw);
    return {
      kind: 'patchWorkItem' as const,
      ...target(raw),
      patch: present({
        ...parsePatch(patchRaw),
        serviceRefs: asOptionalIds(patchRaw.serviceRefs, 'serviceRefs', MOST_SERVICES_ON_ONE_ITEM),
        tagRefs: asOptionalIds(patchRaw.tagRefs, 'tagRefs', MOST_TAGS_ON_ONE_ITEM),
        typeRefs: asOptionalIds(patchRaw.typeRefs, 'typeRefs', MOST_TYPES_ON_ONE_ITEM),
        teamRefs: asOptionalIds(patchRaw.teamRefs, 'teamRefs', MOST_TEAMS_ON_ONE_ITEM),
      }),
    };
  },
  moveWorkItem(raw: CommandInput<'moveWorkItem'>) {
    const parentId = asIdOrNull(raw.parentId, 'parentId');
    const afterId = asIdOrNull(raw.afterId, 'afterId');
    return present({
      kind: 'moveWorkItem' as const,
      ...target(raw),
      parentId,
      parentRef: asOptionalId(raw.parentRef, 'parentRef'),
      afterId,
      afterRef: asOptionalId(raw.afterRef, 'afterRef'),
    });
  },
  duplicateWorkItem: (raw: CommandInput<'duplicateWorkItem'>) => ({
    kind: 'duplicateWorkItem' as const,
    ...target(raw),
    ...ref(raw),
  }),
  deleteWorkItem(raw: CommandInput<'deleteWorkItem'>) {
    const candidate: unknown = raw.strategy;
    if (candidate !== undefined && candidate !== 'cascade' && candidate !== 'promote') {
      throw new CommandNormalizationError('unknown_strategy');
    }
    const strategy: 'cascade' | 'promote' | undefined = candidate;
    return present({ kind: 'deleteWorkItem' as const, ...target(raw), strategy });
  },
  setEstimate: (raw: CommandInput<'setEstimate'>) => ({
    kind: 'setEstimate' as const,
    ...target(raw),
    ...step(raw),
    days: parseOrThrow(ThreePointEstimate, raw.days),
  }),
  clearEstimate: (raw: CommandInput<'clearEstimate'>) => ({
    kind: 'clearEstimate' as const,
    ...target(raw),
    ...step(raw),
  }),
  setActual: (raw: CommandInput<'setActual'>) => ({
    kind: 'setActual' as const,
    ...target(raw),
    ...step(raw),
    days: parseActual(raw),
  }),
  clearActual: (raw: CommandInput<'clearActual'>) => ({
    kind: 'clearActual' as const,
    ...target(raw),
    ...step(raw),
  }),
  setProgress: (raw: CommandInput<'setProgress'>) => ({
    kind: 'setProgress' as const,
    ...target(raw),
    ...step(raw),
    state: parseProgress(raw),
  }),
  clearProgress: (raw: CommandInput<'clearProgress'>) => ({
    kind: 'clearProgress' as const,
    ...target(raw),
    ...step(raw),
  }),
  setStatus: (raw: CommandInput<'setStatus'>) =>
    present({
      kind: 'setStatus' as const,
      ...target(raw),
      status: parseStatus(raw),
      on: parseOn(raw),
      factStart: parseFactStart(raw),
    }),
  setMeasure: (raw: CommandInput<'setMeasure'>) => ({
    kind: 'setMeasure' as const,
    ...target(raw),
    ...step(raw),
    metric: asText(raw.metric, 'metric'),
    value: parseMeasure(raw),
  }),
  clearMeasure: (raw: CommandInput<'clearMeasure'>) => ({
    kind: 'clearMeasure' as const,
    ...target(raw),
    ...step(raw),
    metric: asText(raw.metric, 'metric'),
  }),
  setAssignee: (raw: CommandInput<'setAssignee'>) =>
    present({
      kind: 'setAssignee' as const,
      ...target(raw),
      ...step(raw),
      personId: asIdOrNull(raw.personId, 'personId'),
      personRef: asOptionalId(raw.personRef, 'personRef'),
    }),
  addDependency: (raw: CommandInput<'addDependency'>) =>
    present({
      kind: 'addDependency' as const,
      ...target(raw),
      predecessorId: asOptionalId(raw.predecessorId, 'predecessorId'),
      predecessorRef: asOptionalId(raw.predecessorRef, 'predecessorRef'),
    }),
  removeDependency: (raw: CommandInput<'removeDependency'>) =>
    present({
      kind: 'removeDependency' as const,
      ...target(raw),
      predecessorId: asOptionalId(raw.predecessorId, 'predecessorId'),
      predecessorRef: asOptionalId(raw.predecessorRef, 'predecessorRef'),
    }),
  arrangeBySchedule: (_raw: CommandInput<'arrangeBySchedule'>) => ({
    kind: 'arrangeBySchedule' as const,
  }),
  freezeProject: (_raw: CommandInput<'freezeProject'>) => ({ kind: 'freezeProject' as const }),
  unfreezeProject: (_raw: CommandInput<'unfreezeProject'>) => ({
    kind: 'unfreezeProject' as const,
  }),
  unfreezeWorkItem: (raw: CommandInput<'unfreezeWorkItem'>) => ({
    kind: 'unfreezeWorkItem' as const,
    ...target(raw),
  }),
  setCapacity: (raw: CommandInput<'setCapacity'>) =>
    present({
      kind: 'setCapacity' as const,
      teamId: asOptionalId(raw.teamId, 'teamId'),
      teamRef: asOptionalId(raw.teamRef, 'teamRef'),
      size: capacityOf(raw),
    }),
  setPriorityBands: (raw: CommandInput<'setPriorityBands'>) => ({
    kind: 'setPriorityBands' as const,
    bands: ladderOf(raw),
  }),
  createTeam: (raw: CommandInput<'createTeam'>) => normalizeNamed('createTeam', raw),
  patchTeam(raw: CommandInput<'patchTeam'>) {
    const patch = raw.patch;
    assertRecord(patch);
    return present({
      kind: 'patchTeam' as const,
      teamId: asOptionalId(raw.teamId, 'teamId'),
      teamRef: asOptionalId(raw.teamRef, 'teamRef'),
      patch: present({
        name: asOptionalText(patch.name, 'name'),
        serviceIds: asOptionalIds(patch.serviceIds, 'serviceIds', MOST_SERVICES_ON_ONE_ITEM),
      }),
    });
  },
  deleteTeam: (raw: CommandInput<'deleteTeam'>) =>
    present({
      kind: 'deleteTeam' as const,
      teamId: asOptionalId(raw.teamId, 'teamId'),
      teamRef: asOptionalId(raw.teamRef, 'teamRef'),
      cascade: asOptionalFlag(raw.cascade, 'cascade'),
    }),
  createPerson: (raw: CommandInput<'createPerson'>) =>
    present({
      ...normalizeNamed('createPerson', raw),
      teamIds: asOptionalIds(raw.teamIds, 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
      teamRefs: asOptionalIds(raw.teamRefs, 'teamRefs', MOST_TEAMS_ON_ONE_ITEM),
    }),
  patchPerson(raw: CommandInput<'patchPerson'>) {
    const patch = raw.patch;
    assertRecord(patch);
    return present({
      kind: 'patchPerson' as const,
      personId: asOptionalId(raw.personId, 'personId'),
      personRef: asOptionalId(raw.personRef, 'personRef'),
      patch: present({
        name: asOptionalText(patch.name, 'name'),
        teamIds: asOptionalIds(patch.teamIds, 'teamIds', MOST_TEAMS_ON_ONE_ITEM),
        kind: asOptionalText(patch.kind, 'kind'),
      }),
    });
  },
  deletePerson: (raw: CommandInput<'deletePerson'>) =>
    present({
      kind: 'deletePerson' as const,
      personId: asOptionalId(raw.personId, 'personId'),
      personRef: asOptionalId(raw.personRef, 'personRef'),
      cascade: asOptionalFlag(raw.cascade, 'cascade'),
    }),
  createTag: (raw: CommandInput<'createTag'>) => normalizeNamed('createTag', raw),
  patchTag: (raw: CommandInput<'patchTag'>) =>
    present({
      kind: 'patchTag' as const,
      tagId: asOptionalId(raw.tagId, 'tagId'),
      tagRef: asOptionalId(raw.tagRef, 'tagRef'),
      name: asText(raw.name, 'name'),
    }),
  deleteTag: (raw: CommandInput<'deleteTag'>) =>
    present({
      kind: 'deleteTag' as const,
      tagId: asOptionalId(raw.tagId, 'tagId'),
      tagRef: asOptionalId(raw.tagRef, 'tagRef'),
      cascade: asOptionalFlag(raw.cascade, 'cascade'),
    }),
  createService: (raw: CommandInput<'createService'>) => normalizeNamed('createService', raw),
  patchService: (raw: CommandInput<'patchService'>) =>
    present({
      kind: 'patchService' as const,
      serviceId: asOptionalId(raw.serviceId, 'serviceId'),
      serviceRef: asOptionalId(raw.serviceRef, 'serviceRef'),
      name: asText(raw.name, 'name'),
    }),
  deleteService: (raw: CommandInput<'deleteService'>) =>
    present({
      kind: 'deleteService' as const,
      serviceId: asOptionalId(raw.serviceId, 'serviceId'),
      serviceRef: asOptionalId(raw.serviceRef, 'serviceRef'),
      cascade: asOptionalFlag(raw.cascade, 'cascade'),
    }),
  createWorkItemType: (raw: CommandInput<'createWorkItemType'>) =>
    normalizeNamed('createWorkItemType', raw),
  patchWorkItemType: (raw: CommandInput<'patchWorkItemType'>) =>
    present({
      kind: 'patchWorkItemType' as const,
      typeId: asOptionalId(raw.typeId, 'typeId'),
      typeRef: asOptionalId(raw.typeRef, 'typeRef'),
      name: asText(raw.name, 'name'),
    }),
  deleteWorkItemType: (raw: CommandInput<'deleteWorkItemType'>) =>
    present({
      kind: 'deleteWorkItemType' as const,
      typeId: asOptionalId(raw.typeId, 'typeId'),
      typeRef: asOptionalId(raw.typeRef, 'typeRef'),
      cascade: asOptionalFlag(raw.cascade, 'cascade'),
    }),
} as const satisfies CommandNormalizerRecord<typeof commandDefinitions>;

/** The normalized command union, inferred from every normalizer's return type. */
export type PlanCommand = ReturnType<(typeof commandNormalizers)[PlanCommandKind]>;

/**
 * Applies the semantic normalizer selected by a structurally admitted command kind.
 * Common target and create-ref fields stay eager, including when a structural
 * mismatch means the mounted boundary is choosing the legacy semantic refusal.
 */
export function normalizeCommand(kind: PlanCommandKind, raw: Record<string, unknown>): PlanCommand {
  normalizedTarget(raw['workItemId'], raw['workItemRef']);
  normalizedRef(raw['ref']);
  // A known discriminator selects this function, but rejected structural bodies deliberately
  // remain raw here so their values receive the legacy semantic refusal before invalid_body.
  const rawNormalizers = commandNormalizers as unknown as Readonly<
    Record<PlanCommandKind, (command: Record<string, unknown>) => PlanCommand>
  >;
  return rawNormalizers[kind](raw);
}
