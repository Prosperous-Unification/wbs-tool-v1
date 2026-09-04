import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PlanDiffView,
  SavedPlanCompareResult,
  SavedPlanListEntryView,
  SavedPlanSaveResult,
} from '../../lib/saved-plan-api';
import { compareGoneWords, compareUnreadableWords } from './saved-plan-compare';
import type { SavedPlansPanelDeps } from './saved-plans-panel';
import { SAVE_BUSY, SavedPlansPanel, saveWords } from './saved-plans-panel';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};
const NEWER: SavedPlanListEntryView = { ...ROW, id: 'sp2', name: 'after the re-plan' };
const EMPTY_DIFF: PlanDiffView = { input: [], schedule: [] };

/**
 * One panel's fake wiring.
 *
 * `list` reads a mutable box rather than a fixed array, because the assertion
 * this file exists for is that a *second* read happens and returns something
 * different. A fake that always answered the same rows could not tell a refresh
 * from a render.
 */
const fakeDeps = (start: readonly SavedPlanListEntryView[] = [ROW]) => {
  let shelf = [...start];
  let fire: (() => void) | undefined;
  const list = vi.fn(() => Promise.resolve([...shelf]));
  const save = vi.fn(
    (): Promise<SavedPlanSaveResult> => Promise.resolve({ outcome: 'saved', savedPlan: NEWER }),
  );
  const compare = vi.fn(
    (): Promise<SavedPlanCompareResult> =>
      Promise.resolve({ outcome: 'compared', diff: EMPTY_DIFF }),
  );
  const deps: SavedPlansPanelDeps = {
    available: () => Promise.resolve(true),
    list,
    subscribe: (_projectId, onChange) => {
      fire = onChange;
      return {
        unsubscribe: () => {
          fire = undefined;
        },
      };
    },
    save,
    compare,
  };
  return {
    deps,
    list,
    save,
    compare,
    /** What be-01 will answer the *next* read — nobody has been told yet. */
    setShelf: (rows: readonly SavedPlanListEntryView[]) => {
      shelf = [...rows];
    },
    broadcast: () => fire?.(),
  };
};

/** Resolves once everything already queued as a microtask has run. */
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('what the save status line says', () => {
  it('confirms with the record’s own name and be-01’s timestamp', () => {
    // AC #1: the authoritative timestamp, which only the server knows and which
    // arrived in the response. `toLocaleString` is the browser's, so the
    // assertion holds the two facts around it rather than the rendered date.
    const words = saveWords({ kind: 'saved', savedPlan: ROW });
    expect(words).toContain(ROW.name);
    expect(words).toContain(new Date(ROW.createdAt).toLocaleString());
  });

  it('says the two refusals in their own words, and neither in the other’s', () => {
    // 8.5, save half. `busy` invites a retry because one will work; `quota`
    // names the limit and does not, because no retry clears it. Merging them
    // would point the reader at a button that cannot succeed.
    expect(saveWords({ kind: 'busy' })).toBe(SAVE_BUSY);
    expect(saveWords({ kind: 'quota', refusal: 'at the 50-plan limit' })).toBe(
      'at the 50-plan limit',
    );
    expect(saveWords({ kind: 'quota', refusal: 'at the 50-plan limit' })).not.toBe(SAVE_BUSY);
  });

  it('says nothing while idle or in flight', () => {
    expect(saveWords({ kind: 'idle' })).toBeNull();
    expect(saveWords({ kind: 'saving' })).toBeNull();
  });
});

