import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DateField } from './date-field';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** The field with a day on it, everything it has sent, and every way out it has reported. */
function shownDay(day: string): {
  box: HTMLInputElement;
  sent: string[];
  exits: ('commit' | 'cancel')[];
} {
  const sent: string[] = [];
  const exits: ('commit' | 'cancel')[] = [];
  render(
    <DateField
      aria-label="Starts"
      value={day}
      commit={(typed) => {
        sent.push(typed);
      }}
      onExit={(how) => {
        exits.push(how);
      }}
    />,
  );
  return { box: screen.getByLabelText<HTMLInputElement>('Starts'), sent, exits };
}

/**
 * A year typed digit by digit, as the browser delivers it: a `keydown` for
 * the digit, then the `change` that digit completed.
 *
 * The keydowns are the point. `DateField` sends a `change` with no key behind
 * it at once, because that is a day picked from the calendar; the four dates
 * below are the year-`0002` fault, and every one of them arrives behind a
 * keystroke. A version of this helper that fired the changes alone would be
 * asking the component about a gesture nobody performs.
 */
function typeSegments(box: HTMLInputElement, partials: string[]): void {
  for (const partial of partials) {
    fireEvent.keyDown(box, { key: partial.slice(3, 4) });
    fireEvent.change(box, { target: { value: partial } });
  }
}

describe('a date field holds what is being typed into it', () => {
  itDom('sends nothing while the box has the focus, however many segments land', () => {
    const { box, sent } = shownDay('');
    box.focus();

    typeSegments(box, ['0002-08-17', '0020-08-17', '0202-08-17', '2026-08-17']);

    expect(sent).toEqual([]);
  });

  itDom('sends the one date that was typed, on the way out', () => {
    const { box, sent } = shownDay('');
    box.focus();
    typeSegments(box, ['2026-08-17']);

    fireEvent.blur(box);

    expect(sent).toEqual(['2026-08-17']);
  });

  itDom('sends nothing for a focus and a blur with nothing typed', () => {
    // A person clicking through a row is not a person editing it. Sending
    // anyway writes what was on screen when the focus arrived over whatever has
    // happened since — `CellInput.commit` keeps the same rule.
    const { box, sent } = shownDay('2026-08-20');
    box.focus();

    fireEvent.blur(box);

    expect(sent).toEqual([]);
  });

  itDom('sends nothing twice for one edit', () => {
    const { box, sent } = shownDay('2026-08-20');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    fireEvent.blur(box);

    expect(sent).toEqual(['2026-08-17']);
  });

  itDom('takes an emptied box as "no day", which is a change like any other', () => {
    const { box, sent } = shownDay('2026-08-20');
    box.focus();
    fireEvent.change(box, { target: { value: '' } });

    fireEvent.blur(box);

    expect(sent).toEqual(['']);
  });

  itDom('leaves a half-typed date alone instead of clearing the day it had', () => {
    // A date input reports `''` for a date it **cannot parse** as well as for
    // one that was cleared, and `validity.badInput` is the only thing that
    // tells them apart. jsdom parses nothing and answers `false` to everything,
    // so the browser's answer is given here — which is also what makes this the
    // negative of the test above rather than a second copy of it.
    //
    // Proof: the `badInput` line removed from `commitIfChanged`, this failed on
    // `expected [ '' ] to deeply equal []` — a constraint somebody set, cleared
    // by somebody who typed two digits and walked away.
    const { box, sent } = shownDay('2026-08-20');
    Object.defineProperty(box, 'validity', { configurable: true, value: { badInput: true } });
    box.focus();
    fireEvent.change(box, { target: { value: '' } });

    fireEvent.blur(box);

    expect(sent).toEqual([]);
  });
});

describe('how an edit ends', () => {
  itDom('Enter commits and says so', () => {
    // The one way out that does not leave the field, and the table's earliest
    // start cell closes on it: the day is sent first, then the exit reported,
    // so a caller that unmounts this on the report cannot unmount it before the
    // day has gone.
    const { box, sent, exits } = shownDay('2026-08-20');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(sent).toEqual(['2026-08-17']);
    expect(exits).toEqual(['commit']);
  });

  itDom('leaving the field commits and says so', () => {
    const { box, sent, exits } = shownDay('2026-08-20');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });

    fireEvent.blur(box);

    expect(sent).toEqual(['2026-08-17']);
    expect(exits).toEqual(['commit']);
  });

  itDom('reports leaving a box nobody typed in as a commit all the same', () => {
    // Nothing to send is not the same as a cancel: the edit ended the ordinary
    // way and the caller closes the editor either way. `sent` is what says
    // whether anything went.
    const { box, sent, exits } = shownDay('2026-08-20');
    box.focus();

    fireEvent.blur(box);

    expect(sent).toEqual([]);
    expect(exits).toEqual(['commit']);
  });

  itDom('Escape exits without committing', () => {
    // Everything this suite can honestly claim about Escape, and it is worth
    // saying what it cannot: the blur Escape causes is **not** proved here. The
    // caller unmounts this editor on the report, an unmounted field receives no
    // blur, and jsdom would have to be handed a synthetic one the production
    // path never delivers — a check that could not fail (R5, and the shape of
    // #14/#15). `e2e/keyboard.spec.ts` is where the suppression is proved.
    //
    // Proof: `onExit?.('cancel')` removed from the Escape branch, this failed
    // on `expected [] to deeply equal [ 'cancel' ]`. Watched, 2026-08-09.
    const { box, sent, exits } = shownDay('2026-06-01');
    box.focus();
    typeSegments(box, ['2026-07-01']);

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(exits).toEqual(['cancel']);
    expect(sent).toEqual([]);
  });

  itDom('puts back the day the server agreed, for a field that stays on screen', () => {
    // The toolbar's project start date is not unmounted by Escape — it is
    // always on screen — so abandoning an edit there has to leave the box
    // reading what be-01 holds rather than the day nobody saved.
    const { box } = shownDay('2026-06-01');
    box.focus();
    typeSegments(box, ['2026-07-01']);

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(box.value).toBe('2026-06-01');
  });

  itDom('has nothing left for the blur after an Escape to send', () => {
    // Escape does not suppress that blur; it makes it harmless, by putting the
    // box back to the day the server agreed. So the blur is an ordinary way out
    // — it reports a commit — and it sends nothing, because there is nothing
    // that differs from what be-01 holds.
    //
    // The blur is delivered by hand here, which is why this is not the proof of
    // anything a browser does: `e2e/keyboard.spec.ts` is where a real one
    // arrives.
    const { box, sent, exits } = shownDay('2026-06-01');
    box.focus();
    typeSegments(box, ['2026-07-01']);
    fireEvent.keyDown(box, { key: 'Escape' });

    fireEvent.blur(box);

    expect(sent).toEqual([]);
    expect(exits).toEqual(['cancel', 'commit']);

    // And the field is editable again straight after: abandoning one edit does
    // not abandon the next.
    box.focus();
    typeSegments(box, ['2026-07-02']);
    fireEvent.blur(box);
    expect(sent).toEqual(['2026-07-02']);
  });
});

