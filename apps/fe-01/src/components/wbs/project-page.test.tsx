import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CreatedProject, ProjectApi, ProjectListEntry } from '@/lib/wbs-api';

import { ProjectPage } from './project-page';

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
  return {
    renamed,
    opened,
    // A deletion that happened somewhere else: the next listProjects simply
    // no longer has the project.
    drop(id) {
      projects = projects.filter((p) => p.id !== id);
    },
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
        { id, name, restricted: false, lastOpenedAt: null, ownerName: 'kat', createdAt: MADE_ON },
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
      Promise.resolve({
        workItems: [],
        seq: -1,
        scheduleError: null,
        slices: [],
        roles: [],
        assignedPeople: [],
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        priorityBands: DEFAULT_PRIORITY_BANDS,
        estimateMethod: 'pert' as const,
        startDate: null,
        projectRevision: 0,
        undoable: false,
        redoable: false,
      }),
    setEstimateMethod: () => Promise.resolve(),
    setStartDate: () => Promise.resolve(),
    listTeams: () => Promise.resolve([]),
    addTeam: () => Promise.reject(new Error('not_in_these_tests')),
    listPeople: () => Promise.resolve([]),
    addPerson: () => Promise.reject(new Error('not_in_these_tests')),
    assign: () => Promise.reject(new Error('not_in_these_tests')),
    roles: () => Promise.resolve([]),
    addRole: () => Promise.reject(new Error('not_in_these_tests')),
    renameRole: () => Promise.reject(new Error('not_in_these_tests')),
    removeRole: () => Promise.reject(new Error('not_in_these_tests')),
    create: () => Promise.reject(new Error('not_in_these_tests')),
    patch: () => Promise.reject(new Error('not_in_these_tests')),
    move: () => Promise.reject(new Error('not_in_these_tests')),
    duplicate: () => Promise.reject(new Error('not_in_these_tests')),
    remove: () => Promise.reject(new Error('not_in_these_tests')),
    setEstimate: () => Promise.reject(new Error('not_in_these_tests')),
    clearEstimate: () => Promise.reject(new Error('not_in_these_tests')),
    freeze: () => Promise.reject(new Error('not_in_these_tests')),
    unfreezeProject: () => Promise.reject(new Error('not_in_these_tests')),
    unfreeze: () => Promise.reject(new Error('not_in_these_tests')),
    addDependency: () => Promise.reject(new Error('not_in_these_tests')),
    removeDependency: () => Promise.reject(new Error('not_in_these_tests')),
    undo: () => Promise.reject(new Error('not_in_these_tests')),
    redo: () => Promise.reject(new Error('not_in_these_tests')),
  };
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
    lastOpenedAt: null,
    ownerName: 'kat',
    createdAt: MADE_ON,
  },
  {
    id: 'p2',
    name: 'Paint the fence',
    restricted: false,
    lastOpenedAt: null,
    ownerName: 'strip',
    createdAt: MADE_ON,
  },
];

const pageWith = (api: ProjectApi) => render(<ProjectPage token="t" api={api} />);

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

  itDom('tells the presence slot which project is open, and when none is', async () => {
    // The roster is a project's (F4): gw-01 scopes it by the project the
    // socket subscribed to, and the selection lives here, so the panel cannot
    // be a finished node handed down from `App`.
    //
    // Proof: `presence?.(selected)` in `project-page.tsx` put back to passing
    // `presence` straight through as a node. This test failed on
    // `expect(asked[0]).toBeNull()` — `expected undefined to be null`, the slot
    // never called at all — and `gives the header the slots the app fills` failed
    // beside it on `Unable to find an element with the text: who is here`,
    // because a function React is handed as a child renders nothing. Watched
    // 2026-08-09.
    const asked: (string | null)[] = [];
    render(
      <ProjectPage
        token="t"
        api={fakeProjects(TWO)}
        presence={(projectId) => {
          asked.push(projectId);
          return <p>who is in {projectId ?? 'nothing'}</p>;
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined();
    });
    // Two projects, so nothing is auto-selected and the first ask is honest
    // about it.
    expect(asked[0]).toBeNull();
    expect(screen.getByText('who is in nothing')).toBeDefined();

    await selectProject('p2');

    expect(asked.at(-1)).toBe('p2');
    expect(screen.getByText('who is in p2')).toBeDefined();
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
    const asked: string[] = [];
    const realTree = api.tree.bind(api);
    api.tree = (projectId) => {
      asked.push(projectId);
      return realTree(projectId);
    };
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
    const asked: string[] = [];
    const realTree = api.tree.bind(api);
    api.tree = (projectId) => {
      asked.push(projectId);
      return realTree(projectId);
    };
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
          lastOpenedAt: 900,
          ownerName: 'strip',
          createdAt: MADE_ON,
        },
        {
          id: 'p1',
          name: 'Rewire the shed',
          restricted: false,
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

    await waitFor(() => {
      expect(picker().value).toBe('New project');
    });
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

  itDom('creating a project mid-rename cancels the draft instead of retargeting it', async () => {
    const api = fakeProjects(TWO);
    pageWith(api);
    await selectProject('p2');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Meant for p2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));

    // The draft is gone, nothing was renamed, and the new project keeps the
    // name it was created with.
    await waitFor(() => {
      expect(screen.queryByLabelText('Project name')).toBeNull();
    });
    expect(api.renamed).toEqual([]);
    openPicker();
    await waitFor(() => {
      expect(optionNames()).toContain(`New project (kat · ${THIS_JUNE})`);
    });
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
