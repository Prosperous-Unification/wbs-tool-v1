import type {
  PlanOptimizationView,
  ProjectOptimizationPatch,
  ScheduleObjectiveView,
} from '@/lib/wbs-api';

import { type MenuAction, MenuControl } from './actions-menu';
import {
  type CueReading,
  cueReading,
  type CueRow,
  type UnmeetableDeadline,
} from './optimization-cue-reading';
import {
  ALGORITHM_WORDS,
  days,
  deadlineWords,
  OBJECTIVE_LABEL,
  STALE_WORDS,
} from './optimization-words';

export interface OptimizationCueProps {
  readonly optimization: PlanOptimizationView;
  /** The plan on screen may have moved under this comparison. */
  readonly stale?: boolean;
  readonly projectStart: string | null;
  readonly today: Date;
  readonly workItemName: (id: string) => string | null;
  /** Whether this cue's menu is the open one. Held by the caller: one at a time. */
  readonly menuOpen: boolean;
  readonly onMenuOpen: () => void;
  readonly onMenuClose: () => void;
  /** A write is in flight, so the items show unavailable rather than leaving the menu. */
  readonly busy: boolean;
  /**
   * Moves the project onto another schedule.
   *
   * Absent on a screen with no settings writer, and that absence is the whole
   * of the permission rule: `schedule_engine` and `schedule_objective` are
   * **project-wide**, so one reader's switch moves every collaborator's plan,
   * and a cue that offered the switch to somebody who cannot make it would be
   * a control that fails with a toast. Such a screen still reads everything —
   * see the second arm of the pill below.
   */
  readonly onChoose?: (patch: ProjectOptimizationPatch) => void;
  /** Asks for one more solve of a variant whose own state a Retry may recover. */
  readonly onRetry?: (objective: ScheduleObjectiveView, inputHash: string) => void;
}

/**
 * The pill, at rest and in every state — and a **fixed** box.
 *
 * `w-56` rather than a box the width of its words, and it is the fix for a real
 * fault rather than a preference: this control is the last item in a wrapping
 * toolbar row, and its words change on every switch and on every solve that
 * lands (`Fast` → `Pri`, a saving appearing or going). A control that changes
 * width there can push itself over the wrap threshold, which re-lays the whole
 * row and moves every other control on it — "the whole header toolbox jitters"
 * (Dany, 2026-09-08). A fixed box cannot: the words inside it change and
 * nothing outside it moves. `e2e/optimization-cue.spec.ts` measures a
 * neighbour's edge across a switch.
 *
 * 11.5rem is the width the pill measured at its widest **before** it was
 * pinned — 184px, a dot, `Fast` and `· Pri 3 days earlier`, measured in
 * Chromium — so the row wraps exactly where it wrapped before and the pin
 * costs no line. A longer saving truncates rather than growing past it; the
 * whole of it is in the card and in the menu either way. A `<button>`'s own padding and border in both arms, so the menu arm and
 * the read-only arm are the same object to a reader.
 */
const PILL =
  'inline-flex h-8 w-[11.5rem] max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-muted px-2 text-sm whitespace-nowrap tabular-nums hover:border-border';

/**
 * What the dot has to say, worst-first, or `null` when it has nothing.
 *
 * **`null` is the common case and it draws no dot at all.** A grey disc on a
 * grey pill is not a quiet indicator, it is a smudge that reads as a margin
 * somebody got wrong (Dany, 2026-09-08). A plan whose variants are solved, or
 * whose input has nothing to solve, says so by the figures on the pill and in
 * its card; the dot is for the three states a reader has to notice.
 */
