import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamCapacityView, TeamView } from '@/lib/wbs-api';

import { TeamsDialog, teamsOnThePlan } from './teams-dialog';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

/**
 * Both teams **unsized** globally, deliberately.
 *
 * `TeamView.size` is the retired column, read by nothing since
 * `capacity-per-project`. A fixture that carried numbers there would let every
 * assertion below pass against a build that still fell back to it — which is the
 * one wrong answer this change is most likely to be written with.
 */
const BACKEND: TeamView = { id: 't-backend', name: 'Backend', serviceIds: [] };
const PLATFORM: TeamView = { id: 't-platform', name: 'Platform', serviceIds: [] };
const DESIGN: TeamView = { id: 't-design', name: 'Design', serviceIds: [] };

/** Everything the dialog is given, with each call recorded. */
function stubbed(overrides: Partial<Parameters<typeof TeamsDialog>[0]> = {}) {
  const setCapacity = vi.fn(() => Promise.resolve());
  const onChanged = vi.fn(() => Promise.resolve());
  const props = {
    teams: [
      { id: 't-backend', name: 'Backend', stated: 2, rows: 4 },
      { id: 't-platform', name: 'Platform', stated: null, rows: 1 },
    ],
    setCapacity,
    onChanged,
    ...overrides,
  };
  render(<TeamsDialog {...props} />);
  // Opened through its own trigger, because the trigger is the component's:
  // Radix restores the focus to it on close and to nothing without one.
  fireEvent.click(screen.getByRole('button', { name: 'Teams' }));
  return { setCapacity, onChanged, props };
}

