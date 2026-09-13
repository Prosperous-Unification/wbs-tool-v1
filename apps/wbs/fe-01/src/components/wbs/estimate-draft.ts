import type { Days } from '@/lib/wbs-api';

export const POINTS = ['optimistic', 'realistic', 'pessimistic'] as const;
export type Point = (typeof POINTS)[number];

/** What is in the three boxes of one row-and-step trio, exactly as typed. */
export type TypedTrio = Record<Point, string>;

/** Which boxes are wrong, and what to tell the person about them. */
export interface TrioProblem {
  points: Point[];
  message: string;
}

/**
 * The three sentences this module says, in one place each.
 *
 * The three boxes and the one combined cell are two ways of typing the same
 * estimate, and a rule stated twice is a rule that eventually reads two ways.
 */
const DAYS_MESSAGE = 'Days must be a number, zero or more.';
const ORDER_MESSAGE = 'Must read optimistic ≤ realistic ≤ pessimistic.';
const COUNT_MESSAGE = 'Type three days as 2/3/8, or one number for all three.';

/**
 * What is wrong with a trio as typed, or null when nothing is.
 *
 * This replaces the old `keepOrdered`, which silently rewrote the two numbers
 * you did not type so the request would pass be-01's ordering rule. Dany,
 * 2026-08-06: "when inputing estimates they must not autoedit". Editing
 * somebody's estimate to make it valid is the tool asserting a number nobody
 * chose, and the number then reads as theirs.
 *
 * So nothing is rewritten and nothing is sent until the trio can stand on its
 * own. Four states:
 *
 * 1. **All three empty** — no estimate yet. Not a problem; a row nobody has
 *    estimated is ordinary and must not glow red.
 * 2. **Something unparseable or negative** — those boxes are wrong.
 * 3. **Some filled, some empty** — the empty ones are wrong. be-01 stores a
 *    trio or nothing, so a half-filled one saves nothing, and an unsaved
 *    estimate that looks saved is worse than a visible complaint.
 * 4. **Out of order** — both members of each pair that breaks
 *    `optimistic <= realistic <= pessimistic`. Which single box is "wrong" in
 *    `5 / 3 / 10` is not answerable; the pair is.
 */
export function trioProblem(typed: TypedTrio): TrioProblem | null {
  const filled = POINTS.filter((point) => typed[point].trim() !== '');
  if (filled.length === 0) return null;

  const unparseable = filled.filter((point) => {
    const value = Number(typed[point]);
    return !Number.isFinite(value) || value < 0;
  });
  if (unparseable.length > 0) {
    return { points: unparseable, message: DAYS_MESSAGE };
  }

  const empty = POINTS.filter((point) => typed[point].trim() === '');
  if (empty.length > 0) {
    return { points: empty, message: 'Fill all three, or this estimate is not saved.' };
  }

  const value = (point: Point): number => Number(typed[point]);
  const broken = new Set<Point>();
  if (value('optimistic') > value('realistic')) {
    broken.add('optimistic');
    broken.add('realistic');
  }
  if (value('realistic') > value('pessimistic')) {
    broken.add('realistic');
    broken.add('pessimistic');
  }
  if (broken.size === 0) return null;
  return {
    points: POINTS.filter((point) => broken.has(point)),
    message: ORDER_MESSAGE,
  };
}

/**
 * What one cell's worth of typed shorthand means.
 *
 * Three cases rather than a trio-or-error pair, because "nothing is typed
 * here" is not an error and is not a request either: it is the gesture that
 * clears a stored estimate, and the caller has to be able to tell it apart
 * without inspecting the text again.
 */
export type TrioShorthand =
  { kind: 'empty' } | { kind: 'trio'; days: Days } | { kind: 'problem'; message: string };