function dotState(
  optimization: PlanOptimizationView,
): 'solving' | 'unavailable' | 'infeasible' | 'incomplete' | null {
  const states = [optimization.variants.pri.state, optimization.variants.time.state];
  if (states.includes('failed') || states.includes('corrupt')) return 'unavailable';
  if (states.includes('plan-infeasible')) return 'infeasible';
  if (
    Object.values(optimization.variants).some(
      (variant) => variant.state === 'ready' && variant.proof === 'incomplete',
    )
  )
    return 'incomplete';
  if (states.includes('pending') || states.includes('retrying')) return 'solving';
  // An admitted `idle` is waiting for a solver seat, which is the same news as
  // `pending` — `variantStateWords` has the whole of why the two words differ.
  if (optimization.generation !== null && states.includes('idle')) return 'solving';
  return null;
}

/**
 * What each dot is painted in, and why it is a colour rather than a shade.
 *
 * `--destructive` for the two states a reader has to act on, told apart by
 * which of them it is: a plan that cannot meet a work item deadline is the
 * plan's problem, and a variant that failed to solve is the solver's — the
 * card says which. `--muted-foreground` for a solve in flight, pulsing, which
 * is the only state that is going to change on its own.
 */
const DOT: Readonly<Record<'solving' | 'unavailable' | 'infeasible' | 'incomplete', string>> = {
  solving: 'var(--muted-foreground)',
  unavailable: 'var(--highlight)',
  infeasible: 'var(--destructive)',
  incomplete: 'var(--highlight)',
};

/** One unmeetable work item deadline, as a line of the card. */
function unmeetableLine(
  unmeetable: UnmeetableDeadline,
  nameOf: (id: string) => string,
  projectStart: string | null,
  today: Date,
): string {
  const who =
    unmeetable.ownerWorkItemId === unmeetable.boundWorkItemId
      ? nameOf(unmeetable.boundWorkItemId)
      : `${nameOf(unmeetable.ownerWorkItemId)} → ${nameOf(unmeetable.boundWorkItemId)}`;
  const deadline = deadlineWords(projectStart, unmeetable.effectiveDeadlineOffset, today);
  const effective = deadline.isEffectiveWorkday ? ' (effective workday)' : '';
  return `${who} · Work item deadline${effective} ${deadline.text}`;
}

/**
 * What one row reads, in the order a reader needs it — its name, its finish,
 * how it compares with Fast, and what its own state is doing.
 *
 * `refusedBecause` is deliberately **not** here. It is the menu item's
 * `data-fact` and its `aria-disabled` reason, and a row whose state is already
 * in these words would otherwise say the same sentence twice.
 */
/**
 * Everything the optimizer knows about this plan, as the one string the fact
 * card is drawn from.
 *
 * A string and not a rendered card, because {@link HintLayer} draws it: one
 * layer, one card, one set of rules for the pointer, the keyboard, Escape and
 * touch. Its parts are separated by ` — ` rather than by newlines, because a
 * `data-*` attribute's newlines collapse in HTML rendering and a card that
 * pretended to have lines would have one long one.
 *
 * The order is the order a reader needs it: what each schedule does, what a
 * variant cannot do, the currency caveat, and last the solver identity — which
 * is metadata rather than news, and is here because it is the only place a
 * reader can find out **which** plan and **which** solver contract produced
 * the figures above it.
 */
function factWords(
  reading: CueReading,
  optimization: PlanOptimizationView,
  lineFor: (unmeetable: UnmeetableDeadline) => string,
): string {
  // One block per subject, blank line between them: the three schedules, then
  // the choice between the two optimized ones, then what the algorithms are,
  // then the identity of the run. It was one long ` — ` line for a commit and
  // read as a wall (Dany, 2026-09-08); `HintLayer` renders the breaks.
  const schedules = reading.rows.flatMap((row) => {
    const active = row.which === reading.active ? ' · active' : '';
    const lines = [`${rowWords(row)}${active}`];
    if (row.unmeetable !== null && row.unmeetable.length > 0) {
      // Indented under the row it belongs to — with a bullet rather than
      // leading spaces, which `pre-line` does not keep.
      lines.push(...row.unmeetable.map((unmeetable) => `· ${lineFor(unmeetable)}`));
    }
    return lines;
  });
  const identity = [
    `Solver ${optimization.contractVersion}`,
    `${String(Math.round(optimization.budgetMs / 1000))}s budget`,
    optimization.generation === null
      ? 'no generation for this plan'
      : `generation ${String(optimization.generation)}`,
    // The first eight characters, which is what a reader needs to match a
    // figure against a log line or a solver row; the whole SHA-256 is 64 and
    // would be most of the card.
    `plan ${optimization.inputHash.slice(0, 8)}`,
  ].join(' · ');
  return [
    schedules.join('\n'),
    ...(reading.variantContrast === null ? [] : [reading.variantContrast]),
    ...(reading.stale ? [`${STALE_WORDS}.`] : []),
    ALGORITHM_WORDS,
    identity,
  ].join('\n\n');
}

