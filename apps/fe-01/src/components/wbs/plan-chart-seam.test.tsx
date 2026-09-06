import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { DEFAULT_PERT_WEIGHTS_VIEW } from '@/lib/wbs-api';
import { DEV, fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { refusingApi } from '@/testing/refusing-api';
import { planRead, projectListEntry, sliceView, workItemView } from '@/testing/views';

import type * as GanttGeometryModule from './gantt-geometry';
import type * as TableFrameModule from './table-frame';
import { type SubscriptionHandlers, WbsTable, type WbsTableProps } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

/**
 * How many times the chart has been laid out.
 *
 * `GanttPanel` computes its whole geometry in `useMemo(() => layOutGantt(plan),
 * [plan])`, so this counts the times `plan` arrived as a new object. It is the
 * only thing that distinguishes "the table memoised its chart input" from "the
 * table rebuilt it and React re-ran the layout" — the drawn bars are identical
 * either way, which is exactly why a rendering assertion cannot see this.
 *
 * The mock is call-through: every other case sees the real module.
 */
const layoutCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('./gantt-geometry', async (importOriginal) => {
  const real = await importOriginal<typeof GanttGeometryModule>();
  return {
    ...real,
    layOutGantt: (...args: Parameters<typeof real.layOutGantt>) => {
      layoutCalls.count += 1;
      return real.layOutGantt(...args);
    },
  };
});

/**
 * How many `<td>`/`<th>` renders the table has performed, counted through
 * {@link flexibleCellStyle} — every body cell and heading computes its flexible
 * width exactly once per render (wbs-table.tsx's `<td>`/`<th>` style spreads),
 * so the count divided by the column count is "how many rows rendered".
 *
 * The pointed-row probes read this to assert render isolation: pointing a row
 * must re-render the rows whose light changed and nothing else. jsdom can see
 * nothing else that distinguishes "memo held" from "memo silently vacuous" —
 * React reuses the DOM nodes either way.
 *
 * The mock is call-through: every other test sees the real module unchanged.
 */
const cellStyleCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./table-frame', async (importOriginal) => {
  const real = await importOriginal<typeof TableFrameModule>();
  return {
    ...real,
    flexibleCellStyle: (...args: Parameters<typeof real.flexibleCellStyle>) => {
      cellStyleCalls.count += 1;
      return real.flexibleCellStyle(...args);
    },
  };
});

const numbersOnScreen = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-number]')?.textContent ?? '');

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

const typeName = (number: string, value: string) => {
  fireEvent.change(screen.getByLabelText(`Name of ${number}`), { target: { value } });
};

/**
 * Opens a step's folded columns — the trio and the assignee. Folded is the
 * default, so every test that types an estimate or assigns someone does this
 * first, exactly as a person would.
 */
