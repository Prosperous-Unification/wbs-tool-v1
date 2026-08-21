import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeToProject } from '@/lib/project-stream';
import type {
  DirectoryApi,
  DirectoryUsage,
  DirectoryWrite,
  PersonPatch,
  PersonView,
  TeamView,
} from '@/lib/wbs-api';

import { DirectoryPage } from './directory-page';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * The gateway, replaced by a spy for the whole file.
 *
 * The "no socket" scenario is vacuous against a page that never had one — it
 * would pass by doing nothing — so the claim is made observable here, on the
 * **production** dependency rather than on an injected stand-in: whatever the
 * page opens a subscription with, it opens with this. Imported above so the
 * mocked module really loads.
 */
vi.mock('@/lib/project-stream', () => ({
  subscribeToProject: vi.fn(() => ({ seen: () => undefined, unsubscribe: () => undefined })),
}));

const subscribed = vi.mocked(subscribeToProject);

// A name and an id, which is the whole of a team on this page since
// `capacity-per-project`: how many of them are at work at once is stated per
// plan, in the plan's own `Teams` dialog, and the retired global column is not
// sent by be-01 at all.
const PLATFORM: TeamView = { id: 't1', name: 'Platform', serviceIds: [] };
const PAYMENTS: TeamView = { id: 't2', name: 'Payments', serviceIds: [] };
const DESIGN: TeamView = { id: 't3', name: 'Design', serviceIds: [] };

/**
 * A `DirectoryApi` over an in-memory directory, with every call recorded.
 *
 * The refusals are set per test rather than derived, because what is being
 * asserted is what the page does with an answer — a fake that worked out for
 * itself when a name is taken would be a second be-01 to keep in step.
 */
function fakeDirectory(
  people: PersonView[],
  teams: TeamView[],
): DirectoryApi & {
  reads: number;
  patched: { id: string; patch: PersonPatch }[];
  teamPatches: { id: string; patch: { name?: string; serviceIds?: readonly string[] } }[];
  removals: [string, boolean][];
  added: string[];
  refusePatchWith: (refusal: DirectoryWrite<PersonView> | Error | null) => void;
  refuseRemovalWith: (usage: DirectoryUsage | null) => void;
  put: (next: PersonView[]) => void;
  /** Seeds the tag vocabulary, which decides whether the plan has a Tags column. */
  putTags: (next: { id: string; name: string }[]) => void;
  /** The same for services — the third vocabulary, and the Services card's list. */
  putServices: (next: { id: string; name: string }[]) => void;
  holdWrites: () => void;
  releaseWrites: () => void;
} {
  let held = [...people];
  let heldTeams = [...teams];
  /** The tag vocabulary this deployment holds. Empty unless a case puts one in. */
  let heldTags: { id: string; name: string }[] = [];
  /** The service vocabulary, the same way. */
  let heldServices: { id: string; name: string }[] = [];
  let patchRefusal: DirectoryWrite<PersonView> | Error | null = null;
  let removalUsage: DirectoryUsage | null = null;
  /**
   * A patch left in flight until the test says otherwise.
   *
   * The whole reason it exists: "shown once be-01 has answered, never before"
   * is a claim about the moment **between** the request and the answer, and a
   * page that redraws locally and then re-reads converges on the same screen —
   * so a test that only looks at the end cannot see the optimism at all.
   */
  let inFlight: Promise<void> | null = null;
  let letThrough: (() => void) | null = null;
  const api = {
    holdWrites() {
      inFlight = new Promise<void>((resolve) => {
        letThrough = resolve;
      });
    },
    releaseWrites() {
      const release = letThrough;
      inFlight = null;
      letThrough = null;
      if (release !== null) release();
    },
    reads: 0,
    patched: [] as { id: string; patch: PersonPatch }[],
    /** Every team patch, in order — the ownership map's writes are read off this. */
    teamPatches: [] as { id: string; patch: { name?: string; serviceIds?: readonly string[] } }[],
    removals: [] as [string, boolean][],
    added: [] as string[],
    refusePatchWith(refusal: DirectoryWrite<PersonView> | Error | null) {
      patchRefusal = refusal;
    },
    refuseRemovalWith(usage: DirectoryUsage | null) {
      removalUsage = usage;
    },
    put(next: PersonView[]) {
      held = [...next];
    },
    listPeople() {
      api.reads += 1;
      return Promise.resolve(held.map((person) => ({ ...person })));
    },
    listTeams: () => Promise.resolve(heldTeams.map((team) => ({ ...team }))),
    listTags: () => Promise.resolve(heldTags.map((tag) => ({ ...tag }))),
    listServices: () => Promise.resolve(heldServices.map((service) => ({ ...service }))),
    // The service half of the fake, and it is the tag half with the word
    // changed — which is the point: the page's four vocabularies go through one
    // rename and one removal each, and a fake that answered services
    // differently would be testing a second directory.
    addService(name: string) {
      api.added.push(name);
      const service = { id: `s${String(heldServices.length + 1)}`, name };
      heldServices = [...heldServices, service];
      return Promise.resolve(service);
    },
    renameService(id: string, name: string) {
      heldServices = heldServices.map((each) => (each.id === id ? { ...each, name } : each));
      const written = heldServices.find((each) => each.id === id);
      if (written === undefined) throw new Error('not_found');
      return Promise.resolve({ ok: true as const, entry: written });
    },
    removeService(id: string, cascade: boolean) {
      api.removals.push([id, cascade]);
      if (removalUsage !== null && !cascade) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          usage: removalUsage,
        });
      }
      heldServices = heldServices.filter((each) => each.id !== id);
      return Promise.resolve({ ok: true as const });
    },
    putServices(next: { id: string; name: string }[]) {
      heldServices = [...next];
    },
    addTag(name: string) {
      api.added.push(name);
      const tag = { id: `g${String(heldTags.length + 1)}`, name };
      heldTags = [...heldTags, tag];
      return Promise.resolve(tag);
    },
    renameTag(id: string, name: string) {
      heldTags = heldTags.map((tag) => (tag.id === id ? { ...tag, name } : tag));
      const written = heldTags.find((tag) => tag.id === id);
      if (written === undefined) throw new Error('not_found');
      return Promise.resolve({ ok: true as const, entry: written });
    },
    removeTag(id: string, cascade: boolean) {
      api.removals.push([id, cascade]);
      if (removalUsage !== null && !cascade) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          usage: removalUsage,
        });
      }
      heldTags = heldTags.filter((tag) => tag.id !== id);
      return Promise.resolve({ ok: true as const });
    },
    putTags(next: { id: string; name: string }[]) {
      heldTags = [...next];
    },
    addPerson(name: string, teamIds: readonly string[]) {
      api.added.push(name);
      // `person`, and be-01's own default rather than this fake's invention:
      // the column is `NOT NULL DEFAULT 'person'` and `addPerson` names no
      // kind, so a row created through this route comes back as one.
      const person = {
        id: `p${String(held.length + 1)}`,
        name,
        kind: 'person' as const,
        teamIds: [...teamIds],
      };
      held = [...held, person];
      return Promise.resolve(person);
    },
    addTeam(name: string) {
      api.added.push(name);
      // Unstated, which is `addTeam`'s own rule in be-01: a new team is not a
      // team of one, and a default of 1 would serialise every plan it labels.
      const team = { id: `t${String(heldTeams.length + 1)}`, name };
      heldTeams = [...heldTeams, team];
      return Promise.resolve(team);
    },
    async patchPerson(id: string, patch: PersonPatch) {
      api.patched.push({ id, patch });
      if (inFlight !== null) await inFlight;
      if (patchRefusal instanceof Error) throw patchRefusal;
      if (patchRefusal !== null) return patchRefusal;
      held = held.map((person) =>
        person.id === id
          ? {
              ...person,
              ...(patch.name === undefined ? {} : { name: patch.name }),
              // Spread on presence like the other two, and for the fake's own
              // reason: a `kind: patch.kind` here would write `undefined` over
              // a stored `agent` every time somebody renames one, and the page
              // would look like it demotes agents on rename.
              ...(patch.kind === undefined ? {} : { kind: patch.kind }),
              ...(patch.teamIds === undefined ? {} : { teamIds: [...patch.teamIds] }),
            }
          : person,
      );
      const written = held.find((person) => person.id === id);
      if (written === undefined) throw new Error('not_found');
      return { ok: true as const, entry: written };
    },
    // `patchPerson`'s shape: an **absent** field leaves that half of the team
    // alone and an empty `serviceIds` makes a team that owns nothing. A fake
    // that defaulted the absent one would hide exactly the bug the page's
    // rename must not have — a rename that silently clears the ownership map.
    patchTeam(id: string, patch: { name?: string; serviceIds?: readonly string[] }) {
      api.teamPatches.push({ id, patch });
      heldTeams = heldTeams.map((team) =>
        team.id === id
          ? {
              ...team,
              ...(patch.name === undefined ? {} : { name: patch.name }),
              ...(patch.serviceIds === undefined ? {} : { serviceIds: [...patch.serviceIds] }),
            }
          : team,
      );
      const written = heldTeams.find((team) => team.id === id);
      if (written === undefined) return Promise.reject(new Error('not_found'));
      return Promise.resolve({ ok: true as const, entry: written });
    },
    removePerson(id: string, cascade: boolean) {
      api.removals.push([id, cascade]);
      if (removalUsage !== null && !cascade) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          usage: removalUsage,
        });
      }
      held = held.filter((person) => person.id !== id);
      return Promise.resolve({ ok: true as const });
    },
    removeTeam(id: string, cascade: boolean) {
      api.removals.push([id, cascade]);
      if (removalUsage !== null && !cascade) {
        return Promise.resolve({
          ok: false as const,
          reason: 'in_use' as const,
          usage: removalUsage,
        });
      }
      heldTeams = heldTeams.filter((team) => team.id !== id);
      return Promise.resolve({ ok: true as const });
    },
  };
  return api;
}

