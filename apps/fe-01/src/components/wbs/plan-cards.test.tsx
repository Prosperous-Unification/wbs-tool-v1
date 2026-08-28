import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Days,
  PersonView,
  ProjectApi,
  RoleView,
  ScheduleView,
  ServiceView,
  TagView,
  TeamView,
  WorkItemView,
} from '@/lib/wbs-api';

import { refusedDraftFor, unsent } from './live-editing';
import { type CardRowActionHandlers, PlanCards } from './plan-cards';
import { shortIsoDate } from './short-date';
import type { TreeRow } from './wbs-rows';
import { WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** jsdom's own default, and the width every other test in this app runs at. */
const LAPTOP = 1024;
/** jsdom's own default height, which clears `TABLE_NEEDS_HEIGHT` on its own. */
const LAPTOP_TALL = 768;
/** An iPhone 14's CSS width, which is what `e2e/mobile.spec.ts` measures at. */
const PHONE = 390;
/** The same phone's CSS height, and sideways the two swap places. */
const PHONE_TALL = 844;

const DEV: RoleView = { id: 'role-dev', name: 'Dev' };
const QA: RoleView = { id: 'role-qa', name: 'QA' };

/**
 * What this fake was asked for and does not do.
 *
 * A throw rather than a silent `undefined`: a card test that reached one of
 * these would be exercising a path nothing here models, and answering it with
 * nothing is the "unknown converted to a default" this repository refuses.
 */
const notImplemented = (what: string): never => {
  throw new Error(`the card tests' fake project API has no ${what}`);
};

/**
 * A `ProjectApi` over an in-memory plan, as small as these tests can be served
 * by.
 *
 * Deliberately **not** `wbs-table.test.tsx`'s: that one is four hundred lines
 * modelling renumbering, undo stacks, phase removal and assumed-assignee flips,
 * and it is that file's spec. Nothing here needs any of it — a card is read
 * from the same tree the table is — and importing a test file to borrow its
 * fixture would run its 289 tests again.
 */
/**
 * A plan on a calendar, in the reader's own year, so the short dates print
 * without one. Built from `new Date()` rather than written out, because "this
 * year" is what decides whether the year is shown at all.
 */
const DATED_PLAN = {
  startsOn: `${String(new Date().getFullYear())}-06-01`,
  endsOn: `${String(new Date().getFullYear())}-06-03`,
} as const;

/**
 * Which floor this fake claims held a row's start.
 *
 * **A choice, not a computation, and that is why it is written down.** be-01
 * takes the *latest* of a slice's floors after a real levelling pass, and a
 * fixture with no scheduler in it cannot. What it can do is stop lying: every
 * slice this fake built said `projectStart` — the same fixture bug
 * `wbs-table.test.tsx` carried until chunk 2 fixed it — so its plans claimed no
 * waits at all, and a card could only ever be shown one of the six sentences.
 *
 * The order is the only one two stored fields can honestly support, and each
 * arm is somebody's own rule rather than this file's: a row with a
 * start-no-earlier-than is held by it (`notBeforeFloorWords` appends the typed
 * reason to exactly that floor), a row with a stored dependency waits for that
 * dependency (be-01's `schedule.ts`), and everything else stands on the
 * project's first day.
 */
const fixtureFloorOf = (row: WorkItemView): 'notBefore' | 'predecessor' | 'projectStart' => {
  if (row.startNoEarlierThan !== null) return 'notBefore';
  if (row.dependsOn.length > 0) return 'predecessor';
  return 'projectStart';
};

function fakeApi(options: { refusePatch?: boolean; dated?: boolean } = {}): ProjectApi & {
  patched: {
    id: string;
    name?: string;
    notes?: string;
    priority?: number | null;
    tagIds?: string[];
    serviceIds?: string[];
  }[];
  assignments: string[];
  /**
   * The plan itself, so a test can arrange one before the first render.
   *
   * The cards read the tree and write nothing to the two fields
   * `capacity-ui` put on them — a team label and a parallelism are typed in the
   * table and in the directory, never on a phone — so arranging them through a
   * write path this fake does not have would be modelling a route that does not
   * exist. Handed over instead, and the assertions are about what a card draws.
   */
  rows: WorkItemView[];
  teams: TeamView[];
  /**
   * The directory's services, arranged the way {@link teams} is and for the
   * same reason: a card names a service it never writes one, and the picker
   * that does write them is the table's cell and the directory page.
   */
  services: ServiceView[];
  /** The directory's tags, arranged the way {@link services} is. */
  tags: TagView[];
  /**
   * The directory's people, arranged the way {@link teams} is — and it is the
   * **membership** on them that matters here, not the names.
   *
   * Exposed for the `assigned outside the team` control: this fake's one person
   * belongs to no team, so every assignment onto a labelled row provokes that
   * signal, and a case meaning to show the signal *absent* has no way to say so
   * without putting them in a team. Without this, "the directory has no
   * quarrel" is a claim only half of which can be arranged, which is a control
   * that passes for the wrong reason.
   */
  people: PersonView[];
  /**
   * Every row-action write this fake was asked to make, in order.
   *
   * The **request** and not the screen, for the reason `studio-dev-vhost`
   * chunk 3 wrote down the hard way: a fake that mutates whatever it is asked
   * to mutate lets a card whose menu is wired to nothing pass, as long as
   * something else on the page happens to redraw. `duplicate:w1` here is proof
   * the card's ⋯ reached `api.duplicate`, which is the fact
   * `card-row-actions-unwired` is about.
   */
  rowActionCalls: string[];
  /**
   * Every edge write, in order: `add:<successor>:<predecessor>`.
   *
   * Recorded **and** applied below, for the reason chunk 6's `priority` learned:
   * half of what a dependency case asserts is what the card says *afterwards*,
   * and a fake that took the request and left the row alone would let a write
   * that never landed read as green.
   */
  edges: string[];
} {
  const rows: WorkItemView[] = [];
  const rowActionCalls: string[] = [];
  const edges: string[] = [];
  const roleList: RoleView[] = [{ ...DEV }, { ...QA }];
  const people: PersonView[] = [{ id: 'p1', name: 'Kat', kind: 'person', teamIds: [] }];
  const teams: TeamView[] = [];
  const services: ServiceView[] = [];
  const tags: TagView[] = [];
  const assigned = new Map<string, string>();
  const patched: {
    id: string;
    name?: string;
    notes?: string;
    priority?: number | null;
    tagIds?: string[];
    serviceIds?: string[];
  }[] = [];
  const assignments: string[] = [];
  let next = 0;

  /** The one person this work item is taken to be doing every phase of, if any. */
  const doesEveryPhase = (id: string): string | null => {
    const named = [...assigned.entries()]
      .filter(([key]) => key.startsWith(`${id}::`))
      .map(([, personId]) => personId);
    return named.length === 1 ? (named[0] ?? null) : null;
  };

  const view = (row: WorkItemView): WorkItemView => ({
    ...row,
    doesEveryPhase: doesEveryPhase(row.id),
    assignees: Object.fromEntries(
      roleList.map((role) => [role.id, assigned.get(`${row.id}::${role.id}`)]),
    ),
  });

  return {
    patched,
    assignments,
    rows,
    teams,
    services,
    tags,
    people,
    rowActionCalls,
    edges,
    tree: () =>
      Promise.resolve({
        workItems: rows.map(view),
        seq: 0,
        scheduleError: null,
        // One per row, since these tests make no parents. Read since
        // `wbs-row-waiting-explanation` chunk 4: `startFloorByRow` turns the
        // `boundBy` below into the sentence a card prints, so the field that
        // used to be inert payload is now the thing three cases arrange.
        slices: rows.map((row) => ({
          id: `${row.id}::${DEV.id}`,
          workItemId: row.id,
          roleId: DEV.id,
          personId: null,
          duration: 0,
          estimated: false,
          earliestStart: 0,
          earliestFinish: 0,
          latestStart: 0,
          latestFinish: 0,
          float: 0,
          critical: false,
          boundBy: fixtureFloorOf(row),
          resourcePredecessorId: null,
          // One at a time and nothing holding a pool. The cards read neither —
          // a card's parallelism line is the row's stored number — but the
          // payload carries them, so this fake does too.
          width: 1,
          effort: 0,
          capacityPredecessorIds: [],
        })),
        // The same two lists `roles` and `listPeople` answer with, on the read
        // that carried the slices: the chart is drawn from this payload alone.
        roles: roleList.map((role) => ({ ...role })),
        assignedPeople: people.map(({ id, name }) => ({ id, name })),
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        priorityBands: DEFAULT_PRIORITY_BANDS,
        estimateMethod: 'pert' as const,
        startDate: options.dated === true ? DATED_PLAN.startsOn : null,
        projectRevision: 0,
        undoable: false,
        redoable: false,
      }),
    roles: () => Promise.resolve(roleList.map((role) => ({ ...role }))),
    listTeams: () => Promise.resolve(teams.map((team) => ({ ...team }))),
    listTags: () => Promise.resolve(tags.map((tag) => ({ ...tag }))),
    listServices: () => Promise.resolve(services.map((service) => ({ ...service }))),
    listPeople: () => Promise.resolve(people.map((person) => ({ ...person }))),
    create: (_projectId: string, input: { parentId: string | null; name?: string }) => {
      next += 1;
      const id = `w${String(next)}`;
      rows.push({
        id,
        parentId: input.parentId,
        revision: 0,
        number: String(rows.length + 1).padStart(2, '0') + '0',
        name: input.name ?? '',
        notes: '',
        frozenNumber: null,
        priority: null,
        // One at a time, be-01's `NOT NULL DEFAULT 1`: never absent, because 1
        // and unset are the same fact.
        maxParallel: 1,
        rolledUp: false,
        estimates: {},
        dependsOn: [],
        finalDays: {},
        finalTotal: 0,
        dates: options.dated === true ? { ...DATED_PLAN } : null,
        startNoEarlierThan: null,
        startNoEarlierThanReason: null,
        serviceTeamId: null,
        teamIds: [],
        assignees: {},
        doesEveryPhase: null,
        schedule: {
          duration: 0,
          estimated: false,
          earliestStart: 0,
          earliestFinish: 0,
          latestStart: 0,
          latestFinish: 0,
          float: 0,
          critical: false,
        },
      });
      return Promise.resolve({ id });
    },
    patch: (
      id: string,
      patch: {
        name?: string;
        notes?: string;
        serviceTeamId?: string | null;
        teamIds?: string[];
        tagIds?: string[];
        serviceIds?: string[];
        startNoEarlierThan?: string | null;
        startNoEarlierThanReason?: string | null;
        priority?: number | null;
      },
    ) => {
      if (options.refusePatch === true) return Promise.reject(new Error('forbidden'));
      patched.push({ id, ...patch });
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.notes !== undefined) row.notes = patch.notes;
      // `serviceTeamId` is the stored label and `teamIds` is what the row is
      // read through — be-01 keeps both in step, so a fake that moved only one
      // would let a card pass a test the server would fail.
      if (patch.serviceTeamId !== undefined) {
        row.serviceTeamId = patch.serviceTeamId;
        row.teamIds = patch.serviceTeamId === null ? [] : [patch.serviceTeamId];
      }
      if (patch.teamIds !== undefined) {
        row.teamIds = [...patch.teamIds];
        row.serviceTeamId = [...patch.teamIds].sort().at(0) ?? null;
      }
      if (patch.tagIds !== undefined) row.tagIds = [...patch.tagIds];
      if (patch.serviceIds !== undefined) row.serviceIds = [...patch.serviceIds];
      // be-01's pair rule, kept by the fake so a card cannot pass here what the
      // server would refuse: words about a date that is not there are a
      // `not_before_reason_needs_a_date` 400, checked inside the one
      // transaction that would write them. A fake that took them silently would
      // let the two-request version of this write look correct.
      if (patch.startNoEarlierThan !== undefined) row.startNoEarlierThan = patch.startNoEarlierThan;
      if (patch.startNoEarlierThanReason !== undefined) {
        if (patch.startNoEarlierThanReason !== null && row.startNoEarlierThan === null) {
          return Promise.reject(new Error('not_before_reason_needs_a_date'));
        }
        row.startNoEarlierThanReason = patch.startNoEarlierThanReason;
      }
      // Moved on the row and not only recorded, because half of what the
      // priority sheet's cases assert is what the *chip* says afterwards — a
      // fake that took the patch and left the row alone would let a write that
      // never reached the row read as green.
      if (patch.priority !== undefined) row.priority = patch.priority;
      return Promise.resolve();
    },
    setEstimate: (id: string, roleId: string, days: Days) => {
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      row.estimates = { ...row.estimates, [roleId]: days };
      const final = (days.optimistic + 4 * days.realistic + days.pessimistic) / 6;
      row.finalDays = { ...row.finalDays, [roleId]: final };
      row.finalTotal = Object.values(row.finalDays).reduce((total, each) => total + each, 0);
      return Promise.resolve();
    },
    assign: (workItemId: string, roleId: string, personId: string | null) => {
      assignments.push(`${workItemId} ${roleId} ${personId ?? '(nobody)'}`);
      if (personId === null) assigned.delete(`${workItemId}::${roleId}`);
      else assigned.set(`${workItemId}::${roleId}`, personId);
      return Promise.resolve();
    },
    addRole: (_projectId: string, name: string) => {
      const role = { id: `role-${name.toLowerCase()}`, name };
      roleList.push(role);
      return Promise.resolve({ ...role });
    },
    listProjects: () => notImplemented('listProjects'),
    createProject: () => notImplemented('createProject'),
    openProject: () => notImplemented('openProject'),
    renameProject: () => notImplemented('renameProject'),
    undo: () => notImplemented('undo'),
    redo: () => notImplemented('redo'),
    setEstimateMethod: () => notImplemented('setEstimateMethod'),
    setStartDate: () => notImplemented('setStartDate'),
    renameRole: () => notImplemented('renameRole'),
    removeRole: () => notImplemented('removeRole'),
    // Idempotent by name, because be-01 is: two browsers typing `Platform`
    // at once end up on one team, and a fake that made two would hide the
    // whole reason `createTeamFor` goes through the server at all.
    addTeam: (name: string) => {
      const existing = teams.find((team) => team.name.toLowerCase() === name.toLowerCase());
      if (existing !== undefined) return Promise.resolve({ ...existing });
      const team = { id: `team-${name.toLowerCase()}`, name };
      teams.push(team);
      return Promise.resolve({ ...team });
    },
    addTag: (name: string) => {
      const existing = tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
      if (existing !== undefined) return Promise.resolve({ ...existing });
      const tag = { id: `tag-${name.toLowerCase()}`, name };
      tags.push(tag);
      return Promise.resolve({ ...tag });
    },
    addService: (name: string) => {
      const existing = services.find(
        (service) => service.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing !== undefined) return Promise.resolve({ ...existing });
      const service = { id: `service-${name.toLowerCase()}`, name };
      services.push(service);
      return Promise.resolve({ ...service });
    },
    addPerson: () => notImplemented('addPerson'),
    move: () => notImplemented('move'),
    /**
     * A copy beside the original, numbered as {@link create} numbers, because
     * a card that duplicated nothing and a card that duplicated something both
     * look the same until a second row is on screen.
     */
    duplicate: (id: string) => {
      rowActionCalls.push(`duplicate:${id}`);
      const original = rows.find((each) => each.id === id);
      if (original === undefined) return Promise.reject(new Error('not_found'));
      next += 1;
      const copy: WorkItemView = {
        ...original,
        id: `w${String(next)}`,
        number: String(rows.length + 1).padStart(2, '0') + '0',
        // A freeze pins the number a row left the tool under, and the copy is
        // given none — `wbs-table.tsx`'s own comment on offering Duplicate on a
        // frozen row.
        frozenNumber: null,
      };
      rows.push(copy);
      return Promise.resolve({ id: copy.id });
    },
    remove: (id: string) => {
      rowActionCalls.push(`remove:${id}`);
      const at = rows.findIndex((each) => each.id === id);
      if (at === -1) return Promise.reject(new Error('not_found'));
      rows.splice(at, 1);
      return Promise.resolve();
    },
    // Real since `wbs-mobile-orp-input`: the trio sheet's `Clear` is the one
    // control on a card that reaches it, and a fake that refused would have let
    // "taking an estimate back off" pass untested on the only face that can do
    // it with a thumb. Removes the role's key rather than storing zeros —
    // `0/0/0` is an estimate somebody made, and no estimate is not.
    clearEstimate: (id: string, roleId: string) => {
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      const { [roleId]: goneDays, ...keptDays } = row.estimates;
      const { [roleId]: goneFinal, ...keptFinal } = row.finalDays;
      void goneDays;
      void goneFinal;
      row.estimates = keptDays;
      row.finalDays = keptFinal;
      row.finalTotal = Object.values(keptFinal).reduce((total, each) => total + each, 0);
      return Promise.resolve();
    },
    freeze: () => notImplemented('freeze'),
    unfreezeProject: () => notImplemented('unfreezeProject'),
    unfreeze: (id: string) => {
      rowActionCalls.push(`unfreeze:${id}`);
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      row.frozenNumber = null;
      return Promise.resolve();
    },
    addDependency: (id: string, predecessorId: string) => {
      edges.push(`add:${id}:${predecessorId}`);
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      // Idempotent by pair, which is be-01's own unique constraint: the picker
      // never offers a predecessor a row already holds, so a duplicate here
      // would be modelling a request the app cannot make.
      if (!row.dependsOn.includes(predecessorId)) row.dependsOn = [...row.dependsOn, predecessorId];
      return Promise.resolve();
    },
    removeDependency: (id: string, predecessorId: string) => {
      edges.push(`drop:${id}:${predecessorId}`);
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      row.dependsOn = row.dependsOn.filter((each) => each !== predecessorId);
      return Promise.resolve();
    },
  };
}

