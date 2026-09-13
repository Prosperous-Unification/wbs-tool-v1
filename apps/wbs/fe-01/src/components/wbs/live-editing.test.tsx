import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CellInput } from './cell-input';
import {
  type CommitOutcome,
  forgetRefusedDrafts,
  refusedDraftFor,
  type SendEdit,
} from './live-editing';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);
// The held refusals outlive every renderer on purpose, which means they also
// outlive a test. Left behind, one test's draft is restored into the next
// test's box the moment it mounts.
afterEach(() => {
  forgetRefusedDrafts(() => true);
});

/** The cell both faces below render, and the only one these tests use. */
const CELL = 'w1::name';

/**
 * The desktop renderer, as small as it can be and still be one: a `[data-grid]`
 * table with the cell in a `<td>`.
 */
function TableFace({
  value,
  commit,
}: {
  value: string;
  commit: (typed: string, baseline: string) => Promise<CommitOutcome>;
}): React.JSX.Element {
  return (
    <table data-grid>
      <tbody>
        <tr>
          <td>
            <CellInput aria-label="Name of 010" cellKey={CELL} value={value} commit={commit} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The other renderer, standing in for `M mobile-cards`: the same cell, the same
 * `data-cell`, no table anywhere. Two components rather than one with a flag,
 * because "the same state under a different renderer" is the whole claim and a
 * flag would let one component keep its own state through the switch.
 */
function CardFace({
  value,
  commit,
}: {
  value: string;
  commit: (typed: string, baseline: string) => Promise<CommitOutcome>;
}): React.JSX.Element {
  return (
    <div data-grid>
      <article>
        <CellInput aria-label="Name of 010" cellKey={CELL} value={value} commit={commit} />
      </article>
    </div>
  );
}

/** Types `text` into the one cell on screen and leaves it, which is what commits. */
function typeAndLeave(text: string): void {
  const box = screen.getByLabelText<HTMLInputElement>('Name of 010');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.blur(box);
}

const refuses = (): Promise<CommitOutcome> => Promise.resolve('refused');
const takes = (): Promise<CommitOutcome> => Promise.resolve('landed');

/** A patch that is out and has not been answered yet. */
interface PendingCommit {
  typed: string;
  baseline: string;
  /** Answers this one request, whatever else is in the air. */
  answer: (outcome: CommitOutcome) => void;
}

/**
 * A `commit` that parks every request instead of settling it, so a test can
 * answer two of them in the order be-01 would rather than the order they went
 * out. `refuses` and `takes` above settle immediately and can therefore never
 * have two in the air at once, which is the whole of what the tests below are
 * about.
 */
function queuedCommits(): { pending: PendingCommit[]; commit: SendEdit } {
  const pending: PendingCommit[] = [];
  const commit: SendEdit = (typed, baseline) =>
    new Promise<CommitOutcome>((answer) => {
      pending.push({ typed, baseline, answer });
    });
  return { pending, commit };
}

/** Answers one parked patch, and lets the field act on it before the test looks. */
async function answerPatch(patch: PendingCommit, outcome: CommitOutcome): Promise<void> {
  await act(async () => {
    patch.answer(outcome);
    // The field's continuation is queued behind this resolution; the tick is
    // what lets it, and the render it causes, run inside this `act`.
    await Promise.resolve();
  });
}

describe('a field outliving the thing that renders it', () => {
  /**
   * The mobile-rotate case, which is `X live-editing-extraction`'s reason to
   * exist: the phone turns, the table renderer goes and the card renderer
   * arrives, and the only copy of what be-01 refused was in the box that went
   * with it.
   *
   * Not the step-change remount `wbs-table.test.tsx` already covers — that one
   * unmounts and remounts *the same* renderer, so a hold living anywhere that
   * survives a React unmount would pass it. This one changes the component
   * doing the rendering, which is what a breakpoint does.
   *
   * Two faults, both watched 2026-08-09.
   *
   * - The hold moved back inside the face: `takeNode` restoring from a private
   *   field of `LiveField`, which is constructed once per mount. This and the
   *   test below it failed on `expected 'Rewire the shed' to be 'Strip the
   *   wiring'` — and so did `keeps a draft be-01 refused when a new step
   *   rebuilds every column`, which is the fault it was written for.
   * - The restore gated on `node.closest('table') !== null`, which is the
   *   assumption this change exists to remove. **Only this test saw it**: 695
   *   others passed, including both of the ones above, because everything else
   *   in this repo renders the grid as a table.
   */
  itDom('carries a refused draft from one renderer to the next', async () => {
    const table = render(<TableFace value="Rewire the shed" commit={refuses} />);
    typeAndLeave('Strip the wiring');
    await waitFor(() => {
      expect(refusedDraftFor(CELL)).toBe('Strip the wiring');
    });

    table.unmount();
    render(<CardFace value="Rewire the shed" commit={refuses} />);

    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Strip the wiring');
  });

  /**
   * The other direction, because a phone is turned back: the card is where the
   * refusal happened and the table is what has to show it.
   */
  itDom('carries it back the other way too', async () => {
    const card = render(<CardFace value="Rewire the shed" commit={refuses} />);
    typeAndLeave('Strip the wiring');
    await waitFor(() => {
      expect(refusedDraftFor(CELL)).toBe('Strip the wiring');
    });

    card.unmount();
    render(<TableFace value="Rewire the shed" commit={refuses} />);

    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Strip the wiring');
  });

  /**
   * The negative that keeps the one above from being "the module remembers
   * everything". An edit be-01 took is on the server, so the next renderer
   * reads it from the tree like any other value — and a field that carried its
   * typed text across regardless would be showing text nobody could explain.
   */
  itDom('carries nothing across when be-01 took the edit', async () => {
    const table = render(<TableFace value="Rewire the shed" commit={takes} />);
    typeAndLeave('Strip the wiring');
    await waitFor(() => {
      expect(refusedDraftFor(CELL)).toBeUndefined();
    });

    table.unmount();
    render(<CardFace value="Strip the wiring" commit={takes} />);

    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Strip the wiring');
  });

  /**
   * Resolving the refusal in the second renderer clears it for both, which is
   * what stops a draft nobody is being asked about any more from following the
   * reader around for the life of the page.
   */
  itDom('lets the second renderer put the refusal back and be done with it', async () => {
    const table = render(<TableFace value="Rewire the shed" commit={refuses} />);
    typeAndLeave('Strip the wiring');
    await waitFor(() => {
      expect(refusedDraftFor(CELL)).toBe('Strip the wiring');
    });

    table.unmount();
    render(<CardFace value="Rewire the shed" commit={refuses} />);
    typeAndLeave('Rewire the shed');

    await waitFor(() => {
      expect(refusedDraftFor(CELL)).toBeUndefined();
    });
  });
});

describe('two patches for one cell in the air at once', () => {
  /**
   * The gesture both tests below start from, and the one rule 5 deliberately
   * does not collapse: type, leave, click back in, type something *else*,
   * leave again — all inside one round trip. Two different texts are two
   * edits, so two patches go out, and be-01 answers them in whichever order it
   * likes. It systematically likes the refusal first: a landing refetches the
   * whole tree before it resolves and a refusal has nothing to refetch.
   */
  function typeTwiceBeforeEitherAnswers(pending: PendingCommit[]): void {
    typeAndLeave('Beta');
    typeAndLeave('Gamma');
    expect(pending.map((patch) => patch.typed)).toEqual(['Beta', 'Gamma']);
  }

  /**
   * Fault A. `Beta` is answered last and it landed; `Gamma` was already
   * refused. The answer to `Beta` says nothing about `Gamma` — but before the
   * generation guard it ran the whole landed branch, dropping the hold on the
   * only copy of `Gamma` that exists anywhere and unfreezing the box for the
   * next peer edit to overwrite. X's spec: the hold ends when the person
   * resolves it and not before, and nobody resolved this one.
   *
   * Proof: `generation !== this.submissions` deleted from `submit`'s
   * continuation, this failed on `expected undefined to be 'Gamma'`. Watched,
   * 2026-08-09.
   */
  itDom('an older landing does not clear the refusal that overtook it', async () => {
    const { pending, commit } = queuedCommits();
    const view = render(<TableFace value="Alpha" commit={commit} />);
    typeTwiceBeforeEitherAnswers(pending);

    await answerPatch(pending[1], 'refused');
    await answerPatch(pending[0], 'landed');

    expect(refusedDraftFor(CELL)).toBe('Gamma');
    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Gamma');

    // And the hold is a hold: the next refetch, carrying a peer's name, does
    // not get to write over text be-01 turned down.
    view.rerender(<TableFace value="Delta" commit={commit} />);
    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Gamma');
  });

  /**
   * Fault B, and the one that loses a saved edit. `Gamma` landed; `Beta` comes
   * back refused afterwards and is a round trip out of date. Before the
   * generation guard it held `Beta` — over a name the server had already
   * taken — and `takeNode` is an inline ref, so the *next render* rather than
   * any remount put `Beta` back on screen, `sync` then refused every peer edit
   * on the strength of it, and the blur after that sent it again. The reader
   * watches their saved name revert with nothing on screen to explain it.
   *
   * Proof, one fault, two assertions: `generation !== this.submissions`
   * deleted, this failed on `expected 'Beta' to be 'Gamma'`, and with that
   * line held back it went on to fail the re-send on `expected [ 'Beta',
   * 'Gamma', 'Beta' ] to deeply equal [ 'Beta', 'Gamma' ]`. Watched,
   * 2026-08-09.
   */
  itDom('an older refusal does not hold its text over the edit that landed', async () => {
    const { pending, commit } = queuedCommits();
    const view = render(<TableFace value="Alpha" commit={commit} />);
    typeTwiceBeforeEitherAnswers(pending);

    await answerPatch(pending[1], 'landed');
    await answerPatch(pending[0], 'refused');

    // The refetch the landing triggered. A rerender and not a remount, which
    // is the point: the ref callback is rebuilt every render, so a hold this
    // field should not be carrying reaches the box without anything unmounting.
    view.rerender(<TableFace value="Gamma" commit={commit} />);

    const box = screen.getByLabelText<HTMLInputElement>('Name of 010');
    expect(box.value).toBe('Gamma');
    expect(refusedDraftFor(CELL)).toBeUndefined();

    // Leaving the cell again sends nothing at all — there is nothing left to
    // retry. A third patch here is `Beta` overwriting the name that landed.
    fireEvent.blur(box);
    expect(pending.map((patch) => patch.typed)).toEqual(['Beta', 'Gamma']);
  });
});

describe('a refused draft typed over and refused again', () => {
  /**
   * The fault, in the smallest shape that has it. A client-side refusal raises
   * a toast, React flushes that discrete update **inside the blur** — before
   * any microtask — and the ref callback rebuilt by that render runs
   * `takeNode` against a map still holding the *previous* draft. It wrote the
   * old text into a box holding the new one, and the newer refusal then
   * recorded the right text a round trip later under a box already showing the
   * wrong one, where `sync` could not correct it because rule 4 was holding.
   *
   * The rerender below is that render, and a rerender rather than a remount is
   * the point: nothing unmounts, exactly as fault B above.
   *
   * Observed live on dev in the Prio cell, 2026-08-11 — `urgent` typed over a
   * refused `1e999` blurred back to `1e999`.
   *
   * Proof: `heldRefusals.delete(this.cellKey)` removed from `submit`, this
   * failed on `expected 'Beta' to be 'Gamma'`. Watched, 2026-08-11.
   */
  itDom('shows the newer draft, not the one it replaced', async () => {
    const { pending, commit } = queuedCommits();
    const view = render(<TableFace value="Alpha" commit={commit} />);

    typeAndLeave('Beta');
    await answerPatch(pending[0], 'refused');
    expect(refusedDraftFor(CELL)).toBe('Beta');

    typeAndLeave('Gamma');
    view.rerender(<TableFace value="Alpha" commit={commit} />);

    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Gamma');

    await answerPatch(pending[1], 'refused');

    expect(refusedDraftFor(CELL)).toBe('Gamma');
    expect(screen.getByLabelText<HTMLInputElement>('Name of 010').value).toBe('Gamma');
  });
});
