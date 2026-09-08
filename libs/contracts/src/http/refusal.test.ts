import { expect, expectTypeOf, test } from 'bun:test';

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
export function refusalTypeCases() {
  expectTypeOf<RefusalCode>('parentId_must_be_id_or_null');
  expectTypeOf<RefusalCode>('typeRefs_must_be_at_most_10');
  expectTypeOf<RefusalStatus>(405);
  expectTypeOf<RefusalStatus>(500);
  expectTypeOf<RefusalStatus>(501);
  // @ts-expect-error Unknown codes cannot escape through a string fallback.
  expectTypeOf<RefusalCode>('anything_else');
  // @ts-expect-error Field templates enumerate their actual callers.
  expectTypeOf<RefusalCode>('password_must_be_an_id');
  expectTypeOf<Refusal>({ error: 'not_found' });
  expectTypeOf<Refusal>({ error: 'not_found', savedPlanId: 'saved' });
  expectTypeOf<CommandRefusal>({ error: 'not_found', at: 0, kind: 'patchWorkItem' });
  // @ts-expect-error Runtime command context always includes a recognized kind.
  expectTypeOf<CommandRefusal>({ error: 'not_found', at: 0 });
  // @ts-expect-error Bare global variants must not permit incomplete batch context.
  expectTypeOf<Refusal>({ error: 'not_found', at: 0 });
  // @ts-expect-error A runtime command kind is finite.
  expectTypeOf<CommandRefusal>({ error: 'not_found', at: 0, kind: 'arbitrary' });
  expectTypeOf<Refusal>({ error: 'unknown_kind', at: 0 });
  // @ts-expect-error Recognized parser kind requires its index.
  expectTypeOf<Refusal>({ error: 'expected_object', kind: 'patchWorkItem' });
  const mixedNotFound = {
    error: 'not_found',
    savedPlanId: 'saved',
    at: 0,
    kind: 'patchWorkItem',
  } as const;
  // @ts-expect-error A marker/lookup refusal cannot be combined with batch metadata.
  expectTypeOf<Refusal>(mixedNotFound);
  expectTypeOf<CommandRefusal>({ error: 'taken', at: 0, kind: 'createTeam', name: 'Team' });
  // @ts-expect-error An arbitrary detail bag is not a directory refusal.
  expectTypeOf<Refusal>({ error: 'taken', at: 0, kind: 'createTeam', arbitrary: true });
  expectTypeOf<CommandRefusal>({
    error: 'in_use',
    at: 0,
    kind: 'deleteTeam',
    usage: { projects: [], members: [] },
  });
  // @ts-expect-error Directory usage always reports both arrays.
  expectTypeOf<Refusal>({ error: 'in_use', at: 0, kind: 'deleteTeam', usage: { projects: [] } });
  expectTypeOf<Refusal>({
    error: 'in_use',
    inUse: {
      estimates: 1,
      actuals: 2,
      progress: 3,
      measures: 4,
      assignments: 5,
      assumedAssignees: [{ workItemId: 'w', assumedNow: null, assumedAfter: 'Ada' }],
    },
  });
  const missingAssignments = {
    estimates: 1,
    actuals: 2,
    progress: 3,
    measures: 4,
    assumedAssignees: [],
  };
  // @ts-expect-error Explicit assignment losses cannot disappear from step usage.
  expectTypeOf<StepInUse>(missingAssignments);
  expectTypeOf<Refusal>({
    error: 'quota',
    refusal: { limit: 'body_bytes', asked: 10, allowed: 9 },
  });
  // @ts-expect-error A quota names the allowed bound, not an arbitrary payload.
  expectTypeOf<Refusal>({ error: 'quota', refusal: { limit: 'body_bytes', asked: 10 } });
  expectTypeOf<Refusal>({ error: 'malformed', field: 'markerId' });
  // @ts-expect-error Contrast failures belong only to marker color.
  expectTypeOf<Refusal>({ error: 'contrast', field: 'date' });
  // @ts-expect-error Marker validation keeps its required field detail.
  expectTypeOf<Refusal>({ error: 'malformed' });
  expectTypeOf<Refusal>({
    error: 'unsupported_body_version',
    savedPlanId: 's',
    body: 'input',
    version: 2,
    supported: [1],
  });
  const missingSupported = {
    error: 'unsupported_body_version',
    savedPlanId: 's',
    body: 'input',
    version: 2,
  } as const;
  // @ts-expect-error A version refusal must retain supported reader versions.
  expectTypeOf<Refusal>(missingSupported);
  expectTypeOf<Integrity>({
    savedPlanId: 's',
    body: 'schedule',
    reason: 'schedule_input_mismatch',
    scheduleInputSha256: 'a',
    inputSha256: 'b',
  });
  const inputScheduleMismatch = {
    savedPlanId: 's',
    body: 'input',
    reason: 'schedule_input_mismatch',
    scheduleInputSha256: 'a',
    inputSha256: 'b',
  } as const;
  // @ts-expect-error Schedule/input mismatch cannot claim an input body.
  expectTypeOf<Integrity>(inputScheduleMismatch);
  const missingStoredHash = {
    savedPlanId: 's',
    body: 'input',
    reason: 'body_hash_mismatch',
    recomputed: 'b',
  } as const;
  // @ts-expect-error Missing stored hash is not a complete integrity report.
  expectTypeOf<Integrity>(missingStoredHash);
  expectTypeOf<Refusal>({
    error: 'dependency_unavailable',
    status: 'schema_missing',
    commit: null,
  });
  // @ts-expect-error Health detail keeps its commit metadata.
  expectTypeOf<Refusal>({ error: 'dependency_unavailable', status: 'migrating' });
  // @ts-expect-error Healthy status cannot appear in a dependency refusal.
  expectTypeOf<Refusal>({ error: 'dependency_unavailable', status: 'ok', commit: null });
  // @ts-expect-error No-detail is absence, never arbitrary text or an open object.
  expectTypeOf<RefusalDetail['invalid_json']>('anything');
  expectTypeOf<Refusal>({ error: 'invalid_oidc_callback' });
  expectTypeOf<Refusal>({ error: 'invalid_oidc_session' });
  expectTypeOf<Refusal>({ error: 'oidc_identity_conflict' });
  expectTypeOf<Refusal>({ code: 'stale-input-hash', currentInputHash: 'new' });
  expectTypeOf<Refusal>({ code: 'not-retryable', state: 'plan-infeasible' });
  expectTypeOf<Refusal>({ code: 'already-running' });
  // @ts-expect-error Retry states are the coordinator's finite public states.
  expectTypeOf<Refusal>({ code: 'not-retryable', state: 'future' });
}

