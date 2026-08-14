/**
 * One rung of a project's priority ladder: where it starts, what it is called,
 * and the number its name writes.
 *
 * A band is a **start value**, not a range. The band above it is what ends it,
 * and the top band ends nowhere — which is Dany's own shape, 2026-08-13:
 * _"1-20 are critical, 21-40 are high, 41-60 are medium, 61-80 are low,
 * 81-further is lowest"_. Storing `1..20` instead would let a project state a
 * gap (nothing holds 21) or an overlap (two labels hold 21), and a priority that
 * resolves to no label or to two is a number no face can draw.
 * `openspec/changes/priority-bands/design.md` D1.
 *
 * A band decides **nothing about a date**. Priority is an ordering the leveller
 * reads off `work_item.priority` and that column alone (`goesFirst` in
 * `be-01/src/service/schedule.ts`); a ladder is the vocabulary that number is
 * read and written in. Re-cutting the ladder renames what a plan's numbers are
 * called and moves not one of its dates.
 */
export interface PriorityBand {
  /**
   * The smallest priority this band holds — a whole number of 1 or more, and
   * exactly `1` for the first band, because a ladder that starts at 5 leaves
   * priorities 1 to 4 with no label.
   */
  startsAt: number;
  /** What this band is called on every face. */
  label: string;
  /**
   * What choosing this band by name writes into a work item's priority.
   *
   * Inside its own band, always: a `Critical` that writes 30 is a label that
   * lies about itself the moment the number is read back. Enforced by
   * {@link priorityLadderProblem}, not by convention.
   */
  defaultValue: number;
}

/**
 * The ladder every project starts with, transcribed from Dany's sentence of
 * 2026-08-13 rather than invented: _"by default critical sets to 10, high to 30,
 * medium to 50, low to 70, lowest to 90"_.
 *
 * It is a **constant, not a global setting**, and that distinction is what makes
 * reading it as the answer for a project holding no rows legitimate where
 * `capacity-per-project` D1 refused the same shape for a team's size. A global
 * size was a number somebody typed on a screen, so a plan silently bounded by it
 * was bounded by a decision made elsewhere for another plan. This is the source
 * saying what a priority ladder is when nobody has said otherwise, it is the same
 * five for every project, and no screen can change it. design.md D2.
 */
export const DEFAULT_PRIORITY_BANDS: readonly PriorityBand[] = [
  { startsAt: 1, label: 'Critical', defaultValue: 10 },
  { startsAt: 21, label: 'High', defaultValue: 30 },
  { startsAt: 41, label: 'Medium', defaultValue: 50 },
  { startsAt: 61, label: 'Low', defaultValue: 70 },
  { startsAt: 81, label: 'Lowest', defaultValue: 90 },
];

/**
 * How many bands a ladder has, and it is not configurable.
 *
 * Dany asked for the labels, the cuts and the defaults to be a project's own; he
 * did not ask to add a sixth rung or drop one, and refusing that is what keeps
 * this change to one table with a fixed shape. What it buys: a rank is a
 * position from 0 to 4 that every face can key a colour off, the write is one
 * whole-ladder `PUT` with no insert/delete/renumber path, and there is no empty
 * ladder to render. `openspec/changes/priority-bands/design.md` D3 names it as a
 * refusal rather than an oversight.
 */
export const PRIORITY_BAND_COUNT = DEFAULT_PRIORITY_BANDS.length;

/** The longest a band's label may be — the width the dialog and the cell title can carry. */
export const LONGEST_BAND_LABEL = 40;

/**
 * Which band a priority falls in, as a rank from 0 (most important) upward.
 *
 * The last band whose {@link PriorityBand.startsAt} is at or below the number,
 * which is the whole of the resolution rule: bands are contiguous and exhaustive
 * by construction, so exactly one answers.
 *
 * **Total by construction, and it has to be, because every caller is a render.**
 * A ladder always starts at 1 ({@link priorityLadderProblem} refuses one that
 * does not) and a priority is always 1 or more (`asOptionalPriority` in
 * `work-item.controller.ts` refuses one that is not), so the `0` this falls back
 * to is unreachable from stored data. It is a fallback rather than a throw
 * because the reachable way to get here is a client rendering a plan it read a
 * moment before the ladder it read — and a chart that throws where it could draw
 * the top band is the worse of the two answers. `AGENTS.md`, "React: impossible
 * union states throw into an Error Boundary; no assertions in `render`".
 */
