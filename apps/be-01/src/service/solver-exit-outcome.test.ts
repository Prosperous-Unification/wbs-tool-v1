import { buildSolverRequest } from '@wbs/contracts/solver/build-request';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { evaluateSolverOutcome } from './solver-exit-outcome';

const INPUT: ScheduleInput = {
  rows: [{ id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: 2 }],
  edges: [],
  slices: [
    {
      workItemId: 'w-1',
      stepId: 'dev',
      days: 2,
      personId: null,
      width: 1,
      poolIds: [],
    },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

const built = buildSolverRequest(INPUT, 'pri', {
  baselineOffsets: { 'w-1\u0000dev': 0 },
  solverVersion: '0.1.0',
  budgetMs: 60_000,
});
if (!built.ok) throw new Error('fixture request refused');
const REQUEST = built.request;

const DEADLINED_INPUT: ScheduleInput = {
  ...INPUT,
  deadlines: new Map([['w-1', 0]]),
};
const deadlined = buildSolverRequest(DEADLINED_INPUT, 'pri', {
  baselineOffsets: { 'w-1\u0000dev': 0 },
  solverVersion: '0.1.0',
  budgetMs: 60_000,
});
if (!deadlined.ok) throw new Error('fixture deadline request refused');

const response = (offset = 0, reportedOffset = offset): string =>
  `${JSON.stringify({
    wireVersion: 1,
    status: 'feasible',
    offsets: { 'w-1\u0000dev': offset },
    objectiveValues: {
      makespan: {
        value: 96 + reportedOffset,
        stageValue: 96 + reportedOffset,
        bound: 96,
        status: 'optimal',
      },
      priority: {
        value: 96 + reportedOffset,
        stageValue: 96 + reportedOffset,
        bound: 96,
        status: 'optimal',
      },
      movement: {
        value: reportedOffset,
        stageValue: reportedOffset,
        bound: 0,
        status: 'optimal',
      },
    },
  })}\n`;

describe('evaluateSolverOutcome', () => {
  it('revalidates, materialises and keeps a feasible solver result', () => {
    const outcome = evaluateSolverOutcome(INPUT, REQUEST, {
      kind: 'response',
      stdout: response(),
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.publication).toBe('solver');
    expect(outcome.result.schedule.slices.get('w-1\u0000dev')?.earliestFinish).toBe(2);
  });

  it('maps framing and revalidation defects to invalid-output', () => {
    expect(evaluateSolverOutcome(INPUT, REQUEST, { kind: 'response', stdout: 'not json' })).toEqual(
      { kind: 'failed', reason: 'invalid-output' },
    );
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, { kind: 'response', stdout: response(1, 0) }),
    ).toEqual({ kind: 'failed', reason: 'invalid-output' });
    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, deadlined.request, {
        kind: 'response',
        stdout: response(),
      }),
    ).toEqual({ kind: 'failed', reason: 'invalid-output' });
  });

  it('keeps classified process failures and distinguishes solver no-answer states', () => {
    expect(evaluateSolverOutcome(INPUT, REQUEST, { kind: 'failed', reason: 'oom' })).toEqual({
      kind: 'failed',
      reason: 'oom',
    });
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"unknown"}\n',
      }),
    ).toEqual({ kind: 'failed', reason: 'no-solution' });
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"infeasible"}\n',
      }),
    ).toEqual({ kind: 'failed', reason: 'invalid-output' });
    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, deadlined.request, {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"infeasible"}\n',
      }),
    ).toEqual({
      kind: 'plan-infeasible',
      certificate: {
        items: [
          {
            ownerWorkItemId: 'w-1',
            boundWorkItemId: 'w-1',
            effectiveDeadlineOffset: 0,
          },
        ],
      },
    });
  });

  /**
   * TASK-329 AC #1, on the reviewer's own input and against the exact outcome
   * this seam used to produce.
   *
   * The request is built by hand because `buildSolverRequest` cannot emit it:
   * `deadlineUnitsOf` returns `(D + 1) × 48` or `null`, so every deadline
   * production has ever put on the wire is a multiple by construction. That is
   * the point rather than an obstacle — the independent guard exists for the
   * case where the sender is wrong about the contract, and a test that can only
   * reach the guard through the sender is testing the sender.
   *
   * A zero-duration slice floored at unit 1 and due at unit 1 is genuinely
   * unsolvable, so CP-SAT's `infeasible` is a true answer to a question that
   * means nothing: the due day is `1 / 48 − 1`. Before this change the answer
   * was stored as a `plan-infeasible` certificate, which `Retry` refuses to
   * re-solve. `inputHash` keys the authored deadline, so it cannot distinguish
   * a derived `deadlineUnits` that has diverged from that input — a sticky
   * deterministic claim about the user's deadlines. It is now `internal-error`,
   * which is where `malformed-request` disposes: the fault is on our side of
   * the seam because the builder is ours.
   */
  it('refuses a deadline that names no day instead of certifying it plan-infeasible', () => {
    const withDeadline = (deadlineUnits: number) => ({
      ...deadlined.request,
      slices: deadlined.request.slices.map((slice) => ({
        ...slice,
        durationUnits: 0,
        workItemIsMilestone: true,
        notBeforeUnits: 1,
        deadlineUnits,
      })),
    });

    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, withDeadline(1), {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"infeasible"}\n',
      }),
    ).toEqual({ kind: 'failed', reason: 'internal-error' });

    // The neighbour, and it is what proves the ordering change refused the
    // malformed request rather than the infeasible path: same slice, same
    // floor, but 48 is a multiple, so the response is still dispositioned and
    // the certificate is still stored.
    //
    // Narrowed on Sol's round-2 Minor. This does NOT prove the certificate is
    // deserved, and an earlier draft of this comment said it was. With
    // `durationUnits: 0` and `notBeforeUnits: 1` CP-SAT admits every start in
    // `[1, 47]`, so the plan is satisfiable and the `infeasible` line below is
    // fabricated. What the case establishes is exactly one thing — that a
    // well-formed request still reaches status disposition — and whether the
    // solver was right to say `infeasible` is a different question this seam
    // does not ask.
    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, withDeadline(48), {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"infeasible"}\n',
      }).kind,
    ).toBe('plan-infeasible');

    // `unknown` shares the ordering and not the disposition: the request is
    // still unjudgeable, so it is reported as one instead of as no-solution.
    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, withDeadline(1), {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"unknown"}\n',
      }),
    ).toEqual({ kind: 'failed', reason: 'internal-error' });
  });
});
