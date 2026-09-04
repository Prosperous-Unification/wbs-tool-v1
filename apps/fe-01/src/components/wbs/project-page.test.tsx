import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SavedPlanListEntryView } from '@/lib/saved-plan-api';
import type { CreatedProject, ProjectApi, ProjectListEntry } from '@/lib/wbs-api';
import { DEFAULT_PERT_WEIGHTS_VIEW } from '@/lib/wbs-api';
import { recordCalls } from '@/testing/record-calls';
import { refusingApi } from '@/testing/refusing-api';
import { planRead } from '@/testing/views';

import { ProjectPage } from './project-page';
import type { SavedPlansPanelDeps } from './saved-plans-panel';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * A ProjectApi over an in-memory project list. The table's methods answer
 * emptily rather than throwing: selecting a project renders a real WbsTable,
 * and these tests are about the page around it, not the table.
 */
function fakeProjects(
  initial: ProjectListEntry[],
): ProjectApi & { renamed: [string, string][]; opened: string[]; drop: (id: string) => void } {
  let projects = [...initial];
  const renamed: [string, string][] = [];
  const opened: string[] = [];
  return Object.assign(
    refusingApi({
      listProjects: () => Promise.resolve([...projects]),
      openProject(id) {
        opened.push(id);
        return Promise.resolve();
      },
      createProject(name) {
        const id = `p${String(projects.length + 1)}`;
        // Two shapes, as be-01 has them. The list gains a whole entry; the
        // response carries the project that was written and **no**
        // `lastOpenedAt` — an account's navigation history is not part of a row
        // that has just come into being, and typing it as the list's shape is
        // what let the page believe otherwise.
        projects = [
          ...projects,
          {
            id,
            name,
            restricted: false,
            startDate: null,
            lastOpenedAt: null,
            ownerName: 'kat',
            createdAt: MADE_ON,
          },
        ];
        const created: CreatedProject = { id, name, restricted: false };
        return Promise.resolve(created);
      },
      renameProject(id, name) {
        renamed.push([id, name]);
        projects = projects.map((p) => (p.id === id ? { ...p, name } : p));
        return Promise.resolve();
      },
      tree: () =>
        Promise.resolve(
          planRead({
            workItems: [],
            seq: -1,
            scheduleError: null,
            slices: [],
            steps: [],
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
            startDate: null,
            projectRevision: 0,
            undoable: false,
            redoable: false,
          }),
        ),
      setEstimateMethod: () => Promise.resolve(),
      setStartDate: () => Promise.resolve(),
      listTeams: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listWorkItemTypes: () => Promise.resolve([]),
      listExternalSystems: () => Promise.resolve([]),
      listServices: () => Promise.resolve([]),
      addTeam: () => Promise.reject(new Error('not_in_these_tests')),
      listPeople: () => Promise.resolve([]),
      addPerson: () => Promise.reject(new Error('not_in_these_tests')),
      assignPerson: () => Promise.reject(new Error('not_in_these_tests')),
      steps: () => Promise.resolve([]),
      addStep: () => Promise.reject(new Error('not_in_these_tests')),
      renameStep: () => Promise.reject(new Error('not_in_these_tests')),
      removeStep: () => Promise.reject(new Error('not_in_these_tests')),
      createWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      patchWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      moveWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      duplicateWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      removeWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      setEstimate: () => Promise.reject(new Error('not_in_these_tests')),
      clearEstimate: () => Promise.reject(new Error('not_in_these_tests')),
      freezeProject: () => Promise.reject(new Error('not_in_these_tests')),
      unfreezeProject: () => Promise.reject(new Error('not_in_these_tests')),
      unfreezeWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      addDependency: () => Promise.reject(new Error('not_in_these_tests')),
      removeDependency: () => Promise.reject(new Error('not_in_these_tests')),
      undo: () => Promise.reject(new Error('not_in_these_tests')),
      redo: () => Promise.reject(new Error('not_in_these_tests')),
    }),
    {
      renamed,
      opened,
      // A deletion that happened somewhere else: the next listProjects simply
      // no longer has the project.
      drop: (id: string) => {
        projects = projects.filter((p) => p.id !== id);
      },
    },
  );
}

/**
 * The first of June **this** year, as an epoch millisecond.
 *
 * Computed from the running year rather than pinned to a literal, because the
 * meta drops the year exactly when it matches today's — a fixed `2026-06-01`
 * would print `1 Jun` until the first of January and `1 Jun 2026` for ever
 * after, and every expectation in this file would go red on a date rather than
 * on a change. `shortInstant`'s own rule is proven in `short-date.test.ts`;
 * this file only needs a day it can name.
 */
const MADE_ON = new Date(new Date().getFullYear(), 5, 1, 12).getTime();

/** The same day next year, which is the side of the boundary that shows a year. */
const MADE_NEXT_YEAR = new Date(new Date().getFullYear() + 1, 5, 1, 12).getTime();

/** What the meta prints for {@link MADE_ON}: no year, because it is this one. */
const THIS_JUNE = '1 Jun';

const TWO: ProjectListEntry[] = [
  {
    id: 'p1',
    name: 'Rewire the shed',
    restricted: false,
    startDate: null,
    lastOpenedAt: null,
    ownerName: 'kat',
    createdAt: MADE_ON,
  },
  {
    id: 'p2',
    name: 'Paint the fence',
    restricted: false,
    startDate: null,
    lastOpenedAt: null,
    ownerName: 'strip',
    createdAt: MADE_ON,
  },
];

/** A third project, so a card can be asked to leave the options either side of it alone. */
const THREE: ProjectListEntry[] = [
  ...TWO,
  {
    id: 'p3',
    name: 'Sand the floor',
    restricted: false,
    startDate: null,
    lastOpenedAt: null,
    ownerName: 'kat',
    createdAt: MADE_ON,
  },
];

