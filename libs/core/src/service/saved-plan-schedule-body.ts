import {
  addWorkdays,
  firstWorkdayOf,
  type IsoDate,
  lastWorkdayOf,
  type Schedule,
  type Scheduled,
} from '@wbs/domain';

/**
 * The schedule body's own schema version, written into every body.
 *
 * Bumped when the *shape* of the body changes — a key renamed, a key removed,
 * the date rendering changed. A field **added** to `Scheduled`,
 * `ScheduledSlice` or `Schedule` does not bump it: those flow through
 * {@link buildScheduleBody} untouched by construction (see its doc), and a
 * reader that does not know the new key simply does not read it.
 *
 * Not to be confused with `SCHEDULE_ALGORITHM_ID`, which names the
 * arithmetic rather than the container. Two bodies can share this version and
 * disagree about every date in them.
 */
export const SCHEDULE_BODY_SCHEMA_VERSION = 1;

/**
 * The one key of `Schedule` that is never stored.
 *
 * `eventsVisited` counts the levelling pass's window searches. It is
 * instrumentation about the *run* — the same plan scheduled twice by the same
 * code can produce two figures — so storing it would make two identical plans
 * compare as different. Named as a set rather than deleted inline so the
 * exclusion is one greppable list, and so the test can assert against the same
 * name it is excluded by.
 */
const NOT_STORED: ReadonlySet<string> = new Set(['eventsVisited']);

/** One timing's calendar span, or nulls when the project is not on a calendar. */
export interface SpanDates {
  readonly startsOn: IsoDate | null;
  readonly endsOn: IsoDate | null;
}

/** A `Scheduled` or `ScheduledSlice` as stored: its own fields, plus the dates. */
export type DatedTiming = Record<string, unknown> & SpanDates;

/**
 * A schedule as it is stored: offsets, dates, and the counts — never the
 * instrumentation.
 *
 * The two maps become records because JSON has no `Map`, and their keys are the
 * engine's own: work item ids in `workItems`, `sliceKey`s in `slices`. Both are
 * declared loosely on purpose — the writer copies whatever the engine returned
 * rather than a field list, so a tight type here would be a second enumeration
 * to forget to update, which is the exact failure the deep-equality test in
 * `saved-plan-schedule-body.test.ts` exists to prevent.
 */
export interface ScheduleBody {
  readonly version: number;
  /** Which arithmetic produced these dates — see {@link SCHEDULE_ALGORITHM_ID}. */
  readonly algorithmId: string;
  readonly workItems: Record<string, DatedTiming>;
  readonly slices: Record<string, DatedTiming>;
  readonly waitingForPerson: number;
  readonly waitingForCapacity: number;
}

/**
 * One timing's span as calendar days, from the offsets the engine computed.
 *
 * Deliberately the **same** two readings the live table renders
 * (`work-item.service.ts` `datesOf`, `:358-377`), through the same
 * `@wbs/domain` helpers: `firstWorkdayOf` is snap-then-floor and
 * `lastWorkdayOf` is snap-then-`ceil − 1` clamped to the start's day, so the
 * finish sits on the day the work occupies rather than the one it spills into.
 * A saved plan that rendered its own arithmetic would disagree with the live
 * plan about a date neither of them computed differently, which is a difference
 * a reader would have no way to explain.
 *
 * Both keys are always present, `null` together when the project has no start
 * date. An absent key would make the stored key set depend on the calendar, and
 * the comparison in slice 6 reads key sets.
 */
function datesOf(timing: Scheduled, startDate: IsoDate | null): SpanDates {
  if (startDate === null) return { startsOn: null, endsOn: null };
  return {
    startsOn: addWorkdays(startDate, firstWorkdayOf(timing.earliestStart)),
    endsOn: addWorkdays(startDate, lastWorkdayOf(timing.earliestStart, timing.earliestFinish)),
  };
}