/**
 * Sets the size the next render will read, before anything is on screen.
 *
 * The height defaults to jsdom's own, which is the size every case that says
 * nothing about height has always run at — and clears `TABLE_NEEDS_HEIGHT`, so
 * a width-only caller still asks the width-only question.
 */
function widthIs(width: number, height = LAPTOP_TALL): void {
  const w = window as unknown as { innerWidth: number; innerHeight: number };
  w.innerWidth = width;
  w.innerHeight = height;
}

/** Turns the phone: the size, then the event the page hears about it through. */
function resizeTo(width: number, height = LAPTOP_TALL): void {
  act(() => {
    widthIs(width, height);
    window.dispatchEvent(new Event('resize'));
  });
}

/** Every cell the renderer on screen has drawn a box for, by `data-cell`. */
const cellsOnScreen = (): string[] =>
  [...document.querySelectorAll('[data-cell]')].map((box) => box.getAttribute('data-cell') ?? '');

const openTheSheet = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Plan actions' }));
};

/** Adds one work item through the sheet, which is the only way to on a phone. */
async function addAWorkItem(): Promise<void> {
  openTheSheet();
  fireEvent.click(await screen.findByRole('button', { name: 'Add work item' }));
  await screen.findByLabelText('Name of 010');
}

beforeEach(() => {
  localStorage.clear();
  widthIs(LAPTOP);
});

afterEach(() => {
  cleanup();
  widthIs(LAPTOP);
});

describe('the plan-card ProjectApi fake', () => {
  it('round trips whole team sets and retains the legacy scalar arm', async () => {
    const api = fakeApi();
    const created = await api.create('p1', { parentId: null, afterId: null, name: 'Strip' });

    await api.patch(created.id, { teamIds: ['team-b', 'team-a'] });

    expect(api.rows.find((row) => row.id === created.id)).toMatchObject({
      teamIds: ['team-b', 'team-a'],
      serviceTeamId: 'team-a',
    });

    await api.patch(created.id, { serviceTeamId: 'team-c' });

    expect(api.rows.find((row) => row.id === created.id)).toMatchObject({
      teamIds: ['team-c'],
      serviceTeamId: 'team-c',
    });
  });
});

