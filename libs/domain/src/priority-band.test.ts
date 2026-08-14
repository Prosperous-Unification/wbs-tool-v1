import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_PRIORITY_BANDS,
  LONGEST_BAND_LABEL,
  PRIORITY_BAND_COUNT,
  type PriorityBand,
  priorityBandOf,
  priorityBandRankOf,
  priorityLadderProblem,
} from './priority-band';

/** The default ladder with one field of one rung changed — the shape every refusal case wants. */
function ladderWith(at: number, change: Partial<PriorityBand>): PriorityBand[] {
  return DEFAULT_PRIORITY_BANDS.map((band, rank) =>
    rank === at ? { ...band, ...change } : { ...band },
  );
}

describe('the default ladder', () => {
  it('is Dany’s five, transcribed rather than invented', () => {
    // Dany, 2026-08-13, verbatim: "1-20 are critical, 21-40 are high, 41-60 are
    // medium, 61-80 are low, 81-further is lowest; and by default critical sets
    // to 10, high to 30, medium to 50, low to 70, lowest to 90". Pinned as data
    // because it is a quotation, and a transcription nothing checks is a
    // transcription that drifts.
    expect(DEFAULT_PRIORITY_BANDS).toEqual([
      { startsAt: 1, label: 'Critical', defaultValue: 10 },
      { startsAt: 21, label: 'High', defaultValue: 30 },
      { startsAt: 41, label: 'Medium', defaultValue: 50 },
      { startsAt: 61, label: 'Low', defaultValue: 70 },
      { startsAt: 81, label: 'Lowest', defaultValue: 90 },
    ]);
    expect(PRIORITY_BAND_COUNT).toBe(5);
  });

  it('is a ladder by its own rule, which is what makes it usable as the read’s answer', () => {
    // Not decoration: `PriorityBandRepository.listFor` hands this back for a
    // project holding no rows, so a default that could not pass the write's own
    // validation would be a state the API refuses to store and the read invents.
    expect(priorityLadderProblem(DEFAULT_PRIORITY_BANDS)).toBeNull();
  });
});

describe('which band a priority falls in', () => {
  it('answers exactly one band for every number Dany named', () => {
    // The four cuts and both sides of each, plus the two open ends. A band is a
    // start value and the next band's start ends it, so these are the boundaries
    // that decide whether "1-20 are critical" is what the code actually does.
    const rankOf = (priority: number): number =>
      priorityBandRankOf(DEFAULT_PRIORITY_BANDS, priority);
    expect([1, 10, 20].map(rankOf)).toEqual([0, 0, 0]);
    expect([21, 30, 40].map(rankOf)).toEqual([1, 1, 1]);
    expect([41, 50, 60].map(rankOf)).toEqual([2, 2, 2]);
    expect([61, 70, 80].map(rankOf)).toEqual([3, 3, 3]);
    expect([81, 90, 10_000].map(rankOf)).toEqual([4, 4, 4]);
  });

  it('has no top, because the top band ends nowhere', () => {
    // "81-further is lowest" — an upper bound on the last band would be a
    // priority that resolves to no label, and `asOptionalPriority` in be-01
    // deliberately has no ceiling ("From 1 to infinity was the ask").
    expect(priorityBandOf(DEFAULT_PRIORITY_BANDS, Number.MAX_SAFE_INTEGER)?.label).toBe('Lowest');
  });

  it('names the band, and each band’s own default lands back in it', () => {
    // The round trip Dany's two sentences make together: picking a name writes a
    // number, and reading that number back has to give the same name. A default
    // outside its own band would break it in one keystroke, which is why
    // `priorityLadderProblem` refuses one.
    for (const band of DEFAULT_PRIORITY_BANDS) {
      expect(priorityBandOf(DEFAULT_PRIORITY_BANDS, band.defaultValue)?.label).toBe(band.label);
    }
  });

  it('answers the first band for anything below the ladder, rather than nothing', () => {
    // Unreachable from stored data — a ladder starts at 1 and a priority is 1 or
    // more — and it is a rendered answer rather than a throw because every caller
    // is a render. Asserted so the arm is a decision rather than an accident.
    expect(priorityBandRankOf(DEFAULT_PRIORITY_BANDS, 0)).toBe(0);
    expect(priorityBandRankOf(DEFAULT_PRIORITY_BANDS, -7)).toBe(0);
  });

  it('says nothing at all for a ladder with no bands', () => {
    expect(priorityBandOf([], 10)).toBeNull();
  });

  it('reads a re-cut ladder rather than the default one', () => {
    // The whole point of the table: the same number is a different label on a
    // plan that has said something different about it.
    const recut: PriorityBand[] = [
      { startsAt: 1, label: 'Blocker', defaultValue: 5 },
      { startsAt: 11, label: 'Urgent', defaultValue: 15 },
      { startsAt: 26, label: 'Normal', defaultValue: 40 },
      { startsAt: 61, label: 'Someday', defaultValue: 65 },
      { startsAt: 200, label: 'Never', defaultValue: 500 },
    ];
    expect(priorityBandOf(recut, 10)?.label).toBe('Blocker');
    expect(priorityBandOf(DEFAULT_PRIORITY_BANDS, 10)?.label).toBe('Critical');
    expect(priorityBandOf(recut, 150)?.label).toBe('Someday');
  });
});