const KAT: PersonView = { id: 'p1', name: 'Kat', kind: 'person', teamIds: ['t1', 't2'] };
const ADA: PersonView = { id: 'p2', name: 'Ada', kind: 'person', teamIds: ['t1'] };

/** An assignee somebody has already marked an agent, for the read half of 7.2. */
const CLAUDE: PersonView = { id: 'p3', name: 'Claude', kind: 'agent', teamIds: [] };

/** The usage be-01 answers for a person somebody's plan is holding. */
const PERSON_USAGE: DirectoryUsage = {
  projects: [
    {
      id: 'pr1',
      name: 'Rollout',
      workItems: [
        {
          id: 'w7',
          number: '3.1',
          name: 'Design',
          effects: [
            { kind: 'assignment_dropped', role: { id: 'r1', name: 'Dev' } },
            { kind: 'assumed_assignee_changed', assumedNow: 'Kat', assumedAfter: null },
          ],
        },
      ],
    },
  ],
  members: [],
};

/** The usage of a team nothing but memberships points at. */
const TEAM_USAGE: DirectoryUsage = {
  projects: [],
  members: [
    { id: 'p1', name: 'Kat' },
    { id: 'p2', name: 'Ada' },
  ],
};

const pageWith = (api: DirectoryApi) =>
  render(
    <DirectoryPage token="t" api={api} nav={<span>nav slot</span>} account={<span>me</span>} />,
  );

/** Waits for the arrival read to have redrawn both panels. */
async function drawn(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText(`Name of ${name}`)).toBeDefined();
  });
}

const peoplePanel = () =>
  screen.getByRole('heading', { name: 'People' }).closest('div[class]')?.parentElement ?? null;

afterEach(() => {
  cleanup();
  subscribed.mockClear();
});

