/**
 * Modeled HTTP failures; status/code pairing is narrowed by each endpoint shape.
 * A classified OIDC defect is the one modeled 500; thrown failures still bypass
 * endpoint replies and reach the adapter error boundary.
 */
export type RefusalStatus = 400 | 401 | 403 | 404 | 405 | 409 | 422 | 429 | 500 | 501 | 503;

/** Portable command discriminants, shared with runtime command refusal context. */
export type PlanCommandKind =
  | 'createWorkItem'
  | 'patchWorkItem'
  | 'moveWorkItem'
  | 'duplicateWorkItem'
  | 'deleteWorkItem'
  | 'setEstimate'
  | 'clearEstimate'
  | 'setActual'
  | 'clearActual'
  | 'setProgress'
  | 'clearProgress'
  | 'setMeasure'
  | 'clearMeasure'
  | 'setAssignee'
  | 'addDependency'
  | 'removeDependency'
  | 'freezeProject'
  | 'unfreezeProject'
  | 'unfreezeWorkItem'
  | 'setCapacity'
  | 'setPriorityBands'
  | 'createTeam'
  | 'patchTeam'
  | 'deleteTeam'
  | 'createPerson'
  | 'patchPerson'
  | 'deletePerson'
  | 'createTag'
  | 'patchTag'
  | 'deleteTag'
  | 'createWorkItemType'
  | 'patchWorkItemType'
  | 'deleteWorkItemType'
  | 'createService'
  | 'patchService'
  | 'deleteService';

/**
 * Existing parser messages enumerate their field callers, never arbitrary templates.
 * Proof (type boundary only): adding `${string}_must_be_an_id` makes the invalid
 * password-field fixture fail with TS2578. Production endpoint proof is pending.
 */
export type ParserRefusalCode =
  | 'expected_object'
  | 'number_is_derived'
  | 'externalRefs_must_be_a_list'
  | 'too_many_externalRefs'
  | 'externalRefs_entry_needs_a_systemId'
  | 'externalRefs_entry_needs_a_url'
  | 'externalRefs_entry_name_is_not_text'
  | 'externalRefs_entry_name_is_too_long'
  | 'invalid_actual'
  | 'invalid_measure'
  | 'invalid_progress'
  | 'invalid_estimate'
  | 'cannot_send_both_teamIds_and_serviceTeamId'
  | 'unknown_kind'
  | 'unknown_strategy'
  | 'commands_must_be_a_list'
  | 'size_required'
  | 'bands_required'
  | 'bands_must_be_an_array'
  | 'bands_must_number_5'
  | 'bands_must_be_objects'
  | 'band_start_must_be_a_whole_number_from_1'
  | 'band_default_must_be_a_whole_number_from_1'
  | 'band_label_must_be_1_to_40_characters'
  | 'band_labels_must_differ'
  | 'first_band_must_start_at_1'
  | 'bands_must_start_in_increasing_order'
  | 'band_default_must_be_inside_its_own_band'
  | `${'parentId' | 'afterId' | 'personId' | 'serviceTeamId'}_must_be_id_or_null`
  | `${'name' | 'notes' | 'kind' | 'startNoEarlierThanReason' | 'stepId' | 'metric'}_must_be_text`
  | `${'workItemId' | 'workItemRef' | 'ref' | 'parentRef' | 'afterRef' | 'personRef' | 'predecessorId' | 'predecessorRef' | 'teamId' | 'teamRef' | 'personId' | 'tagId' | 'tagRef' | 'typeId' | 'typeRef' | 'serviceId' | 'serviceRef'}_must_be_an_id`
  | `${'teamIds' | 'teamRefs' | 'tagIds' | 'tagRefs' | 'serviceIds' | 'serviceRefs' | 'typeIds' | 'typeRefs'}_must_be_a_list_of_ids`
  | `${'teamIds' | 'teamRefs' | 'serviceIds' | 'serviceRefs' | 'typeIds' | 'typeRefs'}_must_be_at_most_10`
  | `${'tagIds' | 'tagRefs'}_must_be_at_most_50`
  | 'startNoEarlierThan_must_be_a_date'
  | 'deadline_must_be_a_date'
  | `${'priority' | 'maxParallel' | 'size'}_must_be_a_whole_number_from_1`
  | `${'maxParallel' | 'size'}_must_be_at_most_1000`
  | 'cascade_must_be_true_or_false'
  | 'startNoEarlierThanReason_must_be_at_most_200_characters';