function rowWords(row: CueRow): string {
  const parts = [row.label];
  if (row.finishDays !== null) parts.push(days(row.finishDays));
  if (row.comparedWithFast !== null) parts.push(row.comparedWithFast);
  if (row.stateWords !== null) parts.push(row.stateWords);
  return parts.join(' · ');
}

/**
 * The compact schedule cue: which schedule this plan is on, what the optimizer
 * found, and the switch onto it — one pill in the toolbar row.
 *
 * **It replaced a full-width banner above the table** (tasks.md 8b.6). The
 * banner said one sentence about the variant on screen and, because the plan
 * read only compared *that* variant, drew nothing at all while Fast was
 * displayed — which is the state a project spends its first solve in and the
 * state the toggle leaves it in. Both halves are gone: the plan read now
 * compares every ready variant, and this says so in the width of a control.
 *
 * Two surfaces, and the second one is **not this component's**:
 *
 * - **The pill** carries the state and, when a variant would land the plan
 *   earlier than the schedule on screen, the saving. Its accessible name is the
 *   whole sentence (`cueReading`), because the visible text is two words.
 * - **The menu** carries the actions: the three schedules with their figures,
 *   and a Retry for a variant a Retry can recover.
 * - **The reading is a `data-fact`**, drawn by {@link HintLayer} like every
 *   other explanation in this app — one layer, one card, one set of rules for
 *   the pointer, the keyboard, Escape and touch. `data-fact` and **not**
 *   `data-hint`: this is information about the **project**, not about what a
 *   control does, so it opens at once and behind no wait ring (Dany,
 *   2026-09-08; `tool-hints-wait` is the change that split the two). Everything
 *   the optimizer knows about this plan is in it — every row's figures, its
 *   comparison, its state, the work item deadlines an infeasible variant
 *   proved unmeetable, and the solver identity the result was produced under.
 *
 * This component drew a `HoverCard` of its own for one commit, and that was
 * two cards on one control: the layer already draws one for any `data-hint`,
 * so a pointer resting on the pill opened both and `aria-describedby` named
 * them both. A control that explains itself twice explains itself once too
 * often.
 *
 * A live region beside the pill says the sentence again when it changes: an
 * `aria-label` moving under a button announces nothing.
 */
