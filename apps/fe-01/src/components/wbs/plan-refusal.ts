import { unreachable } from '@/lib/http';
import { type RefusalWords, sentenceForRefusal } from '@/lib/refusal';
import {
  wbsFailureCode,
  type WbsOperationId,
  type WbsProblem,
  type WbsRefusalFor,
  WbsRequestError,
} from '@/lib/wbs-api';

type RefusalOf<O extends WbsOperationId> = WbsRefusalFor<O>;

function directoryReadCode(refusal: RefusalOf<'getApiPeople'>): string {
  switch (refusal.error) {
    case 'invalid_query':
    case 'invalid_params':
    case 'invalid_body':
    case 'unauthenticated':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function projectCreateCode(refusal: RefusalOf<'postApiProjects'>): string {
  switch (refusal.error) {
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'invalid_json':
    case 'invalid_body':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function projectOpenCode(refusal: RefusalOf<'postApiProjectsByIdOpened'>): string {
  switch (refusal.error) {
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'not_found':
    case 'invalid_body':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function projectReadCode(refusal: RefusalOf<'getApiProjectsById'>): string {
  switch (refusal.error) {
    case 'invalid_body':
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'not_found':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function projectPatchCode(refusal: RefusalOf<'patchApiProjectsById'>): string {
  switch (refusal.error) {
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'invalid_json':
    case 'invalid_body':
    case 'not_found':
    case 'forbidden':
    case 'bad_start_date':
    case 'bad_pert_weights':
    case 'optimizer_unavailable':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function treeReadCode(refusal: RefusalOf<'getApiProjectsByIdWork-items'>): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_body':
    case 'invalid_json':
    case 'unauthenticated':
    case 'not_found':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function historyCode(refusal: RefusalOf<'postApiProjectsByIdUndo'>): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_body':
    case 'invalid_json':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'nothing_to_undo':
    case 'stale_undo':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function markerListCode(refusal: RefusalOf<'getApiProjectsByIdCalendar-markers'>): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_json':
    case 'invalid_body':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'taken':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function markerWriteCode(refusal: RefusalOf<'postApiProjectsByIdCalendar-markers'>): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_json':
    case 'invalid_body':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'taken':
    case 'malformed':
    case 'contrast':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function markerRemoveCode(
  refusal: RefusalOf<'deleteApiProjectsByIdCalendar-markersByMarkerId'>,
): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_json':
    case 'invalid_body':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'taken':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function stepWriteCode(refusal: RefusalOf<'postApiProjectsByIdSteps'>): string {
  switch (refusal.error) {
    case 'name_required':
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'invalid_json':
    case 'taken':
    case 'invalid_body':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function stepRemoveCode(refusal: RefusalOf<'deleteApiProjectsByIdStepsByStepId'>): string {
  switch (refusal.error) {
    case 'invalid_query':
    case 'invalid_params':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'forbidden':
    case 'not_found':
    case 'invalid_body':
    case 'in_use':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function commandCode(refusal: RefusalOf<'postApiProjectsByIdCommands'>): string {
  switch (refusal.error) {
    case 'invalid_params':
    case 'invalid_query':
    case 'invalid_body':
    case 'invalid_json':
    case 'unauthenticated':
    case 'invalid_origin':
    case 'insufficient_scope':
    case 'expected_object':
    case 'number_is_derived':
    case 'externalRefs_must_be_a_list':
    case 'too_many_externalRefs':
    case 'externalRefs_entry_needs_a_systemId':
    case 'externalRefs_entry_needs_a_url':
    case 'invalid_actual':
    case 'invalid_measure':
    case 'invalid_progress':
    case 'invalid_estimate':
    case 'cannot_send_both_teamIds_and_serviceTeamId':
    case 'unknown_kind':
    case 'unknown_strategy':
    case 'commands_must_be_a_list':
    case 'size_required':
    case 'bands_required':
    case 'bands_must_be_an_array':
    case 'bands_must_number_5':
    case 'bands_must_be_objects':
    case 'band_start_must_be_a_whole_number_from_1':
    case 'band_default_must_be_a_whole_number_from_1':
    case 'band_label_must_be_1_to_40_characters':
    case 'band_labels_must_differ':
    case 'first_band_must_start_at_1':
    case 'bands_must_start_in_increasing_order':
    case 'band_default_must_be_inside_its_own_band':
    case 'parentId_must_be_id_or_null':
    case 'afterId_must_be_id_or_null':
    case 'personId_must_be_id_or_null':
    case 'serviceTeamId_must_be_id_or_null':
    case 'name_must_be_text':
    case 'notes_must_be_text':
    case 'kind_must_be_text':
    case 'startNoEarlierThanReason_must_be_text':
    case 'stepId_must_be_text':
    case 'metric_must_be_text':
    case 'personId_must_be_an_id':
    case 'workItemId_must_be_an_id':
    case 'workItemRef_must_be_an_id':
    case 'ref_must_be_an_id':
    case 'parentRef_must_be_an_id':
    case 'afterRef_must_be_an_id':
    case 'personRef_must_be_an_id':
    case 'predecessorId_must_be_an_id':
    case 'predecessorRef_must_be_an_id':
    case 'teamId_must_be_an_id':
    case 'teamRef_must_be_an_id':
    case 'tagId_must_be_an_id':
    case 'tagRef_must_be_an_id':
    case 'typeId_must_be_an_id':
    case 'typeRef_must_be_an_id':
    case 'serviceId_must_be_an_id':
    case 'serviceRef_must_be_an_id':
    case 'teamIds_must_be_a_list_of_ids':
    case 'teamRefs_must_be_a_list_of_ids':
    case 'tagIds_must_be_a_list_of_ids':
    case 'tagRefs_must_be_a_list_of_ids':
    case 'serviceIds_must_be_a_list_of_ids':
    case 'serviceRefs_must_be_a_list_of_ids':
    case 'typeIds_must_be_a_list_of_ids':
    case 'typeRefs_must_be_a_list_of_ids':
    case 'teamIds_must_be_at_most_10':
    case 'teamRefs_must_be_at_most_10':
    case 'serviceIds_must_be_at_most_10':
    case 'serviceRefs_must_be_at_most_10':
    case 'typeIds_must_be_at_most_10':
    case 'typeRefs_must_be_at_most_10':
    case 'tagIds_must_be_at_most_50':
    case 'tagRefs_must_be_at_most_50':
    case 'startNoEarlierThan_must_be_a_date':
    case 'deadline_must_be_a_date':
    case 'priority_must_be_a_whole_number_from_1':
    case 'maxParallel_must_be_a_whole_number_from_1':
    case 'size_must_be_a_whole_number_from_1':
    case 'maxParallel_must_be_at_most_1000':
    case 'size_must_be_at_most_1000':
    case 'cascade_must_be_true_or_false':
    case 'startNoEarlierThanReason_must_be_at_most_200_characters':
    case 'too_many_commands':
    case 'project_required':
    case 'unknown_ref':
    case 'missing_id':
    case 'duplicate_ref':
    case 'name_required':
    case 'strategy_required':
    case 'has_children':
    case 'not_before_reason_needs_a_date':
    case 'invalid_kind':
    case 'nothing_to_change':
    case 'forbidden':
    case 'not_found':
    case 'unknown_step':
    case 'unknown_metric':
    case 'unknown_person':
    case 'unknown_team':
    case 'unknown_tag':
    case 'unknown_service':
    case 'unknown_type':
    case 'unknown_system':
    case 'cycle':
    case 'frozen':
    case 'rolled_up':
    case 'ancestor':
    case 'too_large':
    case 'taken':
    case 'in_use':
    case 'deadline_before_project_start':
      return refusal.error;
    default:
      return unreachable(refusal);
  }
}

function refusalCode(problem: Extract<WbsProblem, { kind: 'refusal' }>): string {
  switch (problem.operation) {
    case 'getApiPeople':
    case 'getApiTeams':
    case 'getApiTags':
    case 'getApiServices':
    case 'getApiWork-item-types':
    case 'getApiExternal-systems':
    case 'getApiProjects':
      return directoryReadCode(problem.refusal);
    case 'postApiProjects':
      return projectCreateCode(problem.refusal);
    case 'postApiProjectsByIdOpened':
      return projectOpenCode(problem.refusal);
    case 'getApiProjectsById':
      return projectReadCode(problem.refusal);
    case 'patchApiProjectsById':
      return projectPatchCode(problem.refusal);
    case 'getApiProjectsByIdWork-items':
      return treeReadCode(problem.refusal);
    case 'postApiProjectsByIdCommands':
    case 'postApiDirectoryCommands':
      return commandCode(problem.refusal);
    case 'postApiProjectsByIdUndo':
    case 'postApiProjectsByIdRedo':
      return historyCode(problem.refusal);
    case 'getApiProjectsByIdCalendar-markers':
      return markerListCode(problem.refusal);
    case 'postApiProjectsByIdCalendar-markers':
    case 'patchApiProjectsByIdCalendar-markersByMarkerId':
      return markerWriteCode(problem.refusal);
    case 'deleteApiProjectsByIdCalendar-markersByMarkerId':
      return markerRemoveCode(problem.refusal);
    case 'postApiProjectsByIdSteps':
    case 'patchApiProjectsByIdStepsByStepId':
      return stepWriteCode(problem.refusal);
    case 'deleteApiProjectsByIdStepsByStepId':
      return stepRemoveCode(problem.refusal);
    default:
      return unreachable(problem);
  }
}

/**
 * be-01's word for a rejected request, or `fallback` when it threw something
 * that is not an `Error`.
 *
 * The **code**, not a sentence: the shared client preserves the validated
 * refusal word (or a typed boundary-failure code), and the two callers left
 * here want the word itself. {@link refusalSentence} is what a toast says
 * instead — see the note on each call for why these two are not it.
 */
export const failureText = (thrown: unknown, fallback: string): string =>
  thrown instanceof WbsRequestError
    ? (() => {
        switch (thrown.problem.kind) {
          case 'failure':
            return wbsFailureCode(thrown.problem.failure);
          case 'refusal':
            return refusalCode(thrown.problem);
          default:
            return unreachable(thrown.problem);
        }
      })()
    : thrown instanceof Error
      ? thrown.message
      : fallback;

/**
 * How be-01 refuses a **malformed** request, in the words the shared client keeps.
 *
 * A set rather than a match on `http_4\d\d`, which was the first shape and is
 * wrong: 401 and 403 are the same family and say nothing about the value that
 * was sent, and a sentence claiming "that change was not valid" over an expired
 * session would send the reader looking for a typo. be-01's own words —
 * `forbidden`, `not_found` — already cover those.
 *
 * Three entries, because a malformed body now arrives two ways:
 *
 * - `http_400` / `http_422` — an undeclared legacy refusal whose status is all
 *   the boundary can keep. That was every schema refusal
 *   while the controllers declared TypeBox to Elysia, which answered them with
 *   its own validation report.
 * - `invalid_body` — be-01's own word, and what the migrated controllers
 *   answer now that they check their bodies themselves instead of declaring a
 *   validator. Same refusal, same 422, a word instead of silence.
 *
 * The old two stay: routes this branch has not migrated still answer the
 * Elysia way, and a proxy in front of be-01 can put a 400 on the wire with no
 * JSON at all. This list is what the reader sees, not a census of be-01.
 *
 * **One list, two decisions**: the sentence below, and whether {@link run}
 * reads the plan again — see the note at its call site, which is why this
 * cannot be three literal entries in the table.
 */
export const INVALID_REQUEST = new Set(['http_400', 'http_422', 'invalid_body']);

/**
 * What a request be-01 could not read says.
 *
 * Reachable, and observed: a year segment typed one digit at a time made a date
 * of `dd.12.82026`, be-01 answered 422, and the corner of the screen read
 * `That change could not be completed (http_422).` — a status code, to somebody
 * who typed a date. {@link DateField} is the fix for the *cause*; this is the
 * sentence for whatever else sends be-01 something it cannot take.
 *
 * It says the plan was read again because {@link run} really does read it
 * again for this family, the same way it does for {@link GONE}: what is on
 * screen was refused, and the only honest thing to show next is what be-01
 * actually holds.
 */
export const INVALID_REFUSAL =
  'That change was not valid, so nothing was saved — what is on screen was read again.';

/**
 * What a refused mutation on this table says, by be-01's own word for it.
 *
 * Every other refusal in this table is a full sentence — `That could not be
 * undone: …`, `020 is frozen — unfreeze it first` — and these were the
 * exception: `not_found` and `http_500` reached the corner of the screen
 * verbatim, observed live on 2026-08-09. The table lives here rather than in
 * `wbs-api.ts` for the reason `auth-form.tsx` keeps its own map: the codes are
 * be-01's contract and have to stay stable, and the sentence is a presentation
 * decision that differs per surface. The **shape** of the lookup is
 * {@link sentenceForRefusal}, shared with the four tables in `wbs-api.ts`.
 *
 * Not exhaustive on purpose: the fallback carries the code, so a word nobody
 * has written a sentence for is still a sentence rather than a snake_case
 * token.
 */
export const PLAN_REFUSALS: RefusalWords = {
  sentences: {
    not_found:
      'That change could not be completed: its target is no longer here — someone may have deleted it.',
    forbidden: 'That change could not be completed: this plan is not yours to change.',
    // Reachable bare — the dependency **picker** takes one entry through `run`,
    // where the typed list composes its own sentence and keeps the word instead.
    cycle: 'That dependency could not be added: it would make a loop.',
    ancestor: 'That dependency could not be added: the row it names is already above this one.',
    // The two the In-parallel cell earns, spelled out rather than left to the
    // fallback below. That cell deliberately keeps no copy of be-01's rule and
    // sends `0`, `-1`, `1.5` and `1001` for be-01 to answer — which is right,
    // and which means be-01's own word is what arrives here, so the
    // malformed-request arm never fires and the grammatical fallback would carry
    // the token through. `(maxParallel_must_be_a_whole_number_from_1)` in the
    // corner of the screen is the same defect `not_found` and `http_500` were
    // fixed for above, in the one column of this table somebody types a number
    // into every week. `wbs-api.ts`'s `CAPACITY_REFUSALS` makes the same bargain
    // for the size box the same rule is written on.
    maxParallel_must_be_a_whole_number_from_1:
      'People at once is a whole number of 1 or more. Empty the cell for one at a time.',
    // be-01 refuses a parallelism on a parent because a parent holds no slices,
    // so nothing there would read the number. Only reachable through a race — the
    // cell is read-only on every row that already has children — which is exactly
    // why the sentence has to say what happened rather than name the code.
    has_children:
      'A row with work under it runs no people of its own — set People at once on the rows beneath it.',
    // {@link INVALID_REQUEST}'s three, worded from the one list that also decides
    // whether the plan is read again.
    ...Object.fromEntries([...INVALID_REQUEST].map((code) => [code, INVALID_REFUSAL])),
  },
  limits: [
    {
      // A prefix rather than an entry above, and for `wbs-api.ts`'s stated
      // reason: be-01 spells the limit into the code from its own
      // `MOST_PEOPLE_AT_ONCE`, so a literal `maxParallel_must_be_at_most_1000`
      // here would be a second copy of that number — free to drift from it, and
      // to fall silently back to printing the wire code the day it did.
      prefix: 'maxParallel_must_be_at_most_',
      says: (limit) => `People at once is at most ${limit}.`,
    },
  ],
  // Matched as a family rather than listed: a proxy in front of be-01 can answer
  // with any 5xx and none of them is the reader's doing. Something answered, so
  // the sentence never says the server did not.
  serverFailure: 'The server could not complete that change. Try again.',
  otherwise: (code) => `That change could not be completed (${code}).`,
};

/**
 * The sentence a refused mutation is reported in.
 *
 * @param thrown Whatever the request rejected with; anything that is not an
 * `Error` reads as an unknown code rather than being guessed at.
 */
export const refusalSentence = (thrown: unknown): string =>
  sentenceForRefusal(PLAN_REFUSALS, failureText(thrown, 'unknown'));

/**
 * be-01's word for "the row you named is not there", which is the one refusal
 * that also says the tree on screen is out of date.
 */
export const GONE = 'not_found';

/**
 * What an empty undo stack says.
 *
 * "Yours" is load-bearing: the stack is per account, so a plan somebody else
 * has been editing all morning still has nothing in it for this reader, and a
 * message saying only "nothing to undo" would read as a bug.
 */
export const NOTHING_TO_UNDO = 'There are none of your own changes left to undo on this plan.';

export const NOTHING_TO_REDO = 'There is nothing to put back — nothing of yours has been undone.';