/** One saved plan, so a selected project's shelf has a row to show. */
const CHECKPOINT: SavedPlanListEntryView = {
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: MADE_ON,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

/**
 * The shelf's wiring, faked — handed to **every** render in this file.
 *
 * Not only to the case that asserts the panel: selecting a project mounts
 * `SavedPlansPanel`, and without an override it would build the real HTTP deps
 * and put a `fetch` at a relative URL into jsdom on any test that picks or
 * creates a project. The default is what production uses and this is what the
 * page around it is tested with, which is the same bargain `api` already makes
 * one prop up.
 */
const fakeSavedPlansDeps = (
  rows: readonly SavedPlanListEntryView[] = [CHECKPOINT],
): SavedPlansPanelDeps => ({
  available: () => Promise.resolve(true),
  list: () => Promise.resolve([...rows]),
  subscribe: () => ({ unsubscribe: () => undefined }),
  save: () => Promise.resolve({ outcome: 'saved', savedPlan: CHECKPOINT }),
  compare: () => Promise.resolve({ outcome: 'compared', diff: { input: [], schedule: [] } }),
  rename: () => Promise.resolve({ outcome: 'touched' }),
});

const pageWith = (api: ProjectApi, savedPlansDeps: SavedPlansPanelDeps = fakeSavedPlansDeps()) =>
  render(<ProjectPage token="t" api={api} savedPlansDeps={savedPlansDeps} />);

const picker = () => screen.getByLabelText<HTMLInputElement>('Project');

/**
 * The entries on offer, in the order the picker is showing them.
 *
 * Whole entries rather than bare names: the meta is **inside** the option, so
 * this is what somebody choosing reads and what a screen reader announces. An
 * assertion against the name alone would go green with the meta rendered
 * outside the option, which is the one place it must not be.
 */
const optionNames = () => screen.queryAllByRole('option').map((entry) => entry.textContent);

/** Opens the list — the picker offers everything when it takes the focus. */
function openPicker() {
  fireEvent.focus(picker());
}

/** Gives jsdom's open picker the rectangles a browser supplies. */
function layOutPicker(): HTMLElement {
  const list = screen.getByRole('listbox', { name: 'Projects' });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 200, 240);
  within(list)
    .getAllByRole('option')
    .forEach((option, index) => {
      option.getBoundingClientRect = () => new DOMRect(0, index * 24, 200, 20);
    });
  return list;
}

async function selectProject(id: string) {
  await waitFor(() => {
    expect(screen.getByLabelText('Project')).toBeDefined();
  });
  openPicker();
  await waitFor(() => {
    expect(document.getElementById(`project-option-${id}`)).not.toBeNull();
  });
  const entry = document.getElementById(`project-option-${id}`);
  if (entry === null) throw new Error(`no option for ${id}`);
  fireEvent.click(entry);
}

beforeEach(() => {
  localStorage.clear();
});

/**
 * Where the project controls are, and what they are called there.
 *
 * `H header-fits-a-row` moved every one of them into a `banner` and turned two
 * of them into icon buttons. Nothing in the repository asserted that the page
 * had a landmark, or that the two buttons kept their names — `Rename` and
 * `New project` were found by name in eleven places and named in none of them,
 * which is a contract every test depends on and no test states. These are the
 * assertions, written by the change that moved them, per `F
 * shadcn-foundation`'s rule.
 */