export function OptimizationCue({
  optimization,
  stale = false,
  projectStart,
  today,
  workItemName,
  menuOpen,
  onMenuOpen,
  onMenuClose,
  busy,
  onChoose,
  onRetry,
}: OptimizationCueProps) {
  // No state at all, and that is the point: the pill's words come from the plan
  // read, its menu's open flag is the caller's, and its card belongs to
  // `HintLayer`. A project with optimization off has nothing to say — the
  // settings panel is where its one sentence lives ("Fast is active while
  // optimization is off").
  if (!optimization.enabled) return null;

  const reading = cueReading(optimization, stale);
  const nameOf = (id: string): string => {
    const name = workItemName(id);
    if (name === null) return 'Work item no longer in this plan';
    return name.trim() === '' ? 'Unnamed work item' : name;
  };

  const switches: MenuAction[] =
    onChoose === undefined
      ? []
      : reading.rows.map((row) => {
          const active = row.which === reading.active;
          return {
            id: `schedule-${row.which}`,
            // A check on the one the project is on, and **no refusal**: a
            // refused item carries its reason as a `data-fact`, `MenuControl`
            // focuses its first item the moment it opens, and the first item is
            // Fast — so an active Fast popped a card over the menu on every
            // single opening. Seen in a screenshot at 1600 (2026-09-08), which
            // is the only way it was ever going to be seen.
            label: active ? `✓ ${rowWords(row)}` : rowWords(row),
            // The other reasons stay: a variant that has not solved says why,
            // and a reader has to arrow onto it to be told.
            ...(active || row.refusedBecause === null
              ? {}
              : { refusedBecause: row.refusedBecause }),
            run: () => {
              // Taking the schedule the project is already on is a write that
              // changes nothing and a plan read nobody needs.
              if (active) return;
              onChoose(
                row.which === 'fast'
                  ? { scheduleEngine: 'fast' }
                  : { scheduleEngine: 'optimized', scheduleObjective: row.which },
              );
            },
          };
        });
  const retries: MenuAction[] =
    onRetry === undefined
      ? []
      : reading.retryable.map((objective) => ({
          id: `retry-${objective}`,
          label: `Retry ${OBJECTIVE_LABEL[objective]}`,
          run: () => {
            // `inputHash` is the plan the reader is looking at. Sending it is
            // what lets be-01 refuse a Retry aimed at a screen that has since
            // moved on, rather than re-solving a plan nobody asked about.
            onRetry(objective, optimization.inputHash);
          },
        }));
  const actions = [...switches, ...retries];
  const fact = factWords(reading, optimization, (unmeetable) =>
    unmeetableLine(unmeetable, nameOf, projectStart, today),
  );

  const dot = dotState(optimization);
  const face = (
    <>
      {dot !== null && (
        <span
          data-cue-dot={dot}
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full${dot === 'solving' ? 'animate-pulse' : ''}`}
          style={{ background: DOT[dot] }}
        />
      )}
      {/*
        The name sizes itself: the box around it is fixed, so the few pixels
        between `Fast`, `Pri` and `Time` move the saving beside them and
        nothing outside the pill. A slot wide enough for the longest of the
        three cost the saving 38px of room and truncated it at 1600, which is
        the width this pill is pinned to fit.
      */}
      <span data-cue-active>{reading.activeLabel}</span>
      {reading.suggestionWords !== null && (
        <span data-cue-suggestion className="text-primary min-w-0 truncate font-medium">
          · {reading.suggestionWords}
        </span>
      )}
    </>
  );

  return (
    <span
      data-optimization-cue
      data-cue-suggesting={reading.suggestion ?? undefined}
      className="relative inline-block min-w-0"
    >
      {actions.length === 0 ? (
        // No writer and nothing to retry: there is nothing to press. It stays a
        // `<button>` so the keyboard can reach the fact — `HintLayer` opens the
        // same card from `focusin` — rather than a `<span>` no Tab ever lands
        // on. `MenuControl` refuses to open with no item to focus, and it is
        // right to, so this arm is not one.
        <button type="button" className={PILL} aria-label={reading.sentence} data-fact={fact}>
          {face}
        </button>
      ) : (
        <MenuControl
          name={reading.sentence}
          data-fact={fact}
          align="left"
          open={menuOpen}
          onOpen={onMenuOpen}
          onClose={onMenuClose}
          busy={busy}
          actions={actions}
          trigger={{ className: PILL }}
        >
          {face}
        </MenuControl>
      )}
      {/*
        One node, always rendered, text changing — so a state change is
        announced rather than silently swapped under a button whose
        `aria-label` no screen reader re-reads.
      */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {reading.sentence}
      </span>
    </span>
  );
}