const unfoldStep = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Unfold ${name} estimates` }));
};

// The table remembers each project's open branches in localStorage, so one
// test's collapsing would arrive as the next test's starting shape.
beforeEach(() => {
  localStorage.clear();
});

/**
 * Opens one row's earliest-start editor, the way a reader does.
 *
 * The cell is text at rest since `T2 compact-columns` — the editor is mounted
 * for the cell being edited and for no other — so every date typed into a row
 * has to be typed into an editor that was opened first. Enter is the keyboard's
 * way in; a click is the pointer's.
 */
const openNotBefore = (number: string): HTMLInputElement => {
  const cell = screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
  fireEvent.keyDown(cell, { key: 'Enter' });
  return screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
};

/** Opens a row's earliest-start editor, types a day into it, and leaves. */
const typeIntoNotBefore = (number: string, day: string): void => {
  const editor = openNotBefore(number);
  fireEvent.change(editor, { target: { value: day } });
  fireEvent.blur(editor);
};

/** The `<tr>` whose number cell reads `number`. */
const rowFor = (number: string): HTMLElement => {
  const found = screen
    .getAllByRole('row')
    .find((tr) => tr.querySelector('[data-number]')?.textContent === number);
  if (found === undefined) throw new Error(`no row numbered ${number}`);
  return found;
};

/**
 * Three named root rows: `010 Strip`, `020 Sand`, `030 Paint`.
 *
 * The fake is a parameter rather than always minted here so a caller can seed
 * it **before** the mount — the marker cases below need a project that already
 * has a start date and a marker on it, and both arrive on the first read.
 *
 * `subscribe` is optional for the prop's own reason: the table is driven by a
 * fake here and only the peer case below has a socket to open.
 */
async function threeRoots(api = fakeApi(), subscribe?: WbsTableProps['subscribe']) {
  // Dev's columns take part in the keyboard grid below, so they are open.

  render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
  // Named, not left blank. Blank names made an ordering assertion compare three
  // empty strings against three empty strings, which passes for any order.
  for (const [number, name] of [
    ['010', 'Strip'],
    ['020', 'Sand'],
    ['030', 'Paint'],
  ]) {
    click('Add work item');
    await screen.findByLabelText(`Name of ${number}`);
    typeName(number, name);
    fireEvent.blur(screen.getByLabelText(`Name of ${number}`));
    await waitFor(() => {
      expect(screen.getByLabelText(`Name of ${number}`)).toHaveProperty('value', name);
    });
  }
  unfoldStep('Dev');
  return api;
}

/**
 * Three estimated roots with the chart open beneath them.
 *
 * The chart is opened rather than left shut, because what is under test is the
 * wiring **between** the two faces: a suite that only hovered rows in the
 * table would be asserting the absence of a light with nothing to light.
 */
async function planWithTheChartOpen(seeded = fakeApi(), subscribe?: WbsTableProps['subscribe']) {
  const api = await threeRoots(seeded, subscribe);
  // `threeRoots` unfolds Dev, so the three points are three boxes rather than
  // the folded cell's one.
  for (const number of ['010', '020', '030']) {
    for (const [point, days] of [
      ['optimistic', '2'],
      ['realistic', '3'],
      ['pessimistic', '4'],
    ]) {
      const box = screen.getByLabelText(`Dev ${point} for ${number}`);
      fireEvent.change(box, { target: { value: days } });
      fireEvent.blur(box);
    }
    await waitFor(() => {
      expect(screen.getByLabelText(`Dev realistic for ${number}`)).toHaveProperty('value', '3');
    });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
  await waitFor(() => {
    expect(document.querySelector('[data-gantt-bar]')).not.toBeNull();
  });
  return api;
}

describe('the pointed row', () => {
  /**
   * A pointer event of one kind or the other, built by hand.
   *
   * jsdom has no `PointerEvent`, so `fireEvent.pointerOver(node, { pointerType
   * })` builds a plain `Event` and drops the init's `pointerType` — the guard
   * then reads `undefined` and refuses, and every assertion about the pointer
   * path passes because nothing was ever pointed. `gantt-panel.test.tsx` has
   * the same helper for the same reason; both are the trap, not a preference.
   */
  const pointerEvent = (kind: 'mouse' | 'touch', name: 'pointerover' | 'pointerout'): Event => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: kind });
    // React synthesizes `onPointerEnter`/`onPointerLeave` from over/out, and
    // decides "left the row" from where the pointer went. Null is out of the
    // document, which is the departure the row's handler is about.
    Object.defineProperty(event, 'relatedTarget', { value: null });
    return event;
  };

  /** The `<tr>` a row number stands on. */
  const trOf = (number: string): HTMLElement => {
    const found = [...document.querySelectorAll('tbody tr')].find(
      (tr) => tr.querySelector('[data-number]')?.textContent === number,
    );
    if (!(found instanceof HTMLElement)) throw new Error(`no row for ${number}`);
    return found;
  };

  /** A bar on the open chart, found by the row it names. */
  const barOf = (number: string): Element => {
    const found = document.querySelector(`[data-gantt-bar][aria-label^="${number} - "]`);
    if (found === null) throw new Error(`no bar on the chart for ${number}`);
    return found;
  };

  /** The row label on the open chart, found by the words it prints. */
  const labelOf = (number: string): Element => {
    const found = [...document.querySelectorAll('[data-gantt-label]')].find((button) =>
      button.textContent.startsWith(`${number} - `),
    );
    if (found === undefined) throw new Error(`no row label for ${number}`);
    return found;
  };

  /** The numbers of every table row lit as pointed, in document order. */
  const litRows = (): string[] =>
    [...document.querySelectorAll('tr[data-row-lit]')].map((tr) => {
      const number = tr.querySelector('[data-number]')?.textContent;
      if (number == null) throw new Error('a pointed row has no number cell');
      return number;
    });

  /** The row indices of every pointed band the chart has drawn. */
  const litBands = (): string[] =>
    [...document.querySelectorAll('[data-gantt-row-lit]')].map(
      (rect) => rect.getAttribute('data-gantt-row-lit') ?? '(none)',
    );

  itDom('lights the table row from a bar, and clears when the pointer leaves', async () => {
    await planWithTheChartOpen();
    expect(litRows()).toEqual([]);

    fireEvent(barOf('020'), pointerEvent('mouse', 'pointerover'));

    expect(litRows()).toEqual(['020']);
    expect(litBands()).toEqual(['1']);

    fireEvent(barOf('020'), pointerEvent('mouse', 'pointerout'));
    expect(litRows()).toEqual([]);
    expect(litBands()).toEqual([]);
  });

  itDom('lights the chart from a table row, and the row itself', async () => {
    await planWithTheChartOpen();

    fireEvent(trOf('030'), pointerEvent('mouse', 'pointerover'));

    // The chart answers, which is the point of the gesture.
    expect(litBands()).toEqual(['2']);
    expect(labelOf('030').getAttribute('data-gantt-label-lit')).toBe('true');

    // **And the row lights itself**, which is this attribute's whole job now.
    // It used to be left to `tr:hover`, deliberately, so the alternating band
    // would keep showing through — `data-row-lit` here makes the banded-hover
    // rule unmatchable, and four of `e2e/hover-cards.spec.ts`'s assertions
    // failed on exactly that in 2026-08-14. Dany, 2026-09-01, having watched
    // it: "highlighted row is colored independently of which odd or even row
    // this is". The stripe deciding the colour is the defect; one ink is the
    // contract, and making that rule unmatchable is how it is kept.
    //
    // Proof: `data-row-lit` put back to `pointedFromChart`, watched failing on
    // `expected [] to deeply equal [ '030' ]`.
    expect(litRows()).toEqual(['030']);
  });

  /** The chart's own hit surface for one row's whole line. */
  const lineOf = (rowIndex: number): Element => {
    const found = document.querySelector(`[data-gantt-row-line="${String(rowIndex)}"]`);
    if (found === null) throw new Error(`no row line for ${String(rowIndex)}`);
    return found;
  };

  itDom('points a row from its own line, with no bar under the pointer', async () => {
    await planWithTheChartOpen();

    // Dany, 2026-09-01: "when i hover over gantt chart rows they must also be
    // highlighted, not only when i hover over the item on gantt chart". The
    // chart pointed a row from a **bar** or a **row label** and from nothing
    // else, so the plot area — most of a row's width, and all of it on a row
    // nobody has estimated — was dead. Measured in Chromium before this
    // change: the pointer on a row's line past the end of its bar left every
    // face dark.
    //
    // Proof: the row lines removed from the chart, watched failing on `no row
    // line for 1` at the locator — the fault takes the surface out of this
    // test's reach rather than making it answer wrongly, which is the right
    // place for it.
    fireEvent(lineOf(1), pointerEvent('mouse', 'pointerover'));

    expect(litRows()).toEqual(['020']);
    expect(litBands()).toEqual(['1']);
    expect(labelOf('020').getAttribute('data-gantt-label-lit')).toBe('true');
  });

  itDom('clears when the pointer leaves the chart', async () => {
    await planWithTheChartOpen();

    fireEvent(lineOf(2), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['030']);

    // **The chart's edge is what says "no row", and the row lines say nothing
    // about it.** A caret or a dependency link is drawn over the line on its
    // own row, so a departure from the line is routinely a mark on the same
    // row; clearing there would blink the light off under the thing the reader
    // is looking straight at. Leaving the drawing is the departure.
    //
    // Proof: the SVG root's `onPointerLeave` removed, watched failing on
    // `expected [ '030' ] to deeply equal []`.
    const chart = document.querySelector('[data-gantt-chart]');
    if (chart === null) throw new Error('the chart is not drawn');
    fireEvent(chart, pointerEvent('mouse', 'pointerout'));

    expect(litRows()).toEqual([]);
    expect(litBands()).toEqual([]);
  });

  itDom('points one row at a time', async () => {
    await planWithTheChartOpen();

    fireEvent(barOf('010'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['010']);

    // Straight to another bar without a departure in between, which is what a
    // pointer crossing the chart does. Exactly one row stays lit.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['030']);
    expect(litBands()).toEqual(['2']);
  });

  itDom('pointing a row from the chart re-renders no unrelated row', async () => {
    await planWithTheChartOpen();
    // Three more rows, so "every row rendered" and "only the two lights" are
    // far enough apart that no off-by-one commit can blur them: six rows plus
    // the heading row make the faulted reading 7 and the isolated one 3.
    for (const number of ['040', '050', '060']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    fireEvent(barOf('010'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['010']);

    const columnCount = document.querySelectorAll('thead th').length;
    const before = cellStyleCalls.count;
    fireEvent(barOf('020'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['020']);

    // Row-equivalents rendered by moving the light: the heading row plus the
    // row unlit plus the row lit. Anything above four means rows whose light
    // never changed rendered again.
    const rendered = (cellStyleCalls.count - before) / columnCount;
    expect(rendered).toBeLessThanOrEqual(4);
  });

  itDom('is pointed by a bar’s focus, and the pointer outranks it', async () => {
    await planWithTheChartOpen();

    fireEvent.focus(barOf('010'));
    expect(litRows()).toEqual(['010']);

    // A pointer elsewhere wins while both are live: the pointer is where the
    // eyes are. One field for both would have made this impossible to express.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));
    expect(litRows()).toEqual(['030']);

    // And losing the pointer falls back to the focus rather than to nothing.
    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerout'));
    expect(litRows()).toEqual(['010']);
  });

  itDom('is not pointed by a tap', async () => {
    await planWithTheChartOpen();

    // Chromium synthesizes a whole mouse sequence from a tap, so a row lit on a
    // mouse event lights on every tap as well — and a tap has no departure to
    // clear it, so the light would be stuck on whatever was touched last.
    fireEvent(barOf('020'), pointerEvent('touch', 'pointerover'));
    expect(litRows()).toEqual([]);

    fireEvent(trOf('020'), pointerEvent('touch', 'pointerover'));
    expect(litBands()).toEqual([]);
  });

  itDom('points a row without remounting the cells under a half-typed name', async () => {
    // The landmine: `columns` may depend on `steps` and `unfoldedSteps` and
    // nothing else. A `columns` that rebuilt on a pointed row would hand every
    // cell a new component type on the first hover and React would remount the
    // lot, dropping the focus to the body and the half-typed name with it. The
    // lit row is asserted first so this cannot pass vacuously on a hover that
    // wrote nothing.
    await planWithTheChartOpen();
    const input = screen.getByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    fireEvent(barOf('030'), pointerEvent('mouse', 'pointerover'));

    expect(litRows()).toEqual(['030']);
    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });

  itDom(
    'forgets a pointed row that is no longer drawn, and lights the bar under the pointer',
    async () => {
      await planWithTheChartOpen();

      // The pointer rests on the last row, and the chart answers for it.
      fireEvent(trOf('030'), pointerEvent('mouse', 'pointerover'));
      expect(litBands()).toEqual(['2']);

      // A search narrows 030 away **under the stationary pointer**, and no
      // pointer event follows: a browser fires no `pointerleave` at a node being
      // unmounted, and nothing moved to fire an arrival anywhere else. So the
      // remembered `tablePointedRow` still names 030 — which is the whole
      // premise, and it is measured in Chromium by
      // `e2e/hover-cards.spec.ts`'s 'a row narrowed away under the pointer
      // stops outranking the chart'.
      fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'Strip' } });
      expect(numbersOnScreen()).toEqual(['010']);

      // The pointer now arrives on the one bar left. That is the reading being
      // made, so the chart lights its row — a remembered row the table is no
      // longer drawing must not outrank it.
      fireEvent(barOf('010'), pointerEvent('mouse', 'pointerover'));

      expect(litBands()).toEqual(['0']);
      expect(labelOf('010').getAttribute('data-gantt-label-lit')).toBe('true');
      // The table's own row still lights from the chart's reading, as ever.
      expect(litRows()).toEqual(['010']);
    },
  );
});