describe('a day picked from the calendar', () => {
  // What makes a pick a pick, here and in the component: a `change` with **no
  // `keydown` in the box since the focus arrived**. jsdom has no calendar popup
  // and never will, so what these two cases check is that the rule branches on
  // the key — not that Chrome's picker really delivers none. That half is a
  // browser's to answer and `e2e/keyboard.spec.ts` asks it, with the typing
  // half beside it so the pair cannot drift apart.

  itDom('is sent the moment it lands, without waiting for the field to be left', () => {
    // The bug this exists for: the project start date is the calendar the whole
    // Gantt is drawn against, and “saved when you move on” read as a chart that
    // ignores the reader (`wbs-gantt-stale-on-start-date`, chunk 2 — the table
    // was stale too, and nothing had left the browser).
    //
    // Proof: the `onChange` handler removed from `date-field.tsx`, this fails
    // on `expected [] to deeply equal [ '2026-09-07' ]`.
    const { box, sent } = shownDay('2026-06-01');
    box.focus();

    fireEvent.change(box, { target: { value: '2026-09-07' } });

    expect(sent).toEqual(['2026-09-07']);
  });

  itDom('is not taken back by Escape, because a pick is finished the moment it is sent', () => {
    // **The limit of the exception, pinned so that re-adding an undo has to be
    // a decision rather than an accident.** An Escape branch that restored the
    // day held at focus *and sent it* was written on 2026-08-23 and deleted the
    // same day: a browser cannot reach it. The toolbar disables its controls
    // for the write's window and disabling a focused input drops the focus out
    // of it, so after a pick the Escape goes to `<body>` and this component
    // never sees the key. Two `e2e/keyboard.spec.ts` cases measured exactly
    // that, reading `1 Jul` and `2026-09-09` where the undo claimed otherwise.
    //
    // What jsdom can still say is what the code does *if* the key did arrive,
    // and this is it: the box goes back to the day the server agreed, which
    // after a pick is the picked day, and nothing more is sent.
    //
    // Proof: `node.value = agreed.current` changed back to a `heldAtFocus`
    // restore-and-commit, this fails on `expected [ '2026-09-07',
    // '2026-06-01' ] to deeply equal [ '2026-09-07' ]`.
    const { box, sent } = shownDay('2026-06-01');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-09-07' } });

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(sent).toEqual(['2026-09-07']);
    expect(box.value).toBe('2026-09-07');

    // And the blur Escape causes has nothing left to send either: the box and
    // the server agree on the picked day.
    fireEvent.blur(box);
    expect(sent).toEqual(['2026-09-07']);
  });
});

describe('a date field and the server’s answer', () => {
  /** The field with a day a button can change under it, as a refetch would. */
  function Host() {
    const [day, setDay] = useState('2026-08-20');
    return (
      <>
        <DateField aria-label="Starts" value={day} commit={() => undefined} />
        <button
          type="button"
          onClick={() => {
            setDay((current) => (current === '2026-08-20' ? '2026-09-01' : '2026-09-02'));
          }}
        >
          answer
        </button>
      </>
    );
  }

  itDom('never writes an answer over a reader who is in the box', () => {
    // The other half of the year-0002 fault: the box was controlled, so every
    // render re-asserted be-01's answer into it — and the render that landed
    // between two keystrokes reset the segment under the caret.
    //
    // Proof: the `document.activeElement` line removed from the effect, this
    // failed on `expected '2026-09-01' to be '2026-08-17'`.
    render(<Host />);
    const box = screen.getByLabelText<HTMLInputElement>('Starts');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });

    fireEvent.click(screen.getByRole('button', { name: 'answer' }));

    expect(box.value).toBe('2026-08-17');
  });

  itDom('takes the answer once the reader has left', () => {
    render(<Host />);
    const box = screen.getByLabelText<HTMLInputElement>('Starts');

    fireEvent.click(screen.getByRole('button', { name: 'answer' }));

    expect(box.value).toBe('2026-09-01');
  });
});