describe('the plan on a phone', () => {
  itDom('indents a card one step per level, and stops at the cards’ own cap', async () => {
    // `cardIndentFor`: deeper than the Number column's cap — a card has no
    // pinned neighbour to overlap, so depth 5 and 6 step right where the table
    // cell's number stops — but not uncapped, because the margin comes out of
    // a 390px phone. The chain is built through the fake before the render:
    // eight rows, each the child of the one before, so the deepest is depth 7
    // — one past the cards' stated cap.
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    for (let parent = 1; parent <= 7; parent += 1) {
      await api.create('p1', { parentId: `w${String(parent)}` });
    }
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('article', { name: 'Work item 080' });

    const cardMargin = (id: string): string => {
      const card = document.querySelector<HTMLElement>(`[data-card="${id}"]`);
      if (card === null) throw new Error(`no card on screen for ${id}`);
      return card.style.marginLeft;
    };

    // Proof: the cards pointed at the uncapped `hierarchyIndentFor` — this
    // failed on `expected '84px' to be '72px'` at depth 7. Watched,
    // 2026-08-10.
    expect(cardMargin('w1')).toBe('0px');
    expect(cardMargin('w5')).toBe('48px');
    // Past the Number column's `DEEPEST_INDENT`, where the capped indent held
    // every deeper card at 48px.
    expect(cardMargin('w6')).toBe('60px');
    expect(cardMargin('w7')).toBe('72px');
    // And the cards' own cap: depth 7 draws at depth 6's margin.
    expect(cardMargin('w8')).toBe('72px');
  });

  itDom('is cards below the breakpoint and the table above it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.getByRole('article', { name: 'Work item 010' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    resizeTo(LAPTOP);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Work item 010' })).toBeNull();
  });

  /**
   * codex #14 / agy #12, the first contract: a card's boxes are the table's
   * cells.
   *
   * They have to be, because `heldRefusals` is keyed by `rowId::columnId` and
   * nothing else — a card that spelled its cells its own way would mount a
   * different {@link import('./live-editing').LiveField} and lose every draft
   * be-01 refused on the way across the breakpoint. The subset is checked as
   * well as the exact list: the cards edit three of the table's cells and must
   * invent none.
   *
   * Proof: the card's `cellKey` prefixed with `card-`, so its boxes are cells
   * of their own. This failed on `expected [ 'w1::card-name', … ] to deeply
   * equal [ 'w1::name', … ]` — and `keeps a draft be-01 refused when the window
   * crosses the breakpoint` failed with it, which is the fault that matters.
   * Watched, 2026-08-09.
   */
  itDom('renders no cell the table has not got one for', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCards = cellsOnScreen();
    resizeTo(LAPTOP);
    const onTheTable = cellsOnScreen();

    expect(onCards).toEqual(['w1::name', 'w1::role-dev-final', 'w1::role-qa-final']);
    for (const cell of onCards) expect(onTheTable).toContain(cell);
  });

  /**
   * The other half of the same contract, and the one `X live-editing-extraction`
   * re-anchored `editable-grid.ts` for (agy #11): the cards are a grid without
   * being a table.
   *
   * The marker is asserted structurally because that is what it is — it is what
   * scopes the vendored components' reset away from the boxes (`styles.css`)
   * and what `gridOf` finds. The **behaviour** it stands for is the test below:
   * a grid that walks.
   */
  itDom('marks the card list as the grid, and it is no table', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const grid = document.querySelector('[data-grid]');
    expect(grid).not.toBeNull();
    expect(grid?.tagName).not.toBe('TABLE');
    expect(grid?.querySelectorAll('[data-cell]')).toHaveLength(3);
  });

  /**
   * The grid walked, on the card DOM: the readiness badge carries the caret to
   * the next leaf nobody has estimated, and it finds that cell by asking
   * `editable-grid.ts` for it (`cellIn`, then `focusCellAt`).
   *
   * This is the assertion that would fail if the cards were a list nothing
   * could walk — the structural one above cannot see that, and neither can the
   * create, which claims its own arrival as the box attaches.
   *
   * Proof: `gridRef` dropped from `PlanCards`, so `gridElement` stays null and
   * the walk has no grid to read. Failed on `expected <body> to be <input
   * data-cell="w1::role-dev-final" …>` — the caret left where it was, on a
   * badge that had said it would take the reader somewhere. Watched,
   * 2026-08-09.
   */
  itDom('carries the caret to an unestimated card when the badge is taken', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    openTheSheet();
    fireEvent.click(await screen.findByRole('button', { name: '1 unestimated' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
    });
  });

  /**
   * codex #14's second contract, on the card DOM: a structural edit is a
   * request and a refetch, and something has to put the caret in the row that
   * arrives.
   *
   * On a phone there is exactly one structural edit — Add work item, from the
   * sheet — so this is the whole of it.
   *
   * Proof: `onCloseAutoFocus` removed from the sheet, this failed on `expected
   * <button …(5)></button> to be <textarea …(5)></textarea>` — Radix restores
   * the focus to a modal's trigger **on a timer**, so it lands after the
   * refetch and takes the caret straight back off the new card. Watched,
   * 2026-08-09.
   *
   * What this test does **not** see is the trap itself: jsdom performs none of
   * the `focusin` bookkeeping a real focus scope is made of, so with
   * `closingControlIn` pinned to null the caret still reached the box here while
   * five other tests failed on a sheet left over the plan. The browser is where
   * that half is asserted — `e2e/mobile.spec.ts`.
   */
  itDom('lands the focus in the card of a work item it just created', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    });
  });

  /**
   * codex #14's third contract, and the reason `X live-editing-extraction`
   * exists at all: a draft be-01 refused belongs to the cell, so turning the
   * phone must not take it away.
   *
   * `live-editing.test.tsx` proves this by unmounting one renderer and mounting
   * another by hand. This is the same claim through the **production**
   * breakpoint — one component, one plan, a real `resize` — which is the only
   * version that can see the switch itself put the wrong thing on screen.
   *
   * Proof: `LiveField.takeNode`'s restore deleted, this failed on `expected ''
   * to be 'Strip the wiring'` — the refused name replaced by the server's, by a
   * phone being turned. Watched, 2026-08-09.
   */
  itDom('keeps a draft be-01 refused when the window crosses the breakpoint', async () => {
    const api = fakeApi({ refusePatch: true });
    render(<WbsTable projectId="p1" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add work item' }));
    const onTheTable = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    fireEvent.change(onTheTable, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(onTheTable);
    await waitFor(() => {
      expect(refusedDraftFor('w1::name')).toBe('Strip the wiring');
    });

    resizeTo(PHONE);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  /** The other direction, because a phone is turned back. */
  itDom('and carries it back to the table when the window widens again', async () => {
    const api = fakeApi({ refusePatch: true });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onACard = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(onACard, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(onACard);
    await waitFor(() => {
      expect(refusedDraftFor('w1::name')).toBe('Strip the wiring');
    });

    resizeTo(LAPTOP);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  /**
   * The rotation, which is the same contract as the two above and a different
   * event: turning a phone does not cross the *width* breakpoint at all — it
   * takes the window from 390 to 844, which is wider — so until
   * `TABLE_NEEDS_HEIGHT` existed this was the one resize that put the 1471px
   * table on a 390px-tall screen and threw the card's boxes away with it.
   *
   * The cells are asserted by `data-cell` rather than by what is on screen,
   * because that is the key `heldRefusals` is stored under: a rotation that
   * kept the draft but re-spelled the cell would pass a value check and still
   * be the fault `renders no cell the table has not got one for` exists for.
   */
  itDom('keeps a refused draft, and its cells, when the phone is turned', async () => {
    const api = fakeApi({ refusePatch: true });
    widthIs(PHONE, PHONE_TALL);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const inPortrait = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(inPortrait, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(inPortrait);
    await waitFor(() => {
      expect(refusedDraftFor('w1::name')).toBe('Strip the wiring');
    });
    const cellsInPortrait = cellsOnScreen();

    resizeTo(PHONE_TALL, PHONE);

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('article', { name: 'Work item 010' })).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
    expect(cellsOnScreen()).toEqual(cellsInPortrait);
  });

  itDom('sends a name typed on a card', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const box = screen.getByLabelText('Name of 010');
    fireEvent.change(box, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(box);

    await waitFor(() => {
      expect(api.patched).toEqual([{ id: 'w1', name: 'Strip the wiring' }]);
    });
  });

  itDom('keeps a card’s notes on show at rest, capped at eight lines', async () => {
    // The card face is the one place a note is readable without editing it: a
    // phone has no hover, so the preview the table sends people to does not
    // exist here. That is why the table's Name cell clamps to its first line
    // at rest (`restShowsFirstLineOnly`) and this one deliberately does not —
    // it caps instead, and the cap has been the only thing standing between a
    // long note and a card the length of the page since `maxRestRows` arrived.
    //
    // Proof: `restShowsFirstLineOnly` passed here too, as the table's Name
    // column passes it — `expected 'none' to be '11.2em'` and `expected
    // 'hidden' to be 'auto'`, the note clipped away on the one face that has
    // nowhere else to show it. Watched, 2026-08-09.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const box = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(box, { target: { value: 'Strip\nmeasure twice, the fuse box is old' } });
    box.blur();

    expect(box.style.maxHeight).toBe('11.2em');
    expect(box.style.overflowY).toBe('auto');
  });

  itDom('prints a span in the very words the table’s columns print', async () => {
    // The parity rule, asserted across the breakpoint rather than against a
    // literal: one plan read on a phone and on a laptop may not disagree about
    // how a day is written. Both renderers are handed the table's own
    // `spanOf`, and this is what says so.
    //
    // Proof: the card's span rendered as `span.start.iso ?? span.start.text`
    // — the raw ISO the cards used to print — this failed on `expected
    // '2026-06-01 → 2026-06-03' to be '1 Jun → 3 Jun'`. Watched, 2026-08-09.
    const api = fakeApi({ dated: true });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCard = document.querySelector('[data-card-span]');
    expect(onCard?.textContent).toBe('1 Jun → 3 Jun');
    // And the full days are still a hover away, the same bargain the table's
    // cells make.
    expect(onCard?.getAttribute('title')).toBe(`${DATED_PLAN.startsOn} → ${DATED_PLAN.endsOn}`);

    resizeTo(LAPTOP);

    expect(document.querySelector('[data-start]')?.textContent).toBe('1 Jun');
    expect(document.querySelector('[data-finish]')?.textContent).toContain('3 Jun');
  });

  itDom('prints the workday offsets the columns print, on a plan with no start date', async () => {
    // The fallback, on both faces: without a project start date there are no
    // dates to shorten and both renderers count days from day zero.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCard = document.querySelector('[data-card-span]');
    expect(onCard?.textContent).toBe('0 → 0');
    // Nothing fuller to say, so nothing said: a `title` repeating the cell is
    // noise a screen reader has to read out.
    expect(onCard?.getAttribute('title')).toBe(null);

    resizeTo(LAPTOP);

    expect(document.querySelector('[data-start]')?.textContent).toBe('0');
  });

  itDom('offers nothing to drag a card by', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.queryByRole('button', { name: 'Reorder 010' })).toBeNull();
  });
});

describe('a picker open on a card', () => {
  /**
   * codex #14's fourth contract: the open list owns the keyboard.
   *
   * The chords and the alt-arrows are not wired on a card at all — a phone has
   * neither — so what is left to own is Enter and Escape, and both are asserted
   * here rather than assumed from the table's version of this test.
   *
   * Proof: the `Enter` branch removed from the card's figure box, this failed
   * on `expected [] to deeply equal [ 'w1 role-dev p1' ]` — the key reaching
   * the box under the list and assigning nobody. Watched, 2026-08-09.
   */
  itDom('takes Enter for the list rather than the box under it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '4@ka' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(figure, { key: 'Enter' });

    await waitFor(() => {
      expect(api.assignments).toEqual(['w1 role-dev p1']);
    });
    // The mention goes with the pick and the estimate half stays exactly as it
    // was typed: `@ka` was a search, not part of a figure.
    expect(figure.value).toBe('4');
  });

  /**
   * Escape closes the list and strips nothing — what was typed is still on
   * screen to be corrected, which is the answer every picker in this app gives.
   *
   * Proof: the `Escape` branch removed, this failed on `expected <ul role=
   * "listbox" …> to be null` — a list nothing on a phone could close.
   * Watched, 2026-08-09.
   */
  itDom('closes on Escape and leaves what was typed', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '4@ka' } });
    fireEvent.keyDown(figure, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(figure.value).toBe('4@ka');
    expect(api.assignments).toEqual([]);
  });

  itDom('points the figure box’s combobox at the line its Enter takes', async () => {
    // The table's folded cell carries the same two pointers; the card must
    // not disagree. Enter takes the first line, so that is the line
    // `aria-activedescendant` names — and both pointers go when the list goes.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '4@ka' } });

    const list = screen.getByRole('listbox');
    const first = list.querySelector('[role="option"]')!;
    expect(figure.getAttribute('aria-controls')).toBe(list.id);
    expect(figure.getAttribute('aria-activedescendant')).toBe(first.id);

    // Escape closes the list and takes both pointers with it.
    fireEvent.keyDown(figure, { key: 'Escape' });
    expect(figure.getAttribute('aria-controls')).toBeNull();
    expect(figure.getAttribute('aria-activedescendant')).toBeNull();
    expect(api.assignments).toEqual([]);
  });

  itDom('sends the trio on Enter where no list is open', async () => {
    // The table's fix on the face that has the most reason to want it: a phone
    // has no convenient elsewhere to tap, so blur-only commit means a figure is
    // saved by whatever the reader happens to touch next — and their own
    // keyboard's confirm key did nothing at all.
    //
    // With no `@` in the box there is no list to own the key, which is what
    // makes this the same box as the one above and a different branch of it.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '2/3/8' } });
    expect(screen.queryByRole('listbox'), 'a list is open, so Enter is not this branch').toBeNull();

    fireEvent.keyDown(figure, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.estimates['role-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
  });
});

describe('the toolbar sheet', () => {
  itDom('holds the toolbar, which is nowhere on the page until it is opened', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Add work item' })).toBeNull();

    openTheSheet();

    expect(await screen.findByRole('button', { name: 'Add work item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  /**
   * Taking a control on the sheet is taking it on the plan behind the sheet,
   * and 390px of screen cannot show both.
   *
   * Proof: `closingControlIn` pinned to null, this failed on `expected <button
   * …(2)></button> to be null` — the sheet still over the plan it had just
   * changed. Four other tests in this file failed with it, all on queries that
   * could not reach a plan Radix had marked `aria-hidden`. Watched, 2026-08-09.
   */
  itDom('closes when a control on it acts on the plan', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.queryByRole('button', { name: 'Add work item' })).toBeNull();
  });

  /**
   * The exemption, and the reason it is not a nicety: closing the sheet
   * unmounts the dialog its own trigger was about to open, and a phase change
   * is one of the things a phone most needs the sheet for.
   *
   * Proof, two faults, both watched 2026-08-09. The `aria-haspopup` exemption
   * removed: failed on `Unable to find an accessible element with the role
   * "dialog" and name "Phases"` — the sheet closed on the trigger's own click
   * and took the dialog with it. The surface check removed so a click anywhere
   * closes the sheet: `adds a phase from inside the sheet` failed the same way
   * one click later, on the dialog's own Add.
   */
  itDom('lets the phases dialog open from inside it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Phases', exact: true }));

    expect(await screen.findByRole('dialog', { name: 'Phases' })).toBeInTheDocument();
  });

  /**
   * And works once it is open, which is the half the exemption above cannot
   * prove on its own.
   *
   * React sends a portal's events up the **React** tree, so every click inside
   * that dialog arrives at the sheet's own capture handler — and a rule that
   * only asked "is this a button" would close the sheet under the dialog,
   * mid-click, on the way to adding a phase.
   *
   * Proof: the `[data-modal-surface]` check removed from `closingControlIn`, this
   * failed on `Unable to find an accessible element with the role "dialog" and
   * name "Phases"` — the sheet closed under the dialog on the way to sending
   * the phase, taking the surface somebody was working on with it. Watched,
   * 2026-08-09, and only after the second assertion below was added: the phase
   * itself still lands, so the first one cannot see this at all.
   */
  itDom('adds a phase from inside the sheet', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();
    openTheSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Phases', exact: true }));
    await screen.findByRole('dialog', { name: 'Phases' });

    fireEvent.change(screen.getByLabelText('New phase'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));

    // The new phase reaches the cards behind both surfaces, which is what says
    // the refetch the dialog asked for was not thrown away with them.
    expect(await screen.findByLabelText('Review estimate for 010')).toBeInTheDocument();
    // And the dialog is still there to add a second one. This is the half the
    // line above cannot see: a sheet that closed under it would take the dialog
    // with it *after* the phase had already been sent.
    expect(screen.getByRole('dialog', { name: 'Phases' })).toBeInTheDocument();
  });

  /**
   * `F shadcn-foundation`'s window/chord split, met by this change's own
   * surface: `?` is listened for on `window`, so an open sheet has to hold it
   * back or the cheat sheet opens over the toolbar.
   *
   * Proof: the sheet's body moved out of `ModalContent` into a plain `<div>`,
   * this failed on `expected null not to be null` — the cheat sheet open over
   * the sheet, exactly as it was over `P phases-ui`'s dialog before `Modal`
   * existed. Watched, 2026-08-09.
   */
  /**
   * The other half of the close, and the one that shipped broken: a control
   * that aims the caret nowhere must leave Radix's own restore alone.
   *
   * `onCloseAutoFocus` refused that restore for **every** control, because the
   * flag behind it was set to `true` by any of them. So `Collapse all`, `Gantt`,
   * `Undo` and the exports all closed the sheet and dropped the focus on
   * `<body>` — nothing to type into, nothing to Tab from, on the one renderer
   * where the sheet is the only route to any of them.
   *
   * jsdom is a valid oracle here and only here: Radix's `FocusScope` restore is
   * a `focus()` call on the stored trigger, which jsdom does perform. What it
   * cannot see is the trap around it — `e2e/mobile.spec.ts` presses this same
   * button in Chromium for that.
   *
   * Proof: the assignment put back to the unconditional
   * `sheetControlTakesTheFocus.current = true` that shipped, this failed — alone
   * of the eighteen — on `expected <body style><div>…(1)</div></body> to be
   * <button …(5)></button>`. Watched, 2026-08-09.
   */
  itDom(
    'gives the focus back to the trigger when the control aimed the caret nowhere',
    async () => {
      const api = fakeApi();
      widthIs(PHONE);
      render(<WbsTable projectId="p1" api={api} />);
      await addAWorkItem();

      const trigger = screen.getByRole('button', { name: 'Plan actions' });
      openTheSheet();
      fireEvent.click(await screen.findByRole('button', { name: 'Collapse all' }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });
    },
  );

  /**
   * And the third control that does aim it, which is why the mark is not called
   * `data-lands-in-plan`: the cheat sheet focuses its own panel as it mounts,
   * and Radix's restore arrives on a timer after that.
   *
   * Proof: the `data-takes-the-focus` attribute struck off the `⌨` button, this
   * failed on `expected <button …(5)></button> to be <div role="dialog" …(4)>
   * …(6)</div>` — the focus pulled off a dialog that was still open, leaving
   * its Escape (listened for on the backdrop) with nothing to hear it. Watched,
   * 2026-08-09.
   */
  itDom('leaves the focus on the cheat sheet the sheet opened', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Keyboard shortcuts' }));
    await screen.findByRole('heading', { name: 'Keyboard shortcuts' });

    const panel = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await waitFor(() => {
      expect(document.activeElement).toBe(panel);
    });
  });

  itDom('offers no width control at all, because a card has no columns', async () => {
    /*
     * The placement rule for the width reset, asserted from the side that can
     * see it go wrong. `toolbarControls` is one array rendered in two places —
     * the desktop toolbar row and this sheet — so a control added to it reaches
     * the phone by construction, and the phone is drawing cards. The reset
     * lives in the table renderer's own branch instead, which this renderer
     * never takes.
     *
     * Seeded with a width already in force, or the control would be absent for
     * the wrong reason: on a project nobody has dragged a column in there is
     * nothing to render on either renderer, and the assertion would pass
     * against a reset that was in `toolbarControls` all along.
     *
     * Proof: the reset moved into `toolbarControls`, this failed on `expected
     * <button …(2)></button> to be null` — the control on the sheet at 390px.
     * Watched, 2026-08-09.
     *
     * A width alone never offers the reset here either: the sheet's reset is
     * the Gantt-only `resetGanttSettings`, and a card has no columns to widen,
     * so a width override is nothing the card can forget.
     */
    localStorage.setItem('wbs.columnWidths.p1', JSON.stringify({ number: 240 }));
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();
    // The sheet really is holding the toolbar, which is what makes the absence
    // below a fact about this control rather than about an empty dialog.
    expect(await screen.findByRole('button', { name: 'Add work item' })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    // And no handle anywhere on the page: the cards have no column edges to
    // grab, and the table that does is not rendered at all.
    expect(document.querySelectorAll('[data-resize-handle]').length).toBe(0);
  });

  itDom(
    'offers a Gantt-only Reset layout on the sheet, and it clears the chart settings',
    async () => {
      // The phone's reset is the Gantt-only half: a card has a chart height, a
      // day scale and row-name labels, but no columns to widen — so the sheet
      // carries `resetGanttSettings`, never the width half.
      localStorage.setItem('wbs.ganttHeight.p1', '500');
      localStorage.setItem('wbs.ganttDayPx.p1', '12');
      localStorage.setItem('wbs.ganttLabels.p1', JSON.stringify(false));
      const api = fakeApi();
      widthIs(PHONE);
      render(<WbsTable projectId="p1" api={api} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
      });
      openTheSheet();
      fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

      expect(localStorage.getItem('wbs.ganttHeight.p1')).toBeNull();
      expect(localStorage.getItem('wbs.ganttDayPx.p1')).toBeNull();
      expect(localStorage.getItem('wbs.ganttLabels.p1')).toBeNull();

      // The click closed the sheet — every button inside it does — so the
      // absence below would be vacuous without reopening it. Reopen, confirm
      // the sheet is really up again, then assert the action is gone.
      openTheSheet();
      expect(await screen.findByRole('button', { name: 'Add work item' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    },
  );

  itDom('holds the page’s own shortcuts back while it is open', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    const sheet = await screen.findByRole('dialog', { name: 'Plan actions' });
    fireEvent.keyDown(sheet, { key: '?' });

    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});

describe('what a card says about capacity', () => {
  /**
   * A plan on a phone, arranged before the first render.
   *
   * `arrange` is handed the fake's own rows and teams, which is how a label and
   * a parallelism get onto a plan the cards themselves never write either to.
   */
  async function aPlan(
    arrange: (rows: WorkItemView[], teams: TeamView[], api: ReturnType<typeof fakeApi>) => void,
    howMany = 1,
  ): Promise<void> {
    const api = fakeApi();
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows, api.teams, api);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  const teamOnCard = (): HTMLElement | null => document.querySelector('[data-card-team]');
  const parallelOnCard = (): HTMLElement | null => document.querySelector('[data-card-parallel]');

  itDom('names the team a row carries', async () => {
    await aPlan((rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' });
      rows[0].serviceTeamId = 't1';
      rows[0].teamIds = ['t1'];
    });

    expect(teamOnCard()?.textContent).toBe('Billing');
    expect(teamOnCard()?.getAttribute('data-inherited')).toBeNull();
  });

  itDom('marks a team a row only inherits, and names where the label was written', async () => {
    // The card is the only face some readers have, and a leaf under a labelled
    // parent is on that parent's pool: its dates moved for a number written a
    // row above it. A card showing nothing there cannot explain them.
    //
    // Proof: `teamLabel` pointed back at the stored label — the `teamName` this
    // change replaced, `teamLabelOf(row.serviceTeamId)` — and this failed on
    // `expected undefined to be '↳ Billing'`: the inheriting card drew no team
    // line at all. Watched 2026-08-13.
    await aPlan((rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' });
      const [parent, child] = rows;
      parent.serviceTeamId = 't1';
      parent.teamIds = ['t1'];
      child.parentId = parent.id;
      parent.rolledUp = true;
    }, 2);

    const cards = [...document.querySelectorAll('[data-card-team]')];
    expect(cards[0]?.textContent).toBe('Billing');
    expect(cards[1]?.textContent).toBe('↳ Billing');
    expect(cards[1]?.getAttribute('data-inherited')).toBe('true');
    expect(cards[1]?.getAttribute('title')).toContain('inherited from');
  });

  itDom('draws no team line at all where nothing above carries a label', async () => {
    await aPlan(() => {
      // Nothing arranged: the plan every project starts as.
    });

    expect(teamOnCard()).toBeNull();
  });

  const serviceOnCard = (): HTMLElement | null => document.querySelector('[data-card-service]');

  itDom('names every service a row carries, not the first of them', async () => {
    // The set, on the last surface that was still narrowing it. The store, the
    // wire, the filter facet and the table's cell all widened in section 10;
    // a card that printed `Payments` on a row delivering two would be a phone
    // reader's only face disagreeing with every other one.
    await aPlan((rows, _teams, api) => {
      api.services.push({ id: 's1', name: 'Payments' }, { id: 's2', name: 'Ledger' });
      rows[0].serviceIds = ['s1', 's2'];
    });

    expect(serviceOnCard()?.textContent).toBe('Payments, Ledger');
    expect(serviceOnCard()?.getAttribute('data-inherited')).toBeNull();
  });

  itDom('marks a service a row only inherits, and names where the label was written', async () => {
    // The team chip's glyph and the team chip's sentence, third dimension over:
    // a leaf under a labelled parent delivers what that parent delivers, and a
    // card printing the name bare would say this row states it when it does not.
    await aPlan((rows, _teams, api) => {
      api.services.push({ id: 's1', name: 'Payments' });
      const [parent, child] = rows;
      parent.serviceIds = ['s1'];
      child.parentId = parent.id;
      parent.rolledUp = true;
    }, 2);

    const cards = [...document.querySelectorAll('[data-card-service]')];
    expect(cards[0]?.textContent).toBe('Payments');
    expect(cards[1]?.textContent).toBe('↳ Payments');
    expect(cards[1]?.getAttribute('data-inherited')).toBe('true');
    expect(cards[1]?.getAttribute('title')).toContain('inherited from');
  });

  itDom('draws no service line at all where nothing above delivers anything', async () => {
    await aPlan(() => {
      // Nothing arranged: the plan every project starts as.
    });

    expect(serviceOnCard()).toBeNull();
  });

  itDom('prints the three labels in the order the table puts its columns in', async () => {
    // `Service/team`, `Tags`, `Services` — `wbs-table.tsx`'s column list, and
    // therefore this card's chip order. A reader moving between the two faces
    // of one plan should find its labels in one sequence, and nothing else on
    // a card asserts sibling order, so without this case the chip is free to
    // drift back.
    //
    // Proof: the chip moved up between the team and the tags — where it was
    // first written, before the table's order was read — and this fails on the
    // middle name. The first version of this case arranged no tag at all and
    // stayed green through exactly that move, which is why all three
    // dimensions are stated here. Watched 2026-08-21.
    await aPlan((rows, teams, api) => {
      teams.push({ id: 't1', name: 'Billing' });
      api.services.push({ id: 's1', name: 'Payments' });
      api.tags.push({ id: 'g1', name: 'regulatory' });
      rows[0].serviceTeamId = 't1';
      rows[0].teamIds = ['t1'];
      rows[0].serviceIds = ['s1'];
      rows[0].tagIds = ['g1'];
    });

    const chips = [
      ...document.querySelectorAll('[data-card-team], [data-card-service], [data-card-tags]'),
    ];
    expect(chips.map((chip) => chip.textContent)).toEqual(['Billing', 'regulatory', 'Payments']);
  });

  /**
   * The narrow-width sibling of `wbs-table.test.tsx`'s two marker cases, which
   * assert the same two sentences at `LAPTOP` (`marks the service cell of a row
   * a non-owner is building` and `marks the assignee on a folded role`).
   *
   * Filed as `phone-mismatch-markers` off a Browser Use Cloud walk of dev on
   * 2026-08-22: at 390px both markers were counted in the DOM and there were
   * **none** — 0 `[title]` matching either sentence, 0 `△` in `innerText` —
   * against 2 and 2 on the same rows at desktop width, while the card went on
   * printing the team and the service that constitute the mismatch. The
   * `serviceLabel` prop's own JSDoc had recorded the gap as a deliberate
   * both-or-neither decision; this is the both.
   *
   * `Kat` is the fake's one person and belongs to no team, so a row carrying a
   * team is a row she is assigned outside of; `Billing` owns nothing, so a row
   * delivering `Payments` is built by a non-owner. One row provokes both, which
   * is what the pairing rule needs asserted together.
   */
  const mismatchesOnCard = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-card-mismatch]'),
  ];

  const aMismatchedPlan = async (howMany = 1): Promise<void> => {
    await aPlan((rows, teams, api) => {
      teams.push({ id: 't1', name: 'Billing', serviceIds: [] });
      api.services.push({ id: 's1', name: 'Payments' });
      rows[0].serviceTeamId = 't1';
      rows[0].teamIds = ['t1'];
      rows[0].serviceIds = ['s1'];
      void api.assign(rows[0].id, DEV.id, 'p1');
    }, howMany);
  };

  itDom('says both mismatch signals on a card, in the sentences the table hovers', async () => {
    await aMismatchedPlan();

    expect(mismatchesOnCard().map((each) => each.getAttribute('data-card-mismatch'))).toEqual([
      'service',
      'assignee',
    ]);
    // The whole sentence, not its presence: the sentence *is* the signal, and a
    // phone that drew a mark it could not explain would be the mystery 7.2
    // forbids. The same two strings `wbs-table.test.tsx` asserts on the table.
    expect(mismatchesOnCard()[0]?.textContent).toBe(
      '△Built by a non-owner: Billing does not own Payments.' +
        ' Nothing is blocked — the plan is recording this, not refusing it.',
    );
    expect(mismatchesOnCard()[1]?.textContent).toBe(
      '△Assigned outside the team: Kat is not in Billing.' +
        ' Nothing is blocked — the plan is recording this, not refusing it.',
    );
  });

  itDom(
    'prints the sentence rather than hiding it in a title, which a phone cannot open',
    async () => {
      // The breakpoint's own decision and the reason this task existed: the
      // table's mark carries its words in `title` + `aria-label`, and a `title`
      // reaches a pointer only. There is no pointer here. So the words are text —
      // asserted as *absence of a title anywhere on the block*, because a copy
      // left in one would let the visible text be deleted later and the case
      // still pass on the tooltip.
      await aMismatchedPlan();

      for (const each of mismatchesOnCard()) expect(each.getAttribute('title')).toBeNull();
      expect(document.querySelector('[data-card-mismatches]')?.getAttribute('title')).toBeNull();
      // The glyph is decoration now that the sentence beside it is the accessible
      // name; a screen reader announcing the triangle first would read it out.
      expect(mismatchesOnCard()[0]?.querySelector('[aria-hidden]')?.textContent).toBe('△');
    },
  );

  itDom('marks nothing on a row the directory has no quarrel with', async () => {
    // The control, and it is what makes the two cases above findings rather
    // than counted flags: the identical arrangement — same team, same service,
    // same assignee — with `Billing` owning `Payments` and `Kat` in `Billing`
    // provokes neither signal. A block that rendered unconditionally would put
    // a sentence on every card of a plan, which is the marker-covers-everything
    // failure `label-mismatch.ts` spends three paragraphs refusing.
    //
    // **Both halves have to be cleared and the first version cleared one.** It
    // owned the service and left Kat in no team, so the card still carried the
    // assignee sentence and the case passed only while an injection had the
    // whole block struck. Watched 2026-08-22: with the dedup injected off, this
    // failed on `expected <ul> to be null` — a control reddening for a fault it
    // was not about is a control asserting nothing.
    await aPlan((rows, teams, api) => {
      teams.push({ id: 't1', name: 'Billing', serviceIds: ['s1'] });
      api.services.push({ id: 's1', name: 'Payments' });
      api.people[0].teamIds = ['t1'];
      rows[0].serviceTeamId = 't1';
      rows[0].teamIds = ['t1'];
      rows[0].serviceIds = ['s1'];
      void api.assign(rows[0].id, DEV.id, 'p1');
    });

    expect(document.querySelector('[data-card-mismatches]')).toBeNull();
    expect(mismatchesOnCard()).toEqual([]);
  });

  itDom('says one outsider once, however many phases the plan puts them on', async () => {
    // Kat is named on Dev alone, so `doesEveryPhase` assumes her onto QA too and
    // `assigneeOn` answers with the same sentence for both roles. Two roles,
    // one fact, one line — 390px of card is not where the same words get
    // printed twice, and a signal repeated is a signal a reader stops reading.
    await aMismatchedPlan();

    expect(
      mismatchesOnCard().filter((each) => each.getAttribute('data-card-mismatch') === 'assignee'),
    ).toHaveLength(1);
  });

  itDom('names the band on a card, in its own colour', async () => {
    // The cards are the only face some readers have — a phone shows no table and
    // no chart — so this is where Dany's "ui must display differently for
    // different priorities" either lands or does not. The number is on the chip as
    // well as the name, because the table and the export both show it and a phone
    // reader comparing two screens must not have to work out which `High` is 30.
    //
    // Proof: the chip deleted from the card header, and this failed on `expected
    // null to be truthy` — a phone with no priority anywhere on it. Watched
    // 2026-08-14.
    await aPlan((rows) => {
      rows[0].priority = 5;
    });

    const chip = document.querySelector<HTMLElement>('[data-card-priority]');
    expect(chip?.textContent).toBe('Critical 5');
    expect(chip?.getAttribute('data-priority-rank')).toBe('0');
    expect(chip?.getAttribute('title')).toBe('Critical — priority 5');
    // A colour, and the plan's own — the same `priorityBandStyleOf` the table's
    // cell and the chart's cap read.
    expect(chip?.style.color).not.toBe('');
  });

  itDom('draws different bands differently, which is the whole of the ask', async () => {
    await aPlan((rows) => {
      const [first, second] = rows;
      first.priority = 5;
      second.priority = 90;
    }, 2);

    const chips = [...document.querySelectorAll<HTMLElement>('[data-card-priority]')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['Critical 5', 'Lowest 90']);
    expect(chips[0]?.style.color).not.toBe(chips[1]?.style.color);
  });

  itDom('draws no chip at all on a row nobody has prioritised', async () => {
    // The bargain every face makes with an unranked row: nothing rather than a
    // grey chip reading `—`. On a 390px screen that furniture costs the most.
    await aPlan(() => {
      // Nothing arranged: the plan every project starts as.
    });

    expect(document.querySelector('[data-card-priority]')).toBeNull();
  });

  itDom('says how many people a row runs at, and nothing at one', async () => {
    await aPlan((rows) => {
      rows[0].maxParallel = 3;
    });

    expect(parallelOnCard()?.textContent).toBe('3 at once');
    expect(parallelOnCard()?.getAttribute('data-card-parallel')).toBe('live');
  });

  itDom('leaves the line off a row nobody has widened', async () => {
    await aPlan(() => {
      // `maxParallel` is 1 on every row of every plan nobody has touched, and a
      // line saying "1 at once" under every card is furniture on a 390px
      // screen.
    });

    expect(parallelOnCard()).toBeNull();
  });

  itDom('says a parallelism is not applied where one person is named on the work', async () => {
    // C1's D3 on the phone: one human cannot work beside themselves, so the
    // number is stored and does nothing until the assignment goes.
    await aPlan((rows, _teams, api) => {
      const row = rows[0];
      row.maxParallel = 3;
      // Through the write path, because the fake derives both `assignees` and
      // `doesEveryPhase` from the assignments it holds — a row object with an
      // `assignees` written straight onto it is a shape the tree never sends.
      void api.assign(row.id, DEV.id, 'p1');
    });

    expect(parallelOnCard()?.textContent).toBe('3 at once (not applied)');
    expect(parallelOnCard()?.getAttribute('data-card-parallel')).toBe('inert');
  });

  itDom('says a parallelism on a parent is not applied either', async () => {
    // A parent holds no slices of its own, so the number decides nothing —
    // the same reading the table's cell makes, and it is made from the row
    // rather than from a prop so the two faces cannot drift.
    await aPlan((rows) => {
      const [parent, child] = rows;
      parent.maxParallel = 2;
      child.parentId = parent.id;
      parent.rolledUp = true;
    }, 2);

    expect(parallelOnCard()?.textContent).toBe('2 at once (not applied)');
  });
});

