import {
  applyDirectoryCommands,
  applyProjectCommands,
  commandParserRefusal,
  getWorkItems,
  PLAN_COMMAND_KINDS,
  type PlanCommandKind,
  redoProject,
  responseSchema,
  type SchemaShape,
  undoProject,
  validateSchema,
} from '@wbs/contracts';
import { type, ValidationError } from '@wbs/validation';

import { CommandNormalizationError, normalizeCommand } from '../service/command-normalizers';
import type { PlanCommand } from '../service/plan-command';
import type { AppliedCommand, BatchRefusal, PlanCommandRunner } from '../service/plan-commands';
import type { UndoOutcome, WorkItemService } from '../service/work-item.service';
import { runCommandBatch } from '../use-cases/run-command-batch';
import { BadCapacity } from './capacity-body';
import { bind, type HttpReply, type RequestFailure } from './endpoint';
import { BadLadder } from './priority-ladder-body';
import { isFieldBag } from './route';

export {
  MOST_CHARACTERS_IN_A_REF_NAME,
  MOST_REFS_ON_ONE_ITEM,
  MOST_SERVICES_ON_ONE_ITEM,
  MOST_TAGS_ON_ONE_ITEM,
  MOST_TEAMS_ON_ONE_ITEM,
  MOST_TYPES_ON_ONE_ITEM,
} from '../service/command-normalizers';

/**
 * Semantic interpretation preserves date/range/name refusals and command order.
 * The shared request declaration owns structural validation; this parser also
 * classifies rejected bodies without ever admitting them to a service call.
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

/**
 * A JSON value this module may read named fields off, or a 400.
 *
 * Spelled with {@link isFieldBag} and **not** `typeof body !== 'object'`, which
 * is what it said until a probe measured the difference: `typeof [] ===
 * 'object'`, so the old spelling admitted an array where the `t.Object(...)`
 * schema it replaced refused one, and the cast to `Record<string, unknown>` it
 * needed was the tell.
 *
 * That was **not** only a comment. `{"kind":"patchWorkItem","workItemId":…,
 * "patch":[]}` answered **200** at this route: every field read `undefined` off
 * the array, `present()` dropped all of them, and an empty patch reached the
 * service as a no-op write and was journalled. The same spelling let a JSON
 * `[]` write a saved plan earlier on this branch. `a JSON array body on the
 * work-item routes` in `work-item.controller.test.ts` is the standing control.
 */
