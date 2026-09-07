import { expect, test } from 'bun:test';

import type {
  CommandRefusal,
  Integrity,
  Refusal,
  RefusalCode,
  RefusalDetail,
  RefusalStatus,
  StepInUse,
} from './refusal';

/** Compiled by the test below; these are type-boundary checks, not production wire proofs. */
function refusalTypeCases() {
  void ('parentId_must_be_id_or_null' satisfies RefusalCode);
  void ('typeRefs_must_be_at_most_10' satisfies RefusalCode);
  void (405 satisfies RefusalStatus);
  void (500 satisfies RefusalStatus);
  void (501 satisfies RefusalStatus);
  // @ts-expect-error Unknown codes cannot escape through a string fallback.
  void ('anything_else' satisfies RefusalCode);
  // @ts-expect-error Field templates enumerate their actual callers.
  void ('password_must_be_an_id' satisfies RefusalCode);
  void ({ error: 'not_found' } satisfies Refusal);
  void ({ error: 'not_found', savedPlanId: 'saved' } satisfies Refusal);
  void ({ error: 'not_found', at: 0, kind: 'patchWorkItem' } satisfies CommandRefusal);
  // @ts-expect-error Runtime command context always includes a recognized kind.
  void ({ error: 'not_found', at: 0 } satisfies CommandRefusal);
  // @ts-expect-error Bare global variants must not permit incomplete batch context.
  void ({ error: 'not_found', at: 0 } satisfies Refusal);
  // @ts-expect-error A runtime command kind is finite.
  void ({ error: 'not_found', at: 0, kind: 'arbitrary' } satisfies CommandRefusal);
  void ({ error: 'unknown_kind', at: 0 } satisfies Refusal);
  // @ts-expect-error Recognized parser kind requires its index.
  void ({ error: 'expected_object', kind: 'patchWorkItem' } satisfies Refusal);
  const mixedNotFound = {
    error: 'not_found',
    savedPlanId: 'saved',
    at: 0,
    kind: 'patchWorkItem',
  } as const;
  // @ts-expect-error A marker/lookup refusal cannot be combined with batch metadata.
  void (mixedNotFound satisfies Refusal);
  void ({ error: 'taken', at: 0, kind: 'createTeam', name: 'Team' } satisfies CommandRefusal);
  // @ts-expect-error An arbitrary detail bag is not a directory refusal.
  void ({ error: 'taken', at: 0, kind: 'createTeam', arbitrary: true } satisfies Refusal);
  void ({
    error: 'in_use',
    at: 0,
    kind: 'deleteTeam',
    usage: { projects: [], members: [] },
  } satisfies CommandRefusal);
  // @ts-expect-error Directory usage always reports both arrays.
  void ({ error: 'in_use', at: 0, kind: 'deleteTeam', usage: { projects: [] } } satisfies Refusal);
  void ({
    error: 'in_use',
    inUse: {
      estimates: 1,
      actuals: 2,
      progress: 3,
      measures: 4,
      assignments: 5,
      assumedAssignees: [{ workItemId: 'w', assumedNow: null, assumedAfter: 'Ada' }],
    },
  } satisfies Refusal);
  const missingAssignments = {
    estimates: 1,
    actuals: 2,
    progress: 3,
    measures: 4,
    assumedAssignees: [],
  };
  // @ts-expect-error Explicit assignment losses cannot disappear from step usage.
  void (missingAssignments satisfies StepInUse);
  void ({
    error: 'quota',
    refusal: { limit: 'body_bytes', asked: 10, allowed: 9 },
  } satisfies Refusal);
  // @ts-expect-error A quota names the allowed bound, not an arbitrary payload.
  void ({ error: 'quota', refusal: { limit: 'body_bytes', asked: 10 } } satisfies Refusal);
  void ({ error: 'malformed', field: 'markerId' } satisfies Refusal);
  // @ts-expect-error Contrast failures belong only to marker color.
  void ({ error: 'contrast', field: 'date' } satisfies Refusal);
  // @ts-expect-error Marker validation keeps its required field detail.
  void ({ error: 'malformed' } satisfies Refusal);
  void ({
    error: 'unsupported_body_version',
    savedPlanId: 's',
    body: 'input',
    version: 2,
    supported: [1],
  } satisfies Refusal);
  const missingSupported = {
    error: 'unsupported_body_version',
    savedPlanId: 's',
    body: 'input',
    version: 2,
  } as const;
  // @ts-expect-error A version refusal must retain supported reader versions.
  void (missingSupported satisfies Refusal);
  void ({
    savedPlanId: 's',
    body: 'schedule',
    reason: 'schedule_input_mismatch',
    scheduleInputSha256: 'a',
    inputSha256: 'b',
  } satisfies Integrity);
  const inputScheduleMismatch = {
    savedPlanId: 's',
    body: 'input',
    reason: 'schedule_input_mismatch',
    scheduleInputSha256: 'a',
    inputSha256: 'b',
  } as const;
  // @ts-expect-error Schedule/input mismatch cannot claim an input body.
  void (inputScheduleMismatch satisfies Integrity);
  const missingStoredHash = {
    savedPlanId: 's',
    body: 'input',
    reason: 'body_hash_mismatch',
    recomputed: 'b',
  } as const;
  // @ts-expect-error Missing stored hash is not a complete integrity report.
  void (missingStoredHash satisfies Integrity);
  void ({
    error: 'dependency_unavailable',
    status: 'schema_missing',
    commit: null,
  } satisfies Refusal);
  // @ts-expect-error Health detail keeps its commit metadata.
  void ({ error: 'dependency_unavailable', status: 'migrating' } satisfies Refusal);
  // @ts-expect-error Healthy status cannot appear in a dependency refusal.
  void ({ error: 'dependency_unavailable', status: 'ok', commit: null } satisfies Refusal);
  // @ts-expect-error No-detail is absence, never arbitrary text or an open object.
  void ('anything' satisfies RefusalDetail['invalid_json']);
  void ({ error: 'invalid_oidc_callback' } satisfies Refusal);
  void ({ error: 'invalid_oidc_session' } satisfies Refusal);
  void ({ error: 'oidc_identity_conflict' } satisfies Refusal);
  void ({ code: 'stale-input-hash', currentInputHash: 'new' } satisfies Refusal);
  void ({ code: 'not-retryable', state: 'plan-infeasible' } satisfies Refusal);
  void ({ code: 'already-running' } satisfies Refusal);
  // @ts-expect-error Retry states are the coordinator's finite public states.
  void ({ code: 'not-retryable', state: 'future' } satisfies Refusal);
}
void refusalTypeCases;