// Case budget stated, not defaulted (TASK-415). Two observations that disagree
// by 1.7x: 1952ms on h2puni at load 7-9, and 1125ms in the sweep recorded in
// notes/t415-per-case-duration-sweep.txt. This case spawns tsc, so its duration
// tracks host load rather than anything the assertion does, and it is the one
// case of the four where the choice of observation changes the answer -- 5x the
// sweep figure would give 6000ms. 10000ms is 5x the slower observation, rounded
// up, deliberately: for a load-sensitive case the safe direction is the one
// that does not redden on a busy host. Re-derive with notes/t415-sweep.sh.
test('the compiler enforces closed refusal codes, detail variants and command context', () => {
  const checked = Bun.spawnSync({
    cmd: [
      process.execPath,
      // The gate's own compiler (`bunx tsc`); the `typescript` package is the
      // TS6 API kept for ESLint and ships no `tsc` bin.
      'node_modules/.bin/tsc',
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
}, 10000);

export function deadlineRefusalTypes() {
  const valid = {
    error: 'deadline_before_project_start' as const,
    at: 0,
    kind: 'patchWorkItem' as const,
    workItemId: 'w',
    projectDayZero: '2026-09-07',
  };
  expectTypeOf<Refusal>(valid);
  const { projectDayZero, ...missingDayZero } = valid;
  // @ts-expect-error The deadline refusal identifies both the row and project day zero.
  expectTypeOf<Refusal>(missingDayZero);
  const missingContext = {
    error: 'deadline_before_project_start' as const,
    workItemId: 'w',
    projectDayZero: '2026-09-07',
  };
  // @ts-expect-error A runtime deadline refusal cannot lose its recognized command context.
  expectTypeOf<Refusal>(missingContext);
  expectTypeOf<Refusal>({ error: 'deadline_must_be_a_date', at: 0, kind: 'patchWorkItem' });
}

export function markerOptionalFieldTypes(field?: 'markerId') {
  expectTypeOf<Refusal>({ error: 'not_found', field });
  expectTypeOf<Refusal>({ error: 'taken', field });
  // @ts-expect-error Optional marker detail still cannot mix with saved-plan detail.
  expectTypeOf<Refusal>({ error: 'not_found', field: 'markerId', savedPlanId: 's' });
  // @ts-expect-error Optional marker detail still cannot mix with command context.
  expectTypeOf<Refusal>({ error: 'taken', field: 'markerId', at: 0, kind: 'createTeam' });
}