describe('the header bar', () => {
  itDom('puts the project controls in a banner', async () => {
    pageWith(fakeProjects(TWO));
    await selectProject('p2');

    const bar = screen.getByRole('banner');
    expect(bar.contains(picker())).toBe(true);
    expect(bar.contains(screen.getByRole('button', { name: 'Rename' }))).toBe(true);
    expect(bar.contains(screen.getByRole('button', { name: 'New project' }))).toBe(true);
  });

  itDom('gives the header the slots the app fills, in the bar itself', async () => {
    render(
      <ProjectPage
        token="t"
        api={fakeProjects(TWO)}
        presence={() => <p>who is here</p>}
        account={<button type="button">the account</button>}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    const bar = screen.getByRole('banner');
    expect(bar.contains(screen.getByText('who is here'))).toBe(true);
    expect(bar.contains(screen.getByRole('button', { name: 'the account' }))).toBe(true);
  });

  /**
   * The navigation reaches this page as a slot too, and lands in the bar.
   *
   * The mark on the page that is showing is `app-router.test.tsx`'s, because
   * `aria-current` is the router's answer and there is no router here. What
   * this asserts is the other half of the contract task 6.1 pins: the project
   * route renders its **own** header, and the shared navigation is on it beside
   * the project controls rather than hoisted into a root route above them.
   */
  itDom('carries the navigation beside the project controls', async () => {
    render(
      <ProjectPage
        token="t"
        api={fakeProjects(TWO)}
        nav={<nav aria-label="Pages">the two pages</nav>}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    const bar = screen.getByRole('banner');
    expect(bar.contains(screen.getByRole('navigation', { name: 'Pages' }))).toBe(true);
    expect(bar.contains(picker())).toBe(true);
  });

  itDom('hands the presence slot the roster, and an empty one before any socket', async () => {
    // The roster is a project's (F4): gw-01 scopes it by the project the socket
    // subscribed to. Until 2026-09-02 the slot was handed the **selection** and
    // the panel opened its own socket per project; the panel is presentational
    // now and this page owns the roster, because the stream that carries it is
    // the table's and this page renders both halves of the screen.
    //
    // Proof: `presence?.(roster)` in `project-page.tsx` put back to passing
    // `presence` straight through as a node. This test failed on
    // `expect(asked[0]).toEqual({ users: [], connected: false })` — `expected
    // undefined to deeply equal …`, the slot never called at all — and `gives
    // the header the slots the app fills` failed beside it on `Unable to find
    // an element with the text: who is here`, because a function React is
    // handed as a child renders nothing. Watched 2026-08-09, and again over the
    // roster 2026-09-02.
    const asked: { users: readonly string[]; connected: boolean }[] = [];
    render(
      <ProjectPage
        token="t"
        api={fakeProjects(TWO)}
        presence={(roster) => {
          asked.push(roster);
          return (
            <p>who is here: {roster.users.length === 0 ? 'nobody' : roster.users.join(', ')}</p>
          );
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    // Nothing has subscribed yet, and the honest roster for that is empty and
    // disconnected rather than a stale list under a new project's name.
    expect(asked[0]).toEqual({ users: [], connected: false });
    expect(screen.getByText('who is here: nobody')).toBeDefined();

    await selectProject('p2');

    expect(asked.at(-1)?.users).toEqual([]);
  });

  itDom('leaves the table out of the banner and in the page’s main', async () => {
    pageWith(fakeProjects(TWO));
    await selectProject('p2');

    // The half that says the landmark is a bar rather than the whole page: a
    // `<header>` wrapped around everything would satisfy the assertions above.
    const bar = screen.getByRole('banner');
    const grid = document.querySelector('[data-grid]');
    expect(grid).not.toBeNull();
    expect(bar.contains(grid)).toBe(false);
    expect(document.querySelector('main')?.contains(grid)).toBe(true);
  });
});

/**
 * Slice 9's prerequisite: every part of slice 8 was gated on its own and no
 * screen rendered any of it, so the suites were green over a feature that could
 * not be reached by clicking.
 */
describe('the saved-plan shelf is on the project page', () => {
  itDom('renders the shelf in the header once a project is open', async () => {
    pageWith(fakeProjects(TWO));

    // Before a project is picked there is no history to show — and no project
    // id to ask be-01 about, which is the honest reason the panel is absent
    // rather than empty.
    expect(screen.queryByText('Saved plans', { selector: 'summary' })).toBeNull();

    await selectProject('p2');

    /*
      The shelf is a disclosure in the app header's project row now, and closed
      is its rest state.

      **Four shapes, each killed by a measurement that already existed.** As an
      `mt-2 shrink-0` flex sibling it took ~76px off the one column that has to
      reach the bottom of the window, and four browser measurements failed at
      once (`header.spec.ts:272`/`:289`, `plan-surface.spec.ts:278`/`:318`).
      Floating it over `<main>`'s bottom-right paid that bill but landed on the
      chart's own controls (Gemini F-03 / Sol I4 on PR 202). The plan toolbar
      paid both — and spent a third budget nobody had put on the bill:
      `project-settings.spec.ts:77` holds `[data-toolbar]`'s children to 1265px
      with a named margin for exactly one more control, and `gantt.spec.ts:2605`
      needs that bar to be **one** row at 768 before the drag that adds `Reset
      layout` makes it two. Both went red at `14a1a070` (2 failed / 281 passed).
      The header's project row is the fourth and the settled one **above `md`**:
      `flex-nowrap` with a `max-w` picker that absorbs the width, outside
      `<main>` entirely. Below `md` it is the phone's `Plan actions` sheet
      instead, because the line this row takes there costs 36px that
      `mobile.spec.ts:850` cannot spare — the case below holds that half.

      jsdom lays nothing out, so those six measurements stay the real guard for
      the pixels. What this file can hold is where the chip lives, which is what
      the pixels follow from — so both halves are asserted: in the banner, and
      **not** in either copy of the toolbar. The negative is the load-bearing
      one; it is the shape that was red on CI.
    */
    const chip = await screen.findByText('Saved plans', { selector: 'summary' });
    const shelfDisclosure = chip.closest('details');
    expect(shelfDisclosure?.closest('[data-toolbar], [data-toolbar-sheet]')).toBeNull();
    expect(shelfDisclosure?.closest('header')).not.toBeNull();
    // Beside the project's own controls, in one row, rather than merely
    // somewhere in the bar: `New project` is the nearest of them and the only
    // one that is there whether a rename is armed or not.
    expect(
      within(shelfDisclosure?.parentElement ?? document.body).getByRole('button', {
        name: 'New project',
      }),
    ).toBeDefined();

    fireEvent.click(chip);

    const heading = await screen.findByRole('heading', { name: 'Saved plans' });
    // In the banner landmark, which is the half `main?.contains(heading)`
    // asserted until the chip left the plan column. A screen reader gets to
    // skip a banner, and the plan's history is chrome about the project rather
    // than part of the plan on screen.
    const banner = document.querySelector('header');
    expect(banner?.contains(heading)).toBe(true);
    expect(document.querySelector('main')?.contains(heading)).toBe(false);
    // Above the grid, not below it — the inverse of what this asserted while
    // the shelf floated at the bottom of `<main>`, and the assertion survived
    // three moves because document order is what a screen reader reads. The
    // panel opens over the plan rather than under it.
    const grid = document.querySelector('[data-grid]');
    if (grid === null) throw new Error('the table did not render');
    expect(
      grid.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeGreaterThan(0);
    // The shelf's own read landed, so this is the wired panel and not an empty
    // heading: `before the re-plan` is the row the fake answers with.
    //
    // Scoped to the list, and the ambiguity is the evidence. Unscoped this
    // failed on `Found multiple elements with the text: /before the re-plan/` —
    // the row **and** the comparison's side name, which is the whole panel
    // wired rather than a heading with a list under it.
    const shelf = await screen.findByRole('list', { name: 'Saved plans' });
    expect(within(shelf).getByText('before the re-plan')).toBeDefined();
  });

  itDom('closes the shelf when a pointer goes down outside it', async () => {
    /*
      The regression this exists for, and it shipped once.

      `useClosedByPointerOutside` reads its ref **once**, in a `useEffect` with
      an empty dependency list, so the hook has to mount in the same commit as
      the `<details>` it is handed. Held on `ProjectPage` — which renders first
      with no project selected and so no shelf — `panel.current` was `null` when
      the effect ran, it returned early, and the `pointerdown` listener was never
      registered: the panel could only be closed from its own chip and otherwise
      floated over the plan for good. Gemini's F-01 on PR 202, and the fix is
      `SavedPlanShelf` owning the hook.

      Watched failing 2026-09-04, h2puni, `dirty=0` apart from the one file:
      `project-page.tsx` restored to `4bd9e95b` (the hook hoisted onto
      `ProjectPage`) under this file at `956265a6` fails right here, at
      `expect(disclosure.open).toBe(false)` — 1 failed, 46 skipped of 47. So the
      case is bound to the fault and not to the fix.
    */
    pageWith(fakeProjects(TWO));
    await selectProject('p2');

    const chip = await screen.findByText('Saved plans', { selector: 'summary' });
    const disclosure = chip.closest('details');
    if (disclosure === null) throw new Error('the chip is not inside a disclosure');

    fireEvent.click(chip);
    expect(disclosure.open).toBe(true);

    // Capture-phase `pointerdown` on the document is what the hook listens for,
    // so that is what this fires — a `click` would prove nothing about it.
    fireEvent.pointerDown(document.body);
    expect(disclosure.open).toBe(false);
  });

  itDom('does not compare the new project against the old project’s checkpoint', async () => {
    /*
      The `key={selected}` on the panel, asserted from the outside.

      The panel pins its compare pair once, in `useState`, so that a
      collaborator's save cannot re-point a picker the reader left alone
      (AC #4). Carried across a project switch that same pin is a saved-plan id
      belonging to the project just left, and the compare effect — which *does*
      re-run, because `projectId` is in its dependencies — would then ask be-01
      to compare the new project against a checkpoint that is not in it.

      Asserted on `compare`'s arguments and not on `list`'s: the shelf re-reads
      on a project change by itself, so a `list` assertion goes green with the
      key deleted. Measured — with `key={selected}` removed the whole file still
      passed 46/46 on the `list` form, and this form fails on `expected 'sp1'
      to be 'sp9'`.
    */
    const OTHER: SavedPlanListEntryView = { ...CHECKPOINT, id: 'sp9', name: 'the other project’s' };
    const compared: [string, unknown][] = [];
    const deps: SavedPlansPanelDeps = {
      ...fakeSavedPlansDeps(),
      list: (projectId: string) => Promise.resolve([projectId === 'p2' ? CHECKPOINT : OTHER]),
      compare: (projectId, left) => {
        compared.push([projectId, left]);
        return Promise.resolve({ outcome: 'compared', diff: { input: [], schedule: [] } });
      },
    };
    pageWith(fakeProjects(TWO), deps);

    await selectProject('p2');
    await waitFor(() => {
      expect(compared).toContainEqual(['p2', { saved: 'sp1' }]);
    });

    await selectProject('p1');
    await waitFor(() => {
      expect(compared.some(([projectId]) => projectId === 'p1')).toBe(true);
    });
    // Every question asked about p1 is asked about p1's own checkpoint. Not
    // just the last one: a stale pair asked once and corrected is still a read
    // of somebody else's plan.
    for (const [projectId, left] of compared) {
      if (projectId === 'p1') expect(left).toEqual({ saved: 'sp9' });
    }
  });

  itDom('leaves the header alone on a cards viewport, where the sheet has it', async () => {
    /*
      **The one pixel red slice 9 ended on, held as a placement rule.**

      `mobile.spec.ts:850` asks the card sheet's trigger to be above the sheet
      it opens, and at `5e59b29d` it was 13.39px below it. Measured on h2puni
      rather than argued: the `85vh` cap puts the sheet's top at 126.6 on a
      390×844 phone, a card's trigger sits 55px under `[data-plan-cards]`'s own
      top edge at the scroll ceiling, and that scroller started at 195 — so the
      goal was unreachable and the shelf's line in the header was 36 of the
      missing 21.4px. Off that row the header measured 137 → 101 and the
      scroller 195 → 159.

      jsdom lays nothing out, so this cannot assert those numbers. What it can
      assert is the fact they follow from, which is also the thing a later edit
      would silently undo: below the renderer's breakpoint the header carries no
      shelf — and with the sheet shut there is **no shelf in the document at
      all**, which is what tells a mount apart from a `hidden md:block` pair
      that leaves a second copy in the DOM for every `[data-saved-plans]`
      selector to find. `plan-cards.test.tsx` holds the other half, that the
      sheet is where it went.
    */
    const wide = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    try {
      pageWith(fakeProjects(TWO));
      await selectProject('p2');

      // The project's own controls are still there — this is the shelf leaving
      // the row, not the row leaving the header.
      expect(screen.getByRole('button', { name: 'New project' }).closest('header')).not.toBeNull();
      expect(document.querySelectorAll('header [data-saved-plans]')).toHaveLength(0);
      expect(document.querySelectorAll('[data-saved-plans]')).toHaveLength(0);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: wide, configurable: true });
    }
  });
});

describe('the chosen project survives a refresh', () => {
  itDom('selects the remembered project on the next load, with no click', async () => {
    pageWith(fakeProjects(TWO));
    await selectProject('p2');
    expect(picker().value).toBe('Paint the fence');

    cleanup();
    pageWith(fakeProjects(TWO));

    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
  });

  itDom('ignores a remembered project the list no longer has, and forgets it', async () => {
    localStorage.setItem('wbs.project', 'gone');
    const api = fakeProjects(TWO);
    // What the guard prevents is the table asking be-01 for the deleted
    // project's tree.
    const asked = recordCalls(api, 'tree', (projectId) => projectId);
    pageWith(api);

    await waitFor(() => {
      expect(localStorage.getItem('wbs.project')).toBeNull();
    });
    expect(picker().value).toBe('');
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('an entry says who owns it and when it was made', () => {
  itDom('tells two projects of one name apart by their owners', async () => {
    // The whole reason the meta exists. Two entries reading `Rewire the shed`
    // and nothing else are one project offered twice as far as anybody
    // choosing can tell — by eye and, because the meta is inside the option, by
    // screen reader.
    pageWith(
      fakeProjects([
        { ...TWO[0], id: 'p1', name: 'Rewire the shed', ownerName: 'kat' },
        { ...TWO[0], id: 'p2', name: 'Rewire the shed', ownerName: 'strip' },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();

    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });
    // By accessible name, not by textContent: the claim is that the two are
    // distinguishable to the accessibility tree, and a meta rendered as a
    // `title` or an adjacent sibling would pass a text assertion and fail this.
    expect(screen.getByRole('option', { name: `Rewire the shed (kat · ${THIS_JUNE})` }).id).toBe(
      'project-option-p1',
    );
    expect(screen.getByRole('option', { name: `Rewire the shed (strip · ${THIS_JUNE})` }).id).toBe(
      'project-option-p2',
    );
  });

  itDom('carries the year only when it is not this one', async () => {
    // Both sides of `shortInstant`'s boundary, because the entry must not
    // reimplement the rule — a meta that always printed the year, or never
    // did, passes a one-sided check. The rule itself is proven in
    // `short-date.test.ts`; this asserts the picker asks the right formatter.
    pageWith(
      fakeProjects([
        { ...TWO[0], id: 'p1', name: 'This year', createdAt: MADE_ON },
        { ...TWO[0], id: 'p2', name: 'Next year', createdAt: MADE_NEXT_YEAR },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();

    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });
    const nextYear = String(new Date().getFullYear() + 1);
    expect(optionNames()).toEqual([
      `This year (kat · ${THIS_JUNE})`,
      `Next year (kat · ${THIS_JUNE} ${nextYear})`,
    ]);
  });
});

describe('the picker searches', () => {
  itDom('narrows the list to what was typed, ignoring case', async () => {
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames()).toEqual([
        `Rewire the shed (kat · ${THIS_JUNE})`,
        `Paint the fence (strip · ${THIS_JUNE})`,
      ]);
    });

    fireEvent.change(picker(), { target: { value: 'FENCE' } });

    expect(optionNames()).toEqual([`Paint the fence (strip · ${THIS_JUNE})`]);
  });

  itDom('matches the name alone — an owner’s username offers nothing', async () => {
    // The recorded non-goal, on the page rather than only on the pure
    // function: the meta is on screen and in the accessible name, and typing
    // what it says must still narrow by name. `strip` owns `Paint the fence`
    // and names no project.
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });

    fireEvent.change(picker(), { target: { value: 'strip' } });

    expect(optionNames()).toEqual([]);
  });

  itDom('chooses with the keyboard alone, and shows that project’s table', async () => {
    const api = fakeProjects(TWO);
    const asked = recordCalls(api, 'tree', (projectId) => projectId);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });

    fireEvent.keyDown(picker(), { key: 'ArrowDown' });
    fireEvent.keyDown(picker(), { key: 'ArrowDown' });
    fireEvent.keyDown(picker(), { key: 'Enter' });

    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
    expect(asked).toEqual(['p2']);
  });

  itDom('offers be-01’s order rather than sorting the names itself', async () => {
    // be-01 answers in this account's recency order. `Paint` before `Rewire` is
    // not alphabetical and not the id order — a client that re-sorted by either
    // would show these two the other way round.
    pageWith(
      fakeProjects([
        {
          id: 'p2',
          name: 'Paint the fence',
          restricted: false,
          startDate: null,
          lastOpenedAt: 900,
          ownerName: 'strip',
          createdAt: MADE_ON,
        },
        {
          id: 'p1',
          name: 'Rewire the shed',
          restricted: false,
          startDate: null,
          lastOpenedAt: null,
          ownerName: 'kat',
          createdAt: MADE_ON,
        },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();

    await waitFor(() => {
      expect(optionNames()).toEqual([
        `Paint the fence (strip · ${THIS_JUNE})`,
        `Rewire the shed (kat · ${THIS_JUNE})`,
      ]);
    });
  });

  itDom('an Enter with nothing highlighted picks nothing', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });

    fireEvent.keyDown(picker(), { key: 'Enter' });

    expect(picker().value).toBe('');
    expect(api.opened).toEqual([]);
  });

  itDom('Escape closes the list without choosing', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });

    fireEvent.keyDown(picker(), { key: 'ArrowDown' });
    fireEvent.keyDown(picker(), { key: 'Escape' });

    expect(optionNames()).toEqual([]);
    expect(api.opened).toEqual([]);
  });
});