/** Lets the two awaits every change makes — the call, then the reread — settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

const boxFor = (name: string): HTMLInputElement =>
  screen.getByLabelText(`How many of ${name} at once`);

describe('which teams the plan offers a capacity for', () => {
  const capacities: TeamCapacityView[] = [{ serviceTeamId: 't-backend', size: 2 }];

  it('lists a team only an ancestor carries, because its pool is what the leaves spend', () => {
    // The effective reading, which is the whole reason this takes a list of
    // resolved team ids rather than the rows' own labels. A leaf under a labelled
    // parent carries no label of its own and its dates come out of that parent's
    // pool, so a plan bounded by `Backend` must offer somewhere to state it.
    //
    // Proof: the caller's `effectiveTeams.get(row.id)` replaced by each row's
    // stored `serviceTeamId`, so only rows carrying a label themselves count and
    // the four rows arrive as four nulls. This failed on `expected [] to deeply
    // equal [ { id: 't-backend', …(3) } ]` — a plan whose pool bounds four rows
    // offering nowhere at all to state the number. Watched 2026-08-13.
    const listed = teamsOnThePlan([BACKEND, PLATFORM], capacities, [
      // The labelled ancestor, then three leaves that inherit it.
      't-backend',
      't-backend',
      't-backend',
      't-backend',
    ]);

    expect(listed).toEqual([{ id: 't-backend', name: 'Backend', stated: 2, rows: 4 }]);
  });

  it('offers nothing for a team no work on this plan is labelled with', () => {
    // Not every team in the directory: a plan that does no `Design` work has no
    // `Design` capacity to state, and a list of every team on the deployment is a
    // list nobody reads. `Design` here is in the directory and on no row.
    const listed = teamsOnThePlan([BACKEND, PLATFORM, DESIGN], capacities, ['t-backend', null]);

    expect(listed.map((each) => each.name)).toEqual(['Backend']);
  });

  it('reads a team the plan has stated nothing about as unstated, not as one', () => {
    // Absent from `capacities` is _unstated_, which limits that team's work not at
    // all — and is emphatically not a pool of one, which would serialise every row
    // it labels.
    const listed = teamsOnThePlan([BACKEND, PLATFORM], capacities, ['t-backend', 't-platform']);

    expect(listed.find((each) => each.name === 'Platform')?.stated).toBeNull();
    expect(listed.find((each) => each.name === 'Backend')?.stated).toBe(2);
  });

  it('says a team nobody has counted on this plan is unstated', () => {
    // D1 at this boundary. This used to be `never reads the team's retired
    // global size`, and it built a `TeamView` with `size: 7` on it to prove the
    // fallback was refused. That fixture cannot be written any more: be-01
    // answers `/api/teams` with `{ id, name }` and `TeamView` carries nothing
    // else, so `?? team.size` is `error TS2339` rather than a green suite —
    // watched by injecting it into `teamsOnThePlan`, 2026-08-13. What is left to
    // pin here is the answer itself: no capacity stated, nothing invented.
    const listed = teamsOnThePlan([PLATFORM], [], ['t-platform']);

    expect(listed[0]?.stated).toBeNull();
  });

  it('lists by name, so the panel does not reshuffle between two reads', () => {
    const listed = teamsOnThePlan(
      [PLATFORM, BACKEND],
      [],
      ['t-platform', 't-backend', 't-backend'],
    );

    expect(listed.map((each) => each.name)).toEqual(['Backend', 'Platform']);
    // And the row counts are each team's own, inherited rows included.
    expect(listed.map((each) => each.rows)).toEqual([2, 1]);
  });
});

describe('stating how many of a team are at work at once on this plan', () => {
  itDom('sends the number typed, and re-reads the plan the dates come from', async () => {
    const { setCapacity, onChanged } = stubbed();

    fireEvent.change(boxFor('Platform'), { target: { value: '3' } });
    fireEvent.blur(boxFor('Platform'));
    await settle();

    expect(setCapacity).toHaveBeenCalledWith('t-platform', 3);
    expect(onChanged).toHaveBeenCalled();
  });

  itDom('an emptied box unlimits the team rather than asking for nobody', async () => {
    // The first of the box's two local decisions. `Number('')` is `0`, and a pool
    // of 0 slots clamps every width to 0 — the engine divides effort by width, so
    // that is a plan of `Infinity` dates. An emptied box plainly means "this plan
    // does not limit them", which is `null`.
    //
    // Proof: the empty-box arm replaced by a bare `Number(draft)`, and this failed
    // on `expected "spy" to be called with arguments: [ 't-backend', null ]` — it
    // was called with `0`, which be-01 refuses and which would be a plan of
    // `Infinity` dates if it did not. Watched 2026-08-13.
    const { setCapacity } = stubbed();

    fireEvent.change(boxFor('Backend'), { target: { value: '' } });
    fireEvent.blur(boxFor('Backend'));
    await settle();

    expect(setCapacity).toHaveBeenCalledWith('t-backend', null);
  });

  itDom('refuses a number too big to send rather than unlimiting the team', async () => {
    // The second. JSON has no literal for `Infinity`, so `JSON.stringify` writes a
    // typed `1e999` as `null` — which on this route is the clear. Sending it would
    // silently unlimit a team that was limited while looking to the reader like a
    // refusal, so it is refused here.
    //
    // Proof: the `Number.isFinite` arm deleted, and this failed on `expected "spy"
    // to not be called at all, but actually been called 1 times` — `1e999` on its
    // way out as `{ size: null }`, unlimiting a limited team with nothing on screen
    // said about it. Watched 2026-08-13.
    const { setCapacity } = stubbed();

    fireEvent.change(boxFor('Backend'), { target: { value: '1e999' } });
    fireEvent.blur(boxFor('Backend'));
    await settle();

    expect(setCapacity).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('a whole number of 1 or more');
  });

  itDom('sends what be-01 refuses, and says what be-01 answered', async () => {
    // Validation stays at be-01's boundary — C3's D6, one tier along. A second
    // copy of the rule here is a rule free to disagree with it, so `0` goes and is
    // answered on, and the answer is a sentence rather than the wire code.
    const setCapacity = vi.fn(() => Promise.reject(new Error('size_must_be_at_most_1000')));
    stubbed({ setCapacity });

    fireEvent.change(boxFor('Platform'), { target: { value: '1001' } });
    fireEvent.blur(boxFor('Platform'));
    await settle();

    expect(setCapacity).toHaveBeenCalledWith('t-platform', 1001);
    // The ceiling read out of be-01's own code, never a literal here: a `1000`
    // written in this component is a second copy of `MOST_PEOPLE_AT_ONCE`.
    expect(screen.getByRole('alert').textContent).toContain('at most 1000');
    // And the draft stays, because the sentence is about the number on screen.
    expect(boxFor('Platform').value).toBe('1001');
  });

  itDom('says a sentence when the proxy answers, not the status it answered with', async () => {
    // The one refusal nobody can type their way into, and the one every other
    // surface in this app already has an arm for: `send` throws
    // `Error('http_502')` for a proxy error, and without a 5xx arm the
    // grammatical fallback prints `That capacity could not be changed
    // (http_502).` into a dialog somebody is typing a number into. That is the
    // defect `wbs-table.tsx` fixed for `not_found` and `http_500` on 2026-08-09,
    // reappearing in the refusal helper written to replace the one it was fixed
    // in.
    //
    // Proof: the `/^http_5\d\d$/` arm deleted from `capacityRefusalSentence`,
    // and this failed on `expected 'That capacity could not be changed
    // (http_502).' to contain 'The server could not save that'`. Watched
    // 2026-08-13.
    const setCapacity = vi.fn(() => Promise.reject(new Error('http_502')));
    stubbed({ setCapacity });

    fireEvent.change(boxFor('Platform'), { target: { value: '3' } });
    fireEvent.blur(boxFor('Platform'));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('The server could not save that');
    // And no wire code anywhere in it — the sentence is the whole answer.
    expect(screen.getByRole('alert').textContent).not.toContain('502');
  });

  itDom('sends nothing when the box says what the plan already says', async () => {
    const { setCapacity } = stubbed();

    fireEvent.change(boxFor('Backend'), { target: { value: '2' } });
    fireEvent.blur(boxFor('Backend'));
    await settle();

    expect(setCapacity).not.toHaveBeenCalled();
  });

  itDom('sends nothing when an already-empty box is left empty', async () => {
    const { setCapacity } = stubbed();

    fireEvent.blur(boxFor('Platform'));
    await settle();

    expect(setCapacity).not.toHaveBeenCalled();
  });

  itDom('Escape puts the box back to what the plan says', async () => {
    const { setCapacity } = stubbed();

    fireEvent.change(boxFor('Backend'), { target: { value: '9' } });
    fireEvent.keyDown(boxFor('Backend'), { key: 'Escape' });
    await settle();

    expect(boxFor('Backend').value).toBe('2');
    expect(setCapacity).not.toHaveBeenCalled();
  });

  itDom('Enter commits without waiting for the box to lose the focus', async () => {
    const { setCapacity } = stubbed();

    fireEvent.change(boxFor('Platform'), { target: { value: '5' } });
    fireEvent.keyDown(boxFor('Platform'), { key: 'Enter' });
    await settle();

    expect(setCapacity).toHaveBeenCalledWith('t-platform', 5);
  });

  itDom('says so when no work on the plan is labelled with a team', () => {
    // Said out loud rather than left as an empty panel, which reads as a list that
    // failed to load — and it names the thing to do about it.
    stubbed({ teams: [] });

    expect(screen.getByText(/No work on this plan is labelled with a team yet/)).toBeTruthy();
  });

  itDom('says the number is this plan’s own, where somebody would assume otherwise', () => {
    // The one sentence that has to be on this surface: the box looks exactly like
    // the directory box it replaced, and a reader who remembers that one would
    // assume this number is the team's everywhere.
    stubbed();

    expect(screen.getByText(/another plan sharing a team is not affected/i)).toBeTruthy();
    expect(boxFor('Platform').title).toContain('This plan does not limit');
    expect(boxFor('Backend').title).toContain('on this plan');
  });
});