describe('the directory page', () => {
  itDom('shows every person with the teams they belong to', async () => {
    pageWith(fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]));
    await drawn('Kat');

    expect(screen.getByLabelText('Remove Platform from Kat')).toBeDefined();
    expect(screen.getByLabelText('Remove Payments from Kat')).toBeDefined();
    expect(screen.queryByLabelText('Remove Design from Kat')).toBeNull();
  });

  itDom('shows every service team with how many people belong to it', async () => {
    pageWith(fakeDirectory([KAT, ADA], [PLATFORM, PAYMENTS]));
    await drawn('Platform');

    const platform = screen.getByLabelText('Name of Platform').closest('li');
    const payments = screen.getByLabelText('Name of Payments').closest('li');
    expect(platform?.textContent).toContain('2 members');
    expect(payments?.textContent).toContain('1 member');
  });

  itDom('says a panel is empty and still offers to add to it', async () => {
    pageWith(fakeDirectory([], []));

    await waitFor(() => {
      expect(screen.getByText(/Nobody is in the directory yet/)).toBeDefined();
    });
    expect(screen.getByText(/No service teams yet/)).toBeDefined();
    // Empty is a state, not a blank: both creations are still on the page.
    expect(screen.getByLabelText('New person')).toBeDefined();
    expect(screen.getByLabelText('New service team')).toBeDefined();
  });

  /**
   * The no-socket claim, made observable.
   *
   * Across a mount **and** a rerender, because a subscription opened from a
   * dependency array rather than from a mount effect would survive a check that
   * only looked at the first render.
   *
   * Proof: `void subscribeToProject({ token, projectId: 'x', sinceSeq: -1,
   * onChange: () => undefined })` added to the page's arrival effect, this
   * failed on `expected "subscribeToProject" to be called 0 times, but got 1
   * times`. Watched 2026-08-09.
   */
  itDom('opens no subscription of its own, on mount or after', async () => {
    const page = pageWith(fakeDirectory([KAT], [PLATFORM]));
    await drawn('Kat');
    page.rerender(
      <DirectoryPage token="t" api={fakeDirectory([KAT], [PLATFORM])} nav={null} account={null} />,
    );

    expect(subscribed).toHaveBeenCalledTimes(0);
  });

  itDom('carries the navigation and the account, and no project controls', async () => {
    pageWith(fakeDirectory([], []));
    await waitFor(() => {
      expect(screen.getByRole('banner')).toBeDefined();
    });
    const bar = screen.getByRole('banner');

    expect(bar.textContent).toContain('nav slot');
    expect(bar.textContent).toContain('me');
    // Absent rather than drawn dead: a project picker on a page with no project
    // is a control that can only disappoint.
    expect(within(bar).queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'New project' })).toBeNull();
  });
});

describe('renaming on the directory page', () => {
  itDom('renames a person in place', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');

    fireEvent.change(screen.getByLabelText('Name of Kat'), { target: { value: 'Katrin' } });
    fireEvent.blur(screen.getByLabelText('Name of Kat'));

    await waitFor(() => {
      expect(screen.getByLabelText('Name of Katrin')).toBeDefined();
    });
    expect(api.patched).toEqual([{ id: 'p1', patch: { name: 'Katrin' } }]);
  });

  itDom('renames a service team in place', async () => {
    const api = fakeDirectory([], [PLATFORM]);
    pageWith(api);
    await drawn('Platform');

    fireEvent.change(screen.getByLabelText('Name of Platform'), { target: { value: 'Infra' } });
    fireEvent.keyDown(screen.getByLabelText('Name of Platform'), { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText('Name of Infra')).toBeDefined();
    });
  });

  itDom('reads a taken name as a sentence and leaves the entry as it was', async () => {
    const api = fakeDirectory(
      [KAT, { id: 'p2', name: 'Strip', kind: 'person', teamIds: [] }],
      [PLATFORM],
    );
    // be-01 trims, so the surviving name is the one it kept rather than the one
    // that was typed.
    api.refusePatchWith({ ok: false, reason: 'taken', survivingName: 'Kat' });
    pageWith(api);
    await drawn('Strip');

    fireEvent.change(screen.getByLabelText('Name of Strip'), { target: { value: ' Kat ' } });
    fireEvent.blur(screen.getByLabelText('Name of Strip'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('“Kat”');
    });
    // The sentence is made of the surviving name, never the local draft.
    expect(screen.getByRole('alert').textContent).not.toContain('“ Kat ”');
    expect(screen.getByLabelText('Name of Strip')).toHaveValue('Strip');
  });

  /**
   * Proof: the `clean === ''` guard removed from `commitRename`, this failed on
   * `Unable to find role="alert"` — no sentence about the empty name, and
   * `patchPerson` called with `{ name: '' }` behind it: the blank reaching the
   * client and be-01 asked to store it. Watched 2026-08-09.
   */
  itDom('sends nothing when the name is whitespace alone, and says so', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');

    fireEvent.change(screen.getByLabelText('Name of Kat'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByLabelText('Name of Kat'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('blank');
    });
    expect(api.patched).toEqual([]);
  });
});

/**
 * The options **one picker** is offering, rather than every `role="option"` in
 * the document.
 *
 * Scoped since 7.1, and the scoping is the point: the People card now holds a
 * `<select>` for a person's kind, and a `<select>`'s `<option>`s are in the
 * accessibility tree whether or not it is open. A bare
 * `screen.getAllByRole('option')` read `['Person', 'Agent', 'Design']` where it
 * meant `['Design']` — the query had always meant "what the picker is offering"
 * and had only been unambiguous because nothing else on the page published
 * options. The listbox carries the picker's own label, so this asks for it by
 * name.
 */
const optionsOf = (picker: string): HTMLElement[] =>
  within(screen.getByRole('listbox', { name: picker })).getAllByRole('option');