describe('the chart under a plan being edited', () => {
  /**
   * An api whose schedule moves when a not-before lands, the way be-01's does.
   *
   * `tree()` serves the schedule the last `patch` implies: no floor is day 11,
   * a floor is day 16. The numbers are distinctive rather than computed — what
   * is under test is that the open chart draws the read that followed the
   * edit, not that this fake can schedule.
   */
  const apiWithMovableFloor = (): ProjectApi => {
    let floored = false;
    const scheduleNow = () => ({
      duration: 7,
      estimated: true,
      earliestStart: floored ? 16 : 11,
      earliestFinish: floored ? 23 : 18,
      latestStart: floored ? 18 : 13,
      latestFinish: floored ? 25 : 20,
      float: 2,
      critical: false,
    });
    return refusingApi({
      listProjects: () => Promise.resolve([projectListEntry({ name: 'P' })]),
      createProject: (name: string) =>
        Promise.resolve({ id: 'p1', name, restricted: false, lastOpenedAt: null }),
      openProject: () => Promise.resolve(),
      setEstimateMethod: () => Promise.resolve(),
      setStartDate: () => Promise.resolve(),
      listTeams: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listWorkItemTypes: () => Promise.resolve([]),
      listExternalSystems: () => Promise.resolve([]),
      listServices: () => Promise.resolve([]),
      addTeam: () => Promise.reject(new Error('not_in_these_tests')),
      listPeople: () => Promise.resolve([]),
      // The table reads the calendar markers on mount, alongside the plan, so a
      // double that stands in for a project has to answer it: unstated, this api
      // refuses on purpose and the refusal arrives as a toast over every case in
      // this file. Empty is what these projects have.
      listCalendarMarkers: () => Promise.resolve([]),
      addPerson: () => Promise.reject(new Error('not_in_these_tests')),
      assignPerson: () => Promise.resolve(),
      renameProject: () => Promise.resolve(),
      duplicateWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      steps: () => Promise.resolve([DEV]),
      addStep: () => Promise.reject(new Error('not_in_these_tests')),
      renameStep: () => Promise.reject(new Error('not_in_these_tests')),
      removeStep: () => Promise.reject(new Error('not_in_these_tests')),
      tree: () =>
        Promise.resolve(
          planRead({
            seq: 0,
            scheduleError: null,
            startDate: '2026-08-03',
            projectRevision: 0,
            slices: [
              sliceView({
                id: `w1::${DEV.id}`,
                workItemId: 'w1',
                stepId: DEV.id,
                personId: null,
                // Which floor binds moves with the edit, the way be-01's does: a
                // row with a not-before that pushed it is a slice bound by that
                // date, and it is the one floor whose sentence has words of its
                // own to carry.
                boundBy: floored ? ('notBefore' as const) : ('projectStart' as const),
                resourcePredecessorId: null,
                width: 1,
                effort: 3,
                capacityPredecessorIds: [],
                lateBy: null,
                ...scheduleNow(),
              }),
            ],
            steps: [DEV],
            assignedPeople: [],
            // Present and empty, never absent: be-01 always sends it, so a fake that
            // left it out would let `teamsOnThePlan` be handed `undefined` here and
            // never in production. A plan whose teams are unlimited is what `[]` says.
            teamCapacities: [],
            priorityBands: [...DEFAULT_PRIORITY_BANDS],
            estimateMethod: 'pert' as const,
            depReach: 'whole-item' as const,
            pertWeights: DEFAULT_PERT_WEIGHTS_VIEW,
            estimateRounding: 'ceil' as const,
            workItems: [
              workItemView({
                id: 'w1',
                parentId: null,
                revision: 0,
                number: '010',
                name: 'Strip',
                notes: '',
                frozenNumber: null,
                priority: null,
                rolledUp: false,
                estimates: {},
                dependsOn: [],
                finalDays: {},
                finalTotal: 0,
                startNoEarlierThan: floored ? '2026-08-10' : null,
                startNoEarlierThanReason: floored ? 'waiting on client sign-off' : null,
                serviceTeamId: null,
                teamIds: [],
                assignees: {},
                doesEveryStep: null,
                dates: null,
                schedule: scheduleNow(),
              }),
            ],
            undoable: false,
            redoable: false,
          }),
        ),
      createWorkItem: () => Promise.resolve({ id: 'w2' }),
      patchWorkItem: (_id: string, body: object) => {
        if ('startNoEarlierThan' in body) floored = body.startNoEarlierThan !== null;
        return Promise.resolve();
      },
      moveWorkItem: () => Promise.resolve(),
      removeWorkItem: () => Promise.resolve(),
      setEstimate: () => Promise.resolve(),
      clearEstimate: () => Promise.resolve(),
      freezeProject: () => Promise.resolve(),
      unfreezeProject: () => Promise.resolve(),
      unfreezeWorkItem: () => Promise.resolve(),
      addDependency: () => Promise.resolve(),
      removeDependency: () => Promise.resolve(),
      undo: () => Promise.reject(new Error('not_in_these_tests')),
      redo: () => Promise.reject(new Error('not_in_these_tests')),
    });
  };

  itDom('redraws the open chart when a not-before edit moves the schedule', async () => {
    render(<WbsTable projectId="p1" api={apiWithMovableFloor()} />);
    await waitFor(() => rowFor('010'));

    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const bar = () => document.querySelector('[data-gantt-bar]');
    expect(bar()?.getAttribute('data-start')).toBe('11');

    typeIntoNotBefore('010', '2026-08-10');

    // The chart is on screen the whole time, and the read that followed the
    // edit is what it must be drawing — a bar still on day 11 is the schedule
    // of a moment ago under a table already showing the new one.
    await waitFor(() => {
      expect(bar()?.getAttribute('data-start')).toBe('16');
    });
    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('16');
  });

  itDom('says on the bar why the date that holds it is there', async () => {
    // The wiring `not-before-reason` (#81) could not do from its own side: the
    // chart row is built in this file, and a `GanttRow` that carried no reason
    // left `floorWordsOf` appending nothing to a sentence it was already
    // printing. The words themselves are `gantt-geometry`'s and tested there.
    //
    // Proof: `notBeforeReason` dropped from `ganttPlan`'s row literal, this
    // fails on `expected 'Strip. 1 person. Held by its start-no-earlier-than
    // date' to contain 'Held by its start-no-earlier-than date — waiting on
    // client sign-off'`. Watched, 2026-08-18.
    render(<WbsTable projectId="p1" api={apiWithMovableFloor()} />);
    await waitFor(() => rowFor('010'));
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const bar = () => document.querySelector('[data-gantt-bar]');

    typeIntoNotBefore('010', '2026-08-10');

    await waitFor(() => {
      expect(bar()?.getAttribute('aria-label')).toContain(
        'Held by its start-no-earlier-than date — waiting on client sign-off',
      );
    });
  });
});