function asRecord(body: unknown): Record<string, unknown> {
  if (!isFieldBag(body)) throw new BadRequest('expected_object');
  return body;
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
// Proof: returning the whole value exposed private entryId in the direct undo/redo case.
function answerUndo(outcome: UndoOutcome): HttpReply<typeof undoProject> {
  if (outcome.ok)
    return {
      ok: true,
      status: 200,
      body: { done: outcome.value.done, detail: outcome.value.detail },
    };
  switch (outcome.reason) {
    case 'forbidden':
      return { ok: false, status: 403, body: { error: outcome.reason } };
    case 'not_found':
      return { ok: false, status: 404, body: { error: outcome.reason } };
    case 'nothing_to_undo':
    case 'stale_undo':
      return { ok: false, status: 409, body: { error: outcome.reason, detail: outcome.detail } };
  }
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
    return normalizeCommand(kind as PlanCommandKind, raw);
  } catch (cause) {
    // The parsers' own refusals, given the index; a schema refusal from the
    // estimate's arktype check is the code its route answered with.
    if (cause instanceof BadRequest) throw new BadRequest(cause.reason, at, kind);
    if (cause instanceof CommandNormalizationError) {
      throw new BadRequest(cause.reason, at, kind);
    }
    if (cause instanceof BadCapacity || cause instanceof BadLadder) {
      throw new BadRequest(cause.reason, at, kind);
    }
    if (cause instanceof ValidationError) throw new BadRequest('invalid_estimate', at, kind);
    throw cause;
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

/** Unknown parser codes are malformed trusted translations, never invented wire refusals. */
async function requireShape<T>(schema: SchemaShape<T>, value: unknown): Promise<T> {
  const checked = await validateSchema(schema, value);
  if (checked.issues !== undefined)
    throw new Error(
      `Invalid command producer: ${checked.issues.map((issue) => issue.message).join('; ')}`,
    );
  return checked.value;
}

// Proof: omitting recognized kind returned500 instead of400 in the mounted classification case.
async function parserRefusal(
  error: unknown,
): Promise<Extract<HttpReply<typeof applyProjectCommands>, { ok: false }> | null> {
  if (error instanceof BadRequest) {
    const body =
      error.at === undefined
        ? { error: error.reason }
        : error.kind === undefined
          ? { error: error.reason, at: error.at }
          : { error: error.reason, at: error.at, kind: error.kind };
    return { ok: false, status: 400, body: await requireShape(commandParserRefusal, body) };
  }
  if (error instanceof ValidationError)
    return { ok: false, status: 400, body: { error: 'invalid_estimate' } };
  return null;
}

/**
 * Schema failure classification reuses semantic parsing but cannot admit a body.
 * Proof: bypassing classification returned invalid_body instead of the indexed
 * number_is_derived refusal in the mounted classification case.
 */
async function classifyCommand(
  failure: RequestFailure,
): Promise<Extract<HttpReply<typeof applyProjectCommands>, { ok: false }>> {
  if (failure.code === 'invalid_body') {
    try {
      parseBatch(failure.rejected);
    } catch (error) {
      const refusal = await parserRefusal(error);
      if (refusal !== null) return refusal;
      throw error;
    }
  }
  return { ok: false, status: 400, body: { error: failure.code } };
}

/**
 * Parsing stays before runner admission, so a later invalid command outranks the batch cap.
 * Proof: checking the cap in the mounted handler first made the index-200 case receive
 * `too_many_commands` instead of `invalid_actual`.
 */
async function parsedBatch(body: unknown) {
  try {
    return { ok: true, commands: parseBatch(body) } as const;
  } catch (error) {
    const refusal = await parserRefusal(error);
    if (refusal === null) throw error;
    return refusal;
  }
}

/** A finite status switch retains command detail; an unmodeled producer reason cannot acquire a default. */
function answerBatch(
  outcome: BatchRefusal,
): Extract<HttpReply<typeof applyProjectCommands>, { ok: false }> {
  const context = { at: outcome.at, kind: outcome.kind };
  switch (outcome.reason) {
    // Proof: dropping deadline detail returned500 instead of422 in the mounted runtime-refusal case.
    case 'deadline_before_project_start':
      return {
        ok: false,
        status: 422,
        body: { ...context, error: outcome.reason, ...outcome.detail },
      };
    case 'calendar_range':
      return { ok: false, status: 422, body: { ...context, error: outcome.reason } };
    case 'taken':
      return {
        ok: false,
        status: 409,
        body: { ...context, error: outcome.reason, ...outcome.detail },
      };
    case 'in_use':
      return {
        ok: false,
        status: 409,
        body: { ...context, error: outcome.reason, ...outcome.detail },
      };
    case 'forbidden':
      return { ok: false, status: 403, body: { ...context, error: outcome.reason } };
    case 'not_found':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_step':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_metric':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_person':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_team':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_tag':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_service':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_type':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'unknown_system':
      return { ok: false, status: 404, body: { ...context, error: outcome.reason } };
    case 'cycle':
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'schedule_not_ready':
      // A conflict, not a fault: the same request is accepted the moment the
      // solve lands. `refusal-status.ts` has the family's definition.
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'engine_unavailable':
      // What the plan read answers for the same deployment, with the same code,
      // so a client meets one word for "this release has no optimizer".
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'rolled_up':
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'ancestor':
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'too_large':
      return { ok: false, status: 409, body: { ...context, error: outcome.reason } };
    case 'too_many_commands':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'project_required':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'unknown_ref':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'missing_id':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'duplicate_ref':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'name_required':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'strategy_required':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'has_children':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'not_before_reason_needs_a_date':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'invalid_kind':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
    case 'nothing_to_change':
      return { ok: false, status: 400, body: { ...context, error: outcome.reason } };
  }
}
const namedEntity = responseSchema(type({ id: 'string', name: 'string' }));
// Proof: optional serviceIds admitted a patchTeam without memberships,200 instead of500 in the mounted results case.
const teamEntity = responseSchema(type({ id: 'string', name: 'string', serviceIds: 'string[]' }));
// Proof: optional person kind admitted its omission,200 instead of500 in the mounted results case.
const personEntity = responseSchema(
  type({ id: 'string', name: 'string', kind: "'person' | 'agent'" }),
);
// Proof: optional teamIds admitted a patchPerson without memberships,200 instead of500 in the mounted results case.
const personWithTeamsEntity = responseSchema(
  type({ id: 'string', name: 'string', kind: "'person' | 'agent'", teamIds: 'string[]' }),
);

/**
 * Checks required fields while the producer kind exists, then returns the
 * unchanged untagged wire. Absent refs are omitted as JSON serialization did.
 * Proof: keeping kind added createTeam to the mounted result's exact wire
 * assertion. Keeping ref:undefined made the existing create/read case return500.
 */
async function appliedWire(applied: AppliedCommand) {
  const { kind, ref, ...wire } = applied;
  switch (kind) {
    case 'createWorkItem':
    case 'duplicateWorkItem':
    case 'createTeam':
    case 'createPerson':
    case 'createTag':
    case 'createService':
    case 'createWorkItemType':
      // Proof: removing this check admitted each missing minted id,200 instead of500 in the mounted minted-id case.
      if (typeof applied.id !== 'string')
        throw new Error('Created command producer requires its minted id');
  }
  switch (kind) {
    case 'patchTeam':
      await requireShape(teamEntity, applied.entity);
      break;
    case 'createPerson':
      await requireShape(personEntity, applied.entity);
      break;
    case 'patchPerson':
      await requireShape(personWithTeamsEntity, applied.entity);
      break;
    case 'createTeam':
    case 'createTag':
    case 'patchTag':
    case 'createService':
    case 'patchService':
    case 'createWorkItemType':
    case 'patchWorkItemType':
      await requireShape(namedEntity, applied.entity);
      break;
  }
  return { ...wire, ...(ref === undefined ? {} : { ref }) };
}

/** Five typed work-item endpoints; services retain transactions, access, sequencing and announcements. */
export function workItemRoutes(workItems: WorkItemService, commands: PlanCommandRunner) {
  return [
    bind(getWorkItems, async ({ params, principal }): Promise<HttpReply<typeof getWorkItems>> => {
      const tree = await workItems.tree(params.id);
      if (tree === null) return { ok: false, status: 404, body: { error: 'not_found' } };
      // Proof: removing this branch made the mounted unavailable work-item read
      // receive 500 instead of the required 409.
      if ('kind' in tree)
        return {
          ok: false,
          status: 409,
          body: { error: tree.error, engine: tree.engine },
        };
      return {
        ok: true,
        status: 200,
        body: { ...tree, ...(await workItems.undoState(params.id, principal.id)) },
      };
    }),
    bind(
      applyProjectCommands,
      async ({ params, body, principal }): Promise<HttpReply<typeof applyProjectCommands>> => {
        const parsed = await parsedBatch(body);
        if (!parsed.ok) return parsed;
        const outcome = await runCommandBatch(commands, {
          projectId: params.id,
          actor: principal,
          commands: parsed.commands,
        });
        if ('error' in outcome) {
          return { ok: false, status: 403, body: { error: outcome.error } };
        }
        if (!outcome.ok) return answerBatch(outcome);
        return {
          ok: true,
          status: 200,
          body: {
            results: await Promise.all(outcome.results.map(appliedWire)),
            undoable: outcome.undoable,
            redoable: outcome.redoable,
          },
        };
      },
      { classifyRequestFailure: classifyCommand },
    ),
    bind(
      applyDirectoryCommands,
      async ({ body, principal }): Promise<HttpReply<typeof applyDirectoryCommands>> => {
        const parsed = await parsedBatch(body);
        if (!parsed.ok) return parsed;
        const outcome = await runCommandBatch(commands, {
          projectId: null,
          actor: principal,
          commands: parsed.commands,
        });
        if ('error' in outcome) {
          return { ok: false, status: 403, body: { error: outcome.error } };
        }
        if (!outcome.ok) return answerBatch(outcome);
        return {
          ok: true,
          status: 200,
          body: { results: await Promise.all(outcome.results.map(appliedWire)) },
        };
      },
      { classifyRequestFailure: classifyCommand },
    ),
    bind(undoProject, async ({ params, principal }) =>
      answerUndo(await commands.undo(params.id, principal.id)),
    ),
    bind(redoProject, async ({ params, principal }) =>
      answerUndo(await commands.redo(params.id, principal.id)),
    ),
  ] as const;
}
