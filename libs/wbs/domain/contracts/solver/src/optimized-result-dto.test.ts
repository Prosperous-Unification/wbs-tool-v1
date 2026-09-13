import {
  CACHE_DTO_VERSION,
  encodeSchedule,
  type PlannedRow,
  type PoolSizes,
  type Schedule,
  schedule,
  type Slice,
  type StoredSchedule,
} from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import {
  decodeOptimizedResult,
  encodeOptimizedResult,
  type OptimizedResult,
  RESULT_DTO_VERSION,
  type StoredObjectiveValue,
} from './optimized-result-dto';
import type { SolverObjectiveTerm } from './wire-types';

/**
 * The stored-result envelope (tasks.md 4.12b): what the cached row keeps beyond
 * the schedule, and the ways such a row is refused rather than served.
 *
 * The plan under every case comes from the **real engine** for 4.12's reason —
 * a hand-written `Schedule` would be a second implementation of the shape under
 * test — and the envelope around it is asserted against the two vocabularies
 * the wire schema owns, not against literals restated here.
 */

const DEV = 'step-dev';
const PLATFORM = 'team-platform';

let position = 0;
const item = (id: string): PlannedRow => ({
  id,
  parentId: null,
  position: (position += 10),
  frozenNumber: null,
  priority: null,
});

const slice = (workItemId: string, days: number, extra: Partial<Slice> = {}): Slice => ({
  workItemId,
  stepId: DEV,
  days,
  personId: null,
  width: 1,
  poolIds: [PLATFORM],
  ...extra,
});

const pool = (size: number): PoolSizes => new Map([[PLATFORM, size]]);

/** A plan with a real capacity wait in it, so nothing round-trips vacuously. */
function realPlan(): Schedule {
  const rows = [item('a'), item('b'), item('c')];
  const slices = [slice('a', 2), slice('b', 2), slice('c', 2)];
  return schedule(rows, [], slices, new Map(), pool(1));
}

const term = (
  value: number,
  stageValue: number | null,
  bound: number | null,
  status: StoredObjectiveValue['status'],
): StoredObjectiveValue => ({ value, stageValue, bound, status });

/** A published solver run: quantised units throughout, one stage still unproved. */
function solverResult(plan: Schedule = realPlan()): OptimizedResult {
  return {
    publication: 'solver',
    objectiveValues: {
      makespan: term(288, 288, 288, 'optimal'),
      priority: term(41, 41, 40, 'feasible'),
      movement: term(7, null, null, 'unknown'),
    },
    schedule: plan,
  };
}

/**
 * The mandated width-5 floor row: Fast's schedule, rescored in the **real**
 * domain, where `days / width` stays fractional. No stage produced these
 * numbers, so there is no incumbent and no bound.
 */
function floorResult(plan: Schedule = realPlan()): OptimizedResult {
  return {
    publication: 'quantisation-floor',
    objectiveValues: {
      makespan: term(0.2 + 0.2 + 0.2, null, null, 'unknown'),
      priority: term(0, null, null, 'unknown'),
      movement: term(1.5, null, null, 'unknown'),
    },
    schedule: plan,
  };
}

/** The trip a cached row actually takes: encode, through SQLite's TEXT, decode. */
function throughJson(result: OptimizedResult): OptimizedResult {
  return decodeOptimizedResult(JSON.parse(JSON.stringify(encodeOptimizedResult(result))));
}

/**
 * A stored payload as the negatives below need to hold it.
 *
 * Not `StoredOptimizedResult`: that type is an alias of the WIRE term shape,
 * whose fields are `readonly` and whose numbers and enums are already narrowed
 * — correctly, since it describes a payload that has been through the decoder.
 * A corrupt row is by definition one that has not, so the loosening is declared
 * once here rather than spread over a cast per case, where each cast would be
 * a separate small lie about what the row is.
 */
interface CorruptibleTerm {
  value: unknown;
  stageValue: unknown;
  bound: unknown;
  status: string;
}

interface CorruptibleRow {
  dtoVersion: number;
  publication: string;
  objectiveValues: Record<string, CorruptibleTerm | undefined>;
  schedule: StoredSchedule;
}