describe('creating a project', () => {
  itDom('selects what was created, from a response carrying no last-opened time', async () => {
    // The create route answers with the project it wrote and nothing about
    // this account's history — `CreatedProject` is that shape, and the fixture
    // above returns exactly it. The page must still select the new project by
    // id and show its name, which is all it ever read of that response.
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    // The name field stands in place of the picker while the rename a create
    // arms is open; leaving it is what shows the picker the selection.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Project name').value).toBe('New project');
    });
    fireEvent.keyDown(screen.getByLabelText('Project name'), { key: 'Escape' });
    expect(picker().value).toBe('New project');
    // And it was opened, which is what sorts the picker next time — the
    // recording is driven by the selection, so a create that failed to select
    // would record nothing.
    expect(api.opened).toContain('p3');
    expect(localStorage.getItem('wbs.project')).toBe('p3');
  });
});

describe('opening a project is recorded', () => {
  itDom('records the project that was picked', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    await waitFor(() => {
      expect(api.opened).toEqual(['p2']);
    });
  });

  itDom('records the project restored from a previous visit', async () => {
    // The commonest arrival of all. Recording only on the click would leave
    // the projects people return to most looking never-opened, and the
    // ordering would drift by exactly those.
    localStorage.setItem('wbs.project', 'p1');
    const api = fakeProjects(TWO);
    pageWith(api);

    await waitFor(() => {
      expect(api.opened).toEqual(['p1']);
    });
  });

  itDom('shows no error when recording fails', async () => {
    const api = fakeProjects(TWO);
    api.openProject = () => Promise.reject(new Error('offline'));
    pageWith(api);
    await selectProject('p2');

    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
    // Navigation history nobody can act on: the project still opened.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('renaming a project', () => {
  itDom('commits on Enter and shows the new name, still selected', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    expect(name.value).toBe('Paint the fence');
    fireEvent.change(name, { target: { value: 'Stain the fence' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    await waitFor(() => {
      expect(picker().value).toBe('Stain the fence');
    });
    expect(api.renamed).toEqual([['p2', 'Stain the fence']]);
  });

  itDom('cancels on Escape without a request', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    fireEvent.change(name, { target: { value: 'Never this' } });
    fireEvent.keyDown(name, { key: 'Escape' });

    expect(api.renamed).toEqual([]);
    expect(screen.queryByLabelText('Project name')).toBeNull();
    expect(picker().value).toBe('Paint the fence');
  });

  itDom('shows be-01’s refusal and keeps the old name', async () => {
    const api = fakeProjects(TWO);
    api.renameProject = () => Promise.reject(new Error('forbidden'));
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    fireEvent.change(name, { target: { value: 'Not allowed' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('forbidden');
    });
    // The draft survives the refusal — a `forbidden` must not eat what was
    // typed. Without this the test passed with a catch that closed the input.
    expect(screen.getByLabelText<HTMLInputElement>('Project name').value).toBe('Not allowed');
    // And the project is still called what it was called. This used to read
    // the "Working in …" line, which `H header-fits-a-row` removed with the
    // rest of the stacked chrome; the picker is where a project's name is
    // shown now, and it shows it the moment the rename mode ends. Same claim,
    // one keystroke later, against the control that carries it today.
    fireEvent.keyDown(screen.getByLabelText('Project name'), { key: 'Escape' });
    expect(picker().value).toBe('Paint the fence');
  });

  itDom('commits on blur when the name changed', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    fireEvent.change(name, { target: { value: 'Stain the fence' } });
    fireEvent.blur(name);

    await waitFor(() => {
      expect(picker().value).toBe('Stain the fence');
    });
    expect(api.renamed).toEqual([['p2', 'Stain the fence']]);
  });

  itDom('a blur that changed nothing cancels without a request', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.blur(screen.getByLabelText('Project name'));

    expect(api.renamed).toEqual([]);
    expect(screen.queryByLabelText('Project name')).toBeNull();
    expect(picker().value).toBe('Paint the fence');
  });

  itDom('an emptied draft cancels rather than blanking the name', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(api.renamed).toEqual([]);
    expect(screen.queryByLabelText('Project name')).toBeNull();
    expect(picker().value).toBe('Paint the fence');
  });
});

