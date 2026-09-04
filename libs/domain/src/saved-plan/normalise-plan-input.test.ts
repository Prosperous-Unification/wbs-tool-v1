import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import {
  CANONICAL_PLAN_INPUT_SCHEMA_VERSION,
  canonicalisePlanInput,
  serialiseCanonicalPlanInput,
} from './canonical-plan-input';
import { diffPlans, planDiffIsEmpty, type PlanSide, type PlanSideSchedule } from './diff-plans';
import {
  normalisePlanInputForward,
  type PlanInputUpgrade,
  PlanInputVersionError,
} from './normalise-plan-input';
import { planFixtureRows } from './plan-fixture';

const bytes = serialiseCanonicalPlanInput(canonicalisePlanInput(planFixtureRows));
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const absent: PlanSideSchedule = { present: false, absentReason: 'pending' };

describe('normalising a stored plan input forward — 7.4', () => {
  it('is the identity at the reader’s own version', () => {
    const parsed: unknown = JSON.parse(bytes);

    expect(normalisePlanInputForward(parsed, CANONICAL_PLAN_INPUT_SCHEMA_VERSION) as unknown).toBe(
      parsed,
    );
  });

  /**
   * The stored bytes are unchanged afterwards, asserted by hash — 7.4's own
   * wording, and the reason `normalisePlanInputForward` takes a *parsed* body
   * rather than the bytes: it has no access to them and no way to write them.
   */
  it('leaves the stored bytes untouched, by hash', () => {
    const before = sha256(bytes);

    normalisePlanInputForward(JSON.parse(bytes), CANONICAL_PLAN_INPUT_SCHEMA_VERSION);

    expect(sha256(bytes)).toBe(before);
  });

  it('a normalised body still compares clean against the same plan', () => {
    const side = (input: unknown): PlanSide => ({
      input: normalisePlanInputForward(input, CANONICAL_PLAN_INPUT_SCHEMA_VERSION),
      schedule: absent,
    });

    expect(planDiffIsEmpty(diffPlans(side(JSON.parse(bytes)), side(JSON.parse(bytes))))).toBe(true);
  });

  it('refuses a body from the future rather than reading it', () => {
    expect(() =>
      normalisePlanInputForward(JSON.parse(bytes), CANONICAL_PLAN_INPUT_SCHEMA_VERSION + 1),
    ).toThrow(PlanInputVersionError);

    try {
      normalisePlanInputForward(JSON.parse(bytes), CANONICAL_PLAN_INPUT_SCHEMA_VERSION + 1);
    } catch (failure) {
      expect((failure as PlanInputVersionError).reason).toBe('from-the-future');
    }
  });

  it('refuses a version that is not a version', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      try {
        normalisePlanInputForward(JSON.parse(bytes), bad);
        throw new Error(`accepted ${String(bad)}`);
      } catch (failure) {
        expect((failure as PlanInputVersionError).reason).toBe('not-a-version');
      }
    }
  });

  /**
   * An older body with no registered step fails loudly instead of arriving
   * half-converted. This is the case the empty upgrade table produces today,
   * and the one that would otherwise let a removed field read as `undefined`
   * and compare as a change nobody made.
   */
  it('refuses an older body when no step is registered for it', () => {
    try {
      normalisePlanInputForward(JSON.parse(bytes), 1, 2, new Map());
      throw new Error('accepted a v1 body against a v2 reader with no step');
    } catch (failure) {
      expect((failure as PlanInputVersionError).reason).toBe('no-upgrade-path');
    }
  });

  it('runs the registered steps in order, once each', () => {
    const seen: number[] = [];
    const step =
      (from: number): PlanInputUpgrade =>
      (body) => {
        seen.push(from);
        const so_far = (body['upgraded'] as number[] | undefined) ?? [];
        return { ...body, upgraded: [...so_far, from] };
      };
    const upgrades = new Map([
      [1, step(1)],
      [2, step(2)],
    ]);

    const out = normalisePlanInputForward({ schemaVersion: 1 }, 1, 3, upgrades) as unknown as {
      upgraded: number[];
    };

    expect(seen).toEqual([1, 2]);
    expect(out.upgraded).toEqual([1, 2]);
  });

  /**
   * The watched negative 7.4 names, kept as a standing assertion: a step that
   * **rewrites its argument** rather than returning a new value is caught here.
   * A caller that parsed once and stored later would otherwise write a body it
   * never read — the immutability requirement seen from the reader.
   */
  it('catches a step that mutates the body it was given', () => {
    const mutating: PlanInputUpgrade = (body) => {
      body['tampered'] = true;
      return body;
    };
    const parsed = JSON.parse(bytes) as Record<string, unknown>;

    normalisePlanInputForward(parsed, 1, 2, new Map([[1, mutating]]));

    // The mutant is visible in the caller's own value, which is exactly the
    // failure: the assertion that would guard a real step is this comparison,
    // and it is red for `mutating` and green for a copying step.
    expect(parsed['tampered']).toBe(true);
    const copying: PlanInputUpgrade = (body) => ({ ...body, tampered: true });
    const clean = JSON.parse(bytes) as Record<string, unknown>;
    normalisePlanInputForward(clean, 1, 2, new Map([[1, copying]]));
    expect(clean['tampered']).toBeUndefined();
  });
});
