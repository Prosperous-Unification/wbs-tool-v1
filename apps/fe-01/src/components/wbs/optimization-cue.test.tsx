import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as WorkdayModule from '@wbs/domain/workday';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanOptimizationView, ProjectOptimizationPatch } from '@/lib/wbs-api';

import { OptimizationCue } from './optimization-cue';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const addWorkdaysCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@wbs/domain/workday', async (importOriginal) => {
  const real = await importOriginal<typeof WorkdayModule>();
  return {
    ...real,
    addWorkdays: (...args: Parameters<typeof real.addWorkdays>) => {
      addWorkdaysCalls.count += 1;
      return real.addWorkdays(...args);
    },
  };
});

beforeEach(() => {
  addWorkdaysCalls.count = 0;
});

afterEach(cleanup);

/** Fast on screen, PRI three workdays ahead of it, Time still solving. */
const SUGGESTING: PlanOptimizationView = {
  enabled: true,
  engine: 'fast',
  objective: 'pri',
  inputHash: 'hash-a',
  generation: 7,
  contractVersion: '1.5+test',
  budgetMs: 60_000,
  displayed: 'fast',
  variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } },
  finishDays: { fast: 10, pri: 7 },
  sameOrderAsFast: { pri: true },
};

/**
 * The cue with its menu state held for it, the way the table holds it.
 *
 * A controlled menu driven through a controller rather than by re-rendering
 * with new props: "one menu open at a time" is the table's rule, and this is
 * the smallest thing that keeps it while a case really opens and closes one.
 */