/** Service/runner refusals after a command kind has been recognized. */
export type CommandRefusalCode =
  | 'too_many_commands'
  | 'project_required'
  | 'unknown_ref'
  | 'missing_id'
  | 'duplicate_ref'
  | 'name_required'
  | 'not_found'
  | 'forbidden'
  | 'strategy_required'
  | 'cycle'
  | 'frozen'
  | 'rolled_up'
  | 'has_children'
  | 'ancestor'
  | 'too_large'
  | 'unknown_step'
  | 'unknown_metric'
  | 'unknown_person'
  | 'unknown_team'
  | 'unknown_tag'
  | 'unknown_service'
  | 'unknown_type'
  | 'unknown_system'
  | 'not_before_reason_needs_a_date'
  | 'deadline_before_project_start'
  | 'invalid_kind'
  | 'nothing_to_change'
  | 'taken'
  | 'in_use';

/**
 * Proof (type boundary only): making kind optional produces TS2578 for both the
 * runtime and global incomplete-command fixtures. Production binding is pending.
 */
export interface CommandContext {
  at: number;
  kind: PlanCommandKind;
}

/** A parser can fail before an index or recognized kind exists; runtime commands cannot. */
type ParserContext = undefined | { at: number; kind?: never } | CommandContext;

export type DirectoryEffect =
  | { kind: 'assignment_dropped'; step: { id: string; name: string } }
  | { kind: 'label_nulled' }
  | { kind: 'label_removed' }
  | { kind: 'capacity_released'; size: number; fromId: string }
  | { kind: 'assumed_assignee_changed'; assumedNow: string | null; assumedAfter: string | null };

/** Both affected-project and directory-member lists are present, including when empty. */
export interface DirectoryUsage {
  projects: {
    id: string;
    name: string;
    workItems: { id: string; number: string; name: string; effects: DirectoryEffect[] }[];
  }[];
  members: { id: string; name: string }[];
}

/**
 * Mirrors apps/be-01/src/service/step.service.ts::StepInUse, including explicit
 * assignments omitted by the initial HTTP inventory. Proof (type boundary only):
 * making assignments optional produces TS2578 for its missing-field fixture.
 */
export interface StepInUse {
  estimates: number;
  actuals: number;
  progress: number;
  measures: number;
  assignments: number;
  assumedAssignees: {
    workItemId: string;
    assumedNow: string | null;
    assumedAfter: string | null;
  }[];
}

export interface Quota {
  limit: 'body_bytes' | 'plan_count' | 'project_bytes';
  asked: number;
  allowed: number;
}

/**
 * Saved-body integrity failures preserve hash and reader-version evidence.
 * Proof (type boundary only): admitting input in schedule_input_mismatch makes
 * its incorrect-body fixture fail with TS2578. Production binding is pending.
 */
export type Integrity = { savedPlanId: string } & (
  | { reason: 'body_missing'; body: 'input' | 'schedule' }
  | { reason: 'body_hash_mismatch'; body: 'input' | 'schedule'; stored: string; recomputed: string }
  | {
      reason: 'schedule_input_mismatch';
      body: 'schedule';
      scheduleInputSha256: string;
      inputSha256: string;
    }
  | {
      reason: 'input_version_unreadable';
      body: 'input';
      storedVersion: number;
      readerVersion: number;
      versionReason: 'from-the-future' | 'no-upgrade-path' | 'not-a-version';
    }
);

/** Command-specific fields are finite; at/kind are required independently of the refusal code. */
export type CommandRefusalDetail = {
  [C in CommandRefusalCode]: CommandContext &
    // Proof: making projectDayZero optional caused TS2578 in the deadline refusal type fixture.
    (C extends 'deadline_before_project_start'
      ? { workItemId: string; projectDayZero: string }
      : C extends 'in_use'
        ? { usage: DirectoryUsage }
        : C extends 'taken'
          ? { name?: string }
          : Record<never, never>);
};