function stored(result: OptimizedResult): CorruptibleRow {
  return JSON.parse(JSON.stringify(encodeOptimizedResult(result))) as CorruptibleRow;
}

/** One term of a payload this file has just written, so it is there. */
function termOf(row: CorruptibleRow, term: SolverObjectiveTerm): CorruptibleTerm {
  const held = row.objectiveValues[term];
  if (held === undefined) throw new Error(`fixture has no ${term} term`);
  return held;
}

describe('what a stored result keeps', () => {
  it('reloads a solver row whole: publication, every term, and the plan', () => {
    const source = solverResult();
    const back = throughJson(source);

    expect(back.publication).toBe('solver');
    expect(back.objectiveValues).toEqual(source.objectiveValues);
    expect([...back.schedule.slices.keys()]).toEqual([...source.schedule.slices.keys()]);
    expect(back.schedule.waitingForCapacity).toBe(source.schedule.waitingForCapacity);
    expect(back.schedule.eventsVisited).toBe(source.schedule.eventsVisited);
  });

  it('writes the terms in schema order, whatever order the caller held them in', () => {
    const plan = realPlan();
    const forward = solverResult(plan);
    const reversed: OptimizedResult = {
      publication: forward.publication,
      objectiveValues: {
        movement: forward.objectiveValues.movement,
        priority: forward.objectiveValues.priority,
        makespan: forward.objectiveValues.makespan,
      },
      schedule: plan,
    };

    expect(JSON.stringify(encodeOptimizedResult(reversed))).toBe(
      JSON.stringify(encodeOptimizedResult(forward)),
    );
  });

  it('stamps its own envelope version, not the nested schedule one', () => {
    const row = stored(solverResult());
    expect(row.dtoVersion).toBe(RESULT_DTO_VERSION);
    expect(typeof row.schedule.dtoVersion).toBe('number');
  });
});

describe('the real domain a quantisation-floor row lives in', () => {
  it('keeps a fractional makespan that is not a safe integer', () => {
    const back = throughJson(floorResult());

    expect(back.publication).toBe('quantisation-floor');
    expect(back.objectiveValues.makespan.value).toBe(0.2 + 0.2 + 0.2);
    expect(Number.isSafeInteger(back.objectiveValues.makespan.value)).toBe(false);
    expect(back.objectiveValues.makespan.stageValue).toBeNull();
    expect(back.objectiveValues.makespan.bound).toBeNull();
  });

  it('refuses that same value on a solver row, whose units are quantised', () => {
    const row = stored(solverResult());
    termOf(row, 'makespan').value = 0.2 + 0.2 + 0.2;

    expect(() => decodeOptimizedResult(row)).toThrow(
      /objectiveValues\.makespan\.value is not a safe integer/,
    );
  });

  it('refuses a stage incumbent on a floor row, which had no stage', () => {
    const row = stored(floorResult());
    termOf(row, 'priority').stageValue = 3;

    expect(() => decodeOptimizedResult(row)).toThrow(
      /objectiveValues\.priority\.stageValue is 3 on a quantisation-floor row/,
    );
  });

  it('refuses a negative and a NaN under both readings', () => {
    for (const source of [solverResult(), floorResult()]) {
      const negative = stored(source);
      termOf(negative, 'movement').value = -1;
      expect(() => decodeOptimizedResult(negative)).toThrow(
        /objectiveValues\.movement\.value is not a finite non-negative number/,
      );

      const notANumber = stored(source);
      // Injected AFTER the JSON trip on purpose: `JSON.stringify` writes `NaN`
      // as `null`, so a round trip would silently test a different defect.
      termOf(notANumber, 'movement').value = Number.NaN;
      expect(() => decodeOptimizedResult(notANumber)).toThrow(
        /objectiveValues\.movement\.value is not a finite non-negative number/,
      );
    }
  });
});

describe('the two enums that live inside the JSON', () => {
  it('throws naming publication and the unknown value', () => {
    const row = stored(solverResult());
    row.publication = 'fast';

    expect(() => decodeOptimizedResult(row)).toThrow(/publication is "fast"/);
  });

  it('throws naming the term and the value on an unknown stage status', () => {
    const row = stored(solverResult());
    termOf(row, 'movement').status = 'proved';

    expect(() => decodeOptimizedResult(row)).toThrow(
      /objectiveValues\.movement\.status is "proved"/,
    );
  });
});