describe('what a ladder may be', () => {
  it('is five bands, and a project may not add or drop one', () => {
    // The refusal that makes the count not configurable — design.md D3. Both
    // directions, because "at most five" and "exactly five" are different rules
    // and only one of them keeps `rank` a number from 0 to 4.
    expect(priorityLadderProblem(DEFAULT_PRIORITY_BANDS.slice(0, 4))).toBe('bands_must_number_5');
    expect(
      priorityLadderProblem([
        ...DEFAULT_PRIORITY_BANDS,
        { startsAt: 200, label: 'Never', defaultValue: 300 },
      ]),
    ).toBe('bands_must_number_5');
  });

  it('starts at 1, or the numbers below the first band have no name', () => {
    expect(priorityLadderProblem(ladderWith(0, { startsAt: 5, defaultValue: 10 }))).toBe(
      'first_band_must_start_at_1',
    );
  });

  it('climbs, so no number belongs to two bands or to none', () => {
    // Equal starts are two labels holding one number; a decreasing start is a
    // rank order that disagrees with the numeric one, so `rank` stops meaning
    // "more important". Both are the same refusal because both are the same
    // broken invariant.
    expect(priorityLadderProblem(ladderWith(2, { startsAt: 21, defaultValue: 30 }))).toBe(
      'bands_must_start_in_increasing_order',
    );
    expect(priorityLadderProblem(ladderWith(2, { startsAt: 15, defaultValue: 18 }))).toBe(
      'bands_must_start_in_increasing_order',
    );
  });

  it('keeps each band’s number inside that band, in both directions', () => {
    // Above its own band's top and below its own floor. Both, because a check
    // written with one comparison passes half the cases it is for.
    expect(priorityLadderProblem(ladderWith(0, { defaultValue: 30 }))).toBe(
      'band_default_must_be_inside_its_own_band',
    );
    expect(priorityLadderProblem(ladderWith(2, { defaultValue: 30 }))).toBe(
      'band_default_must_be_inside_its_own_band',
    );
    // The top band has no ceiling to fall out of, so only its floor binds.
    expect(priorityLadderProblem(ladderWith(4, { defaultValue: 10_000 }))).toBeNull();
    expect(priorityLadderProblem(ladderWith(4, { defaultValue: 80 }))).toBe(
      'band_default_must_be_inside_its_own_band',
    );
  });

  it('takes whole numbers of 1 or more, and nothing else that JSON can carry', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(priorityLadderProblem(ladderWith(1, { startsAt: bad }))).toBe(
        'band_start_must_be_a_whole_number_from_1',
      );
    }
    for (const bad of [0, -1, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(priorityLadderProblem(ladderWith(1, { defaultValue: bad }))).toBe(
        'band_default_must_be_a_whole_number_from_1',
      );
    }
  });

  it('refuses two bands with one name, however they are cased', () => {
    // A picker with two `High` lines is a list where one of them does nothing
    // anybody can predict — and case is not a difference a reader sees.
    expect(priorityLadderProblem(ladderWith(1, { label: 'critical' }))).toBe(
      'band_labels_must_differ',
    );
  });

  it('refuses a name of whitespace alone, and one too long to draw', () => {
    expect(priorityLadderProblem(ladderWith(3, { label: '   ' }))).toBe(
      `band_label_must_be_1_to_${String(LONGEST_BAND_LABEL)}_characters`,
    );
    expect(
      priorityLadderProblem(ladderWith(3, { label: 'x'.repeat(LONGEST_BAND_LABEL + 1) })),
    ).toBe(`band_label_must_be_1_to_${String(LONGEST_BAND_LABEL)}_characters`);
    // The bound itself is not off by one: exactly the limit is a name.
    expect(
      priorityLadderProblem(ladderWith(3, { label: 'x'.repeat(LONGEST_BAND_LABEL) })),
    ).toBeNull();
  });

  it('takes a re-cut ladder that is still a ladder', () => {
    expect(
      priorityLadderProblem([
        { startsAt: 1, label: 'Blocker', defaultValue: 1 },
        { startsAt: 2, label: 'Urgent', defaultValue: 2 },
        { startsAt: 3, label: 'Normal', defaultValue: 3 },
        { startsAt: 4, label: 'Later', defaultValue: 4 },
        { startsAt: 5, label: 'Never', defaultValue: 900 },
      ]),
    ).toBeNull();
  });
});