export function priorityBandRankOf(bands: readonly PriorityBand[], priority: number): number {
  let rank = 0;
  for (let at = 0; at < bands.length; at += 1) {
    const band = bands[at];
    if (band === undefined || band.startsAt > priority) break;
    rank = at;
  }
  return rank;
}

/**
 * The band a priority falls in, or `null` for a ladder with no bands at all.
 *
 * The nullable arm is not a state stored data can be in — a ladder is five bands
 * or it is the default five — and it exists so callers holding a list they have
 * not validated get an absence rather than an `undefined` that types as a band.
 */
export function priorityBandOf(
  bands: readonly PriorityBand[],
  priority: number,
): PriorityBand | null {
  return bands[priorityBandRankOf(bands, priority)] ?? null;
}

/**
 * What is wrong with a proposed ladder, as the code a client branches on, or
 * `null` where it is a ladder.
 *
 * **One function, one caller.** `priorityBandController` is the only thing that
 * asks, exactly as `TeamsDialog` sends `0` and `1001` to be refused rather than
 * holding a second copy of the capacity rule — a validation repeated in the
 * browser is a rule free to disagree with the one that stores the row. It lives
 * here rather than in be-01 because the invariants it enforces are what
 * {@link priorityBandRankOf} assumes, and the assumption and its guard drifting
 * apart is how a priority stops resolving to a label.
 *
 * The checks, and what each one is for:
 *
 * - **Five bands.** {@link PRIORITY_BAND_COUNT} — the refusal that makes the
 *   count not configurable.
 * - **A first band starting at 1.** Otherwise the priorities below it have no
 *   label, and `priorityBandRankOf` would answer `Critical` for a number
 *   `Critical` does not hold.
 * - **Strictly increasing starts.** Equal starts are two labels holding one
 *   number; decreasing starts are a rank order that disagrees with the numeric
 *   one, so `rank` would stop meaning "more important".
 * - **A default inside its own band.** The picker writes the default and the
 *   cell reads the band back; a default outside makes those two disagree in the
 *   same keystroke.
 * - **Distinct, non-empty labels.** Two `High`s in a picker is a list where one
 *   of the lines does nothing a reader can predict.
 */
export function priorityLadderProblem(bands: readonly PriorityBand[]): string | null {
  if (bands.length !== PRIORITY_BAND_COUNT) {
    return `bands_must_number_${String(PRIORITY_BAND_COUNT)}`;
  }
  const seen = new Set<string>();
  for (let at = 0; at < bands.length; at += 1) {
    const band = bands[at];
    // `bands.length` was just checked, so this is unreachable; it is here
    // because `noUncheckedIndexedAccess` is on and a `!` would be the assertion
    // AGENTS.md bans outside tests.
    if (band === undefined) return 'bands_must_be_objects';
    const label = band.label.trim();
    if (label === '' || label.length > LONGEST_BAND_LABEL) {
      return `band_label_must_be_1_to_${String(LONGEST_BAND_LABEL)}_characters`;
    }
    const lowered = label.toLowerCase();
    if (seen.has(lowered)) return 'band_labels_must_differ';
    seen.add(lowered);
    if (!Number.isSafeInteger(band.startsAt) || band.startsAt < 1) {
      return 'band_start_must_be_a_whole_number_from_1';
    }
    if (!Number.isSafeInteger(band.defaultValue) || band.defaultValue < 1) {
      return 'band_default_must_be_a_whole_number_from_1';
    }
    const below = bands[at - 1];
    if (at === 0) {
      if (band.startsAt !== 1) return 'first_band_must_start_at_1';
    } else if (below !== undefined && band.startsAt <= below.startsAt) {
      return 'bands_must_start_in_increasing_order';
    }
    const above = bands[at + 1];
    // The top band ends nowhere, so only its floor is checked. Every other
    // band is closed by the one above it, exclusive of that band's own start.
    if (band.defaultValue < band.startsAt) return 'band_default_must_be_inside_its_own_band';
    if (above !== undefined && band.defaultValue >= above.startsAt) {
      return 'band_default_must_be_inside_its_own_band';
    }
  }
  return null;
}