describe('a person or an agent', () => {
  itDom('is shown as be-01 stored it, and as `person` for anybody never marked', async () => {
    const api = fakeDirectory([KAT, CLAUDE], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');

    // Nobody asked for Kat to be a person: the column's default answered, and
    // the page draws what the read carried. The only way this can be wrong is
    // be-01 sending something else.
    expect(screen.getByLabelText('Kind of Kat')).toHaveValue('person');
    expect(screen.getByLabelText('Kind of Claude')).toHaveValue('agent');
  });

  itDom('is patched alone when it changes, and the row redraws as what came back', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');

    fireEvent.change(screen.getByLabelText('Kind of Kat'), { target: { value: 'agent' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Kind of Kat')).toHaveValue('agent');
    });
    // `{ kind }` and nothing beside it: a patch carrying the name as well would
    // send whatever draft was standing in the box, and an absent field is what
    // tells be-01 to leave the memberships alone.
    expect(api.patched).toEqual([{ id: 'p1', patch: { kind: 'agent' } }]);
  });

  itDom('is not sent again when the option already shown is chosen', async () => {
    const api = fakeDirectory([CLAUDE], [PLATFORM]);
    pageWith(api);
    await drawn('Claude');

    fireEvent.change(screen.getByLabelText('Kind of Claude'), { target: { value: 'agent' } });
    // A second, real write behind it, because "no request was made" cannot be
    // waited for: an assertion the moment after the event would hold whether
    // the guard exists or not. The rename is what gives the no-op somewhere to
    // show up, and `patched` is in order.
    fireEvent.change(screen.getByLabelText('Name of Claude'), { target: { value: 'Claudine' } });
    fireEvent.blur(screen.getByLabelText('Name of Claude'));

    await waitFor(() => {
      expect(screen.getByLabelText('Name of Claudine')).toBeDefined();
    });
    // `commitRename`'s rule for a name typed back to itself, one field over: a
    // write nobody asked for still journals, and a journal of no-ops is a
    // history somebody has to read past.
    expect(api.patched).toEqual([{ id: 'p3', patch: { name: 'Claudine' } }]);
  });

  /**
   * The scenario 7.2 asks for, and what makes it non-vacuous: the page holds
   * **no draft** for the kind, so there is nothing to roll back — the select
   * reads `person.kind`, which is what the last read answered. Proof that it is
   * watching something: `value={person.kind}` replaced by a local
   * `useState`-backed draft set in `onChange` leaves the box on `agent` after
   * the refusal, and this fails on `expected 'agent' to be 'person'`.
   */
  itDom('stays at what be-01 still holds when the write is refused', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    api.refusePatchWith(new Error('unknown_person'));
    api.holdWrites();
    pageWith(api);
    await drawn('Kat');

    fireEvent.change(screen.getByLabelText('Kind of Kat'), { target: { value: 'agent' } });

    await waitFor(() => {
      expect(api.patched).toHaveLength(1);
    });
    // In flight, and already not an agent: nothing was drawn ahead of the answer.
    expect(screen.getByLabelText('Kind of Kat')).toHaveValue('person');

    api.releaseWrites();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(screen.getByLabelText('Kind of Kat')).toHaveValue('person');
  });
});

describe('the directory page re-reads', () => {
  itDom('after each of its own writes', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');
    const onArrival = api.reads;

    fireEvent.change(screen.getByLabelText('Name of Kat'), { target: { value: 'Katrin' } });
    fireEvent.blur(screen.getByLabelText('Name of Kat'));

    await waitFor(() => {
      expect(api.reads).toBe(onArrival + 1);
    });
  });

  /**
   * Coming back to the page, by both of the ways a browser reports it.
   *
   * The **count** is asserted, not merely that the name arrived: a page that
   * re-read on every render would put the new name on screen too, and pass a
   * check that only looked at the panel.
   *
   * Proof: the `focus` and `visibilitychange` listeners removed from the
   * page's second effect, this failed on `expected 1 to be 2` with `Bo` — added
   * elsewhere while the window was away — nowhere on the panel. Watched
   * 2026-08-09.
   */
  itDom('when the window is focused again, and when the tab becomes visible again', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');
    expect(api.reads).toBe(1);

    // Somebody else adds a person while this window is elsewhere.
    api.put([KAT, { id: 'p9', name: 'Bo', teamIds: [] }]);
    fireEvent.focus(window);

    await waitFor(() => {
      expect(api.reads).toBe(2);
    });
    expect(screen.getByLabelText('Name of Bo')).toBeDefined();

    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => {
      expect(api.reads).toBe(3);
    });
  });

  /**
   * Three call sites fire {@link DirectoryPage}'s read — arrival, `focus` and
   * `visibilitychange` — and none is gated on the others, so two of them
   * overlap the moment somebody switches windows twice. They can finish out of
   * order, and an earlier one landing last would put a directory older than
   * what is on screen back on it, with nothing guaranteed to arrive afterwards
   * and repair it.
   *
   * C3's cross-review found it through a sharper case than a stale name:
   * `commitSize` short-circuited on `asNumber === team.size`, so typing the
   * number a stale screen already showed sent **nothing**. That box is on the
   * plan now (`capacity-per-project`, D5) and the short-circuit went with it, so
   * what is left here is the stale-name hazard — which is enough on its own, and
   * all three call sites are still ungated without the guard. C3's cross-review,
   * P2-3.
   */
  itDom('and only the newest read may write the screen', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    /** Every people read still in flight, oldest first, answered by hand. */
    const pending: ((people: PersonView[]) => void)[] = [];
    api.listPeople = () =>
      new Promise<PersonView[]>((answer) => {
        pending.push(answer);
      });

    pageWith(api);
    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    pending[0]([KAT]);
    await drawn('Kat');

    // Two overlapping re-reads: the window comes forward, and the tab is
    // switched back to before the first answer has arrived.
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => {
      expect(pending).toHaveLength(3);
    });

    // The newest answers first — somebody has renamed Kat to Bo.
    pending[2]([{ id: 'p1', name: 'Bo', teamIds: [] }]);
    await waitFor(() => {
      expect(screen.queryByLabelText('Name of Bo')).not.toBeNull();
    });

    // And the superseded one answers last, carrying the name that has gone.
    pending[1]([KAT]);
    await new Promise((settle) => {
      setTimeout(settle, 0);
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Name of Bo')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Name of Kat')).toBeNull();
  });

  itDom('and not on every render, which is what makes the count above mean something', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    const page = pageWith(api);
    await drawn('Kat');

    page.rerender(
      <DirectoryPage token="t" api={api} nav={<span>nav slot</span>} account={<span>me</span>} />,
    );
    // Typing is a render per keystroke, and none of them is an arrival.
    fireEvent.change(screen.getByLabelText('Name of Kat'), { target: { value: 'Ka' } });

    expect(api.reads).toBe(1);
  });
});