describe('the ways a stored result is refused', () => {
  it('refuses an envelope version it does not read', () => {
    const row = stored(solverResult());
    row.dtoVersion = RESULT_DTO_VERSION + 1;

    expect(() => decodeOptimizedResult(row)).toThrow(/unknown dtoVersion 2/);
  });

  /**
   * The 4.12b watched red, corrected to what it can be true of.
   *
   * tasks.md words this one "a `resultJson` holding a bare `encodeSchedule`
   * output makes `decodeOptimizedResult` throw naming the **missing
   * `dtoVersion`**". That state does not exist: 4.12 REQUIRES the schedule
   * payload to carry a `dtoVersion` of its own, so a bare `encodeSchedule`
   * output arrives stamped `1` and the envelope check passes it. The defect it
   * is actually in is that it is a schedule where a result belongs, and the
   * first envelope field it lacks is `publication` — which is also the more
   * useful message, since it names what the row was supposed to be.
   *
   * **The falsifier fired, on 2026-09-06, and this is the re-read it asked
   * for.** The case used to open `expect(bare.dtoVersion).toBe(
   * RESULT_DTO_VERSION)` and reach the `publication` check only while the two
   * stamps happened to be equal. `work-item-deadline` 5.2 made
   * `ScheduledSlice.lateBy` required, `CACHE_DTO_VERSION` moved to 2 and
   * `RESULT_DTO_VERSION` did not, and that line went red — exactly as its own
   * comment predicted, and not by being retuned.
   *
   * What the re-read finds is that the coincidence was load-bearing and the
   * subject was not. A bare schedule now arrives stamped 2 and the envelope's
   * version fence refuses it first, which is a *correct* refusal of a wrong
   * payload for an accidental reason: the row is not the wrong version of a
   * result, it is not a result at all. `refuses an envelope version it does
   * not read` already owns the fence. So the stamp is corrected on the way in
   * — this case asks what happens to a schedule stored where a result belongs
   * once the version is no longer the thing that stops it — and the first
   * assertion becomes the direct one: the two constants are now different, so
   * nothing here rests on them being equal again.
   */
  it('refuses a bare encodeSchedule output stored where a result belongs', () => {
    expect(CACHE_DTO_VERSION).not.toBe(RESULT_DTO_VERSION);

    const bare = JSON.parse(JSON.stringify(encodeSchedule(realPlan()))) as StoredSchedule;
    expect(bare.dtoVersion).toBe(CACHE_DTO_VERSION);

    // Past the fence deliberately, so the answer is about the shape and not
    // about the number. Everything else is the schedule exactly as it was
    // encoded, and `publication` is the first envelope field it has no answer
    // for — which is also the message that names what the row should have been.
    const stampedAsAResult = { ...bare, dtoVersion: RESULT_DTO_VERSION };

    expect(() => decodeOptimizedResult(stampedAsAResult)).toThrow(/publication is undefined/);
  });

  it('refuses a row that is missing a term outright', () => {
    const row = stored(solverResult());
    delete row.objectiveValues['priority'];

    expect(() => decodeOptimizedResult(row)).toThrow(/objectiveValues has no priority term/);
  });

  it('refuses a term the schema does not have and a key it does not have', () => {
    const extraTerm = stored(solverResult());
    extraTerm.objectiveValues['slack'] = termOf(extraTerm, 'movement');
    expect(() => decodeOptimizedResult(extraTerm)).toThrow(
      /objectiveValues carries the unknown term slack/,
    );

    const extraKey = stored(solverResult());
    (termOf(extraKey, 'movement') as unknown as Record<string, unknown>)['proof'] = 'yes';
    expect(() => decodeOptimizedResult(extraKey)).toThrow(
      /objectiveValues\.movement carries the unknown key proof/,
    );
  });

  it('hands the nested schedule to 4.12, whose own defects surface unchanged', () => {
    const row = stored(solverResult());
    row.schedule.workItems = [];

    expect(() => decodeOptimizedResult(row)).toThrow(/stored schedule: .*no workItems projection/);
  });
});