describe('what a keystroke costs the chart', () => {
  /**
   * Opening a row's menu changes `openMenuRowId` and nothing the chart reads.
   * The bars are placed from the tree be-01 last sent, which no menu touches.
   *
   * Before this was memoised the chart was laid out again anyway: `ganttPlan`
   * was an object literal rebuilt on every render, so `GanttPanel`'s
   * `useMemo(..., [plan])` saw a new object on every render of the table. The drawn bars are identical either way, which is exactly why no
   * rendering assertion can see this and a call count can.
   *
   * Counted around the gesture itself: the fault is a layout per render, and a
   * count read after a settle would be satisfied by any number at all.
   *
   * A Find keystroke is deliberately not the subject. That one narrows the shown
   * rows, so the chart is entitled to be laid out again — and `search.visibleIds`
   * is a fresh `Set` each time regardless, so the memo cannot hold across it.
   *
   * Proof: with `ganttPlan`'s `useMemo` taken back off — the object literal
   * built inline, as it was — watched failing on `expected 1 to be +0`
   * (2026-09-02).
   */
  itDom('does not lay the chart out again for a gesture that changes no bar', async () => {
    await planWithTheChartOpen();

    layoutCalls.count = 0;
    // Opening a row's ⋯ menu, which is `openMenuRowId` — a state of `WbsTable`,
    // so the whole table renders — and which cannot move a bar.
    //
    // Deliberately not a keystroke in a Name cell: that box is uncontrolled, so
    // typing into it re-renders nothing, and a probe built on it would pass with
    // the memo removed. Deliberately not a pointer on a bar either: since
    // `pointed-row-render-cost` that reading lives in an external store and does
    // not render the table at all. Both were tried.
    click('Actions for 010');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    expect(layoutCalls.count).toBe(0);
    // The precondition: a chart that had gone would also lay out zero times.
    expect(document.querySelector('[data-gantt-bar]')).not.toBeNull();
  });
});