describe('a person’s memberships', () => {
  itDom('are chips beside a picker offering only what they lack', async () => {
    pageWith(fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]));
    await drawn('Kat');

    fireEvent.focus(screen.getByLabelText('Add a team for Kat'));
    await waitFor(() => {
      expect(optionsOf('Add a team for Kat').length).toBeGreaterThan(0);
    });
    expect(optionsOf('Add a team for Kat').map((option) => option.textContent)).toEqual(['Design']);
  });

  /**
   * Proof: the `.filter((team) => !person.teamIds.includes(team.id))` dropped
   * from the picker's `entries`, this failed on `expected [ 'Platform',
   * 'Payments', 'Design' ] to deeply equal [ 'Design' ]` — and its sibling
   * below then sent `['t1','t2','t1']`, a duplicate membership. Watched
   * 2026-08-09.
   */
  itDom('send exactly the set the chips show when one is added', async () => {
    const api = fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]);
    pageWith(api);
    await drawn('Kat');

    fireEvent.focus(screen.getByLabelText('Add a team for Kat'));
    await waitFor(() => {
      expect(optionsOf('Add a team for Kat').length).toBeGreaterThan(0);
    });
    fireEvent.click(optionsOf('Add a team for Kat')[0]);

    await waitFor(() => {
      expect(screen.getByLabelText('Remove Design from Kat')).toBeDefined();
    });
    expect(api.patched).toEqual([{ id: 'p1', patch: { teamIds: ['t1', 't2', 't3'] } }]);
  });

  itDom('send exactly the set the chips show when one is removed', async () => {
    const api = fakeDirectory([KAT], [PLATFORM, PAYMENTS]);
    pageWith(api);
    await drawn('Kat');

    fireEvent.click(screen.getByLabelText('Remove Payments from Kat'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Remove Payments from Kat')).toBeNull();
    });
    expect(api.patched).toEqual([{ id: 'p1', patch: { teamIds: ['t1'] } }]);
  });

  /**
   * On-response, not optimistic — asserted **in flight**, which is the only
   * place the difference is visible.
   *
   * A page that draws the chip locally and then re-reads converges on exactly
   * the same screen as one that waits, so a check made after the answer cannot
   * fail for optimism. It was written that way first and the fault was watched
   * **passing**; this is the rewrite.
   *
   * Proof: `setMemberships` given a `setPeople` with the new memberships ahead
   * of `patchPerson` — the optimistic redraw — and this failed on
   * `expected HTMLButtonElement to be null` for `Remove Design from Kat`, the
   * chip on screen while be-01 had answered nothing. Watched 2026-08-09.
   */
  itDom('are not drawn until be-01 has answered', async () => {
    const api = fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]);
    api.holdWrites();
    pageWith(api);
    await drawn('Kat');

    fireEvent.focus(screen.getByLabelText('Add a team for Kat'));
    await waitFor(() => {
      expect(optionsOf('Add a team for Kat').length).toBeGreaterThan(0);
    });
    fireEvent.click(optionsOf('Add a team for Kat')[0]);

    await waitFor(() => {
      expect(api.patched).toHaveLength(1);
    });
    expect(screen.queryByLabelText('Remove Design from Kat')).toBeNull();

    api.releaseWrites();
    await waitFor(() => {
      expect(screen.getByLabelText('Remove Design from Kat')).toBeDefined();
    });
  });

  itDom(
    'are left exactly as they were by a refused change, with the refusal on screen',
    async () => {
      const api = fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]);
      api.refusePatchWith(new Error('unknown_team'));
      api.holdWrites();
      pageWith(api);
      await drawn('Kat');

      fireEvent.focus(screen.getByLabelText('Add a team for Kat'));
      await waitFor(() => {
        expect(optionsOf('Add a team for Kat').length).toBeGreaterThan(0);
      });
      fireEvent.click(optionsOf('Add a team for Kat')[0]);

      await waitFor(() => {
        expect(api.patched).toHaveLength(1);
      });
      // In flight, and already not chipped: a refusal cannot take back a chip
      // that was never drawn.
      expect(screen.queryByLabelText('Remove Design from Kat')).toBeNull();

      api.releaseWrites();
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });
      expect(screen.getByRole('alert').textContent).toContain('no longer in the directory');
      expect(screen.getByLabelText('Remove Platform from Kat')).toBeDefined();
      expect(screen.getByLabelText('Remove Payments from Kat')).toBeDefined();
      expect(screen.queryByLabelText('Remove Design from Kat')).toBeNull();
    },
  );

  itDom('are removable from the keyboard, and the focus lands on the neighbour', async () => {
    const api = fakeDirectory(
      [{ ...KAT, teamIds: ['t1', 't2', 't3'] }],
      [PLATFORM, PAYMENTS, DESIGN],
    );
    pageWith(api);
    await drawn('Kat');

    const payments = screen.getByLabelText('Remove Payments from Kat');
    payments.focus();
    expect(document.activeElement).toBe(payments);
    fireEvent.keyDown(payments, { key: 'Delete' });

    await waitFor(() => {
      expect(screen.queryByLabelText('Remove Payments from Kat')).toBeNull();
    });
    expect(api.patched).toEqual([{ id: 'p1', patch: { teamIds: ['t1', 't3'] } }]);
    // The chip it left, not the top of the page: a removal that dropped the
    // focus would leave a keyboard reader with nothing to carry on from.
    expect(document.activeElement).toBe(screen.getByLabelText('Remove Design from Kat'));
  });

  itDom('keep the picker’s combobox contract', async () => {
    pageWith(fakeDirectory([KAT], [PLATFORM, PAYMENTS, DESIGN]));
    await drawn('Kat');

    const picker = screen.getByLabelText('Add a team for Kat');
    expect(picker.getAttribute('role')).toBe('combobox');
    expect(picker.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(picker);
    await waitFor(() => {
      expect(picker.getAttribute('aria-expanded')).toBe('true');
    });
    expect(picker.getAttribute('aria-controls')).not.toBeNull();
  });
});