describe('what a card says about the schedule', () => {
  /** A plan on a phone, arranged before the first render — the capacity block’s own pattern. */
  async function aPlan(arrange: (rows: WorkItemView[]) => void, howMany = 1): Promise<void> {
    const api = fakeApi();
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  const slackOnCard = (): HTMLElement | null => document.querySelector('[data-card-slack]');

  itDom('says how many days a row can slip, in the table’s own word', async () => {
    // Two fields the mobile plan named as missing from the card since
    // `mobile-cards` shipped (2026-08-10) and `priority-column` (2026-08-11)
    // never reached: this is Slack. Read off `row.schedule` directly, the
    // same fields `wbs-table.tsx`'s Float column cell reads — a phone has no
    // second computation of what can slip.
    await aPlan((rows) => {
      rows[0].schedule = { ...rows[0].schedule, float: 2.5, critical: false };
    });

    expect(slackOnCard()?.textContent).toBe('2.5d slack');
    expect(slackOnCard()?.getAttribute('data-critical')).toBeNull();
    expect(slackOnCard()?.getAttribute('title')).toBe(
      'This work item can slip 2.5 workdays before the plan finishes later.',
    );
  });

  itDom('keeps the singular where a row can slip exactly one workday', async () => {
    await aPlan((rows) => {
      rows[0].schedule = { ...rows[0].schedule, float: 1, critical: false };
    });

    expect(slackOnCard()?.getAttribute('title')).toBe(
      'This work item can slip 1 workday before the plan finishes later.',
    );
  });

  itDom('says a row on the critical path has none, in the table’s own word', async () => {
    // `critical` replaces the figure outright on the table's own cell — a
    // card printing a bare `0` here would say the opposite of what the row
    // means.
    await aPlan((rows) => {
      rows[0].schedule = { ...rows[0].schedule, float: 0, critical: true };
    });

    expect(slackOnCard()?.textContent).toBe('critical');
    expect(slackOnCard()?.getAttribute('data-critical')).toBe('true');
    expect(slackOnCard()?.getAttribute('title')).toBe(
      'On the critical path: any delay here moves the whole plan’s finish.',
    );
  });

  /*
    What is holding a row's start, on the face that has no hover to ask
    (`wbs-row-waiting-explanation`, criteria 1–2 on a phone).

    Through `<WbsTable>` at 390px and never through `<PlanCards>` alone, which
    is `card-row-actions-unwired`'s lesson taken as a rule: a card prop the
    caller does not pass is a feature no reader can reach, and only a case
    through the call site can tell a wired prop from a stubbed one. These
    three run the real `startFloorByRow` over the real payload, so what they
    pin is the seam — that the phone gets the *chart's* sentence — rather than
    the prose, which `gantt-geometry.test.ts` owns.
  */
  const floorOnCard = (rowId = 'w1'): HTMLElement | null =>
    document.querySelector(`[data-card="${rowId}"] [data-card-floor]`);

  itDom('says a row nothing holds back starts with the project, in words', async () => {
    // The project-start floor prints like every other floor rather than
    // printing nothing, and that is the contract the `null` case below is
    // about: absence means the geometry could not explain the row, and it can
    // only mean that if "nothing holds this" has words of its own.
    await aPlan(() => undefined);

    expect(floorOnCard()?.textContent).toBe('Starts with the project');
  });

  itDom(
    'says a row waiting on a dependency is waiting, where the table needs a pointer',
    async () => {
      // The report this task was filed on, on the phone face: the card already
      // prints `waits for 010` and a span that starts before that row's `End`,
      // and until this line existed nothing on it reconciled the two.
      await aPlan((rows) => {
        rows[1].dependsOn = [rows[0].id];
      }, 2);

      // **`010` and not a name, because this fixture's rows have none** —
      // `api.create` takes a name optionally, like be-01's own route, so every
      // row here is one a planner added and has not yet named. That is what
      // reddened this case on chunk 8's gate: the sentence resolved the anchor
      // and printed `Waits for  (Dev)`, and `spokenNameOf` is the fix.
      // The day is absent because this plan has no start date, which is the
      // no-calendar arm rather than a missing date.
      expect(floorOnCard('w2')?.textContent).toBe('Waits for 010 (Dev)');
      // The first row is untouched by its dependant, so one card's sentence is
      // not the whole plan's.
      expect(floorOnCard('w1')?.textContent).toBe('Starts with the project');
    },
  );

  itDom('carries the whole not-before sentence, the typed reason included', async () => {
    // `notBeforeFloorWords` appends somebody's own words to the floor rather
    // than replacing it, and a card that printed the floor alone would drop
    // the only half a reader cannot get anywhere else on a phone.
    await aPlan((rows) => {
      rows[0].startNoEarlierThan = DATED_PLAN.startsOn;
      rows[0].startNoEarlierThanReason = 'waiting on client sign-off';
    });

    expect(floorOnCard()?.textContent).toBe(
      'Held by its start-no-earlier-than date — waiting on client sign-off',
    );
  });
});

describe('the trio behind a phase’s figure, on a card', () => {
  const trioOnCard = (roleId: string): HTMLElement | null =>
    document.querySelector(`[data-phase-trio="${roleId}"]`);
  const finalOnCard = (roleId: string): HTMLElement | null =>
    document.querySelector(`[data-phase-final="${roleId}"]`);
  const detailOnCard = (roleId: string): HTMLDetailsElement | null =>
    document.querySelector(`details[data-phase-detail="${roleId}"]`);

  itDom('says nothing has been estimated, in the words the hover card already prints', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(trioOnCard(DEV.id)?.textContent).toBe('No estimate yet');
    expect(finalOnCard(DEV.id)).toBeNull();
  });

  itDom(
    'reads the trio and the final off the row, in the same words `folded-role-card.tsx` prints on hover',
    async () => {
      // Read off `row.estimates` and `row.finalDays` — not the box's draft,
      // and not `estimateValue`/`combinedValue` — the same choice
      // `folded-role-card.tsx`'s own points make, and for the same reason:
      // a card is what the fold left behind, not what somebody is mid-typing.
      const api = fakeApi();
      const created = await api.create('p1', { parentId: null });
      await api.setEstimate(created.id, DEV.id, { optimistic: 2, realistic: 3, pessimistic: 8 });
      widthIs(PHONE);
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByLabelText('Name of 010');

      expect(trioOnCard(DEV.id)?.textContent).toBe('optimistic 2 · realistic 3 · pessimistic 8');
      expect(finalOnCard(DEV.id)?.textContent).toBe('Final 3.7 days');
    },
  );

  itDom('opens on a tap and stays shut until one', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const detail = detailOnCard(DEV.id);
    expect(detail?.open).toBe(false);

    const summary = detail?.querySelector('summary');
    if (summary === null || summary === undefined) throw new Error('no summary on the detail');
    fireEvent.click(summary);

    expect(detail?.open).toBe(true);
  });
});