describe('the selection is a claim too', () => {
  itDom('a selected project deleted elsewhere is dropped on the next list load', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    // p2 vanishes behind our back; the next load is triggered by a rename
    // commit, which is one of the two paths that refetch the list.
    api.drop('p2');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText<HTMLInputElement>('Project name');
    fireEvent.change(name, { target: { value: 'Too late' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    // The one project left is auto-selected — the read-back is 'p1', which a
    // held-forever 'p2' cannot produce (it would read back '').
    await waitFor(() => {
      expect(picker().value).toBe('Rewire the shed');
    });
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDefined();
  });
});

describe('the hover card follows the list, not a stale pointer', () => {
  itDom(
    'remeasures the fixed card when its scrolling list moves the option underneath it',
    async () => {
      pageWith(fakeProjects(TWO));
      await waitFor(() => {
        expect(screen.getByLabelText('Project')).toBeDefined();
      });
      openPicker();
      const list = await screen.findByRole('listbox', { name: 'Projects' });
      await waitFor(() => {
        expect(within(list).queryAllByRole('option').length).toBe(2);
      });
      list.getBoundingClientRect = () => new DOMRect(0, 0, 200, 240);

      const option = document.getElementById('project-option-p2');
      if (option === null) throw new Error('the second project is not offered');
      let optionTop = 20;
      option.getBoundingClientRect = () => new DOMRect(10, optionTop, 120, 10);
      fireEvent.mouseEnter(option);
      // The option's own top, not its bottom plus a gap: the card opens
      // *beside* the list now, on the row it describes.
      await waitFor(() => {
        expect(screen.getByRole('tooltip', { name: 'Paint the fence' }).style.top).toBe('20px');
      });

      optionTop = 100;
      fireEvent.scroll(list);

      await waitFor(() => {
        expect(screen.getByRole('tooltip', { name: 'Paint the fence' }).style.top).toBe('100px');
      });
    },
  );

  itDom('hides the card when scrolling takes its option outside the visible listbox', async () => {
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    const list = await screen.findByRole('listbox', { name: 'Projects' });
    list.getBoundingClientRect = () => new DOMRect(0, 0, 200, 60);
    const option = document.getElementById('project-option-p2');
    if (option === null) throw new Error('the second project is not offered');
    let optionTop = 20;
    option.getBoundingClientRect = () => new DOMRect(10, optionTop, 120, 10);
    fireEvent.mouseEnter(option);
    expect(await screen.findByRole('tooltip', { name: 'Paint the fence' })).toBeDefined();

    optionTop = 80;
    fireEvent.scroll(list);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('remeasures during list scroll without rerendering the project page', async () => {
    let pageRenders = 0;
    render(
      <ProjectPage
        token="t"
        api={fakeProjects(TWO)}
        presence={() => {
          pageRenders += 1;
          return null;
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    const list = await screen.findByRole('listbox', { name: 'Projects' });
    list.getBoundingClientRect = () => new DOMRect(0, 0, 200, 240);
    const option = document.getElementById('project-option-p2');
    if (option === null) throw new Error('the second project is not offered');
    let optionTop = 20;
    option.getBoundingClientRect = () => new DOMRect(10, optionTop, 120, 10);
    fireEvent.mouseEnter(option);
    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: 'Paint the fence' }).style.top).toBe('20px');
    });
    const rendersBeforeScroll = pageRenders;

    optionTop = 40;
    fireEvent.scroll(list);

    await waitFor(() => {
      expect(screen.getByRole('tooltip', { name: 'Paint the fence' }).style.top).toBe('40px');
    });
    expect(pageRenders).toBe(rendersBeforeScroll);
  });

  itDom(
    'shows the card for the entry the pointer rests on, then nothing stale after Escape and reopen',
    async () => {
      pageWith(fakeProjects(TWO));
      await waitFor(() => {
        expect(screen.getByLabelText('Project')).toBeDefined();
      });
      openPicker();
      await waitFor(() => {
        expect(optionNames().length).toBe(2);
      });
      layOutPicker();

      // Hover the second project.
      fireEvent.mouseEnter(document.getElementById('project-option-p2')!);
      expect(await screen.findByRole('tooltip', { name: 'Paint the fence' })).toBeDefined();

      // Close with Escape while the pointer remains over p2 — the options
      // unmount, so no mouseleave fires and the pointer id would linger.
      fireEvent.keyDown(picker(), { key: 'Escape' });
      expect(optionNames()).toEqual([]);

      // Reopen by keyboard: the card must not show the stale pointer's project.
      openPicker();
      await waitFor(() => {
        expect(optionNames().length).toBe(2);
      });
      layOutPicker();
      expect(screen.queryByRole('tooltip')).toBeNull();

      // The card now follows the keyboard highlight, never the old pointer.
      fireEvent.keyDown(picker(), { key: 'ArrowDown' });
      expect(await screen.findByRole('tooltip', { name: 'Rewire the shed' })).toBeDefined();
      expect(screen.queryByRole('tooltip', { name: 'Paint the fence' })).toBeNull();
    },
  );

  itDom('does not leave the just-chosen project’s card showing on the next open', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    openPicker();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });
    layOutPicker();

    fireEvent.mouseEnter(document.getElementById('project-option-p2')!);
    expect(await screen.findByRole('tooltip', { name: 'Paint the fence' })).toBeDefined();

    // Choosing unmounts the options without a mouseleave, then closes.
    fireEvent.click(document.getElementById('project-option-p2')!);
    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });

    openPicker();
    const list = await screen.findByRole('listbox', { name: 'Projects' });
    await waitFor(() => {
      expect(within(list).queryAllByRole('option').length).toBe(2);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

/**
 * How far an option's box is inset from the listbox's own, in px.
 *
 * The `<ul>` has a 1px border and `p-1`, so an option's rectangle is five
 * pixels inside the list's on each side. It is stubbed here rather than left
 * equal because that inset is the **only** measurable difference between a
 * card anchored to the list and one anchored to the option: every option in a
 * one-column `w-full` list shares its width, so a per-option anchor cannot
 * produce two different lefts, and a stub that gave both the same box could
 * not see the two apart at all.
 */
const OPTION_INSET = 5;

/** How tall a stubbed option row is, in px. */
const OPTION_ROW = 24;

/** The clear air the placement keeps between the card and the list, in px. */
const CARD_GAP = 6;

/**
 * What jsdom reports for the hover card's own box while these tests run.
 *
 * jsdom measures every element as 0×0, and a card with no width can neither
 * run out of room on the right nor cover anything on the left — which is both
 * of the placements this suite is about. `G gantt-calendar-axis`'s sixteenth
 * fault is a measurement taken against something with no size; each test below
 * asserts this is non-zero before it believes an overlap.
 */
const CARD_WIDTH = 300;

/** How tall the stubbed card is. Only the placement's vertical clamp reads it. */
const CARD_HEIGHT = 90;

/**
 * jsdom's own measurement, restored after each test in this suite.
 *
 * Referenced unbound on purpose and called with `.call(this)` below: this is
 * the prototype method the stub stands in front of, and binding it to one
 * element would measure that element for every node asking.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- see above; every call site supplies its own `this`.
const measureElement = HTMLElement.prototype.getBoundingClientRect;

/** jsdom's own window width, restored after each test in this suite. */
const WINDOW_WIDTH = window.innerWidth;

function resizeWindow(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

/**
 * Lays the open listbox out where a browser would put it, options inset.
 *
 * Returns the list's own edges, which is what the card is asserted against —
 * reading them back rather than restating the numbers keeps each assertion
 * about the relation rather than about two literals that happen to agree.
 */
function layOutPickerAt(box: { left: number; width: number }): { left: number; right: number } {
  const list = screen.getByRole('listbox', { name: 'Projects' });
  list.getBoundingClientRect = () => new DOMRect(box.left, 0, box.width, 240);
  within(list)
    .getAllByRole('option')
    .forEach((option, index) => {
      option.getBoundingClientRect = () =>
        new DOMRect(
          box.left + OPTION_INSET,
          index * OPTION_ROW,
          box.width - 2 * OPTION_INSET,
          OPTION_ROW,
        );
    });
  return { left: box.left, right: box.left + box.width };
}

/** Rests the pointer on a project's option, by the id the listbox gives it. */
function pointAt(id: string): void {
  const option = document.getElementById(`project-option-${id}`);
  if (option === null) throw new Error(`no option for ${id}`);
  fireEvent.mouseEnter(option);
}

/** Opens the picker on `projects` and waits for every one of them to be offered. */
async function openPickerOn(projects: ProjectListEntry[]): Promise<void> {
  pageWith(fakeProjects(projects));
  await waitFor(() => {
    expect(screen.getByLabelText('Project')).toBeDefined();
  });
  openPicker();
  await waitFor(() => {
    expect(optionNames().length).toBe(projects.length);
  });
}

describe('the card opens beside the list, not over it', () => {
  beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      // The card alone: everything else keeps jsdom's zeroes, or the stubs
      // `layOutPickerAt` installs on the list and its options.
      if (this.getAttribute('role') === 'tooltip') {
        return new DOMRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
      }
      return measureElement.call(this);
    };
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = measureElement;
    resizeWindow(WINDOW_WIDTH);
  });

  itDom('the open card leaves every option visible', async () => {
    await openPickerOn(THREE);
    const list = layOutPickerAt({ left: 40, width: 200 });

    pointAt('p2');

    const card = await screen.findByRole('tooltip', { name: 'Paint the fence' });
    const cardLeft = Number.parseFloat(card.style.left);
    // Or the card has no rectangle, covers nothing whatever it is placed over,
    // and every assertion under this one is green by default.
    expect(CARD_WIDTH, 'a card of no width cannot cover the list').toBeGreaterThan(0);
    expect(
      cardLeft,
      `the card opens at ${card.style.left} in a list ending at ${String(list.right)}`,
    ).toBeGreaterThanOrEqual(list.right);
    // And every option — the two being compared as much as the one being read
    // — ends before the card begins.
    const optionRights = screen
      .getAllByRole('option')
      .map((option) => option.getBoundingClientRect().right);
    expect(optionRights).toHaveLength(3);
    expect(Math.max(...optionRights)).toBeLessThanOrEqual(cardLeft);
  });

  itDom('a narrow window flips the card to the left of the list', async () => {
    await openPickerOn(TWO);
    resizeWindow(700);
    const list = layOutPickerAt({ left: 400, width: 200 });

    pointAt('p2');

    const card = await screen.findByRole('tooltip', { name: 'Paint the fence' });
    await waitFor(() => {
      expect(Number.parseFloat(card.style.left)).toBeLessThan(list.left);
    });
    expect(CARD_WIDTH, 'a card of no width cannot cover the list').toBeGreaterThan(0);
    // The whole card, not only its left edge: a clamp back into the viewport
    // would put its right edge over the list, which is the failure the flip
    // exists to avoid.
    const cardRight = Number.parseFloat(card.style.left) + CARD_WIDTH;
    expect(
      cardRight,
      `the flipped card ends at ${String(cardRight)}, over a list starting at ${String(list.left)}`,
    ).toBeLessThanOrEqual(list.left);
  });

  itDom('a window with room on neither side shows no card', async () => {
    await openPickerOn(TWO);
    resizeWindow(500);
    layOutPickerAt({ left: 100, width: 200 });

    pointAt('p2');

    // A card that must cover the list to exist has no claim on the space.
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  itDom('moving down the list does not move the card sideways', async () => {
    await openPickerOn(THREE);
    const list = layOutPickerAt({ left: 40, width: 200 });

    pointAt('p1');
    const first = await screen.findByRole('tooltip', { name: 'Rewire the shed' });
    const firstPlacement = { left: first.style.left, top: first.style.top };

    pointAt('p3');

    const third = await screen.findByRole('tooltip', { name: 'Sand the floor' });
    // Sideways: unchanged, and at the **list's** edge rather than the option's
    // — the two are five pixels apart, which is what an anchor taken from the
    // option's own box would read instead.
    expect(third.style.left).toBe(firstPlacement.left);
    expect(third.style.left).toBe(`${String(list.right + CARD_GAP)}px`);
    // Vertically: it followed the pointer, or the assertion above is about a
    // card that never moved at all.
    expect(Number.parseFloat(third.style.top)).toBeGreaterThan(
      Number.parseFloat(firstPlacement.top),
    );
  });
});

describe('a pick leaves the picker at rest', () => {
  itDom('choosing a project takes the focus off the picker', async () => {
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    // A real focus, not a dispatched `focus` event: `document.activeElement`
    // is the whole claim here, and `fireEvent.focus` moves nothing at all —
    // the assertion below would then hold with the blur deleted, which is the
    // vacuous check this file exists to avoid.
    picker().focus();
    await waitFor(() => {
      expect(optionNames().length).toBe(2);
    });
    expect(document.activeElement, 'the picker never took the focus').toBe(picker());

    fireEvent.click(document.getElementById('project-option-p2')!);

    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
    // Nothing focuses an option — the list's mousedown is prevented so the
    // click can land — so without the blur the combobox keeps the keyboard,
    // showing the project's name with a caret in it.
    expect(document.activeElement).not.toBe(picker());
  });

  itDom('choosing a project arms no rename', async () => {
    pageWith(fakeProjects(TWO));
    await selectProject('p2');

    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
    expect(screen.queryByLabelText('Project name')).toBeNull();
    // The rename is reachable, and only through its own control.
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDefined();
  });

  itDom('the picker still searches after a pick', async () => {
    pageWith(fakeProjects(TWO));
    await selectProject('p2');
    await waitFor(() => {
      expect(picker().value).toBe('Paint the fence');
    });
    // At rest it is a label of what is open, which is what `readOnly` says.
    expect(picker().readOnly).toBe(true);

    picker().focus();

    // Scoped to the picker's own list: a selected project renders the table,
    // and the table has options of its own.
    const offered = () =>
      within(screen.getByRole('listbox', { name: 'Projects' }))
        .queryAllByRole('option')
        .map((entry) => entry.textContent);
    await waitFor(() => {
      expect(offered().length).toBe(2);
    });
    // And it is a search box again the moment it has the focus, in the same
    // commit that opened the list.
    expect(picker().readOnly).toBe(false);
    fireEvent.change(picker(), { target: { value: 'FENCE' } });
    expect(offered()).toEqual([`Paint the fence (strip · ${THIS_JUNE})`]);
    expect(picker().value).toBe('FENCE');
  });
});

describe('a new project opens with its name ready to be typed', () => {
  itDom('creating a project puts the caret in its name', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    const name = await screen.findByLabelText<HTMLInputElement>('Project name');
    expect(name.value).toBe('New project');
    expect(document.activeElement).toBe(name);
    // And it was selected and opened, which is what sorts the picker next
    // time — both are driven by the selection, so a create that failed to
    // select would record nothing.
    expect(api.opened).toContain('p3');
    expect(localStorage.getItem('wbs.project')).toBe('p3');
  });

  itDom('does not put the whole draft back under the next keystroke', async () => {
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const name = await screen.findByLabelText<HTMLInputElement>('Project name');

    fireEvent.change(name, { target: { value: 'A' } });

    // The selection is armed once, when the rename is armed — not on every
    // render. Re-selected after each keystroke, the second character typed
    // would replace the first and the field could never hold two.
    expect([name.selectionStart, name.selectionEnd]).toEqual([1, 1]);
  });

  itDom('creating a project selects the whole placeholder name', async () => {
    pageWith(fakeProjects(TWO));
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    const name = await screen.findByLabelText<HTMLInputElement>('Project name');
    // Selected rather than emptied: `commitOrCancelRename` reads an empty
    // draft as a cancel, so an empty box would answer Enter with a project
    // still called `New project` and no explanation. Selected, the first
    // keystroke replaces it and an untouched Enter is a no-op rename.
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'New project'.length]);
  });

  itDom('arms the rename only once the list can name the new project', async () => {
    const api = fakeProjects(TWO);
    const listProjects = api.listProjects.bind(api);
    let releaseList: () => void = () => undefined;
    let listCalls = 0;
    // The page's own first load answers at once; the create's reload is held,
    // which is the window the fault lives in. Armed before `await load()`, the
    // name field is on screen for a project the picker cannot yet name — and
    // an Enter there compares the draft against no current name at all and
    // sends a rename for the name the row already has.
    api.listProjects = async () => {
      listCalls += 1;
      if (listCalls > 1) {
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
      }
      return listProjects();
    };
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    await waitFor(() => {
      expect(listCalls).toBe(2);
    });
    expect(screen.queryByLabelText('Project name')).toBeNull();

    releaseList();

    expect(await screen.findByLabelText<HTMLInputElement>('Project name')).toBeDefined();
  });

  itDom('a draft armed for another project does not follow the create', async () => {
    const api = fakeProjects(TWO);
    const createProject = api.createProject.bind(api);
    let releaseCreate: () => void = () => undefined;
    api.createProject = async (name) => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return createProject(name);
    };
    pageWith(api);
    await selectProject('p2');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Meant for p2' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    // Asserted in the window the fault lives in: with the create held, a draft
    // that was not cancelled is still on screen and still aimed at p2. Once
    // the create resolves the re-arm would overwrite it either way, so the
    // final state cannot see this at all.
    await waitFor(() => {
      expect(releaseCreate).not.toBeNull();
    });
    expect(screen.queryByLabelText<HTMLInputElement>('Project name')?.value ?? null).toBeNull();

    releaseCreate();

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Project name').value).toBe('New project');
    });
    // Nothing was renamed, and p2 still holds the name it had.
    expect(api.renamed).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText('Project name'), { key: 'Escape' });
    openPicker();
    await waitFor(() => {
      expect(optionNames()).toContain(`Paint the fence (strip · ${THIS_JUNE})`);
    });
  });

  itDom('abandoning the new project’s rename keeps the project', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const name = await screen.findByLabelText<HTMLInputElement>('Project name');

    fireEvent.keyDown(name, { key: 'Escape' });

    // The project was created before the rename was ever offered; nothing is
    // rolled back, and it is still the one that is open.
    expect(api.renamed).toEqual([]);
    expect(picker().value).toBe('New project');
    openPicker();
    await waitFor(() => {
      expect(optionNames()).toContain(`New project (kat · ${THIS_JUNE})`);
    });
  });
});