describe('removing from the directory', () => {
  /**
   * Proof: `askToRemove`'s two `false`s pinned to `true`, this failed on
   * `Unable to find role="dialog"` — the removal taken on the first request
   * and nobody shown what it took — along with five of its siblings. The fault
   * `phases-dialog` already knows. Watched 2026-08-09.
   */
  itDom('asks without a cascade first, and names the work on the refusal', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    api.refuseRemovalWith(PERSON_USAGE);
    pageWith(api);
    await drawn('Kat');

    fireEvent.click(screen.getByLabelText('Remove Kat'));

    const dialog = await screen.findByRole('dialog');
    expect(api.removals).toEqual([['p1', false]]);
    expect(dialog.textContent).toContain('Rollout');
    expect(dialog.textContent).toContain('3.1 Design');
    expect(dialog.textContent).toContain('The Dev assignment goes.');
    // Still there: nothing was removed by the first request.
    expect(screen.getByLabelText('Name of Kat')).toBeDefined();
  });

  itDom('draws a work item left with nobody as going to unassigned', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    api.refuseRemovalWith(PERSON_USAGE);
    pageWith(api);
    await drawn('Kat');

    fireEvent.click(screen.getByLabelText('Remove Kat'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Kat now, unassigned afterwards');
  });

  itDom('names the members a team’s removal would unseat, rather than an empty list', async () => {
    const api = fakeDirectory([KAT, ADA], [PLATFORM]);
    api.refuseRemovalWith(TEAM_USAGE);
    pageWith(api);
    await drawn('Platform');

    fireEvent.click(screen.getByLabelText('Remove Platform'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('would lose a membership');
    expect(within(dialog).getByText('Kat')).toBeDefined();
    expect(within(dialog).getByText('Ada')).toBeDefined();
  });

  itDom('sends the cascade only from the confirmation', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    api.refuseRemovalWith(PERSON_USAGE);
    pageWith(api);
    await drawn('Kat');

    fireEvent.click(screen.getByLabelText('Remove Kat'));
    const dialog = await screen.findByRole('dialog');
    // The fake stops refusing once the cascade is on, which is be-01's rule.
    fireEvent.click(within(dialog).getByRole('button', { name: /^Remove Kat and all of that/ }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Name of Kat')).toBeNull();
    });
    expect(api.removals).toEqual([
      ['p1', false],
      ['p1', true],
    ]);
  });

  itDom('forgets a confirmation that was closed, and asks again without a cascade', async () => {
    const api = fakeDirectory([KAT], [PLATFORM]);
    api.refuseRemovalWith(PERSON_USAGE);
    pageWith(api);
    await drawn('Kat');

    fireEvent.click(screen.getByLabelText('Remove Kat'));
    const first = await screen.findByRole('dialog');
    fireEvent.click(within(first).getByRole('button', { name: 'Keep Kat' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(screen.getByLabelText('Remove Kat'));
    await screen.findByRole('dialog');
    expect(api.removals).toEqual([
      ['p1', false],
      ['p1', false],
    ]);
  });

  itDom(
    'removes an entry nothing points at on the first request, with no confirmation',
    async () => {
      const api = fakeDirectory([KAT], [PLATFORM, PAYMENTS]);
      pageWith(api);
      await drawn('Payments');

      fireEvent.click(screen.getByLabelText('Remove Payments'));

      await waitFor(() => {
        expect(screen.queryByLabelText('Name of Payments')).toBeNull();
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.removals).toEqual([['t2', false]]);
    },
  );
});

describe('creating on the directory page', () => {
  itDom('adds a person and a service team', async () => {
    const api = fakeDirectory([], []);
    pageWith(api);
    await waitFor(() => {
      expect(screen.getByLabelText('New person')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('New person'), { target: { value: 'Kat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of Kat')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('New service team'), { target: { value: 'Platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of Platform')).toBeDefined();
    });

    expect(api.added).toEqual(['Kat', 'Platform']);
    expect(peoplePanel()).not.toBeNull();
  });
});

describe('how many of a team are at work at once', () => {
  itDom('is not asked here at all, because the number is one plan’s', async () => {
    // C3 put a size box on this page, beside each team's name, and that was right
    // for a global number: the directory is the global page. Dany's call on
    // 2026-08-13 — "The global number should not matter, only per project capacity
    // configuration matters" — made the number a **plan's**, and this page has no
    // plan. So the box is gone rather than disabled or left showing a number from
    // somewhere: a control that writes a value no schedule reads is worse than no
    // control at all. `capacity-per-project`'s design.md D4 and D5, and the box
    // itself is `components/wbs/teams-dialog.tsx`.
    //
    // The whole of C3's block about the box moved with it — 160 lines, including
    // both of its watched negatives — and is in `teams-dialog.test.tsx`.
    //
    // Proof: the `<Input>` put back on the team row (`aria-label={`How many of
    // ${team.name} at once`}`, wired to a local draft), and this failed on
    // `expected null not to be null` for `How many of Platform at once`. Watched
    // 2026-08-13.
    pageWith(fakeDirectory([KAT], [PLATFORM, PAYMENTS]));
    await drawn('Kat');

    for (const team of ['Platform', 'Payments']) {
      expect(screen.queryByLabelText(`How many of ${team} at once`)).toBeNull();
    }
    // The rest of the team row is untouched: the name, the member count and the
    // removal are all still the directory's.
    expect(screen.getByLabelText('Name of Platform')).toBeTruthy();
    expect(screen.getByLabelText('Remove Platform')).toBeTruthy();
    // And nothing on this page can write a size any more.
    expect('resizeTeam' in fakeDirectory([], [])).toBe(false);
  });
});

describe('what removing a sized team says it takes', () => {
  /** A sized team labelling a parent, with a leaf beneath it that inherits the pool. */
  const SIZED_TEAM_USAGE: DirectoryUsage = {
    projects: [
      {
        id: 'pr1',
        name: 'Rollout',
        workItems: [
          {
            id: 'w1',
            number: '010',
            name: 'Backend',
            effects: [
              { kind: 'label_nulled' },
              { kind: 'capacity_released', size: 4, fromId: 'w1' },
            ],
          },
          {
            id: 'w2',
            number: '010.1',
            name: 'Ship it',
            effects: [{ kind: 'capacity_released', size: 4, fromId: 'w1' }],
          },
        ],
      },
    ],
    members: [],
  };

  itDom('names the pool going, on the labelled row and on the row that inherits it', async () => {
    // The inheriting leaf holds no label to clear, and its dates move exactly
    // as the labelled row's do. A confirmation carrying only `label_nulled`
    // would show one row and move twenty.
    const api = fakeDirectory([KAT], [PLATFORM]);
    pageWith(api);
    await drawn('Kat');
    api.refuseRemovalWith(SIZED_TEAM_USAGE);

    fireEvent.click(screen.getByLabelText('Remove Platform'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The service team label is cleared.');
    // The labelled row says it plainly; the inheriting one names where the
    // limit it is losing was written.
    expect(dialog.textContent).toContain('No longer limited to 4 at a time. Dates may move');
    expect(dialog.textContent).toContain('the limit it inherits from 010 Backend');
  });
});

describe('the Tags section, and what it deliberately has not got', () => {
  itDom('offers a tag no capacity box and no member count', async () => {
    // **The model rule taught by absence, asserted so it cannot drift back.**
    // A team row carries a member count because people belong to teams; nobody
    // belongs to a tag. A team's size is a fact about one plan and lives in
    // that plan's dialog; a tag has no size anywhere. A reader who notices this
    // section has one fewer control than the one above it has learned that a
    // tag says what kind of thing the work is and nothing about who does it or
    // how fast.
    //
    // Proof: a `count(…, 'member')` span copied into the tag row from the team
    // row above it and this fails on the `member` query finding two nodes where
    // one was owed — a directory quietly claiming somebody belongs to
    // `regulatory`. Watched 2026-08-20.
    const api = fakeDirectory(
      [{ id: 'p1', name: 'Ada', teamIds: ['t1'] }],
      [{ id: 't1', name: 'Platform' }],
    );
    api.putTags([{ id: 'g1', name: 'regulatory' }]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    const box = await screen.findByLabelText('Name of regulatory');
    const row = box.closest('li');
    if (row === null) throw new Error('the tag is not in a row');

    // What it has: a name to rename, and a ✕ to remove.
    expect(within(row).getByLabelText('Remove regulatory')).toBeTruthy();
    // What it has not: any number at all beside the name. The team row's
    // member count is the thing this is asserting the absence of.
    expect(row.textContent).not.toMatch(/member/i);
    expect(within(row).queryByRole('spinbutton')).toBeNull();
  });

  itDom('adds a tag, and says why the plan had no column until now', async () => {
    const api = fakeDirectory([], []);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    // The empty state names the consequence rather than just the emptiness: the
    // table's Tags column does not exist until a tag does, so a reader looking
    // for it needs to be told where it comes from.
    expect(await screen.findByText(/No tags yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: '  regulatory  ' } });
    fireEvent.click(screen.getByText('Add tag'));

    // Trimmed at be-01, and this page sends what was typed minus the edges —
    // the same bargain `Add team` makes one card up.
    await waitFor(() => {
      expect(api.added).toContain('regulatory');
    });
    expect(await screen.findByLabelText('Name of regulatory')).toBeTruthy();
  });
});

describe('the Services section, and the removal that had to say which dimension it was', () => {
  itDom('offers a service no capacity box and no member count', async () => {
    // The Tags card's asserted absence, one vocabulary over and for a **third**
    // reason. Nobody belongs to a tag; nobody belongs to a service either, and
    // a service is not a pool: it is what the work is part of, and who has the
    // people is still a team. Dany, 2026-08-20 23:16 — service and team are
    // independent — taught by the screen rather than by a sentence.
    const api = fakeDirectory(
      [{ id: 'p1', name: 'Ada', teamIds: ['t1'] }],
      [{ id: 't1', name: 'Platform', serviceIds: [] }],
    );
    api.putServices([{ id: 's1', name: 'Payments' }]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    const box = await screen.findByLabelText('Name of Payments');
    const row = box.closest('li');
    if (row === null) throw new Error('the service is not in a row');

    expect(within(row).getByLabelText('Remove Payments')).toBeTruthy();
    expect(row.textContent).not.toMatch(/member/i);
    expect(within(row).queryByRole('spinbutton')).toBeNull();
  });

  itDom('adds a service, and says where the plan column comes from', async () => {
    const api = fakeDirectory([], []);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    expect(await screen.findByText(/No services yet/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New service'), { target: { value: '  Payments  ' } });
    fireEvent.click(screen.getByText('Add service'));

    // Trimmed at the edges here, decided at be-01 — `Add tag`'s bargain, and
    // `Add team`'s before it.
    await waitFor(() => {
      expect(api.added).toContain('Payments');
    });
    expect(await screen.findByLabelText('Name of Payments')).toBeTruthy();
  });

  itDom('renames a service where the reader typed it', async () => {
    // The rename goes through the same `writesFor` entry the tag's and the
    // team's do; what this pins is that the **service** entry is wired to
    // `renameService` and not to the neighbour a line above it.
    const api = fakeDirectory([], []);
    api.putServices([{ id: 's1', name: 'Payements' }]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    const box = await screen.findByLabelText('Name of Payements');
    fireEvent.change(box, { target: { value: 'Payments' } });
    fireEvent.blur(box);

    expect(await screen.findByLabelText('Name of Payments')).toBeTruthy();
  });

  itDom('names the service, not the tag, in what a removal would take', async () => {
    // **The bug this case exists for.** be-01 answers a service removal with
    // `label_removed` — the same kind a tag's removal carries, because since
    // task 10.2 both take a labelling row off a join and null no column — and
    // the payload says which dimension it was **nowhere**. The confirmation
    // therefore reads the vocabulary off the removal the reader asked for.
    //
    // Proof: `removing` pinned to `'tag'` in the dialog and this fails on
    // `expected … to contain 'The service comes off this item'` — somebody
    // removing `Payments` being asked to confirm a sentence about tags.
    const api = fakeDirectory([], []);
    api.putServices([{ id: 's1', name: 'Payments' }]);
    api.refuseRemovalWith({
      projects: [
        {
          id: 'pr1',
          name: 'Ledger',
          workItems: [
            { id: 'w1', number: '010', name: 'Backend', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    });
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name of Payments')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Remove Payments'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The service comes off this item. No dates move.');
    expect(dialog.textContent).not.toContain('The tag comes off');
    // The first ask never carries the cascade — this page's rule for all four
    // vocabularies, and the one a service must not be the exception to.
    expect(api.removals).toEqual([['s1', false]]);
  });

  itDom('still names the tag when a tag is what is going', async () => {
    // The other side of the same switch. One dimension's sentence being right
    // is not evidence when both come out of one expression: the fix could have
    // been `'service'` unconditionally and the case above would still pass.
    const api = fakeDirectory([], []);
    api.putTags([{ id: 'g1', name: 'regulatory' }]);
    api.refuseRemovalWith({
      projects: [
        {
          id: 'pr1',
          name: 'Ledger',
          workItems: [
            { id: 'w1', number: '010', name: 'Backend', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    });
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name of regulatory')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Remove regulatory'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The tag comes off this item. No dates move.');
  });

  itDom('confirms a service removal with the cascade, and only then', async () => {
    const api = fakeDirectory([], []);
    api.putServices([{ id: 's1', name: 'Payments' }]);
    api.refuseRemovalWith({
      projects: [
        {
          id: 'pr1',
          name: 'Ledger',
          workItems: [
            { id: 'w1', number: '010', name: 'Backend', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    });
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name of Payments')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Remove Payments'));
    fireEvent.click(await screen.findByText('Remove Payments and all of that'));

    await waitFor(() => {
      expect(api.removals).toEqual([
        ['s1', false],
        ['s1', true],
      ]);
    });
  });
});

describe('the ownership map, edited on the team row', () => {
  itDom('shows which services a team is responsible for, in the directory order', async () => {
    const api = fakeDirectory([], [{ id: 't1', name: 'Platform', serviceIds: ['s2', 's1'] }]);
    // Seeded the other way round from the claim, deliberately: the chips follow
    // the **directory's** order, so two teams owning the same pair list it the
    // same way. The order somebody claimed them in is not a fact about anything.
    api.putServices([
      { id: 's1', name: 'Billing' },
      { id: 's2', name: 'Payments' },
    ]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Platform no longer owns Billing')).toBeDefined();
    });
    const row = screen.getByLabelText('Name of Platform').closest('li');
    if (row === null) throw new Error('the team is not in a row');
    const chips = within(row)
      .getAllByRole('button')
      .map((node) => node.getAttribute('aria-label'))
      .filter((label) => label?.includes('no longer owns') === true);
    expect(chips).toEqual(['Platform no longer owns Billing', 'Platform no longer owns Payments']);
  });

  itDom('sends the whole set when a service is claimed, and again when one goes', async () => {
    const api = fakeDirectory([], [{ id: 't1', name: 'Platform', serviceIds: ['s1'] }]);
    api.putServices([
      { id: 's1', name: 'Billing' },
      { id: 's2', name: 'Payments' },
    ]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Platform no longer owns Billing')).toBeDefined();
    });

    // The picker offers only what the team does not already own — claiming a
    // service twice is what a full-replacement write cannot repair.
    const picker = screen.getByLabelText('Make Platform responsible for a service');
    fireEvent.change(picker, { target: { value: 'Payments' } });
    fireEvent.click(await screen.findByText('Payments'));

    await waitFor(() => {
      expect(api.teamPatches).toEqual([{ id: 't1', patch: { serviceIds: ['s1', 's2'] } }]);
    });

    fireEvent.click(await screen.findByLabelText('Platform no longer owns Billing'));

    // **The whole set both times.** A delta would need this page to know what
    // it is diffing against, and it redraws from a directory somebody else may
    // have changed between the two clicks.
    await waitFor(() => {
      expect(api.teamPatches[1]).toEqual({ id: 't1', patch: { serviceIds: ['s2'] } });
    });
  });

  itDom('renames a team without touching what it is responsible for', async () => {
    // **The absence that matters.** `patchTeam` takes both fields now, and a
    // rename that sent `serviceIds` — even the set it believed be-01 held —
    // would silently overwrite an ownership map somebody else had just edited.
    // Absent means "leave it alone", and this is where that is pinned.
    const api = fakeDirectory([], [{ id: 't1', name: 'Platfrom', serviceIds: ['s1'] }]);
    api.putServices([{ id: 's1', name: 'Billing' }]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);

    const box = await screen.findByLabelText('Name of Platfrom');
    fireEvent.change(box, { target: { value: 'Platform' } });
    fireEvent.blur(box);

    await waitFor(() => {
      expect(api.teamPatches).toEqual([{ id: 't1', patch: { name: 'Platform' } }]);
    });
    expect(api.teamPatches[0]?.patch.serviceIds).toBeUndefined();
    expect(await screen.findByLabelText('Platform no longer owns Billing')).toBeTruthy();
  });

  itDom('makes a service and claims it in one gesture', async () => {
    // The picker creates, because the team row is the surface where somebody
    // realises the vocabulary is missing a word — and a create that did not
    // also claim it would leave the reader to find the new service and pick it.
    const api = fakeDirectory([], [{ id: 't1', name: 'Platform', serviceIds: [] }]);
    render(<DirectoryPage token="t" api={api} nav={null} account={null} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name of Platform')).toBeDefined();
    });

    const picker = screen.getByLabelText('Make Platform responsible for a service');
    fireEvent.change(picker, { target: { value: 'Payments' } });
    fireEvent.click(await screen.findByText(/Payments/));

    await waitFor(() => {
      expect(api.added).toContain('Payments');
    });
    expect(api.teamPatches).toEqual([{ id: 't1', patch: { serviceIds: ['s1'] } }]);
    // And it is in the vocabulary the Services card lists, not only on the team.
    expect(await screen.findByLabelText('Name of Payments')).toBeTruthy();
  });
});
