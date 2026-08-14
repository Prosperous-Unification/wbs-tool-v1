import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PriorityBandView } from '@/lib/wbs-api';

import {
  type BandDraft,
  bandRangeWords,
  draftsOf,
  ladderOfDrafts,
  PrioritiesDialog,
} from './priorities-dialog';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

/** Everything the dialog is given, with each call recorded. */
function stubbed(bands: readonly PriorityBandView[] = DEFAULT_PRIORITY_BANDS) {
  // Typed, and not decoration: an untyped `vi.fn` records its calls as `[]`, so
  // `mock.calls.at(0)?.at(0)` reads as `void` and the assertions below become a
  // lint error rather than a check on what was sent.
  const setBands = vi.fn<[readonly PriorityBandView[]], Promise<void>>(async () => {
    await Promise.resolve();
  });
  const onChanged = vi.fn(async () => {
    await Promise.resolve();
  });
  render(<PrioritiesDialog bands={bands} setBands={setBands} onChanged={onChanged} />);
  // Opened through its own trigger, because the trigger is the component's:
  // Radix restores the focus to it on close and to nothing without one.
  fireEvent.click(screen.getByRole('button', { name: 'Priorities' }));
  return { setBands, onChanged };
}

/** Lets the two awaits a save makes — the call, then the reread — settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('what a rung holds, in words', () => {
  const drafts = draftsOf(DEFAULT_PRIORITY_BANDS);

  it('reads a start as the range it amounts to', () => {
    // A band is **stored** as a start and **read** as a range, and this is the
    // only place a reader is shown the second. Without it the surface asks
    // somebody to do the subtraction Dany did in his own sentence.
    expect(bandRangeWords(drafts, 0)).toBe('1 to 20');
    expect(bandRangeWords(drafts, 2)).toBe('41 to 60');
  });

  it('leaves the top rung open, because the ladder has no top', () => {
    expect(bandRangeWords(drafts, 4)).toBe('81 and above');
  });

  it('follows the boxes rather than the saved ladder, so a moved cut is visible as it is typed', () => {
    // The whole reason this reads the drafts: moving one cut changes what **two**
    // bands hold, and a reader who could not see the second would move a cut and
    // find out afterwards.
    const moved: BandDraft[] = drafts.map((draft, at) =>
      at === 1 ? { ...draft, startsAt: '11' } : draft,
    );
    expect(bandRangeWords(moved, 0)).toBe('1 to 10');
    expect(bandRangeWords(moved, 1)).toBe('11 to 40');
  });

  it('says the start alone while the box above it is half-typed', () => {
    const halfTyped: BandDraft[] = drafts.map((draft, at) =>
      at === 1 ? { ...draft, startsAt: '' } : draft,
    );
    expect(bandRangeWords(halfTyped, 0)).toBe('1 and above');
  });
});

describe('what the boxes amount to', () => {
  it('refuses an empty box here rather than sending a zero', () => {
    // `Number('')` is `0`, which be-01 refuses with a code about whole numbers —
    // a true sentence about the wrong mistake. Proof: the `Number.isSafeInteger`
    // arm replaced by a bare `Number(draft)`, and this returned a ladder with a
    // band starting at 0 rather than null. Watched 2026-08-14.
    const drafts = draftsOf(DEFAULT_PRIORITY_BANDS).map((draft, at) =>
      at === 2 ? { ...draft, startsAt: '' } : draft,
    );
    expect(ladderOfDrafts(drafts)).toBeNull();
  });

  it('refuses a number too big to send rather than sending an infinity', () => {
    // JSON has no literal for `Infinity`, so a typed `1e999` arrives as `null`.
    const drafts = draftsOf(DEFAULT_PRIORITY_BANDS).map((draft, at) =>
      at === 0 ? { ...draft, defaultValue: '1e999' } : draft,
    );
    expect(ladderOfDrafts(drafts)).toBeNull();
  });

  it('sends everything else and lets be-01 refuse it', () => {
    // A default outside its own band is a real refusal and it is **be-01's**:
    // `priorityLadderProblem` is the one guard, and a second copy here is a rule
    // free to disagree with the one that answers the request. The same bargain
    // `TeamsDialog` makes with `0` and `1001`.
    const drafts = draftsOf(DEFAULT_PRIORITY_BANDS).map((draft, at) =>
      at === 0 ? { ...draft, defaultValue: '90' } : draft,
    );
    expect(ladderOfDrafts(drafts)?.at(0)).toEqual({
      startsAt: 1,
      label: 'Critical',
      defaultValue: 90,
    });
  });
});

describe('the priorities dialog', () => {
  itDom('shows the plan’s ladder, each rung as its name, its start and its number', () => {
    stubbed();

    expect(screen.getByLabelText<HTMLInputElement>('Name of band 1').value).toBe('Critical');
    expect(screen.getByLabelText<HTMLInputElement>('Critical starts at').value).toBe('1');
    expect(screen.getByLabelText<HTMLInputElement>('Critical writes').value).toBe('10');
    expect(screen.getByLabelText<HTMLInputElement>('Lowest starts at').value).toBe('81');
    // The ranges, which is what makes a ladder of starts readable as Dany wrote it.
    expect(
      [...document.querySelectorAll('[data-priority-range]')].map((each) => each.textContent),
    ).toEqual(['1 to 20', '21 to 40', '41 to 60', '61 to 80', '81 and above']);
  });

  itDom('sends the whole ladder on Save, never one rung of it', async () => {
    // design.md D4. Contiguity is a fact about five rows together, so a per-rung
    // write would have to pass through states in which the ladder is not one —
    // and a reader on another screen would draw one of them.
    //
    // Proof: the `bands` argument narrowed to the rung that changed, and this
    // failed on `expected [ { startsAt: 1, … } ] to have a length of 5` — half a
    // ladder on its way to a route that refuses anything but five. Watched
    // 2026-08-14.
    const { setBands, onChanged } = stubbed();

    fireEvent.change(screen.getByLabelText('Name of band 1'), { target: { value: 'Blocker' } });
    save();
    await settle();

    expect(setBands).toHaveBeenCalledTimes(1);
    expect(setBands.mock.calls.at(0)?.at(0)).toEqual([
      { startsAt: 1, label: 'Blocker', defaultValue: 10 },
      ...DEFAULT_PRIORITY_BANDS.slice(1),
    ]);
    // And the plan is reread, which is what redraws every face in the new names.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  itDom('holds the drafts until Save, so a cut can be moved past its neighbour', async () => {
    // The one place this deliberately differs from `TeamsDialog`, which commits
    // per box on blur. Moving `High` down to 15 is an invalid ladder until
    // `Medium` moves too, and a dialog that committed per box would refuse every
    // intermediate state somebody has to type through.
    const { setBands } = stubbed();

    fireEvent.change(screen.getByLabelText('High starts at'), { target: { value: '15' } });
    fireEvent.blur(screen.getByLabelText('High starts at'));
    fireEvent.change(screen.getByLabelText('High writes'), { target: { value: '20' } });
    fireEvent.blur(screen.getByLabelText('High writes'));
    await settle();
    // Nothing has been sent yet, which is the claim.
    expect(setBands).not.toHaveBeenCalled();

    save();
    await settle();
    expect(setBands).toHaveBeenCalledTimes(1);
    expect(setBands.mock.calls.at(0)?.at(0)?.at(1)).toEqual({
      startsAt: 15,
      label: 'High',
      defaultValue: 20,
    });
  });

  itDom('says what be-01 refused, in words, and keeps what was typed', async () => {
    const setBands = vi.fn(() =>
      Promise.reject(new Error('band_default_must_be_inside_its_own_band')),
    );
    const onChanged = vi.fn(async () => {
      await Promise.resolve();
    });
    render(
      <PrioritiesDialog bands={DEFAULT_PRIORITY_BANDS} setBands={setBands} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Priorities' }));

    fireEvent.change(screen.getByLabelText('Critical writes'), { target: { value: '90' } });
    save();
    await settle();

    // A sentence about the ladder, not the wire code — the refusal is about a box
    // somebody is looking at, and it belongs on this surface rather than in a
    // toast in the corner of the page this dialog is covering.
    expect(screen.getByRole('alert').textContent).toContain('has to fall inside that band');
    // The draft is kept: the number on screen is what the sentence is about, and
    // resetting it to be-01's would leave a sentence explaining a value nobody
    // could see.
    expect(screen.getByLabelText<HTMLInputElement>('Critical writes').value).toBe('90');
    expect(onChanged).not.toHaveBeenCalled();
  });

  itDom('says a sentence when the proxy answers, not the status it answered with', async () => {
    // C3's P2-2 and C5's R5 #18, written here rather than rediscovered a third
    // time: `(http_502)` beside a box somebody is typing in is a word about HTTP
    // where a sentence about their plan belongs.
    const setBands = vi.fn(() => Promise.reject(new Error('http_502')));
    render(
      <PrioritiesDialog
        bands={DEFAULT_PRIORITY_BANDS}
        setBands={setBands}
        onChanged={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Priorities' }));
    fireEvent.change(screen.getByLabelText('Critical writes'), { target: { value: '12' } });
    save();
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('The server could not save that');
  });

  itDom('refuses an empty box on this surface, without asking be-01 about it', async () => {
    const { setBands } = stubbed();

    fireEvent.change(screen.getByLabelText('Medium starts at'), { target: { value: '' } });
    save();
    await settle();

    expect(setBands).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('whole number');
  });

  itDom('leaves nothing half-typed behind when it is closed', async () => {
    stubbed();

    fireEvent.change(screen.getByLabelText('Name of band 1'), { target: { value: 'Blocker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Priorities' }));

    expect(screen.getByLabelText<HTMLInputElement>('Name of band 1').value).toBe('Critical');
  });
});