describe('the saved-plans panel', () => {
  afterEach(cleanup);

  itDom('renders the shelf it read', async () => {
    const wiring = fakeDeps();
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    expect(screen.getByRole('button', { name: 'Save plan' })).toBeTruthy();
    // Scoped to the list, because a saved plan's name is on screen twice by
    // design: once as a row and once as an option in each picker. An unscoped
    // `getByText` here found two nodes and threw, which is the assertion
    // telling the truth about the surface rather than a fault in it.
    const shelf = screen.getByRole('list', { name: 'Saved plans' });
    expect(within(shelf).getByText(ROW.name)).toBeTruthy();
  });

  itDom('shows a plan the user just saved, with no broadcast to prompt it', async () => {
    // **The finding this chunk is built on.** `saved-plan.controller.ts`
    // publishes nothing — grep it for `broadcast` and there is no hit — so the
    // stream the shelf listens to is the *plan's*, and the user's own checkpoint
    // is the single change that never arrives on it. Nothing is broadcast in
    // this case on purpose: without the refresh effect, the row below never
    // appears and the reader is looking at a shelf that is missing the plan they
    // just watched succeed.
    const wiring = fakeDeps([ROW]);
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();
    expect(screen.queryByText(NEWER.name)).toBeNull();

    wiring.setShelf([NEWER, ROW]);
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    await flush();

    expect(wiring.save).toHaveBeenCalledWith('p1');
    await waitFor(() => {
      expect(screen.getAllByText(NEWER.name).length).toBeGreaterThan(0);
    });
    expect(wiring.list).toHaveBeenCalledTimes(2);
  });

  itDom('does not re-point a picker the reader left alone when the shelf grows', async () => {
    // AC #4, and the reason the default is pinned by an effect rather than
    // derived from `rows[0]`. A derived default would follow the newest row, so
    // a collaborator saving a plan would move a picker nobody touched and swap
    // the comparison under the reader mid-read.
    const wiring = fakeDeps([ROW]);
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();
    const picker: HTMLSelectElement = screen.getByLabelText(/Compare/);
    expect(picker.value).toBe(ROW.id);

    wiring.setShelf([NEWER, ROW]);
    act(() => {
      wiring.broadcast();
    });
    await flush();

    expect(screen.getAllByText(NEWER.name).length).toBeGreaterThan(0);
    expect(picker.value).toBe(ROW.id);
  });

  itDom('offers no comparison at all when nothing has been saved yet', async () => {
    // Two pickers whose only option is `the current plan` can ask exactly one
    // question, and it is the one `compareRefusal` declines — so rendering them
    // on an empty shelf would put a refusal sentence on screen for a choice the
    // reader was never given.
    const wiring = fakeDeps([]);
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    expect(screen.getByText('No plans saved yet.')).toBeTruthy();
    expect(screen.queryByLabelText(/Compare/)).toBeNull();
    expect(wiring.compare).not.toHaveBeenCalled();
  });

  itDom('compares the newest saved plan against the current one by default', async () => {
    const wiring = fakeDeps([NEWER, ROW]);
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    expect(wiring.compare).toHaveBeenCalledWith('p1', { saved: NEWER.id }, 'current');
    expect(screen.getByText('No differences.')).toBeTruthy();
  });

  itDom('refuses a pair of the same side instead of asking be-01 for it', async () => {
    // The pair no shelf row can resolve, and one be-01 answers with an empty
    // diff indistinguishable from two equal plans. Refused at the picker, so the
    // request is never made.
    const wiring = fakeDeps([NEWER, ROW]);
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();
    const calls = wiring.compare.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/Compare/), { target: { value: 'current' } });
    await flush();

    expect(screen.getByText('Pick two different plans to compare.')).toBeTruthy();
    expect(wiring.compare).toHaveBeenCalledTimes(calls);
  });

  itDom('names the side a corrupt refusal was about', async () => {
    // With two pickers on screen, a refusal naming no plan leaves the reader
    // unable to tell which of them holds the damaged one — be-01's reason for
    // putting `savedPlanId` on its 422, and worth nothing unless it is rendered.
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'corrupt',
      savedPlanId: ROW.id,
      refusal: 'stored_plan_unreadable',
    });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('stored_plan_unreadable');
    expect(alert.textContent).toContain(ROW.id);
  });
  itDom('offers a refresh when the plan changes, and leaves the comparison alone', async () => {
    /*
      8.4, both halves in one case, because they are one promise: the affordance
      appears **and** the diff on screen does not move until it is used.

      The two answers are told apart by their `path`, so "did not change" is an
      assertion about what is rendered rather than about a call count. A call
      count would go green on a comparison that re-ran and happened to return
      the same thing.
    */
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'compared',
      diff: {
        input: [{ category: 'notes', path: 'the first answer', left: 1, right: 2 }],
        schedule: [],
      },
    });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();
    expect(screen.getByText('the first answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compare again' })).toBeNull();

    // The plan moved: a collaborator saved, and be-01 published on the plan's
    // stream. The next comparison would say something else.
    wiring.setShelf([NEWER, ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'compared',
      diff: {
        input: [{ category: 'notes', path: 'the second answer', left: 3, right: 4 }],
        schedule: [],
      },
    });
    await act(async () => {
      wiring.broadcast();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole('button', { name: 'Compare again' })).toBeTruthy();
    // Still the reader's comparison. Losing your place in a diff to somebody
    // else's save is exactly what AC #4 forbids.
    expect(screen.getByText('the first answer')).toBeTruthy();
    expect(screen.queryByText('the second answer')).toBeNull();
  });

  itDom('brings the comparison up to date when the refresh is used', async () => {
    // The other half of the offer. An affordance that appears and does nothing
    // is worse than none: it tells the reader their diff is stale and gives
    // them no way out of it.
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'compared',
      diff: {
        input: [{ category: 'notes', path: 'the first answer', left: 1, right: 2 }],
        schedule: [],
      },
    });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    wiring.setShelf([NEWER, ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'compared',
      diff: {
        input: [{ category: 'notes', path: 'the second answer', left: 3, right: 4 }],
        schedule: [],
      },
    });
    await act(async () => {
      wiring.broadcast();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Compare again' }));
    await flush();

    expect(screen.getByText('the second answer')).toBeTruthy();
    expect(screen.queryByText('the first answer')).toBeNull();
    // The offer is spent: the comparison on screen was made from the shelf that
    // is on screen, so there is nothing left to bring up to date.
    expect(screen.queryByRole('button', { name: 'Compare again' })).toBeNull();
  });

  itDom('says a deleted plan was deleted, rather than printing not_found', async () => {
    /*
      8.5, compare half. `not_found` and `corrupt` are two different things that
      happened, and until 2026-09-04 the panel flattened both into
      `{ kind: 'error', code }` — so a plan a collaborator had just deleted was
      reported as `The comparison could not be read (not_found (sp1)).`

      The assertion that carries the change is the **negative** one: the raw
      outcome word must not reach the screen. Without it this case would pass
      against the old flattening, which prints the id and the word both.
    */
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({ outcome: 'not_found', savedPlanId: ROW.id });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(compareGoneWords(ROW.id));
    expect(alert.textContent).toContain(ROW.id);
    expect(alert.textContent).not.toContain('not_found');
    // The next move is on this panel, so it is named.
    expect(alert.textContent).toContain('Pick another');
  });

  itDom('a refusal naming no plan is about the project, and offers no pick', async () => {
    // The other branch, and it is a different sentence rather than the same one
    // with a gap: be-01 refused the project, which no choice among these
    // pickers can fix, so inviting one would send the reader round a loop.
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({ outcome: 'not_found', savedPlanId: null });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(compareGoneWords(null));
    expect(alert.textContent).not.toContain('Pick another');
  });

  itDom('an unreadable plan is not offered a retry', async () => {
    // Rereading stored bytes gives the same bytes and the same answer, so the
    // sentence names the plan and the reason and sends the reader at the other
    // picker rather than at the same button again.
    const wiring = fakeDeps([ROW]);
    wiring.compare.mockResolvedValue({
      outcome: 'corrupt',
      savedPlanId: ROW.id,
      refusal: 'stored_plan_unreadable',
    });
    render(<SavedPlansPanel projectId="p1" deps={wiring.deps} />);
    await flush();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(compareUnreadableWords(ROW.id, 'stored_plan_unreadable'));
    expect(alert.textContent).not.toMatch(/try again|again in a moment/i);
    // The two refusals do not share a sentence: telling them apart is the whole
    // of 8.5, and one wording for both would make this suite green over it.
    expect(alert.textContent).not.toBe(compareGoneWords(ROW.id));
  });
});
