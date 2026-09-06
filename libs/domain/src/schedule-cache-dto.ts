import { type Schedule, type Scheduled, type ScheduledSlice, sliceKey } from './schedule';

/**
 * The version of the stored schedule payload, bumped whenever the shape below
 * changes in a way a previous release cannot read (tasks.md 4.12).
 *
 * It is a **read fence, not a migration**. A row written by a release whose
 * number differs is not upgraded and not deleted: {@link decodeSchedule} throws,
 * the cache read reports `corrupt` (4.8), and the ordinary admission path
 * recomputes. That is the same treatment a truncated payload gets, and it is
 * deliberate — a decoder that guessed at an older shape would serve a plan
 * assembled out of fields it invented.
 *
 * **2 since 2026-09-06**, because {@link ScheduledSlice} gained a required
 * `lateBy`. A version-1 row does not carry the field, and nothing in this
 * decoder validates per-entry shapes — the entry is cast — so leaving the fence
 * at 1 would have served `lateBy === undefined` from every cached plan written
 * before this release, where the contract now promises `number | null`. The
 * rows are recomputed instead, which is what the fence is for.
 */
export const CACHE_DTO_VERSION = 2;

/**
 * One `Map` entry, as JSON can carry it.
 *
 * `JSON.stringify` renders a `Map` as `{}`, so an implementation that stored a
 * {@link Schedule} directly would type-check everywhere and reload a plan with
 * no slices and no work items in it. The entries are therefore explicit, and
 * they are **sorted by key** so one schedule has one encoding: a row whose bytes
 * depended on `Map` insertion order could not be compared, diffed or hashed, and
 * two runs of the same solve would look like two different answers.
 */
export interface StoredEntry<T> {
  key: string;
  value: T;
}

/** A {@link Schedule} in the shape that goes into `optimized_schedule_cache.result_json`. */
export interface StoredSchedule {
  dtoVersion: number;
  slices: StoredEntry<ScheduledSlice>[];
  workItems: StoredEntry<Scheduled>[];
  /**
   * The three projections carried explicitly, because they are answers rather
   * than instrumentation a reader can recompute: `waitingForPerson` and
   * `waitingForCapacity` are two sentences the schedule header says, and
   * `eventsVisited` is the levelling pass's own count of work done. Recomputing
   * any of them from the reloaded maps would mean re-running the pass, which is
   * exactly what the cache exists to avoid.
   */
  waitingForPerson: number;
  waitingForCapacity: number;
  eventsVisited: number;
}

/** The prefix every defect below carries, so a corrupt row is diagnosable from the log line. */
function defect(message: string): Error {
  return new Error(`stored schedule: ${message}`);
}

/**
 * A stored value as a message may quote it.
 *
 * Not `JSON.stringify` alone: its lib signature promises a `string` and it
 * returns `undefined` for `undefined`, a function and a symbol, so every message
 * below would read `... is not an object: undefined` for three different
 * defects — and the `?? typeof value` that would fix it is unreachable code as
 * far as the type checker is concerned, which is a lint error rather than a
 * guard. The branch is taken on the type instead, where it is true.
 */