describe('holding the chart to the row the table is showing', () => {
  /**
   * A plan be-01 could work no dates out for, which is what a circle of
   * dependencies gets back.
   *
   * The rows still arrive — the table draws them with dashes where the dates
   * would be — and it is the *chart* that becomes something else: a sentence
   * about the circle under the same `[data-gantt-panel]` a chart carries.
   */
  const circularApi = (): ProjectApi => {
    const api = fakeApi();
    return refusingApi({
      ...api,
      // A cycle takes the slices with it, the way be-01 sends it: there is no
      // schedule to have placed any.
      tree: (projectId) =>
        api
          .tree(projectId)
          .then((tree) => ({ ...tree, scheduleError: 'cycle' as const, slices: [] })),
    });
  };

  itDom('does not hold the chart to the table while the plan is a circle', async () => {
    // Found in cross-review, 2026-08-12, and by nothing else: the link is
    // installed on whatever answers `[data-gantt-panel]`, and on a cycle that
    // is the message rather than the chart. The message has no calendar axis,
    // `panelFace` refuses an element it cannot measure — and it does it inside
    // a scroll listener, where no React boundary is, so every scroll of the
    // frame threw for as long as the circle stood.
    //
    // Proof: the axis guard in `wbs-table.tsx` dropped — this failed on
    // `expected [ 'Error: the Gantt panel has no calendar axis to measure its
    // content top from' ] to deeply equal []`. Watched on h2puni, 2026-08-13.
    render(<WbsTable projectId="p1" api={circularApi()} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Gantt');

    const panel = document.querySelector('[data-gantt-panel]');
    // The state this is about: a panel, and not a chart.
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-gantt-axis]')).toBeNull();

    // A listener that throws does not throw at the dispatch — the browser
    // reports it to the window instead, which is exactly why this went
    // unnoticed. So that is where it is watched for.
    const reported: string[] = [];
    const onError = (event: ErrorEvent) => {
      reported.push(String(event.error ?? event.message));
    };
    window.addEventListener('error', onError);
    try {
      const frame = screen.getByRole('table').parentElement;
      if (frame === null) throw new Error('no table frame rendered');
      fireEvent.scroll(frame);
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(reported).toEqual([]);
  });
});

/**
 * Slice 9.0 — the host seam.
 *
 * The five marker props on `GanttPanel` are all **optional**, which is why this
 * suite exists as its own thing rather than as a line in section 8: the host
 * compiles perfectly well passing none of them, so every jsdom case in
 * `gantt-panel.test.tsx` can stay green while the running product draws no
 * marker at all and `listCalendarMarkers` has no caller. That is exactly the
 * state chunk 53 found the branch in, and it is what held 8.2a's browser tier
 * at `fixme`.
 *
 * So the assertions here are about the **wire**, not about the panel: the list
 * reaches the chart from `ProjectApi`, and each of the four writes reaches
 * `ProjectApi` back and is drawn from the answer rather than from a local
 * guess. Every case drives the real panel through the real table — a fixture
 * that handed the panel its props would be re-proving section 6 and would have
 * passed against the very gap this closes.
 */
describe('the calendar markers the host owns', () => {
  /**
   * A Monday, so offset 0 and offset 1 are both workdays.
   *
   * The three roots are three-day PERT siblings with no dependency between
   * them, so they run together from the start date and the horizon is short —
   * a marker parked several days out would be off the chart and 8.5 would
   * (correctly) draw nothing, which reads exactly like an unwired seam.
   */
  const MONDAY = '2026-08-10';

  /** The fake, already on a calendar: an undated plan refuses every mark (7.2). */
  const datedApi = async () => {
    const api = fakeApi();
    await api.setStartDate('p1', MONDAY);
    return api;
  };

  const cellAt = (offset: number): Element => {
    const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
    if (cell === null) throw new Error(`no axis cell at offset ${String(offset)}`);
    return cell;
  };

  const chip = (markerId: string): Element | null =>
    document.querySelector(`[data-marker-chip="${markerId}"]`);

  itDom('draws the markers the project is already holding', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });

    await planWithTheChartOpen(api);

    // The read is the half that has no gesture behind it: nothing on this
    // screen asked for these markers, so a host that only wired the writes
    // would fail here and nowhere else.
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });
    expect(chip('launch')?.textContent).toBe('Launch');
  });

  itDom('takes a saved composer to the api and draws the marker it answers with', async () => {
    const api = await datedApi();
    await planWithTheChartOpen(api);

    // Offset 1: a dated cell with nothing on it yet, so the click opens the
    // composer rather than the day sheet.
    fireEvent.click(cellAt(1));
    const composer = await screen.findByRole('dialog');
    const day = composer.getAttribute('data-composer-date');
    if (day === null) throw new Error('the composer named no day');
    fireEvent.change(screen.getByLabelText('Marker name'), { target: { value: 'Cutover' } });
    fireEvent.click(screen.getByLabelText(new RegExp('^Save the new calendar marker on ')));

    // The owner's store, not a call log: a host that reported the create and
    // dropped the answer would show the chip from its own guess and leave the
    // project holding nothing.
    await waitFor(() => {
      expect(api.markers.map((marker) => [marker.date, marker.name])).toEqual([[day, 'Cutover']]);
    });
    // `.at` and not `[0]`: this project has `noUncheckedIndexedAccess` off, so
    // the index signature is typed as always present and the guard below reads
    // as dead code to eslint.
    const created = api.markers.at(0);
    if (created === undefined) throw new Error('nothing was created');
    // Drawn under the **id be-01 answered with**, which is what says the chart
    // is showing the read and not the request.
    await waitFor(() => {
      expect(chip(created.id)?.textContent).toBe('Cutover');
    });
  });

  itDom('renames through the api, and redraws from the answer', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });
    await planWithTheChartOpen(api);
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });

    // A populated cell opens the sheet, which is where the three edits live.
    fireEvent.click(cellAt(0));
    fireEvent.click(await screen.findByLabelText('Rename Launch'));
    fireEvent.change(screen.getByLabelText('New name for Launch'), {
      target: { value: 'Go live' },
    });
    fireEvent.click(screen.getByLabelText('Save the new name for Launch'));

    await waitFor(() => {
      expect(api.markers.map((marker) => marker.name)).toEqual(['Go live']);
    });
    await waitFor(() => {
      expect(chip('launch')?.textContent).toBe('Go live');
    });
  });

  itDom('recolours through the api, and paints from the answer', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });
    await planWithTheChartOpen(api);
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });

    fireEvent.click(cellAt(0));
    fireEvent.click(await screen.findByLabelText('Recolour Launch'));
    fireEvent.click(screen.getByLabelText('teal for Launch'));

    // Its own call and not a second field on the rename, because be-01 refuses
    // a `PATCH` naming both — the seam has to keep them two.
    await waitFor(() => {
      expect(api.markers.map((marker) => marker.color)).toEqual(['#0386a5']);
    });
  });

  itDom('deletes through the api, and the chip goes with it', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });
    await planWithTheChartOpen(api);
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });

    fireEvent.click(cellAt(0));
    fireEvent.click(await screen.findByLabelText('Delete Launch'));

    await waitFor(() => {
      expect(api.markers).toEqual([]);
    });
    await waitFor(() => {
      expect(chip('launch')).toBeNull();
    });
  });

  itDom('draws a peer’s new marker on the event, without remounting', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });

    // The socket, as the table sees one: a `subscribe` that hands back the
    // frame handler. `WbsTable` owns the stream (`wbs-table.tsx`'s `subscribe`
    // prop) and `GanttPanel` has none at all, so a case that mounted the panel
    // would have no way to deliver this event.
    let notify: SubscriptionHandlers['onChange'] = () => {
      throw new Error('the table never subscribed');
    };
    await planWithTheChartOpen(api, (_projectId, handlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    });
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });

    // What a peer's write looks like from here: the project is holding a second
    // marker and nothing on this screen did it or knows about it.
    await api.createCalendarMarker('p1', { markerId: 'cutover', date: MONDAY, name: 'Cutover' });
    expect(chip('cutover')).toBeNull();

    // The cell the reader is in. Its identity is what says the frame was a
    // re-render and not a remount — a remounted table would build a new input
    // and take the caret out of a half-typed name with it.
    const nameCell = screen.getByLabelText('Name of 010');

    notify('calendar_markers_changed');

    // 9.1 counts the emissions be-01 sends. This is the half that makes the
    // content-free event worth sending: the frame carries no marker, so the
    // client has to go and read one.
    await waitFor(() => {
      expect(chip('cutover')?.textContent).toBe('Cutover');
    });
    expect(screen.getByLabelText('Name of 010')).toBe(nameCell);
  });
  itDom('installs held markers after a newer tree already installed', async () => {
    const api = await datedApi();
    let notify: SubscriptionHandlers['onChange'] = () => {
      throw new Error('not subscribed');
    };
    await planWithTheChartOpen(api, (_id, handlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    });
    let release!: (markers: Awaited<ReturnType<typeof api.listCalendarMarkers>>) => void;
    api.listCalendarMarkers = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    notify('calendar_markers_changed');
    api.rows[0].name = 'Marker tree arrived';
    notify('tree_replaced');
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Marker tree arrived');
    });
    release([{ id: 'covered', name: 'Covered marker', date: MONDAY, color: '#2563eb' }]);
    await waitFor(() => {
      expect(chip('covered')?.textContent).toBe('Covered marker');
    });
  });

  itDom('rereads a marker refused because a peer already deleted it', async () => {
    const api = await datedApi();
    await api.createCalendarMarker('p1', { markerId: 'launch', date: MONDAY, name: 'Launch' });
    await planWithTheChartOpen(api);
    await waitFor(() => {
      expect(chip('launch')).not.toBeNull();
    });
    fireEvent.click(cellAt(0));
    fireEvent.click(await screen.findByLabelText('Rename Launch'));
    await api.deleteCalendarMarker('p1', 'launch');
    fireEvent.change(screen.getByLabelText('New name for Launch'), {
      target: { value: 'Too late' },
    });
    fireEvent.click(screen.getByLabelText('Save the new name for Launch'));
    await waitFor(() => {
      expect(chip('launch')).toBeNull();
    });
    expect(document.querySelector('[data-toast-text]')?.textContent).toContain('no longer');
  });
});