/**
 * The three points, one box each — Dany, 2026-08-23: *"I cannot input o/r/p on
 * WBS from mobile."*
 *
 * **jsdom cannot press a soft key, so none of these claims that it can.** What
 * they hold is the half a unit test can hold: the sheet exists, its three boxes
 * are three boxes with no separator between them, each asks for the decimal
 * keypad, and what they compose goes through the shorthand's own rules rather
 * than a second estimate path. The claim that a *finger* can do it is the e2e's
 * to make, at the cards viewport, against a real browser.
 */
describe('typing a trio on a card, where the keypad has no slash', () => {
  const openTheTrioSheet = async (roleName: string, number: string): Promise<HTMLElement> => {
    fireEvent.click(screen.getByRole('button', { name: `${roleName} o, r and p for ${number}` }));
    return screen.findByRole('dialog', { name: `${roleName} estimate for ${number}` });
  };

  /**
   * A one-row phone plan, estimated before the render rather than after it: a
   * write landing behind a mounted table is a refetch this fake does not push,
   * and a sheet seeded from a row the component never saw would test the fake.
   */
  const aPhonePlan = async (days: Days | null = null): Promise<ReturnType<typeof fakeApi>> => {
    const api = fakeApi();
    const created = await api.create('p1', { parentId: null });
    if (days !== null) await api.setEstimate(created.id, DEV.id, days);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  };

  itDom('gives each point its own box, each asking for a keypad', async () => {
    // The whole bug in one assertion. `inputmode="decimal"` is specified as
    // "Numeric keys and the format separator for the locale" — no `/` — so the
    // fix cannot be a separator, it has to be the absence of one.
    const api = await aPhonePlan();
    await openTheTrioSheet('Dev', '010');

    for (const point of ['optimistic', 'realistic', 'pessimistic']) {
      const box = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for 010`);
      expect(box.getAttribute('inputmode')).toBe('decimal');
      // The table's own cell id for that point, so the three boxes on a phone
      // are the three boxes an unfolded role shows — one cell, two faces.
      expect(box.getAttribute('data-cell')).toBe(`${api.rows[0]?.id ?? ''}::role-dev-${point}`);
    }
  });

  itDom('stores what three boxes compose, exactly as `2/3/8` in one box would', async () => {
    const api = await aPhonePlan();
    await openTheTrioSheet('Dev', '010');

    fireEvent.change(screen.getByLabelText('Dev optimistic for 010'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Dev realistic for 010'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Dev pessimistic for 010'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.rows[0]?.estimates[DEV.id]).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
    // The words the card prints at rest, which is the round trip the reader
    // sees rather than the write the fake recorded.
    await waitFor(() => {
      expect(document.querySelector(`[data-phase-trio="${DEV.id}"]`)?.textContent).toBe(
        'optimistic 2 · realistic 3 · pessimistic 8',
      );
    });
  });

  itDom('refuses a trio that runs backwards, in the shorthand’s own sentence', async () => {
    // Not a second rule: the sheet composes `8/3/2` and hands it to
    // `parseTrioShorthand`, which complains rather than sorting — Dany,
    // 2026-08-06, "when inputing estimates they must not autoedit".
    const api = await aPhonePlan();
    await openTheTrioSheet('Dev', '010');

    fireEvent.change(screen.getByLabelText('Dev optimistic for 010'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Dev realistic for 010'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Dev pessimistic for 010'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Dev estimate for 010').value).toBe('8/3/2');
    });
    expect(api.rows[0]?.estimates[DEV.id]).toBeUndefined();
  });

  itDom('takes an estimate back off with its own control', async () => {
    const api = await aPhonePlan({ optimistic: 2, realistic: 3, pessimistic: 8 });
    await openTheTrioSheet('Dev', '010');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(api.rows[0]?.estimates[DEV.id]).toBeUndefined();
    });
  });

  itDom('is reachable on a phase nobody has estimated, and Clear is not', async () => {
    // The departure this file has now made five times: the words are the claim
    // and say "No estimate yet", so the control around them has to be drawn
    // anyway. `Clear` is the opposite case — there is nothing to take off.
    await aPhonePlan();
    const sheet = await openTheTrioSheet('Dev', '010');

    expect(document.querySelector(`[data-phase-trio="${DEV.id}"]`)?.textContent).toBe(
      'No estimate yet',
    );
    expect(sheet.querySelector('[data-card-trio-clear]')).toBeNull();
  });
});

/**
 * A card's ⋯ menu driven the way a person on a phone drives it: through
 * `<WbsTable>`, over a fake that records the writes.
 *
 * **This block exists because the isolated one below passed for eight days
 * while no phone could reach the menu at all.** `<PlanCards>` renders the ⋯
 * only where the caller passes `rowActions`, and until `card-row-actions-
 * unwired` the only caller that ever did was this file: `wbs-table.tsx`'s call
 * site left it out, so a card carried zero buttons on a real plan and three
 * green tests guarded it. A component test cannot tell a wired feature from an
 * unreachable one — only its call site can — and that is the gap these cases
 * close. Every assertion is on `rowActionCalls`, the request, rather than on
 * the redraw that follows it.
 */
describe('the ⋯ row-actions menu on a card in a running plan', () => {
  afterEach(cleanup);

  itDom('duplicates a row through the table’s own handler', async () => {
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('article', { name: 'Work item 010' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(api.rowActionCalls).toEqual(['duplicate:w1']);
    });
    // And the copy arrives on the same face, because a phone's only proof that
    // the duplicate happened is the card that was not there before.
    await screen.findByRole('article', { name: 'Work item 020' });
  });

  itDom('deletes a row through the table’s own handler', async () => {
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    await api.create('p1', { parentId: null });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('article', { name: 'Work item 020' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await waitFor(() => {
      expect(api.rowActionCalls).toEqual(['remove:w1']);
    });
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'Work item 010' })).toBeNull();
    });
  });

  itDom(
    'unfreezes a frozen row, and refuses to delete one, with the table’s own words',
    async () => {
      const api = fakeApi();
      await api.create('p1', { parentId: null });
      // Arranged on the row rather than through a write path: this fake has no
      // `freeze`, and what is under test is what the menu does with a frozen row,
      // not how it came to be frozen.
      api.rows[0].frozenNumber = '010';
      widthIs(PHONE);
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByRole('article', { name: 'Work item 010' });

      fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
      const items = screen.getAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual(['Duplicate', 'Unfreeze', 'Delete']);
      expect(items[2]).toHaveAttribute('title', 'Frozen — unfreeze this row before deleting it');

      // The refusal refuses on the real handler, not only on the stub the
      // isolated suite hands it.
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      expect(api.rowActionCalls).toEqual([]);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Unfreeze' }));
      await waitFor(() => {
        expect(api.rowActionCalls).toEqual(['unfreeze:w1']);
      });
    },
  );
});

/**
 * The row-actions menu tests below render `<PlanCards>` directly rather than
 * through `<WbsTable>`, unlike every other describe block in this file.
 *
 * Kept, and kept isolated, now that the call site is wired: these pin the
 * menu's own shape — the ids, the labels, the order, the 44px target, the
 * one-menu-at-a-time rule — against props a running plan cannot easily
 * arrange. What they cannot prove is reachability, which is why the block
 * above goes through `<WbsTable>` and asserts the writes.
 */
const EMPTY_SCHEDULE: ScheduleView = {
  duration: 0,
  estimated: false,
  earliestStart: 0,
  earliestFinish: 0,
  latestStart: 0,
  latestFinish: 0,
  float: 0,
  critical: false,
};

function aTreeRow(overrides: Partial<TreeRow> = {}): TreeRow {
  return {
    id: 'w1',
    parentId: null,
    revision: 0,
    number: '010',
    name: 'Strip the hull',
    notes: '',
    frozenNumber: null,
    rolledUp: false,
    estimates: {},
    dependsOn: [],
    finalDays: {},
    finalTotal: 0,
    dates: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    priority: null,
    maxParallel: 1,
    teamIds: [],
    serviceTeamId: null,
    assignees: {},
    doesEveryPhase: null,
    schedule: EMPTY_SCHEDULE,
    subRows: [],
    ...overrides,
  };
}

/**
 * Every prop `<PlanCards>` needs, stubbed to do nothing — this suite's own
 * rows carry no roles, no dependencies and no team, so the phase loop and the
 * fact line render nothing to stub wrong. `rowActions` is each test's own.
 */
function renderCards(
  rows: readonly TreeRow[],
  rowActions?: CardRowActionHandlers,
  /** The rows that answered a filter themselves, which is what the tint marks. */
  matchedIds: readonly string[] = [],
  /**
   * What holds each row's start, defaulting to the answer a payload the
   * geometry could not explain produces — which is also what every row of this
   * suite's stub tree honestly is, since none of them came from a plan.
   */
  startFloor: (row: TreeRow) => string | null = () => null,
) {
  return render(
    <PlanCards
      rows={rows.map((row) => ({
        row,
        depth: 0,
        expandable: false,
        expanded: false,
        toggleBranch: () => undefined,
        matched: matchedIds.includes(row.id),
      }))}
      roles={[]}
      priorityBands={DEFAULT_PRIORITY_BANDS}
      gridRef={() => undefined}
      commitName={() => unsent()}
      claimFocus={() => undefined}
      estimateValue={() => ''}
      estimateProblem={() => null}
      commitEstimate={() => unsent()}
      enterEstimate={() => undefined}
      readEstimate={() => undefined}
      closeMention={() => undefined}
      leaveEstimate={() => undefined}
      mentionOptions={() => []}
      assigneeOn={() => null}
      waitsFor={() => []}
      startFloor={startFloor}
      teamLabel={() => ({ state: 'none' })}
      // The three team props and the two date ones, stubbed rather than
      // omitted: they are required, this stub predates them, and a suite that
      // leaves a required prop out is one that will typecheck differently from
      // the app that uses it.
      teams={[]}
      setTeam={() => undefined}
      createTeam={() => undefined}
      // No calendar, which is what a stub tree honestly is: none of these rows
      // came from a plan, so none of them has a project start date behind it.
      // The date field draws its refusal and opens onto nothing, which is
      // exactly what these row-actions tests want it doing.
      hasCalendar={false}
      setNotBefore={() => undefined}
      setPriority={() => Promise.resolve('landed')}
      tagLabel={() => ({ state: 'none' })}
      tags={[]}
      setTags={() => undefined}
      createTag={() => undefined}
      serviceLabel={() => ({ state: 'none' })}
      services={[]}
      setServices={() => undefined}
      createService={() => undefined}
      nonOwner={() => null}
      spanOf={() => ({ start: { text: '', iso: null }, finish: { text: '', iso: null } })}
      showDay={(days) => String(days)}
      rowActions={rowActions}
    />,
  );
}

/**
 * The one thing `<PlanCards>` decides for itself about the start floor: what a
 * row it was given no sentence for looks like.
 *
 * Direct rather than through `<WbsTable>`, unlike the three cases above, and
 * for this block's stated reason — a plan a running table can arrange always
 * has a floor for every row, so the absence these pin cannot be reached from
 * there. It is reachable in production: `startFloorByRow` skips a row whose
 * payload broke a promise, and that row's card must read exactly as it did
 * before this feature existed.
 *
 * The pair, not the negative alone: a case asserting a selector finds nothing
 * passes just as well when the selector is a typo, so the one above it proves
 * the selector by finding something.
 */
describe('a card given no sentence for its start', () => {
  afterEach(cleanup);

  const floors = (): NodeListOf<Element> => document.querySelectorAll('[data-card-floor]');

  itDom('prints the sentence where there is one', () => {
    renderCards([aTreeRow()], undefined, [], () => 'Starts with the project');

    expect(floors()).toHaveLength(1);
    expect(floors()[0].textContent).toBe('Starts with the project');
  });

  itDom('prints no line at all for a row the geometry could not explain', () => {
    // Not an empty paragraph and not the word `null`: the card says what it
    // said before this existed, which is the whole of `startFloorByRow`'s
    // skip being safe to make.
    renderCards([aTreeRow()], undefined, [], () => null);

    expect(floors()).toHaveLength(0);
  });
});

const doNothingActions = (): CardRowActionHandlers => ({
  duplicate: () => undefined,
  unfreeze: () => undefined,
  remove: () => undefined,
});

describe('the ⋯ row-actions menu on a card', () => {
  afterEach(cleanup);

  itDom('prints no ⋯ button at all when the caller has not wired row actions', () => {
    renderCards([aTreeRow()]);
    expect(screen.queryByRole('button', { name: 'Actions for 010' })).toBeNull();
  });

  itDom('offers Duplicate and Delete on a row that is not frozen — the table’s own two', () => {
    renderCards([aTreeRow()], doNothingActions());
    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Duplicate',
      'Delete',
    ]);
  });

  itDom('adds Unfreeze, and refuses Delete with the table’s own sentence, on a frozen row', () => {
    renderCards([aTreeRow({ frozenNumber: '010' })], doNothingActions());
    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Duplicate', 'Unfreeze', 'Delete']);
    expect(items[2]).toHaveAttribute('title', 'Frozen — unfreeze this row before deleting it');
    expect(items[2]).toHaveAttribute('aria-disabled', 'true');
  });

  itDom('does not delete a frozen row through the menu — the refusal actually refuses', () => {
    const taken: string[] = [];
    renderCards([aTreeRow({ frozenNumber: '010' })], {
      ...doNothingActions(),
      remove: () => taken.push('delete'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(taken).toEqual([]);
  });

  itDom('duplicates and unfreezes by the row id, and deletes by the row itself', () => {
    const taken: string[] = [];
    let removed: TreeRow | null = null;
    const row = aTreeRow({ frozenNumber: '010' });
    renderCards([row], {
      duplicate: (id) => taken.push(`duplicate:${id}`),
      unfreeze: (id) => taken.push(`unfreeze:${id}`),
      remove: (deleted) => {
        removed = deleted;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unfreeze' }));
    expect(taken).toEqual(['unfreeze:w1']);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(taken).toEqual(['unfreeze:w1', 'duplicate:w1']);
    expect(removed).toBeNull();
  });

  itDom('grows the ⋯ button to a 44px tap target, the phone floor every card control keeps', () => {
    renderCards([aTreeRow()], doNothingActions());
    const button = screen.getByRole('button', { name: 'Actions for 010' });
    expect(button.style.minHeight).toBe('44px');
    expect(button.style.minWidth).toBe('44px');
  });

  itDom('keeps at most one card’s menu open at a time — the table’s own rule', () => {
    const rowA = aTreeRow({ id: 'a', number: '010' });
    const rowB = aTreeRow({ id: 'b', number: '020' });
    renderCards([rowA, rowB], doNothingActions());

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 010' }));
    expect(screen.getByRole('menu', { name: 'Actions for 010' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 020' }));
    expect(screen.queryByRole('menu', { name: 'Actions for 010' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Actions for 020' })).toBeDefined();
  });
});

describe('the mark a filter leaves on a card', () => {
  afterEach(cleanup);

  itDom('marks the card that answered the filter, and not the rows kept around it', () => {
    // The table's Name cell has carried `data-match` since `find-in-the-tree`,
    // and a phone had nothing: a narrowed list with a hit three levels down
    // read as four rows that all matched. `R10 F1`.
    const parent = aTreeRow({ id: 'a', number: '010' });
    const hit = aTreeRow({ id: 'a1', parentId: 'a', number: '010.1' });
    renderCards([parent, hit], undefined, ['a1']);

    const hitCard = screen.getByLabelText('Work item 010.1');
    expect(hitCard.dataset['match']).toBe('true');
    expect(hitCard.style.background).not.toBe('');
    // Absent, not `false`: `[data-match]` selects the hits on either face.
    const context = screen.getByLabelText('Work item 010');
    expect(context.dataset['match']).toBeUndefined();
    expect(context.style.background).toBe('');
  });

  itDom('marks nothing while no filter is on', () => {
    renderCards([aTreeRow()]);

    const card = screen.getByLabelText('Work item 010');
    expect(card.dataset['match']).toBeUndefined();
    expect(card.style.background).toBe('');
  });
});

describe('a filter on a phone', () => {
  /**
   * The plan the sheet is opened over: two roots, one of them Billing's, so a
   * facet has something to keep and something to drop.
   */
  async function aFilterablePlan(): Promise<void> {
    const api = fakeApi();
    const { id } = await api.create('p1', { parentId: null, name: 'Strip the hull' });
    await api.create('p1', { parentId: null, name: 'Paint' });
    api.teams.push({ id: 't1', name: 'Billing' });
    // By the id `create` answered with rather than by position: a fake whose
    // first row is not the row this labels is a fixture quietly filtering on
    // something else, and the label is the whole of what these two tests ask.
    const strip = api.rows.find((row) => row.id === id);
    if (strip === undefined) throw new Error('the fake lost the row it just created');
    strip.serviceTeamId = 't1';
    strip.teamIds = ['t1'];
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  const cardNumbers = (): string[] =>
    [...document.querySelectorAll('[data-card] [data-number]')].map((node) => node.textContent);

  itDom('narrows the cards, because they are the rows the table kept', async () => {
    // R10 §0: the cards read `shownRows`, the one list the table and the chart
    // read, so a facet reaches a phone by construction. Asserted rather than
    // assumed — a second narrowing path on either face is exactly what this
    // change must not have added.
    await aFilterablePlan();
    expect(cardNumbers()).toEqual(['010', '020']);

    openTheSheet();
    fireEvent.click(await screen.findByText(/^Filters/));
    fireEvent.click(screen.getByLabelText('Team Billing'));

    expect(cardNumbers()).toEqual(['010']);
    expect(document.querySelector('[data-card="w1"]')?.getAttribute('data-match')).toBe('true');
  });

  itDom('keeps the sheet open while the facets are being ticked', async () => {
    // `closingControlIn` closes the sheet on a `<button>`, which is right for
    // `Add work item` — the plan is what wants looking at next — and wrong for
    // a checkbox somebody is about to tick a second one of. A `<summary>` and
    // an `<input>` are neither.
    await aFilterablePlan();
    openTheSheet();

    fireEvent.click(await screen.findByText(/^Filters/));
    fireEvent.click(screen.getByLabelText('Team Billing'));

    expect(screen.getByLabelText('Team Billing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add work item' })).toBeInTheDocument();
  });

  itDom('says how much of the plan a facet left, on the sheet', async () => {
    await aFilterablePlan();
    openTheSheet();
    fireEvent.click(await screen.findByText(/^Filters/));
    fireEvent.click(screen.getByLabelText('Team Billing'));

    expect(screen.getByText('1 of 2 rows')).toBeInTheDocument();
  });
});

describe('setting a card’s team', () => {
  /**
   * A plan on a phone, with the fake kept — unlike `aPlan` above, which hands
   * its api to `arrange` and then drops it. What a tap *sent* is the whole
   * subject here, and `patched` is where the fake records it.
   */
  async function aPhonePlan(
    arrange: (rows: WorkItemView[], teams: TeamView[]) => void,
    howMany = 1,
    options: { refusePatch?: boolean } = {},
  ): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi(options);
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows, api.teams);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  }

  /** The control the printed team now sits inside, per card. */
  const teamFields = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-card-team-field]'),
  ];

  itDom('opens a sheet over the same cell the table’s Team box edits', async () => {
    // The `data-cell` is the contract `plan-cards.tsx` opens with — the box a
    // card mounts is the box the table mounted — and it is what makes a draft
    // survive a rotation. A sheet whose picker carried no cell id would be a
    // second box over the same field, which is the divergence the cards were
    // written not to have.
    // Proof: watched RED on h2puni at test-only 197da4f — the sheet opened but
    // `Add a team to 010` was absent; 100/103 passed.
    const api = await aPhonePlan((_rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' });
    });

    fireEvent.click(teamFields()[0]);

    const box = await screen.findByRole('combobox', { name: 'Service or team for 010' });
    expect(box.getAttribute('data-cell')).toBe(`${api.rows[0]?.id ?? ''}::team`);
    expect(screen.getByRole('button', { name: 'Add a team to 010' })).toBeInTheDocument();
  });

  itDom('opens the shared phone sheet with every selected team removable', async () => {
    await aPhonePlan((rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' }, { id: 't2', name: 'Platform' });
      rows[0].serviceTeamId = 't1';
      rows[0].teamIds = ['t1', 't2'];
    });

    fireEvent.click(teamFields()[0]);

    expect(document.querySelector('[data-reference-set="team"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Billing from 010' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Platform from 010' })).toBeInTheDocument();
  });

  itDom('keeps the shared sheet and typed team open when the write is refused', async () => {
    await aPhonePlan(
      (_rows, teams) => {
        teams.push({ id: 't1', name: 'Billing' });
      },
      1,
      { refusePatch: true },
    );

    fireEvent.click(teamFields()[0]);
    const box = await screen.findByRole<HTMLInputElement>('combobox', {
      name: 'Service or team for 010',
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Billing' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(box).toHaveValue('Billing');
    });
    expect(document.querySelector('[data-reference-set="team"]')).toBeInTheDocument();
  });

  itDom('blocks a pending team double tap and closes after it lands', async () => {
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    api.teams.push({ id: 't1', name: 'Billing' });
    let patchCalls = 0;
    let land: (() => void) | undefined;
    api.patch = async () => {
      patchCalls += 1;
      await new Promise<void>((resolve) => {
        land = resolve;
      });
    };
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    fireEvent.click(teamFields()[0]);
    const box = await screen.findByRole('combobox', { name: 'Service or team for 010' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Billing' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(patchCalls).toBe(1);
    });
    act(() => {
      land?.();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-reference-set="team"]')).toBeNull();
    });
  });

  itDom(
    'labels the row with the team the first line offers, not the one typed inside',
    async () => {
      // `team-picker-substitutes`' own case, on the face that could not reach a
      // picker at all until now: `QA` typed in full must not bind
      // `claire qa billing`. It passes here because the sheet mounts the *same*
      // `CreatablePicker` — which is the argument for not drawing a phone-shaped
      // list of its own, stated as a test rather than in a comment.
      const api = await aPhonePlan((_rows, teams) => {
        teams.push({ id: 't1', name: 'claire qa billing' }, { id: 't2', name: 'QA' });
      });

      fireEvent.click(teamFields()[0]);
      const box = await screen.findByRole('combobox', { name: 'Service or team for 010' });
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: 'QA' } });
      fireEvent.keyDown(box, { key: 'Enter' });

      await waitFor(() => {
        expect(api.patched.at(-1)).toEqual({ id: api.rows[0]?.id, teamIds: ['t2'] });
      });
      // And the card now says so, which is the half a patch alone does not prove.
      await waitFor(() => {
        expect(document.querySelector('[data-card-team]')?.textContent).toBe('QA');
      });
    },
  );

  itDom(
    'is reachable on a row that carries no team, and makes one from the name typed',
    async () => {
      // The departure from the printed chip, and the reason for it: a control
      // drawn only where a value already exists cannot set the first one. Every
      // plan starts as this row.
      const api = await aPhonePlan(() => {
        // Nothing arranged: the plan every project starts as.
      });

      // Still no *claim* about a team — `data-card-team` is the claim, and this
      // row makes none. The control around it is what is new.
      expect(document.querySelector('[data-card-team]')).toBeNull();
      expect(teamFields().length).toBe(1);

      fireEvent.click(teamFields()[0]);
      const box = await screen.findByRole('combobox', { name: 'Service or team for 010' });
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: 'Platform' } });
      fireEvent.keyDown(box, { key: 'Enter' });

      await waitFor(() => {
        expect(api.teams.map((team) => team.name)).toEqual(['Platform']);
      });
      await waitFor(() => {
        expect(document.querySelector('[data-card-team]')?.textContent).toBe('Platform');
      });
    },
  );

  itDom('clears only the row’s own team and reveals the one it inherits', async () => {
    // Proof: without the card sheet's focused-clear opt-in, this failed at
    // `getByRole('button', { name: 'Clear Service or team for 020' })` after
    // focusing the combobox. Watched in jsdom, 2026-08-23.
    const api = await aPhonePlan((rows, teams) => {
      teams.push({ id: 't-parent', name: 'Billing' }, { id: 't-child', name: 'Platform' });
      const [parent, child] = rows;
      parent.serviceTeamId = 't-parent';
      parent.teamIds = ['t-parent'];
      parent.rolledUp = true;
      child.parentId = parent.id;
      child.serviceTeamId = 't-child';
      child.teamIds = ['t-child'];
    }, 2);

    fireEvent.click(teamFields()[1]);
    const box = await screen.findByRole('combobox', { name: 'Service or team for 020' });
    fireEvent.focus(box);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Platform from 020' }));

    await waitFor(() => {
      expect(api.patched.at(-1)).toEqual({ id: api.rows[1]?.id, teamIds: [] });
    });
    await waitFor(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('[data-card-team]')];
      expect(cards[0]?.textContent).toBe('Billing');
      expect(cards[0]?.getAttribute('data-inherited')).toBeNull();
      expect(cards[1]?.textContent).toBe('↳ Billing');
      expect(cards[1]?.getAttribute('data-inherited')).toBe('true');
    });
  });
});

describe('setting a card’s tags and services', () => {
  itDom('keeps the directory as the bootstrap surface for both vocabularies', async () => {
    // Proof: with CardSetField rendered unconditionally, h2puni failed here on
    // the first selector (received a button instead of null), 103/104 passed.
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    expect(document.querySelector('[data-card-tags-field]')).toBeNull();
    expect(document.querySelector('[data-card-service-field]')).toBeNull();
  });

  async function aPhonePlan(
    arrange: (rows: WorkItemView[]) => void = () => undefined,
  ): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    api.tags.push({ id: 'tag-seed', name: 'seed tag' });
    api.services.push({ id: 'service-seed', name: 'seed service' });
    arrange(api.rows);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('creates and applies a tag from the card sheet', async () => {
    // Proof: watched RED on h2puni at test-only 197da4f — the card field was
    // absent and fireEvent.click(null) failed; 100/103 passed.
    const api = await aPhonePlan();

    fireEvent.click(document.querySelector<HTMLElement>('[data-card-tags-field]')!);
    const box = await screen.findByRole('combobox', { name: 'Tags for 010' });
    expect(screen.getByRole('button', { name: 'Add a tag to 010' })).toBeInTheDocument();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'regulatory' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(api.tags.map((tag) => tag.name)).toContain('regulatory');
      expect(api.patched.at(-1)).toEqual({ id: api.rows[0]?.id, tagIds: ['tag-regulatory'] });
    });
  });

  itDom('creates and applies a service from the card sheet', async () => {
    // Proof: watched RED beside the tag case at test-only 197da4f — the card
    // field was absent and fireEvent.click(null) failed; 100/103 passed.
    const api = await aPhonePlan();

    fireEvent.click(document.querySelector<HTMLElement>('[data-card-service-field]')!);
    const box = await screen.findByRole('combobox', { name: 'Services for 010' });
    expect(screen.getByRole('button', { name: 'Add a service to 010' })).toBeInTheDocument();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'payments' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(api.services.map((service) => service.name)).toContain('payments');
      expect(api.patched.at(-1)).toEqual({
        id: api.rows[0]?.id,
        serviceIds: ['service-payments'],
      });
    });
  });

  itDom('shows and removes the row’s own service inside the card sheet', async () => {
    const api = await aPhonePlan((rows) => {
      rows[0].serviceIds = ['service-seed'];
    });

    fireEvent.click(screen.getByRole('button', { name: 'Services for 010: seed service' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove seed service from 010' }));

    await waitFor(() => {
      expect(api.patched.at(-1)).toEqual({ id: api.rows[0]?.id, serviceIds: [] });
    });
  });
});

describe('setting a card’s earliest start', () => {
  /**
   * A phone plan **on a calendar**, which is this field's precondition rather
   * than a convenience: without a project start date be-01 ignores the
   * constraint, so a dateless fixture would only ever exercise the refusal.
   * The fake is kept, like the team's, because what a tap *sent* is the subject.
   */
  async function aDatedPhonePlan(
    arrange: (rows: WorkItemView[]) => void = () => {
      // The plan a project starts as: on a calendar, constraining nothing.
    },
  ): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi({ dated: true });
    await api.create('p1', { parentId: null });
    arrange(api.rows);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  }

  /** The control the day now sits inside, drawn on every card with or without one. */
  const dateFields = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-card-not-before-field]'),
  ];
  /** The claim, which is a different thing from the control around it. */
  const dayOnCard = (): HTMLElement | null => document.querySelector('[data-card-not-before]');

  const openTheDateSheet = async (): Promise<HTMLElement> => {
    fireEvent.click(dateFields()[0]);
    return screen.findByRole('dialog', { name: 'Earliest start for 010' });
  };

  itDom('opens a sheet over the same cell the table’s Not before box edits', async () => {
    // `plan-cards.tsx`'s opening contract, and this field's third
    // done-criterion: the box a card mounts is the box the table mounted, which
    // is what makes one draft survive a rotation instead of becoming two.
    const api = await aDatedPhonePlan();

    await openTheDateSheet();

    const box = screen.getByLabelText('Earliest start for 010', { selector: 'input[type=date]' });
    expect(box.getAttribute('data-cell')).toBe(`${api.rows[0]?.id ?? ''}::not-before`);
  });

  itDom('sends the day and the words about it as one request', async () => {
    // The whole reason `setNotBefore` grew a third parameter. `run` is
    // fire-and-forget, so a date request and a reason request issued back to
    // back are unordered, and be-01 answers the losing order with
    // `not_before_reason_needs_a_date` — which this fake now also does. Two
    // entries in `patched` here would be that bug, whether or not it happened
    // to win the race on the day.
    const api = await aDatedPhonePlan();
    const before = api.patched.length;
    await openTheDateSheet();

    fireEvent.change(
      screen.getByLabelText('Earliest start for 010', { selector: 'input[type=date]' }),
      { target: { value: DATED_PLAN.startsOn } },
    );
    fireEvent.change(screen.getByLabelText('Why 010 may not start earlier'), {
      target: { value: '  waiting on client sign-off  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.patched.slice(before)).toEqual([
        {
          id: api.rows[0]?.id,
          startNoEarlierThan: DATED_PLAN.startsOn,
          // Trimmed, and `null` would be the spelling for a blank one: one
          // sentence for "nobody has said", `setNotBeforeReason`'s own call.
          startNoEarlierThanReason: 'waiting on client sign-off',
        },
      ]);
    });
    // And the card says so, which is the half a patch alone does not prove.
    await waitFor(() => {
      expect(dayOnCard()?.textContent).toBe(
        `not before ${shortIsoDate(DATED_PLAN.startsOn, new Date())}`,
      );
    });
  });

  itDom('clears the day and the words together, in one request', async () => {
    // The control exists because a finger cannot empty a native date input, and
    // it sends the table's own null — which takes the reason with it, because
    // be-01 will not hold words about a date that has gone.
    const api = await aDatedPhonePlan((rows) => {
      rows[0].startNoEarlierThan = DATED_PLAN.startsOn;
      rows[0].startNoEarlierThanReason = 'waiting on client sign-off';
    });
    const before = api.patched.length;
    await openTheDateSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(api.patched.slice(before)).toEqual([
        {
          id: api.rows[0]?.id,
          startNoEarlierThan: null,
          startNoEarlierThanReason: null,
        },
      ]);
    });
    await waitFor(() => {
      expect(dayOnCard()).toBeNull();
    });
  });

  itDom('will not open on a plan with no start date, and says why', async () => {
    // The table cell's own refusal, word for word. A date that saved and did
    // nothing would be worse than a field that will not take one: be-01 ignores
    // the constraint entirely without a day zero to count from.
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    const field = dateFields()[0];
    expect(field.hasAttribute('disabled')).toBe(true);
    expect(field.getAttribute('title')).toBe(
      'Set the project start date first — without one there are no dates to constrain.',
    );

    fireEvent.click(field);
    expect(screen.queryByRole('dialog', { name: 'Earliest start for 010' })).toBeNull();
  });

  itDom('seeds the boxes from the row again on the second open', async () => {
    // What the `key` on the panel buys. Proof: the `key` removed, this fails on
    // `expected '1999-01-01' to be '<this year>-06-01'` — the abandoned draft
    // still in the box, offering to save a date the reader had already backed
    // out of.
    await aDatedPhonePlan((rows) => {
      rows[0].startNoEarlierThan = DATED_PLAN.startsOn;
    });
    const sheet = await openTheDateSheet();

    fireEvent.change(
      screen.getByLabelText('Earliest start for 010', { selector: 'input[type=date]' }),
      { target: { value: '1999-01-01' } },
    );
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Earliest start for 010' })).toBeNull();
    });

    await openTheDateSheet();
    expect(
      screen.getByLabelText<HTMLInputElement>('Earliest start for 010', {
        selector: 'input[type=date]',
      }).value,
    ).toBe(DATED_PLAN.startsOn);
  });
});

describe('setting a card’s priority', () => {
  /**
   * A phone plan with the fake kept, the team's and the date's shape: what a
   * tap *sent* is the subject, and `patched` is where the fake records it.
   */
  async function aPhonePlan(
    arrange: (rows: WorkItemView[]) => void = () => {
      // The plan every project starts as: nobody has ranked anything.
    },
    howMany = 1,
  ): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi();
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  }

  /** The control the chip now sits inside, drawn on every card with or without one. */
  const priorityFields = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-card-priority-field]'),
  ];
  /** The ranking, which is a different thing from the control around it. */
  const chipOnCard = (): HTMLElement | null => document.querySelector('[data-card-priority]');

  const openTheSheet = async (): Promise<HTMLElement> => {
    fireEvent.click(priorityFields()[0]);
    return screen.findByRole('dialog', { name: 'Priority for 010' });
  };

  itDom('opens a sheet over the same cell the table’s Prio box edits', async () => {
    // `plan-cards.tsx`'s opening contract and this field's third
    // done-criterion: the box a card mounts is the box the table mounted.
    const api = await aPhonePlan();

    await openTheSheet();

    expect(screen.getByLabelText('Priority for 010, as a number').getAttribute('data-cell')).toBe(
      `${api.rows[0]?.id ?? ''}::priority`,
    );
  });

  itDom(
    'is reachable on a row nobody has prioritised, and ranks it from a tapped band',
    async () => {
      // The departure this file has now made three times: the chip is the claim
      // and is absent here, so the control around it has to be drawn anyway — a
      // control that appears once a value exists cannot set the first one.
      const api = await aPhonePlan();
      expect(chipOnCard()).toBeNull();
      const before = api.patched.length;

      await openTheSheet();
      fireEvent.click(screen.getByRole('button', { name: /^High/ }));

      // 30 and not the label: `priorityTyped` resolves the name behind
      // `setPriority`, so a tapped line writes the band's own default value —
      // the same number the table's picked line writes.
      await waitFor(() => {
        expect(api.patched.slice(before)).toEqual([{ id: api.rows[0]?.id, priority: 30 }]);
      });
      await waitFor(() => {
        expect(chipOnCard()?.textContent).toBe('High 30');
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Priority for 010' })).toBeNull();
      });
    },
  );

  itDom('takes a number typed into the box, which is Dany’s other language', async () => {
    // "select priority by labels or input a number manually" (2026-08-13). The
    // ladder is five rungs and a priority is any whole number from 1 up, so a
    // sheet offering only the five would be the face that cannot say 42.
    const api = await aPhonePlan();
    const before = api.patched.length;
    await openTheSheet();

    fireEvent.change(screen.getByLabelText('Priority for 010, as a number'), {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.patched.slice(before)).toEqual([{ id: api.rows[0]?.id, priority: 42 }]);
    });
    // 42 is in `Medium`'s range (41–60), which is the resolution being shared
    // rather than the number being echoed.
    await waitFor(() => {
      expect(chipOnCard()?.textContent).toBe('Medium 42');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Priority for 010' })).toBeNull();
    });
  });

  itDom('takes a typed band name and closes after that shared writer accepts it', async () => {
    const api = await aPhonePlan();
    const before = api.patched.length;
    await openTheSheet();

    fireEvent.change(screen.getByLabelText('Priority for 010, as a number'), {
      target: { value: 'High' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.patched.slice(before)).toEqual([{ id: api.rows[0]?.id, priority: 30 }]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Priority for 010' })).toBeNull();
    });
  });

  itDom(
    'keeps a refused word in the open sheet, out loud — because null is the clear',
    async () => {
      // The refusal path is the reason {@link PlanCardsProps.setPriority} takes a
      // string, and the rule it keeps is narrower than its own sentence sounds.
      // `setPriority` refuses exactly what **JSON cannot carry**: `Number('urgent')`
      // is `NaN`, `Number('1e999')` is `Infinity`, and both arrive on the wire as
      // `null` — which is the request that *clears* a priority. So a typo left to
      // the server would silently unrank the row somebody was ranking.
      //
      // Everything finite goes out and is answered on, `1.5` and `0` and `-1`
      // included, because what a priority may *be* is be-01's rule and a second
      // copy here is one that can quietly disagree. This case was first written
      // with `1.5` on the assumption the word "whole" in the toast described the
      // guard; the fake recorded `{ priority: 1.5 }` and no toast appeared. Kept
      // as a comment because a card that grew its own parse would make exactly
      // that mistake in code.
      const api = await aPhonePlan();
      const before = api.patched.length;
      const sheet = await openTheSheet();

      const input = screen.getByLabelText('Priority for 010, as a number');
      fireEvent.change(input, {
        target: { value: 'urgent' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByText('A priority is a whole number from 1 upward.'),
      ).toBeInTheDocument();
      expect(sheet).toBeInTheDocument();
      expect(input).toHaveValue('urgent');
      expect(api.patched.slice(before)).toEqual([]);
    },
  );

  itDom('clears a ranking with its own control, and sends null rather than zero', async () => {
    // "Nobody has said" is a state a planner has to be able to get back to, and
    // emptying a box then finding Save is two gestures for one decision. The
    // empty string is the table's own reading of a cleared cell; `Number('')`
    // is 0, which is the trap the one shared writer exists to keep away from
    // both faces.
    const api = await aPhonePlan((rows) => {
      rows[0].priority = 5;
    });
    const before = api.patched.length;
    await openTheSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => {
      expect(api.patched.slice(before)).toEqual([{ id: api.rows[0]?.id, priority: null }]);
    });
    await waitFor(() => {
      expect(chipOnCard()).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Priority for 010' })).toBeNull();
    });
  });

  itDom('seeds the box from the row again on the second open', async () => {
    // What the `key` on the panel buys, `CardNotBeforeField`'s case one field
    // over. Without it the sheet re-opens holding a draft the reader backed out
    // of and offers to save it.
    await aPhonePlan((rows) => {
      rows[0].priority = 5;
    });
    const sheet = await openTheSheet();

    fireEvent.change(screen.getByLabelText('Priority for 010, as a number'), {
      target: { value: '77' },
    });
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Priority for 010' })).toBeNull();
    });

    await openTheSheet();
    expect(screen.getByLabelText<HTMLInputElement>('Priority for 010, as a number').value).toBe(
      '5',
    );
  });
});

describe('setting what a card waits for', () => {
  /**
   * A phone plan of `howMany` rows, the priority sheet's own shape: the request
   * a tap made is the subject, and `edges` is where the fake records it.
   */
  async function aPhonePlan(
    howMany = 2,
    arrange: (rows: WorkItemView[]) => void = () => {
      // A plan whose rows wait for nothing, which is what a new one is.
    },
  ): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi();
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    return api;
  }

  /**
   * Opens one card's sheet, found **by the row's number** rather than by
   * position in the card list.
   *
   * The first draft indexed `[data-card-waits-field]` and mapped `'030'` onto
   * the second card, which is how two of these six went red on the gate: they
   * clicked 020's trigger and waited for 030's dialog. The trigger and the
   * dialog now come from the one name, so a case naming a row that is not on
   * screen fails saying so instead of opening the wrong card.
   */
  const openTheSheetOn = async (number: string): Promise<HTMLElement> => {
    fireEvent.click(screen.getByRole('button', { name: `Depends on for ${number}` }));
    return screen.findByRole('dialog', { name: `Depends on for ${number}` });
  };

  itDom('opens a sheet over the same cell the table’s Depends box edits', async () => {
    // `plan-cards.tsx`'s opening contract and this field's third
    // done-criterion, for the fourth and last time.
    const api = await aPhonePlan();

    await openTheSheetOn('020');

    expect(screen.getByLabelText('Add a dependency to 020').getAttribute('data-cell')).toBe(
      `${api.rows[1]?.id ?? ''}::depends`,
    );
  });

  itDom('is reachable on a row that waits for nothing, and makes the first edge', async () => {
    // The departure this file has now made four times: `data-card-waits` is the
    // claim and is absent here, so the button around it has to be drawn anyway.
    const api = await aPhonePlan();
    expect(document.querySelector('[data-card-waits]')).toBeNull();

    await openTheSheetOn('020');
    fireEvent.click(screen.getByRole('button', { name: /^010/ }));

    await waitFor(() => {
      expect(api.edges).toEqual([`add:${api.rows[1]?.id ?? ''}:${api.rows[0]?.id ?? ''}`]);
    });
    // The line the tap wrote, read back off the card — the half a fake that
    // only recorded the request could not show.
    await waitFor(() => {
      expect(document.querySelector('[data-card-waits]')?.textContent).toBe('waits for 010');
    });
  });

  itDom('stays open after a pick, so three predecessors are one visit', async () => {
    // The table's `pickDependency` bargain, and the reason this sheet has no
    // Save: an edge is complete on its own, each is its own request judged
    // against the graph including the ones just added, so there is nothing to
    // batch and nothing to hold back. What landed shows as a line above the box.
    const api = await aPhonePlan(3);

    await openTheSheetOn('030');
    fireEvent.click(screen.getByRole('button', { name: /^010/ }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^010/ })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: /^020/ }));

    await waitFor(() => {
      expect(api.edges).toEqual([
        `add:${api.rows[2]?.id ?? ''}:${api.rows[0]?.id ?? ''}`,
        `add:${api.rows[2]?.id ?? ''}:${api.rows[1]?.id ?? ''}`,
      ]);
    });
    // Still the same sheet, never re-opened.
    expect(screen.getByRole('dialog', { name: 'Depends on for 030' })).toBeInTheDocument();
  });

  itDom('takes a wait off again with a control a finger can hit', async () => {
    // The table says this with a `✕` inside a pill about twelve pixels across.
    // A card's is a full-width line with its own named button, because chunk 3
    // had CI measure what a 21px target is worth on a phone.
    const api = await aPhonePlan(2, (rows) => {
      rows[1].dependsOn = [rows[0]?.id ?? ''];
    });

    await openTheSheetOn('020');
    fireEvent.click(screen.getByRole('button', { name: 'Stop 020 waiting for 010' }));

    await waitFor(() => {
      expect(api.edges).toEqual([`drop:${api.rows[1]?.id ?? ''}:${api.rows[0]?.id ?? ''}`]);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-card-waits]')).toBeNull();
    });
  });

  itDom('narrows the list by what is typed, over the number and the name', async () => {
    // `pickerEntries`' filter, asked of the face that had no picker at all —
    // and asked *through* the table's own `depEntriesFor`, which is the whole
    // of what these two faces share in this dimension.
    await aPhonePlan(3);

    await openTheSheetOn('030');
    fireEvent.change(screen.getByLabelText('Add a dependency to 030'), {
      target: { value: '020' },
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^010/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /^020/ })).toBeInTheDocument();
  });

  itDom('shows a row it cannot wait for, greyed, and says why', async () => {
    // `pickerEntries` relays be-01's judgement instead of dropping the row, and
    // `REFUSAL_SUFFIX` is now beside it rather than inside `wbs-table.tsx` —
    // two spellings of one refusal is how two faces drift. 020 already waits
    // for 010, so 010 waiting for 020 would loop.
    const api = await aPhonePlan(2, (rows) => {
      rows[1].dependsOn = [rows[0]?.id ?? ''];
    });
    expect(api.rows[1]?.dependsOn).toHaveLength(1);

    await openTheSheetOn('010');

    const refused = screen.getByRole('button', { name: /^020/ });
    expect(refused).toBeDisabled();
    expect(refused.textContent).toContain('would loop');
  });

  itDom(
    'locks a tapped option until its write settles, so a double tap sends one write',
    async () => {
      // The pending-option defect `wbs-dependency-sheet-pending-option-repeats`:
      // a tap that has not landed must not be offered for a second tap, because
      // two taps in that window sent two identical POSTs.
      const api = await aPhonePlan(3);
      let release!: () => void;
      const realAdd = api.addDependency.bind(api);
      const calls: string[] = [];
      api.addDependency = (id, predecessorId) => {
        calls.push(`add:${id}:${predecessorId}`);
        return new Promise<void>((resolve) => {
          release = () => {
            resolve();
          };
        }).then(() => realAdd(id, predecessorId));
      };

      await openTheSheetOn('030');
      const option = (): HTMLElement => screen.getByRole('button', { name: /^010/ });
      fireEvent.click(option());

      // Locked while the write travels — the face no longer offers it twice.
      await waitFor(() => {
        expect(option()).toBeDisabled();
      });

      // A second tap is turned away, not a second write.
      fireEvent.click(option());
      expect(calls).toHaveLength(1);

      // The write settles and the edge lands as a wait.
      release();
      await waitFor(() => {
        expect(document.querySelector('[data-card-waits]')?.textContent).toBe('waits for 010');
      });
      expect(calls).toHaveLength(1);
    },
  );

  itDom('re-offers an option be-01 refuses, once the write settles', async () => {
    // The refused peer-race arm: the tap looked valid, be-01 refused it, and
    // the row must come back on offer — not stay locked under the reader's
    // thumb. The toast is `run`'s own sentence, preserved not replaced.
    const api = await aPhonePlan(2);
    let rejectNow!: (error: unknown) => void;
    api.addDependency = () =>
      new Promise<void>((_, reject) => {
        rejectNow = reject;
      });

    await openTheSheetOn('020');
    const option = (): HTMLElement => screen.getByRole('button', { name: /^010/ });
    fireEvent.click(option());

    await waitFor(() => {
      expect(option()).toBeDisabled();
    });

    // be-01 answers: the edge is refused and the option is offered again.
    rejectNow(new Error('cycle'));
    await waitFor(() => {
      expect(option()).not.toBeDisabled();
    });
    await waitFor(() => {
      expect(screen.getByText(/would make a loop/)).toBeInTheDocument();
    });
    // Still on offer — nothing landed, and no edge was recorded.
    expect(screen.getByRole('button', { name: /^010/ })).toBeInTheDocument();
    expect(api.edges).toEqual([]);
  });

  itDom('locks a wait being removed until its write settles', async () => {
    // The remove arm: a wait whose Remove is in flight must not be tappable a
    // second time.
    const api = await aPhonePlan(2, (rows) => {
      rows[1].dependsOn = [rows[0]?.id ?? ''];
    });
    let release!: () => void;
    const realDrop = api.removeDependency.bind(api);
    api.removeDependency = (id, predecessorId) =>
      new Promise<void>((resolve) => {
        release = () => {
          resolve();
        };
      }).then(() => realDrop(id, predecessorId));

    await openTheSheetOn('020');
    const remove = (): HTMLElement =>
      screen.getByRole('button', { name: 'Stop 020 waiting for 010' });
    fireEvent.click(remove());

    await waitFor(() => {
      expect(remove()).toBeDisabled();
    });

    release();
    await waitFor(() => {
      expect(document.querySelector('[data-card-waits]')).toBeNull();
    });
    expect(api.edges).toEqual([`drop:${api.rows[1]?.id ?? ''}:${api.rows[0]?.id ?? ''}`]);
  });
});