/** One part of a shorthand entry as days, or null when it is not days at all. */
function readDays(part: string): number | null {
  // The emptiness test comes first because `Number('')` is 0: without it
  // `1//3` would parse as a zero nobody typed, which is the exact class of
  // invention {@link trioProblem} exists to refuse.
  if (part.trim() === '') return null;
  const value = Number(part);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The trio behind `2/3/8`, `0.5 / 1 / 2` or `5`, or why it is not one.
 *
 * The folded step column shows be-01's computed final figure at rest and
 * takes this shorthand when it is typed into, so one cell replaces unfolding
 * a step and filling three boxes — the loop an estimating session is almost
 * entirely made of.
 *
 * It repairs nothing, in exactly the sense {@link trioProblem} does not: a
 * count that is not three, a part that is not a number of days, and a trio
 * that runs backwards are all complaints, and `8/3/2` is never quietly
 * sorted into `2/3/8`. The one figure it produces that was not typed
 * digit-for-digit is the single-number form, and that is the person saying
 * all three are the same, not the tool guessing two of them.
 *
 * Proof: made to sort the trio instead of refusing it, `complains about an
 * out-of-order trio instead of sorting it` in `estimate-draft.test.ts` fails;
 * watched 2026-08-06.
 */
export function parseTrioShorthand(typed: string): TrioShorthand {
  const text = typed.trim();
  if (text === '') return { kind: 'empty' };

  const parts = text.split('/');
  // One number is all three, said once — and an order check on one figure
  // against itself is a check that cannot fail, so this branch does not run
  // one.
  if (parts.length === 1) {
    const only = readDays(text);
    return only === null
      ? { kind: 'problem', message: DAYS_MESSAGE }
      : { kind: 'trio', days: { optimistic: only, realistic: only, pessimistic: only } };
  }
  if (parts.length !== 3) {
    return { kind: 'problem', message: COUNT_MESSAGE };
  }

  const [first, second, third] = parts.map(readDays);
  if (first === null || second === null || third === null) {
    return { kind: 'problem', message: DAYS_MESSAGE };
  }
  if (first > second || second > third) {
    return { kind: 'problem', message: ORDER_MESSAGE };
  }
  return { kind: 'trio', days: { optimistic: first, realistic: second, pessimistic: third } };
}

/**
 * A stored estimate as the shorthand that would type it — `2/3/8`, or `5`
 * where all three points agree, or `''` where there is no estimate at all.
 *
 * {@link parseTrioShorthand}'s inverse, and it lives beside it for that
 * reason: a printer written where its parser cannot see it is how the two come
 * to disagree about which strings are one estimate. `estimate-draft.test.ts`
 * asserts the round trip rather than the spelling alone.
 *
 * **This is what a folded step's cell holds at rest**, since
 * `estimate-triple-visible`. Until then the cell showed be-01's computed final
 * figure, which cost two things: the three numbers somebody chose left the
 * screen the moment they landed (Dany, 2026-08-29 — *"i want to keep seeing
 * the values i've put in"*), and the box was the one in the grid whose value
 * was not a legal way to have typed what it stood for — retyping `2.2` over
 * `2/2/3` stores `2.2/2.2/2.2`. The figure is still on screen, muted, beside
 * the box; see `wbs-table.tsx`'s folded cell.
 *
 * The collapse is not a shortening for its own sake. `5` is what a person
 * types to mean all three are five, and the long form printed back would show
 * them a trio they did not type — the same objection {@link trioProblem}
 * makes to repairing one. It is exactly the single-number form
 * {@link parseTrioShorthand} reads, so the round trip holds through it.
 */
export function showTrio(days: Days | undefined): string {
  if (days === undefined) return '';
  const [optimistic, realistic, pessimistic] = POINTS.map((point) => String(days[point]));
  if (optimistic === realistic && realistic === pessimistic) return optimistic;
  return `${optimistic}/${realistic}/${pessimistic}`;
}

/**
 * Whether every box of a trio now reads empty.
 *
 * The one thing {@link sendableTrio} returning null does not tell its caller.
 * "Nothing to send" covers three different situations — never typed, half
 * typed, typed wrongly — and exactly one of them is a person taking an
 * estimate back off. Emptying all three boxes of a stored trio is the gesture
 * that clears it; emptying one or two is still a half-filled trio and still a
 * complaint, because guessing that two blanks mean "delete it" would be the
 * same assumption as repairing a trio nobody finished.
 */
export function isTrioEmpty(typed: TypedTrio): boolean {
  return POINTS.every((point) => typed[point].trim() === '');
}

/**
 * The trio to send, or null when there is nothing to send.
 *
 * Null covers both "nothing typed yet" and "typed but wrong": neither is a
 * request, and the difference between them is {@link trioProblem}'s to
 * report. Never returns a repaired trio — that is the whole point.
 */
export function sendableTrio(typed: TypedTrio): Days | null {
  if (trioProblem(typed) !== null) return null;
  if (isTrioEmpty(typed)) return null;
  return {
    optimistic: Number(typed.optimistic),
    realistic: Number(typed.realistic),
    pessimistic: Number(typed.pessimistic),
  };
}