function show(value: unknown): string {
  switch (typeof value) {
    case 'object':
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    default:
      return typeof value;
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`${what} is not an object: ${show(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw defect(`${what} is not a finite number: ${show(value)}`);
  }
  return value;
}

/**
 * Reads one entry array back into a `Map`, refusing a **duplicate key**.
 *
 * `new Map(entries)` would take the last of them silently, and the two entries
 * that collided are not interchangeable — they are two different placements of
 * one slice, and which one survived would depend on array order. A row that
 * carries both is corrupt whichever way it is read, so it is refused rather
 * than resolved.
 */
function readEntries<T>(raw: unknown, field: string): Map<string, T> {
  if (!Array.isArray(raw)) {
    throw defect(`${field} is not an array: ${show(raw)}`);
  }
  const out = new Map<string, T>();
  for (const entry of raw) {
    const { key, value } = asRecord(entry, `an entry of ${field}`);
    if (typeof key !== 'string') {
      throw defect(`an entry of ${field} has a non-string key: ${show(key)}`);
    }
    if (out.has(key)) {
      throw defect(`${field} carries the key ${JSON.stringify(key)} twice`);
    }
    out.set(key, asRecord(value, `${field}[${JSON.stringify(key)}]`) as T);
  }
  return out;
}

/**
 * A {@link Schedule} as it is stored: both maps flattened, sorted, and stamped.
 *
 * Nothing is dropped and nothing is derived. The inverse is
 * {@link decodeSchedule}, and the pair is the only seam between a computed plan
 * and a cached one.
 */
export function encodeSchedule(plan: Schedule): StoredSchedule {
  return {
    dtoVersion: CACHE_DTO_VERSION,
    slices: sortedEntries(plan.slices),
    workItems: sortedEntries(plan.workItems),
    waitingForPerson: plan.waitingForPerson,
    waitingForCapacity: plan.waitingForCapacity,
    eventsVisited: plan.eventsVisited,
  };
}

/**
 * `[...map]` in key order, by code unit.
 *
 * Not `localeCompare`: {@link sliceKey} joins its two halves with U+0000, and a
 * collator may treat a control character as ignorable — which would order two
 * keys by their *contents* across the separator and make the sort depend on the
 * host's locale data rather than on the string.
 */
function sortedEntries<T>(map: ReadonlyMap<string, T>): StoredEntry<T>[] {
  return [...map]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * A stored payload back into a {@link Schedule}, or a throw naming the defect.
 *
 * Four defects are refused, and each of them is a way a cached plan could be
 * served as an answer while being a different plan from the one that was
 * computed:
 *
 * 1. **An unknown `dtoVersion`** — a shape this release does not read.
 * 2. **A duplicate key** in either map, per {@link readEntries}.
 * 3. **A slice key disagreeing with its own entry**, i.e. a key that is not
 *    `sliceKey(workItemId, stepId)` of the value beside it. The key is what
 *    `resourcePredecessorId` and `capacityPredecessorIds` are looked up by, so a
 *    disagreeing pair draws the wait arrow at a slice that is not the one the
 *    engine pointed at.
 * 4. **A missing projection** — a slice whose `workItemId` has no `workItems`
 *    entry. `workItems` *is* the projection of `slices` and it is what the table
 *    reads; a plan missing one is a plan whose rows and whose bars disagree.
 *
 * **What this decoder does not prove, said plainly.** The per-entry field
 * shapes are not validated: a `ScheduledSlice` whose `boundBy` holds text no
 * `ScheduleFloor` ever had, or whose `duration` is a string, is cast into the
 * returned map. That is not an oversight to be read as safety — tasks.md puts
 * the JSON-held enums at 4.12b's `decodeOptimizedResult`, which is the envelope
 * this payload is nested inside and the seam that owns them, and a guard added
 * here without a case to watch fail would be a claim rather than a proof.
 */
export function decodeSchedule(raw: unknown): Schedule {
  const dto = asRecord(raw, 'the payload');
  // Bracketed throughout, because `dto` is an index signature and this package
  // compiles under `noPropertyAccessFromIndexSignature`: dotted access here
  // would read as a declared field and hide that every one of these came off a
  // stored string.
  const version = dto['dtoVersion'];
  if (version !== CACHE_DTO_VERSION) {
    throw defect(
      `unknown dtoVersion ${show(version)}; this release reads ${String(CACHE_DTO_VERSION)}`,
    );
  }

  const slices = readEntries<ScheduledSlice>(dto['slices'], 'slices');
  const workItems = readEntries<Scheduled>(dto['workItems'], 'workItems');

  for (const [key, slice] of slices) {
    const own = sliceKey(slice.workItemId, slice.stepId ?? null);
    if (own !== key) {
      throw defect(
        `slices carries the key ${JSON.stringify(key)} against an entry whose own key is ${JSON.stringify(own)}`,
      );
    }
    if (!workItems.has(slice.workItemId)) {
      throw defect(
        `slices[${JSON.stringify(key)}] has no workItems projection for ${JSON.stringify(slice.workItemId)}`,
      );
    }
  }

  return {
    slices,
    workItems,
    waitingForPerson: asNumber(dto['waitingForPerson'], 'waitingForPerson'),
    waitingForCapacity: asNumber(dto['waitingForCapacity'], 'waitingForCapacity'),
    eventsVisited: asNumber(dto['eventsVisited'], 'eventsVisited'),
  };
}