/**
 * One value with its own keys in sorted order.
 *
 * `JSON.stringify` emits an object's keys in insertion order, so a body whose
 * keys arrive in the engine's declaration order hashes differently the day
 * somebody reorders two fields of `ScheduledSlice` — a byte change, and
 * therefore a SHA-256 change, with no change to the plan or to the algorithm.
 * Sorting here is the canonicaliser's half of the contract that
 * `serialiseCanonicalPlanInput` states for the input body: **the builder makes
 * the value stable and the serializer adds nothing**, so a canonicaliser that
 * stopped doing its half cannot be hidden by a key-sorting stringify later.
 *
 * One level deep is the whole of it: every value in a timing is a number, a
 * boolean, a string, `null`, or `capacityPredecessorIds`, whose order is the
 * engine's answer rather than an accident of iteration.
 */
function withSortedKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

/**
 * One of the engine's maps, as a record, with each value's dates merged in.
 *
 * The record's own keys are sorted too, for {@link withSortedKeys}'s reason one
 * level up: a `Map` iterates in insertion order, and the engine's placement
 * order is a fact about the levelling pass rather than about the plan.
 */
function datedRecordOf(
  timings: ReadonlyMap<string, Scheduled>,
  startDate: IsoDate | null,
): Record<string, DatedTiming> {
  const stored: Record<string, DatedTiming> = {};
  for (const key of [...timings.keys()].sort()) {
    const timing = timings.get(key);
    if (timing === undefined) continue;
    // Spread rather than a field list: see `buildScheduleBody`.
    stored[key] = withSortedKeys({ ...timing, ...datesOf(timing, startDate) }) as DatedTiming;
  }
  return stored;
}

/**
 * The schedule body for one captured plan.
 *
 * **Nothing here enumerates a field of `Scheduled`, `ScheduledSlice` or
 * `Schedule`, and that is the whole design.** The top level is a loop over the
 * engine's own keys minus {@link NOT_STORED}; each timing is a spread of its
 * own value plus the two dates. So a field added to any of those three
 * interfaces is stored the day it is added, with no edit here and no reviewer
 * remembering to make one.
 *
 * The alternative — writing the fields out — stays green for every field the
 * writer forgot, because the test that checks it would be reading the same
 * list. That is not a hypothetical: it is why the spec (`specs/wbs-domain`,
 * "The stored schedule body SHALL be deep-equal to what `schedule()`
 * returned") states the property as deep equality rather than as a schema.
 *
 * `startDate` is the captured project's own (`PlanInputReads.project`), not
 * today's: the dates a saved plan carries are the ones it had when it was
 * saved, and re-rendering them against a project whose start has since moved
 * would restate the plan, which is the fault this whole feature exists to
 * prevent.
 *
 * `algorithmId` names the answer actually selected for this capture. Fast uses
 * `SCHEDULE_ALGORITHM_ID`; an optimized answer includes its contract version,
 * objective and budget so stored dates never claim a different arithmetic.
 */
export function buildScheduleBody(
  planned: Schedule,
  startDate: IsoDate | null,
  algorithmId: string,
): ScheduleBody {
  const body: Record<string, unknown> = {
    version: SCHEDULE_BODY_SCHEMA_VERSION,
    // Proof: hardcoding `SCHEDULE_ALGORITHM_ID` here stored `slice-leveling-v2`;
    // the ready optimized schedule test expected `optimized:2.4:pri:12345`.
    algorithmId,
  };
  for (const key of Object.keys(planned).sort()) {
    if (NOT_STORED.has(key)) continue;
    const value: unknown = (planned as unknown as Record<string, unknown>)[key];
    body[key] =
      value instanceof Map
        ? datedRecordOf(value as ReadonlyMap<string, Scheduled>, startDate)
        : value;
  }
  return withSortedKeys(body) as unknown as ScheduleBody;
}

/**
 * The bytes the SHA-256 is taken over, and the bytes the body stores.
 *
 * Plain `JSON.stringify`, for the reason `serialiseCanonicalPlanInput` gives
 * about the input body: {@link buildScheduleBody} has already done both things
 * that make a serialization stable — sorted keys at every level, and the one
 * array left in the value ordered by the engine rather than by iteration. A
 * key-sorting serializer here would hide a builder that had stopped doing its
 * half, so this deliberately adds nothing.
 */
export function serialiseScheduleBody(body: ScheduleBody): string {
  return JSON.stringify(body);
}