test('the compiler enforces closed refusal codes, detail variants and command context', () => {
  const checked = Bun.spawnSync({
    cmd: [
      process.execPath,
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--moduleResolution',
      'bundler',
      '--module',
      'esnext',
      '--target',
      'es2022',
      '--types',
      'bun-types',
      'libs/contracts/src/http/refusal.test.ts',
    ],
    cwd: new URL('../../../../', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(new TextDecoder().decode(checked.stdout) + new TextDecoder().decode(checked.stderr)).toBe(
    '',
  );
  expect(checked.exitCode).toBe(0);
});

function deadlineRefusalTypes() {
  const valid = {
    error: 'deadline_before_project_start' as const,
    at: 0,
    kind: 'patchWorkItem' as const,
    workItemId: 'w',
    projectDayZero: '2026-09-07',
  };
  void (valid satisfies Refusal);
  const { projectDayZero, ...missingDayZero } = valid;
  void projectDayZero;
  // @ts-expect-error The deadline refusal identifies both the row and project day zero.
  void (missingDayZero satisfies Refusal);
  const missingContext = {
    error: 'deadline_before_project_start' as const,
    workItemId: 'w',
    projectDayZero: '2026-09-07',
  };
  // @ts-expect-error A runtime deadline refusal cannot lose its recognized command context.
  void (missingContext satisfies Refusal);
  void ({ error: 'deadline_must_be_a_date', at: 0, kind: 'patchWorkItem' } satisfies Refusal);
}
void deadlineRefusalTypes;

function markerOptionalFieldTypes(field?: 'markerId') {
  void ({ error: 'not_found', field } satisfies Refusal);
  void ({ error: 'taken', field } satisfies Refusal);
  // @ts-expect-error Optional marker detail still cannot mix with saved-plan detail.
  void ({ error: 'not_found', field: 'markerId', savedPlanId: 's' } satisfies Refusal);
  // @ts-expect-error Optional marker detail still cannot mix with command context.
  void ({ error: 'taken', field: 'markerId', at: 0, kind: 'createTeam' } satisfies Refusal);
}
void markerOptionalFieldTypes;