type BareRefusalCode =
  | 'unauthenticated'
  | 'insufficient_scope'
  | 'invalid_origin'
  | 'unauthorized'
  | 'invalid_body'
  | 'invalid_query'
  | 'unsupported_format'
  | 'bad_start_date'
  | 'bad_pert_weights'
  | 'optimizer_unavailable'
  | 'snapshot_busy'
  | 'invalid_client'
  | 'rate_limited'
  | 'invalid_credentials'
  | 'invalid_token'
  | 'invalid'
  | 'method_not_allowed'
  | 'duplicate_parameter'
  | 'invalid_json'
  | 'invalid_params'
  | 'invalid_oidc_callback'
  | 'invalid_oidc_session'
  | 'oidc_identity_conflict';

type SharedCommandCode = 'not_found' | 'forbidden' | 'name_required' | 'taken' | 'in_use';

/**
 * Details by finite code. Undefined means no detail, never an open object bag.
 * Per-endpoint response schemas narrow the applicable route variant and status.
 * The new OIDC/health/parser codes describe approved wire translations still
 * awaiting production endpoint binding; they do not classify thrown exceptions.
 * Approved translations preserve statuses: bodiless callback 400 becomes
 * invalid_oidc_callback; callback/refresh 401 becomes invalid_oidc_session;
 * unresolved OIDC account 409 becomes oidc_identity_conflict. Health 503 becomes
 * dependency_unavailable and retains status/commit. Malformed JSON 400 becomes
 * invalid_json; freeform smoke/internal validation 400 becomes invalid_body
 * (existing invalid_body 422 arms stay 422). Cookies, logs and timing stay local
 * to their endpoint; RefusalStatus does not infer a status from a code.
 */
export type RefusalDetail = Record<BareRefusalCode, undefined> &
  Record<ParserRefusalCode, ParserContext> & {
    [C in Exclude<CommandRefusalCode, SharedCommandCode>]: CommandRefusalDetail[C];
  } & {
    not_found: { savedPlanId?: string } | { field?: 'markerId' } | CommandContext;
    forbidden: undefined | CommandContext;
    name_required: undefined | CommandContext;
    taken: undefined | { field?: 'markerId' } | CommandRefusalDetail['taken'];
    in_use: { inUse: StepInUse } | CommandRefusalDetail['in_use'];
    nothing_to_undo: { detail: string | null };
    stale_undo: { detail: string | null };
    malformed: { field: 'body' | 'markerId' | 'date' | 'name' | 'color' };
    contrast: { field: 'color' };
    quota: { refusal: Quota };
    corrupt: { refusal: Integrity; savedPlanId?: string };
    unsupported_body_version: {
      savedPlanId: string;
      body: 'input' | 'schedule';
      version: number;
      supported: readonly number[];
    };
    dependency_unavailable: {
      status: 'migrating' | 'database_unreachable' | 'schema_missing';
      commit: string | null;
    };
  };

export type RefusalCode = keyof RefusalDetail;

type UnionKeys<T> = T extends T ? keyof T : never;
/** Prevents mixing route-specific fields merely because their error codes coincide. */
type ClosedVariants<T, Whole = T> = T extends T
  ? T & Partial<Record<Exclude<UnionKeys<Whole>, keyof T>, never>>
  : never;
type Envelope<C, D> = D extends undefined ? { error: C } : { error: C } & D;

/**
 * One discriminated envelope, without batch metadata on non-command routes.
 * Proof (type boundary only): replacing this with an open unknown-valued record
 * produces eleven TS2578 diagnostics for invalid detail/context fixtures.
 * Endpoint response validation and wire status correlation remain pending.
 */
type ErrorRefusal<C extends RefusalCode = RefusalCode> = {
  [K in C]: ClosedVariants<Envelope<K, RefusalDetail[K]>>;
}[C];

/** Retry retains the coordinator decision as `code`; clients branch on this established envelope. */
export type OptimizerRetryRefusal =
  | { code: 'stale-input-hash'; currentInputHash: string }
  | {
      code: 'not-retryable';
      state: 'ready' | 'pending' | 'retrying' | 'failed' | 'corrupt' | 'plan-infeasible' | 'idle';
    }
  | { code: 'already-running' };

export type Refusal<C extends RefusalCode = RefusalCode> = ErrorRefusal<C> | OptimizerRetryRefusal;

/** Runtime command failures always retain their command index and recognized kind. */
export type CommandRefusal<C extends CommandRefusalCode = CommandRefusalCode> = {
  [K in C]: { error: K } & CommandRefusalDetail[K];
}[C];