function Harness({
  optimization,
  stale = false,
  projectStart = '2026-09-07',
  today = new Date(2026, 8, 7),
  workItemName = (id) => (id === 'parent' ? 'Launch' : id === 'leaf' ? 'Migration' : null),
  onChoose,
  onRetry,
  busy = false,
}: {
  optimization: PlanOptimizationView;
  stale?: boolean;
  projectStart?: string | null;
  today?: Date;
  workItemName?: (id: string) => string | null;
  onChoose?: (patch: ProjectOptimizationPatch) => void;
  onRetry?: (objective: 'pri' | 'time', inputHash: string) => void;
  busy?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <OptimizationCue
      optimization={optimization}
      stale={stale}
      projectStart={projectStart}
      today={today}
      workItemName={workItemName}
      menuOpen={open}
      onMenuOpen={() => {
        setOpen(true);
      }}
      onMenuClose={() => {
        setOpen(false);
      }}
      busy={busy}
      {...(onChoose === undefined ? {} : { onChoose })}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

const pill = () => screen.getByRole('button', { name: /is the active schedule/ });
const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('the schedule cue', () => {
  itDom('says nothing at all while optimization is off', () => {
    render(<Harness optimization={{ ...SUGGESTING, enabled: false }} onChoose={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  itDom('is a pill and not a banner, on the row of controls', () => {
    render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    // The one thing the banner it replaced could not be: a control whose own
    // box is the width of its words. The measurement is a browser fact
    // (`e2e/optimization-cue.spec.ts`); what is asserted here is that there is
    // exactly one of them and it is not a region of its own.
    expect(document.querySelectorAll('[data-optimization-cue]')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-cue-active]')?.textContent).toBe('Fast');
  });

  /**
   * Proof: with `suggestionWords` returned for every difference rather than
   * for an earlier finish alone — the reading's `finish < onScreen` replaced by
   * "outside the drift or reordered" — the two cases below failed on `expected
   * <span …(2)></span> to be null`. The rule itself is proven where it is
   * decided (`optimization-cue-reading.test.ts`); this is the half that says
   * the pill really wears it. Watched 2026-09-08.
   */
  itDom('wears the saving when a variant would land the plan earlier', () => {
    render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    expect(document.querySelector('[data-cue-suggestion]')?.textContent).toBe(
      '· Pri 3 days earlier',
    );
    expect(document.querySelector('[data-optimization-cue]')).toHaveAttribute(
      'data-cue-suggesting',
      'pri',
    );
  });

  itDom.each([
    ['the same project deadline in a different order', { fast: 10, pri: 10 }, { pri: false }],
    ['a later project deadline', { fast: 10, pri: 12 }, { pri: true }],
  ] as const)('wears nothing for %s', (_what, finishDays, sameOrderAsFast) => {
    render(
      <Harness
        optimization={{ ...SUGGESTING, finishDays, sameOrderAsFast }}
        onChoose={() => undefined}
      />,
    );
    expect(document.querySelector('[data-cue-suggestion]')).toBeNull();
    expect(document.querySelector('[data-optimization-cue]')).not.toHaveAttribute(
      'data-cue-suggesting',
    );
  });

  /**
   * Proof: the `null` arm of `dotState` replaced by `'ready'` — the grey disc
   * this change deleted — and **both** cases below failed on `expected <span
   * data-cue-dot="ready" …(2)></span> to be null`. A grey dot on a grey pill
   * reads as a margin somebody got wrong rather than as a state (Dany,
   * 2026-09-08). Watched 2026-09-08.
   */
  itDom('draws no dot at all when there is nothing to indicate', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            pri: { state: 'ready', proof: 'proven' },
            time: { state: 'ready', proof: 'proven' },
          },
          finishDays: { fast: 10, pri: 7, time: 10 },
          sameOrderAsFast: { pri: true, time: true },
        }}
        onChoose={() => undefined}
      />,
    );
    expect(document.querySelector('[data-cue-dot]')).toBeNull();
  });

  itDom('draws no dot for a plan with nothing to solve', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          generation: null,
          variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
          finishDays: { fast: 10 },
          sameOrderAsFast: {},
        }}
        onChoose={() => undefined}
      />,
    );
    expect(document.querySelector('[data-cue-dot]')).toBeNull();
  });

  /**
   * Proof: moving the incomplete arm above the in-flight arm makes this mixed
   * state report `incomplete`; this assertion then fails because the second
   * variant is still solving. The measured production window is Pri ready and
   * incomplete while Time remains pending.
   */
  itDom('keeps the in-flight marker while another variant has settled incomplete', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            pri: { state: 'ready', proof: 'incomplete' },
            time: { state: 'pending' },
          },
        }}
        onChoose={() => undefined}
      />,
    );

    expect(document.querySelector('[data-cue-dot]')).toHaveAttribute('data-cue-dot', 'solving');
    expect(pill()).toHaveAccessibleName(/Search stopped before proving this schedule optimal/);
    fireEvent.click(pill());
    const pri = screen.getByRole('menuitem', {
      name: /Pri · 7 days · Earlier project deadline by 3 days · Search stopped/,
    });
    expect(pri).toHaveAttribute('aria-disabled', 'false');
  });

  itDom('marks an incomplete search once both variants have settled', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            pri: { state: 'ready', proof: 'incomplete' },
            time: { state: 'ready', proof: 'proven' },
          },
        }}
        onChoose={() => undefined}
      />,
    );

    expect(document.querySelector('[data-cue-dot]')).toHaveAttribute('data-cue-dot', 'incomplete');
  });

  itDom.each(['proven', 'quantisation-floor'] as const)(
    'does not show the unfinished-search marker for %s results',
    (proof) => {
      render(
        <Harness
          optimization={{
            ...SUGGESTING,
            variants: { pri: { state: 'ready', proof }, time: { state: 'pending' } },
          }}
          onChoose={() => undefined}
        />,
      );
      expect(pill()).not.toHaveAccessibleName(/Search stopped/);
    },
  );

  itDom.each([
    [
      'solving',
      { pri: { state: 'pending' }, time: { state: 'ready', proof: 'proven' } } as const,
      'solving',
    ],
    [
      'a variant that could not be computed',
      {
        pri: { state: 'failed', reason: 'oom' },
        time: { state: 'ready', proof: 'proven' },
      } as const,
      'unavailable',
    ],
    [
      'a plan that cannot meet a work item deadline',
      {
        pri: { state: 'plan-infeasible', items: [] },
        time: { state: 'ready', proof: 'proven' },
      } as const,
      'infeasible',
    ],
    [
      'a variant waiting for a solver seat',
      { pri: { state: 'idle' }, time: { state: 'ready', proof: 'proven' } } as const,
      'solving',
    ],
  ])('paints a dot for %s', (_what, variants, expected) => {
    render(<Harness optimization={{ ...SUGGESTING, variants }} onChoose={() => undefined} />);
    const dot = document.querySelector('[data-cue-dot]');
    expect(dot).toHaveAttribute('data-cue-dot', expected);
    // A colour rather than a shade of the pill it sits on: the whole complaint
    // was grey on grey.
    expect(dot?.getAttribute('style')).toMatch(
      /background: var\(--(muted-foreground|highlight|destructive)\)/,
    );
  });

  itDom('lists all three schedules with their figures, and refuses the active one', () => {
    render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    fireEvent.click(pill());
    expect(items()).toEqual([
      '✓ Fast · 10 days',
      'Pri · 7 days · Earlier project deadline by 3 days',
      'Time · Optimizing…',
    ]);
    // The active one is checked and carries **no** fact: `MenuControl` focuses
    // its first item on opening, and a fact there opens a card over the menu
    // the moment it appears.
    const fast = screen.getByRole('menuitem', { name: '✓ Fast · 10 days' });
    expect(fast).not.toHaveAttribute('data-fact');
    expect(fast).toHaveAttribute('aria-disabled', 'false');
    // Present and refused rather than absent, for every other reason: a control
    // that leaves a menu somebody is reading takes its own explanation with it.
    expect(screen.getByRole('menuitem', { name: /^Time/ })).toHaveAttribute(
      'data-fact',
      'Optimizing…',
    );
    expect(screen.getByRole('menuitem', { name: /^Time/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  itDom('switches the project onto the variant it suggested', () => {
    const asked: ProjectOptimizationPatch[] = [];
    render(
      <Harness
        optimization={SUGGESTING}
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pri/ }));
    expect(asked).toEqual([{ scheduleEngine: 'optimized', scheduleObjective: 'pri' }]);
  });

  itDom('switches back to Fast from a displayed variant', () => {
    const asked: ProjectOptimizationPatch[] = [];
    render(
      <Harness
        optimization={{ ...SUGGESTING, engine: 'optimized', displayed: 'pri' }}
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: /^Fast/ }));
    expect(asked).toEqual([{ scheduleEngine: 'fast' }]);
  });

  itDom('asks for nothing when the schedule on screen is chosen again', () => {
    const asked: ProjectOptimizationPatch[] = [];
    render(
      <Harness
        optimization={SUGGESTING}
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: /^✓ Fast/ }));
    expect(asked).toEqual([]);
  });

  itDom('takes nothing from the item that says why it cannot be taken', () => {
    const asked: ProjectOptimizationPatch[] = [];
    render(
      <Harness
        optimization={SUGGESTING}
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: /^Time/ }));
    expect(asked).toEqual([]);
  });

  /**
   * The window the fault lives in (R5, `estimate-triple-visible`).
   *
   * The plan is re-read after every write, so an optimistic pill and a patient
   * one land on the same screen: the only moment they differ is while the
   * patch is in flight. The fake holds it there and the assertion is made in
   * that window.
   *
   * Proof: with the pill's face rendering an optimistic label instead of the
   * read's own — `reading.activeLabel` replaced by a constant `'Pri'`, which is
   * what an optimistic switch would put there — this failed on `Expected:
   * "Fast" · Received: "Pri"`. Watched 2026-09-08.
   */
  itDom('leaves the active schedule alone until a plan read moves it', () => {
    const asked: ProjectOptimizationPatch[] = [];
    const view = render(
      <Harness
        optimization={SUGGESTING}
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pri/ }));

    // The window: the switch has been asked for and no plan read has answered.
    // `onChoose` returns nothing, so this **is** the in-flight state — the
    // caller's `run` has the request and this component has the same props it
    // had a moment ago.
    expect(asked).toHaveLength(1);
    expect(document.querySelector('[data-cue-active]')?.textContent).toBe('Fast');

    // And a refusal is the same picture from here: the props do not change, so
    // neither does the pill.
    view.rerender(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    expect(document.querySelector('[data-cue-active]')?.textContent).toBe('Fast');

    // Only the read that carries the new `displayed` moves it.
    view.rerender(
      <Harness
        optimization={{ ...SUGGESTING, engine: 'optimized', displayed: 'pri' }}
        onChoose={() => undefined}
      />,
    );
    expect(document.querySelector('[data-cue-active]')?.textContent).toBe('Pri');
  });

  itDom('shows the items unavailable while a write is in flight', () => {
    const asked: ProjectOptimizationPatch[] = [];
    render(
      <Harness
        optimization={SUGGESTING}
        busy
        onChoose={(patch) => {
          asked.push(patch);
        }}
      />,
    );
    fireEvent.click(pill());
    expect(screen.getByRole('menuitem', { name: /^Pri/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Pri/ }));
    expect(asked).toEqual([]);
  });

  itDom.each([
    ['failed', { state: 'failed', reason: 'timeout' } as const],
    ['corrupt', { state: 'corrupt', message: 'bad dto' } as const],
  ])('offers a Retry for a %s variant, naming the plan it was pressed against', (_what, state) => {
    const asked: { objective: string; inputHash: string }[] = [];
    render(
      <Harness
        optimization={{ ...SUGGESTING, variants: { ...SUGGESTING.variants, time: state } }}
        onChoose={() => undefined}
        onRetry={(objective, inputHash) => {
          asked.push({ objective, inputHash });
        }}
      />,
    );
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry Time' }));
    expect(asked).toEqual([{ objective: 'time', inputHash: 'hash-a' }]);
  });

  itDom.each([
    ['plan-infeasible', { state: 'plan-infeasible', items: [] } as const],
    ['pending', { state: 'pending' } as const],
    ['ready', { state: 'ready', proof: 'proven' } as const],
  ])('offers no Retry for a %s variant', (_what, state) => {
    render(
      <Harness
        optimization={{ ...SUGGESTING, variants: { ...SUGGESTING.variants, time: state } }}
        onChoose={() => undefined}
        onRetry={() => undefined}
      />,
    );
    fireEvent.click(pill());
    // The menu really is open — three schedules — and the Retry is absent from
    // it. Without the first assertion this case would pass against a menu that
    // never opened.
    expect(items()).toHaveLength(3);
    expect(screen.queryByRole('menuitem', { name: /retry/i })).toBeNull();
  });

  itDom('reads without offering a switch when there is no writer', () => {
    render(<Harness optimization={SUGGESTING} />);
    // The pill is still there and still says everything: what a reader without
    // the project's settings loses is the ability to act, not the reading.
    // Still a `<button>`, so the keyboard can reach the fact — `HintLayer`
    // opens the same card from `focusin` — and still carrying every word.
    const reader = screen.getByRole('button', { name: /is the active schedule/ });
    expect(reader).toHaveAttribute('data-fact');
    expect(screen.getByRole('status')).toHaveTextContent('Priority-first finishes 3 days earlier');
    fireEvent.click(reader);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  /**
   * The reading is a `data-fact`, so what this suite asserts is the words on
   * the mark; that a card is drawn from them, at once and behind no wait ring,
   * is `HintLayer`'s contract and is proven in `hint.test.tsx` and in
   * `e2e/optimization-cue.spec.ts`.
   *
   * `data-fact` and **not** `data-hint`: this is information about the project
   * rather than about what the control does, and the two open on different
   * rules (Dany, 2026-09-08).
   */
  itDom('carries the whole reading as a project fact, not as a tool hint', () => {
    render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    const fact = pill().getAttribute('data-fact');
    expect(pill()).not.toHaveAttribute('data-hint');
    expect(fact).toContain('Fast · 10 days · active');
    expect(fact).toContain('Pri · 7 days · Earlier project deadline by 3 days');
    expect(fact).toContain('Time · Optimizing…');
    // What the three algorithms are — a name this short cannot say it, and the
    // reader has to choose between them.
    expect(fact).toContain('Fast places the plan in milliseconds');
    expect(fact).toContain('Time searches for the earliest project deadline');
    expect(fact).toContain('Pri searches for the schedule that starts higher-priority work');
    expect(fact).toContain('CP-SAT searches from Google OR-Tools');
    // The metadata, which is the only place a reader can find out which plan
    // and which solver contract produced the figures.
    expect(fact).toContain('Solver 1.5+test · 60s budget · generation 7 · plan hash-a');
    // Blocks, not one line: the schedules, the algorithms and the run's
    // identity are separated by a blank line each. The Pri-against-Time block
    // is a fourth, and this fixture has no Time answer to contrast.
    expect((fact ?? '').split('\n\n')).toHaveLength(3);
  });

  itDom('names the active schedule in the fact, wherever the project is', () => {
    render(
      <Harness
        optimization={{ ...SUGGESTING, engine: 'optimized', displayed: 'pri' }}
        onChoose={() => undefined}
      />,
    );
    const fact = pill().getAttribute('data-fact');
    expect(fact).toContain('Pri · 7 days · Earlier project deadline by 3 days · active');
    expect(fact).not.toContain('Fast · 10 days · active');
  });

  itDom('contrasts Pri with Time where both have an answer', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            pri: { state: 'ready', proof: 'proven' },
            time: { state: 'ready', proof: 'proven' },
          },
          finishDays: { fast: 10, pri: 7, time: 8 },
          sameOrderAsFast: { pri: true, time: false },
        }}
        onChoose={() => undefined}
      />,
    );
    // The comparison a reader actually chooses between: Fast is the reference
    // every figure is measured against, and the decision is Pri or Time.
    expect(pill().getAttribute('data-fact')).toContain(
      'Pri against Time: Pri 1 day earlier, in a different order from each other.',
    );
  });

  itDom('says nothing about Pri against Time while one of them has no answer', () => {
    render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    expect(pill().getAttribute('data-fact')).not.toContain('Pri against Time');
  });

  itDom('says in the fact that a stale plan has no comparison to show', () => {
    render(<Harness optimization={SUGGESTING} stale onChoose={() => undefined} />);
    const fact = pill().getAttribute('data-fact');
    expect(fact).toContain('Schedule comparison unavailable while this plan may be stale');
    expect(fact).not.toContain('Earlier project deadline');
  });

  itDom('puts every unmeetable work item deadline in the fact', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 4 },
                { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: -1 },
                { ownerWorkItemId: 'gone', boundWorkItemId: 'gone', effectiveDeadlineOffset: 4 },
              ],
            },
          },
        }}
        onChoose={() => undefined}
      />,
    );
    const fact = pill().getAttribute('data-fact') ?? '';
    expect(fact).toContain('Time · Plan infeasible · 3 Work item deadlines');
    // Offset 4 is also what a user-entered Saturday 12 Sep folds to. The cue
    // has only the effective offset, so it labels the reconstructed Friday
    // honestly instead of presenting it as the date the user entered.
    expect(fact).toContain('Launch → Migration · Work item deadline (effective workday) 11 Sep');
    // The same row on both ends of the binding is named once.
    expect(fact).toContain("Migration · Work item deadline before the project's first working day");
    // A row that has left the plan is named, never its raw id.
    expect(fact).toContain(
      'Work item no longer in this plan · Work item deadline (effective workday) 11 Sep',
    );
    expect(fact).not.toContain('gone');
    // Proof: the two valid offsets above each reconstruct once. Reintroducing
    // separate validity, suffix and copy reconstructions makes this 6.
    expect(addWorkdaysCalls.count).toBe(2);
  });

  itDom('distinguishes unnamed and missing rows without an orphan deadline bullet', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'empty', boundWorkItemId: 'empty', effectiveDeadlineOffset: 4 },
                { ownerWorkItemId: 'gone', boundWorkItemId: 'gone', effectiveDeadlineOffset: 4 },
              ],
            },
          },
        }}
        workItemName={(id) => (id === 'empty' ? '' : id === 'leaf' ? 'Migration' : null)}
        onChoose={() => undefined}
      />,
    );
    const fact = pill().getAttribute('data-fact') ?? '';
    expect(fact).toContain('Unnamed work item · Work item deadline (effective workday) 11 Sep');
    expect(fact).toContain(
      'Work item no longer in this plan · Work item deadline (effective workday) 11 Sep',
    );
    expect(fact).not.toContain('\n· · Work item deadline');
  });

  itDom('refuses malformed offsets at the renderer boundary without throwing', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 1.5 },
                {
                  ownerWorkItemId: 'parent',
                  boundWorkItemId: 'parent',
                  effectiveDeadlineOffset: -2,
                },
                {
                  ownerWorkItemId: 'gone',
                  boundWorkItemId: 'gone',
                  effectiveDeadlineOffset: Number.MAX_SAFE_INTEGER,
                },
              ],
            },
          },
        }}
        onChoose={() => undefined}
      />,
    );
    const fact = pill().getAttribute('data-fact') ?? '';
    expect(fact).toContain('Migration · Work item deadline date unavailable');
    expect(fact).toContain('Launch · Work item deadline date unavailable');
    expect(fact).toContain(
      'Work item no longer in this plan · Work item deadline date unavailable',
    );
  });

  itDom('refuses a malformed project start at the renderer boundary without throwing', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 4 },
              ],
            },
          },
        }}
        projectStart="the end of August"
        onChoose={() => undefined}
      />,
    );
    expect(pill().getAttribute('data-fact')).toContain(
      'Migration · Work item deadline date unavailable',
    );
  });

  itDom('does not invent sentinel copy when the project has no calendar start', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: -1 },
              ],
            },
          },
        }}
        projectStart={null}
        onChoose={() => undefined}
      />,
    );
    expect(pill().getAttribute('data-fact')).toContain(
      'Migration · Work item deadline date unavailable',
    );
  });

  itDom('uses the reader local year when an effective deadline crosses New Year', () => {
    render(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            ...SUGGESTING.variants,
            time: {
              state: 'plan-infeasible',
              items: [
                { ownerWorkItemId: 'leaf', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 4 },
              ],
            },
          },
        }}
        projectStart="2026-12-28"
        today={new Date(2026, 11, 31, 23, 30)}
        onChoose={() => undefined}
      />,
    );
    expect(pill().getAttribute('data-fact')).toContain(
      'Migration · Work item deadline (effective workday) 1 Jan 2027',
    );
  });

  itDom('keeps one live region while the optimizer state changes under it', () => {
    const view = render(<Harness optimization={SUGGESTING} onChoose={() => undefined} />);
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');

    view.rerender(
      <Harness
        optimization={{
          ...SUGGESTING,
          variants: {
            pri: { state: 'failed', reason: 'oom' },
            time: { state: 'ready', proof: 'proven' },
          },
          finishDays: { fast: 10, time: 10 },
          sameOrderAsFast: { time: true },
        }}
        onChoose={() => undefined}
      />,
    );
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Priority-first: Optimization unavailable');
  });

  itDom('drops the comparison, and the suggestion, while the plan may be stale', () => {
    render(<Harness optimization={SUGGESTING} stale onChoose={() => undefined} />);
    expect(document.querySelector('[data-cue-suggestion]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Schedule comparison unavailable while this plan may be stale',
    );
    fireEvent.click(pill());
    expect(items()).toEqual(['✓ Fast', 'Pri', 'Time · Optimizing…']);
  });
});
