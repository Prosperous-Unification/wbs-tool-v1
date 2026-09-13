import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HintLayer, RING_QUIET_MS, TOOL_HINT_WAIT_MS } from './hint';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** Two controls — one hinted, one not — and the layer that draws for them. */
function aPageWithAHint(): { hinted: HTMLElement; bare: HTMLElement } {
  render(
    <div>
      <HintLayer />
      <button type="button" data-hint="Undo your last change to this plan">
        Undo
      </button>
      <button type="button">Redo</button>
    </div>,
  );
  return {
    hinted: screen.getByRole('button', { name: 'Undo' }),
    bare: screen.getByRole('button', { name: 'Redo' }),
  };
}

/** A mark carrying a project fact, which waits for nothing. */
function aPageWithAFact(): { facted: HTMLElement; bare: HTMLElement } {
  render(
    <div>
      <HintLayer />
      <span data-fact="Backend — inherited from 010. Remove it there.">↳ Backend</span>
      <button type="button">Redo</button>
    </div>,
  );
  return {
    facted: screen.getByText('↳ Backend'),
    bare: screen.getByRole('button', { name: 'Redo' }),
  };
}

/**
 * A `pointerover` of one kind or the other, built by hand.
 *
 * jsdom has no `PointerEvent`, so `fireEvent.pointerOver(node, { pointerType })`
 * builds a plain `Event` and **drops** the init's `pointerType`: the layer's
 * guard then reads `undefined`, refuses, and every assertion about the pointer
 * path passes because nothing was ever pointed. `wbs-table.test.tsx` and
 * `gantt-panel.test.tsx` carry the same helper for the same reason; all three
 * are the trap, not a preference.
 *
 * The coordinates go on for the same reason: the ring is placed from them, and
 * an init jsdom drops is a ring placed at the origin in every test.
 */
const pointAt = (
  node: HTMLElement,
  { pointerType = 'mouse', at = { x: 100, y: 200 } }: PointedInit = {},
): void => {
  const event = new Event('pointerover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'clientX', { value: at.x });
  Object.defineProperty(event, 'clientY', { value: at.y });
  // Through `fireEvent` and not `node.dispatchEvent`: the former wraps the
  // dispatch in `act`, so the state the listener sets is flushed before the
  // assertion. Dispatched raw, the card is drawn a tick after it is looked for.
  fireEvent(node, event);
};

interface PointedInit {
  pointerType?: 'mouse' | 'touch';
  at?: { x: number; y: number };
}

/** The cursor moving without leaving anything — what the ring follows. */
const dragCursorTo = (at: { x: number; y: number }): void => {
  const event = new Event('pointermove', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: at.x });
  Object.defineProperty(event, 'clientY', { value: at.y });
  fireEvent(document, event);
};

/**
 * A press on a mark, which is what ends a wait.
 *
 * `pointerdown` and not `click`: the layer cancels on the press because
 * Chromium focuses a `<button>` on mousedown, so a cancel that waited for the
 * click would run after the `focusin` the press already caused. Built by hand
 * for the same reason {@link pointAt} is — jsdom has no `PointerEvent`.
 */
const pressAt = (node: HTMLElement, at = { x: 100, y: 200 }): void => {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  // The coordinates are the whole of how the layer tells a departure from the
  // page redrawing under a cursor that has not moved, so an init jsdom drops is
  // a press the quiet cannot be measured from.
  Object.defineProperty(event, 'clientX', { value: at.x });
  Object.defineProperty(event, 'clientY', { value: at.y });
  fireEvent(node, event);
};

/** Runs the clock forward inside `act`, so what the timer sets is on screen after it. */
const waitOut = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** The wait ring, or null while none is drawn. */
const ring = (): Element | null => document.querySelector('[data-wait-ring]');

describe('a project fact is drawn the moment the pointer arrives', () => {
  itDom('opens the page’s own card on a pointer, with no timer to wait out', () => {
    const { facted } = aPageWithAFact();

    // Nothing before the pointer arrives: the card is rendered, not hidden.
    expect(screen.queryByRole('tooltip')).toBeNull();

    pointAt(facted);

    // Proof: `HintLayer`'s `pointerover` listener and its handler deleted —
    // the words then reach a reader only through an attribute nothing draws.
    // Watched failing on `Unable to find an accessible element with the role
    // "tooltip"`, which is `getByRole` on a card that was never opened.
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Backend — inherited from 010. Remove it there.',
    );
  });

  itDom('draws no ring, because there is nothing to wait for', () => {
    vi.useFakeTimers();
    try {
      const { facted } = aPageWithAFact();

      pointAt(facted);
      expect(screen.getByRole('tooltip').textContent).toBe(
        'Backend — inherited from 010. Remove it there.',
      );

      // Measured 100ms past the quiet and **not** at the end of the wait, which
      // is the window the fault lives in: `stopWaiting` clears the ring on its
      // way to opening the card, so a fact that had wrongly taken the tool path
      // would be indistinguishable from a correct one two seconds later. Read
      // there, this assertion could not fail — watched passing with the ring
      // started for a fact.
      waitOut(RING_QUIET_MS + 100);

      // Proof: `attend`'s ring timer started before its `if (!at.waits)` early
      // return, so a fact opened at once and rang anyway. Watched failing on
      // `expected SVGSVGElement{ …(2), …(2) } to be null`.
      expect(ring()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('answers first when it sits inside a hinted control', () => {
    render(
      <div>
        <HintLayer />
        <button type="button" data-hint="Choose which columns are on the table">
          <span data-fact="010 — Foundations">010</span>
        </button>
      </div>,
    );

    // The arrangement the nearest-wins rule exists for. `closest` is handed
    // both attributes in one selector, so the inner mark is simply the nearer
    // of the two and no precedence rule is needed at all.
    //
    // Proof: the selector narrowed back to `[data-hint]` alone, watched failing
    // on `Unable to find an accessible element with the role "tooltip"`. Not
    // the wrong words, which is what the fault looks like it should give — the
    // nearest mark `closest` then finds is the **button**, whose words are a
    // tool hint, so the chip's fact is not late or wrong but silent for three
    // seconds. The failure output named the button and its `data-hint` under
    // "Here are the accessible roles".
    pointAt(screen.getByText('010'));

    expect(screen.getByRole('tooltip').textContent).toBe('010 — Foundations');
  });
});

describe('a tool hint waits, so a cursor crossing the toolbar is not interrupted', () => {
  itDom('says nothing until the wait is out', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      pointAt(hinted);
      waitOut(TOOL_HINT_WAIT_MS - 1);

      // Dany, 2026-09-01: "this must avoid unnecessary interruptions while
      // moving the cursor over UI elements".
      //
      // Proof: the wait removed — `attend` calling `setOpen(at)` for a tool
      // hint the way it does for a fact. Watched failing on `expected <div
      // role="tooltip" id="hint-card">Undo your last change to this
      // plan</div> to be null`, the card present a millisecond short of the
      // wait it is meant to take.
      expect(screen.queryByRole('tooltip')).toBeNull();

      waitOut(1);

      expect(screen.getByRole('tooltip').textContent).toBe('Undo your last change to this plan');
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('opens nothing for a pointer that moves on before the wait is out', () => {
    vi.useFakeTimers();
    try {
      const { hinted, bare } = aPageWithAHint();

      pointAt(hinted);
      waitOut(TOOL_HINT_WAIT_MS - 100);
      pointAt(bare);
      waitOut(TOOL_HINT_WAIT_MS);

      // Proof: `clear`'s call to `stopWaiting` removed, so a departure
      // cancelled nothing — watched failing on `expected <div role="tooltip"
      // …>Undo your last change to this plan</div> to be null`, a card opening
      // for a control the pointer had left a hundred milliseconds earlier.
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('leaves nothing behind a cursor sweeping across three controls', () => {
    vi.useFakeTimers();
    try {
      render(
        <div>
          <HintLayer />
          <button type="button" data-hint="Undo your last change to this plan">
            Undo
          </button>
          <button type="button" data-hint="Put back what you last undid">
            Redo
          </button>
          <button type="button" data-hint="Keyboard shortcuts (?)">
            Shortcuts
          </button>
        </div>,
      );

      // 150ms on each, which is a hand moving to something else — well inside
      // the 400ms of `RING_QUIET_MS` and nowhere near `TOOL_HINT_WAIT_MS`.
      //
      // A literal rather than `RING_QUIET_MS - 250`, and that is the point: the
      // fault this case is about *is* that constant going to zero, and an
      // advance computed from it would go negative and fail the run on `Negative
      // ticks are not supported` instead of on the assertion. Watched doing
      // exactly that before it was written this way.
      for (const name of ['Undo', 'Redo', 'Shortcuts']) {
        pointAt(screen.getByRole('button', { name }));
        waitOut(150);
        // Proof: `RING_QUIET_MS` set to 0, watched failing here on `expected
        // <svg data-wait-ring …/> to be null` at the first crossing — a mark
        // drawn under a cursor that was only passing.
        expect(ring()).toBeNull();
        expect(screen.queryByRole('tooltip')).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('says nothing at all to a tap', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      // The touch seam, as on the Gantt's bars and the table's rows: Chromium
      // synthesizes a whole mouse sequence from a tap and a tap has no
      // departure behind it, so a card opened on one is stuck on whatever was
      // touched last.
      //
      // Proof: the `pointerType !== 'mouse'` guard deleted, watched failing on
      // `expected SVGSVGElement{ …(2), …(2) } to be null` — the ring assertion
      // below reaches it first, a mark drawn beside a finger.
      pointAt(hinted, { pointerType: 'touch' });

      // The ring is read inside its own window and the card at the end of the
      // wait, because the two are only ever on screen at different moments: a
      // ring read at the end of the wait has been cleared by the opening whether the
      // fault is there or not.
      waitOut(RING_QUIET_MS + 100);
      expect(ring()).toBeNull();

      waitOut(TOOL_HINT_WAIT_MS);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the wait ring says a hint is coming', () => {
  itDom('is absent through the quiet, drawn after it, and gone once the card is up', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      pointAt(hinted, { at: { x: 100, y: 200 } });
      // 399 and 1, either side of `RING_QUIET_MS`'s 400, written as literals for
      // the reason the sweep above is: an advance computed from the constant
      // goes negative under the very fault this asserts against.
      waitOut(399);
      expect(ring()).toBeNull();

      waitOut(1);

      // Proof: the `ringing` timer's `setRing` removed, watched failing on
      // `expected null not to be null` — a three-second wait with nothing on
      // screen to say one was happening.
      const drawn = ring();
      expect(drawn).not.toBeNull();
      expect(drawn?.getAttribute('style')).toContain('left: 114px');

      waitOut(TOOL_HINT_WAIT_MS - RING_QUIET_MS);

      // Proof: the `stopWaiting()` inside the opening timer removed, watched
      // failing on `expected <svg data-wait-ring …/> to be null` — a ring left
      // spinning beside a card it had already delivered.
      expect(ring()).toBeNull();
      expect(screen.queryByRole('tooltip')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('follows the cursor, and stops listening for it once the wait is over', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      pointAt(hinted, { at: { x: 100, y: 200 } });
      waitOut(RING_QUIET_MS);
      dragCursorTo({ x: 300, y: 400 });

      // Proof: the `pointermove` listener never added, watched failing on
      // `expected 'position: fixed; left: 114px; top: 214px; …' to contain
      // 'left: 314px'` — a ring left at the pixel the pointer entered on.
      expect(ring()?.getAttribute('style')).toContain('left: 314px');

      waitOut(TOOL_HINT_WAIT_MS - RING_QUIET_MS);
      dragCursorTo({ x: 500, y: 600 });

      // The listener is added for the part of the wait the ring is drawn in and
      // taken off when the wait resolves, so a page at rest does no per-move
      // work at all. Nothing to see is the whole assertion: a ring drawn here
      // would be one this move brought back.
      //
      // Proof: `stopWaiting`'s `removeEventListener` deleted, watched failing on
      // `expected <svg data-wait-ring …/> to be null` — the move above
      // re-rendering a ring for a wait that had already ended.
      expect(ring()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a scroll closes a card but does not kill a wait', () => {
  itDom('leaves a waiting tool hint running when the page settles under the pointer', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      pointAt(hinted);
      waitOut(600);

      // The case this exists for, found in Chromium: adding a work item makes
      // the table settle a moment later, that fires a scroll, and the pointer
      // resting on a toolbar button has not moved — so cancelling here means no
      // `pointerover` ever restarts the wait and the hint never comes at all.
      //
      // Proof: `settled`'s `if (opening !== null) return;` removed, which is
      // the scroll handler being `clear` again. Watched failing on `expected
      // null not to be null`.
      fireEvent.scroll(document);
      waitOut(TOOL_HINT_WAIT_MS);

      expect(screen.queryByRole('tooltip')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('still closes a card that is already open, whose anchor a scroll makes stale', () => {
    const { facted } = aPageWithAFact();

    pointAt(facted);
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // Proof: `settled`'s body reduced to a bare `return`, watched failing on
    // `expected <div role="tooltip" …(2)></div> to be null` — a card left
    // hanging where its mark no longer is.
    fireEvent.scroll(document);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('places the card from where the control is when it opens, not where it was', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      /*
        jsdom measures every box as zero, so the two rectangles are stubbed:
        this is the one assertion in this file that needs a measurement, and
        stubbing is the only way to have one up here. What it proves is the
        *wiring* — that the rectangle the card is placed from is read at the
        moment the card opens rather than at the moment the pointer arrived —
        and that is a fact about this file, not about a browser.
      */
      const before = { left: 10, top: 10, bottom: 30 };
      const after = { left: 400, top: 500, bottom: 520 };
      let box = before;
      hinted.getBoundingClientRect = (): DOMRect => ({
        ...box,
        right: 0,
        width: 0,
        height: 0,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      });

      pointAt(hinted);
      waitOut(600);
      box = after;
      waitOut(TOOL_HINT_WAIT_MS);

      // Proof: the opening timer's `getBoundingClientRect` taken back out and
      // `setOpen(at)` restored, so the card is placed from the rectangle the
      // pointer arrived over. Watched failing on `expected 'position: fixed;
      // top: 36px; left: 10px; …' to contain 'left: 400px'`.
      const style = screen.getByRole('tooltip').getAttribute('style') ?? '';
      expect(style).toContain('left: 400px');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the keyboard is answered at once, and a click is not the keyboard', () => {
  itDom('opens a tool hint on focus with no wait, and points the control at it', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      // A `title` on a focusable control is announced as its description, so a
      // card only a pointer can open is data withheld from anybody who does not
      // use one — `start-date-hover-card`'s own argument, one cell wider. And
      // there is no cursor to put a ring beside.
      //
      // Proof: the `focusin` path routed through `attend`, watched failing on
      // `Unable to find an accessible element with the role "tooltip"` before
      // any timer had been advanced.
      fireEvent.focusIn(hinted);

      const card = screen.getByRole('tooltip');
      expect(hinted.getAttribute('aria-describedby')).toBe(card.id);
      expect(ring()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('does not let a click on a hinted control jump its wait', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      // Chromium focuses a `<button>` on mousedown, so every click on a hinted
      // control fires `focusin` on a mark the pointer is already attending. An
      // instant card there would undo the wait for every button in the toolbar,
      // which is the whole change.
      //
      // Proof: `focused`'s `at.node === attending` guard removed, watched
      // failing on `expected <div role="tooltip" …>Undo your last change to
      // this plan</div> to be null` — the card up the instant the button was
      // pressed.
      pointAt(hinted);
      waitOut(500);
      fireEvent.focusIn(hinted);

      expect(screen.queryByRole('tooltip')).toBeNull();

      // And the wait it interrupted nothing of still finishes on time.
      waitOut(TOOL_HINT_WAIT_MS - 500);
      expect(screen.queryByRole('tooltip')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('keeps a pointer’s wait when the keyboard lands on something with nothing to say', () => {
    vi.useFakeTimers();
    try {
      render(
        <div>
          <HintLayer />
          <button type="button" data-hint="Draw the schedule under the plan">
            Gantt
          </button>
          <textarea aria-label="Name of 010" />
        </div>,
      );

      pointAt(screen.getByRole('button', { name: 'Gantt' }));
      waitOut(400);

      // The bug this change nearly shipped with. Adding a work item hands the
      // keyboard to the new row's Name box a few milliseconds later, and that
      // focus names an element with no words of its own — which used to cancel
      // a wait the pointer had just started, with the pointer still on the
      // button and nothing left to restart it.
      //
      // Proof: `focused`'s `if (at === null) return;` put back to
      // `clear(); return;`. Watched failing on `expected null not to be null`.
      fireEvent.focusIn(screen.getByLabelText('Name of 010'));
      waitOut(TOOL_HINT_WAIT_MS);

      expect(screen.queryByRole('tooltip')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('takes the description back off the control when the card goes', () => {
    const { hinted, bare } = aPageWithAHint();

    fireEvent.focusIn(hinted);
    expect(hinted.getAttribute('aria-describedby')).not.toBeNull();

    pointAt(bare);

    // A control that has been hinted is indistinguishable at rest from one that
    // never was — an `aria-describedby` left pointing at a card that is no
    // longer in the document is a broken reference, which a screen reader reads
    // as nothing at all rather than as an error.
    //
    // Proof: the cleanup's `removeAttribute` dropped, watched failing on
    // `expected 'hint-card' to be null`.
    expect(hinted.getAttribute('aria-describedby')).toBeNull();
  });

  itDom('closes on Escape without taking the pointer or the focus anywhere', () => {
    const { hinted } = aPageWithAHint();

    fireEvent.focusIn(hinted);
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // Proof: the `keydown` listener and its handler deleted, watched failing
    // on `expected <div role="tooltip" …(2)></div> to be null`.
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('a press says the reader already knows what the control does', () => {
  itDom('ends the wait it interrupted', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      // Dany, 2026-09-01: "if user clicks and interacts with the element, no
      // need to show the tooltip; only show tooltip after prolonged hover
      // without clicks". A reader who has pressed the control has answered the
      // question the wait was asking.
      pointAt(hinted);
      waitOut(RING_QUIET_MS + 100);
      expect(ring()).not.toBeNull();

      pressAt(hinted);

      // The ring goes with the wait, in the same breath.
      expect(ring()).toBeNull();

      // And the whole of the rest of the wait passes with nothing drawn — the
      // press cancelled the timer rather than deferring it.
      //
      // Proof: the `pointerdown` listener removed, watched failing on
      // `expected SVGSVGElement{ …(2), …(2) } to be null` — the ring still
      // beside the cursor in the moment after the press, one assertion before
      // the card it would have opened.
      waitOut(TOOL_HINT_WAIT_MS);
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(ring()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('is not undone by the focus the press itself causes', () => {
    vi.useFakeTimers();
    try {
      const { hinted } = aPageWithAHint();

      // Chromium focuses a `<button>` on mousedown, so a real press is a
      // `pointerdown` and a `focusin` on the same mark, in that order. The
      // focus path opens with no wait at all, so this sequence is the one that
      // would invert the feature.
      //
      // **No new guard was written for this**, and the check is here to say so:
      // `focused` already returns on `at.node === attending`, and a marker
      // consulted beside that identity would be a check that cannot fail.
      pointAt(hinted);
      waitOut(RING_QUIET_MS + 100);
      pressAt(hinted);
      fireEvent.focusIn(hinted);

      expect(screen.queryByRole('tooltip')).toBeNull();

      waitOut(TOOL_HINT_WAIT_MS);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('leaves a fact’s card alone, because a fact never waited', () => {
    vi.useFakeTimers();
    try {
      const { facted } = aPageWithAFact();

      pointAt(facted);
      expect(screen.queryByRole('tooltip')).not.toBeNull();

      // The words are about the reader’s own plan — who a tag was inherited
      // from — and pressing the mark does not make them less worth reading.
      // The press path ends a *wait*, and this mark has none.
      //
      // Proof: the press path’s `stopWaiting()` replaced by `clear()`, watched
      // failing on `expected null not to be null`. The same injection also
      // fails `is not undone by the focus the press itself causes`, and that is
      // the more interesting half: `clear()` nulls `attending`, so the
      // `focusin` the press causes no longer matches the identity guard and
      // opens the card at once. Ending a wait and closing a card are not the
      // same act.
      pressAt(facted);

      expect(screen.queryByRole('tooltip')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('is not restarted by the page redrawing under a cursor that has not moved', () => {
    vi.useFakeTimers();
    try {
      const { hinted, bare } = aPageWithAHint();

      pointAt(hinted);
      pressAt(hinted);

      /*
        **The case that made this rule.** Measured in Chromium: pressing
        `Keyboard shortcuts` and closing the dialog it opens fires
        `pointerover DIV mark=none` and then `pointerover svg mark=BUTTON`,
        both at the press's own `834.47998046875,65` — the cursor is exactly
        where it was, and only the elements under it changed. Read as a
        departure and a return, those two restart the wait, and the card
        arrives two seconds after the dialog closes over a button the reader
        has just used.

        Proof: the `pressedAt` coordinate comparison removed from `pointed`,
        watched failing on `expected <div role="tooltip" …(2)></div> to be
        null` — the card up a whole wait after a press the reader never moved
        away from.
      */
      pointAt(bare);
      pointAt(hinted);
      waitOut(TOOL_HINT_WAIT_MS);

      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('waits again once the pointer has left and come back', () => {
    vi.useFakeTimers();
    try {
      const { hinted, bare } = aPageWithAHint();

      pointAt(hinted);
      pressAt(hinted);
      waitOut(TOOL_HINT_WAIT_MS);
      expect(screen.queryByRole('tooltip')).toBeNull();

      // **The quiet is a cancelled timer, not a control marked silent.** This
      // slice adds no guard at all — it is the absence of any `pressed` state
      // that makes the return work — and this case is what stops a later change
      // adding one without noticing that this is the contract.
      // **At a different point**, which is what a departure is. Left at the
      // press's own coordinates these two are the dialog case below, and this
      // assertion would be about the wrong rule entirely.
      pointAt(bare, { at: { x: 400, y: 400 } });
      pointAt(hinted, { at: { x: 100, y: 200 } });
      waitOut(TOOL_HINT_WAIT_MS);

      expect(screen.getByRole('tooltip').textContent).toBe('Undo your last change to this plan');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a fact’s lead word is drawn bold, and in its tone', () => {
  itDom('bolds the lead where it occurs in the words, and colours a done one', () => {
    render(
      <div>
        <HintLayer />
        <span
          data-fact="Status: Done. Every step says finished."
          data-fact-lead="Done"
          data-fact-tone="done"
        >
          ✓
        </span>
        <span data-fact="Status: Unknown. Nobody has said." data-fact-lead="Unknown">
          ○
        </span>
        <span data-fact="Backend — inherited from 010.">↳ Backend</span>
      </div>,
    );

    pointAt(screen.getByText('✓'));
    let card = screen.getByRole('tooltip');
    expect(card.textContent).toBe('Status: Done. Every step says finished.');
    let lead = card.querySelector('strong');
    // Dany, 2026-09-13: "mark Unknown and Done statuses in bold + make Done
    // green color". Proof: `factWords` made to return `words` outright, and
    // this fails on `expected null not to be null`; watched 2026-09-13.
    expect(lead).not.toBeNull();
    expect(lead?.textContent).toBe('Done');
    expect(lead?.style.color).toBe('var(--status-done)');

    pointAt(screen.getByText('○'));
    card = screen.getByRole('tooltip');
    lead = card.querySelector('strong');
    expect(lead?.textContent).toBe('Unknown');
    expect(lead?.style.color).toBe('');
    expect(card.textContent).toBe('Status: Unknown. Nobody has said.');

    // A fact with no lead is the plain words it always was.
    pointAt(screen.getByText('↳ Backend'));
    expect(screen.getByRole('tooltip').querySelector('strong')).toBeNull();
  });

  itDom('draws a lead that is not in the words as plain words rather than a broken card', () => {
    render(
      <div>
        <HintLayer />
        <span data-fact="Status: Done." data-fact-lead="Finished">
          ✓
        </span>
      </div>,
    );
    pointAt(screen.getByText('✓'));
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toBe('Status: Done.');
    expect(card.querySelector('strong')).toBeNull();
  });
});

describe('a mark that opens a list of its own takes its card down', () => {
  /** A combobox the way the Status and priority cells are one: a click opens its list. */
  function AListOpener(): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <HintLayer />
        <input
          aria-label="Status of 010"
          role="combobox"
          aria-expanded={open}
          aria-controls="a-list-that-is-not-here"
          data-fact="Status: Unknown. Nobody has said where this work has got to."
          readOnly
          onClick={() => {
            setOpen((was) => !was);
          }}
        />
        <button type="button">Redo</button>
      </div>
    );
  }

  itDom(
    'closes the fact card the moment the list opens, and leaves it up for a click that opens nothing',
    async () => {
      render(<AListOpener />);
      const box = screen.getByRole('combobox', { name: 'Status of 010' });
      const bare = screen.getByRole('button', { name: 'Redo' });

      pointAt(box);
      expect(screen.queryByRole('tooltip')).not.toBeNull();

      // A press elsewhere that opens nothing: the fact stays, as `leaves a fact’s
      // card alone` says it must.
      await act(async () => {
        fireEvent.click(bare);
        // The layer re-reads the mark in a microtask; this lets it run.
        await Promise.resolve();
      });
      expect(screen.queryByRole('tooltip')).not.toBeNull();

      // Dany, 2026-09-13: "when i click the status to select new value i want
      // dropdown to remove the hint pop-up". The list and the card would stand
      // one over the other, saying the same word twice.
      // Proof: the `click`/`keyup` listener that re-reads `aria-expanded`
      // removed, and this fails on `expected not null to be null`; watched
      // 2026-09-13.
      pressAt(box);
      await act(async () => {
        fireEvent.click(box);
        // The layer re-reads the mark in a microtask; this lets it run.
        await Promise.resolve();
      });
      expect(box).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('tooltip')).toBeNull();
    },
  );

  itDom('closes it for a keyboard that opens the list too', async () => {
    render(<AListOpener />);
    const box = screen.getByRole('combobox', { name: 'Status of 010' });

    act(() => {
      box.focus();
    });
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // The component opens on click; Enter on a real cell does the same, and the
    // layer reads the outcome — `aria-expanded` — not the key, so a `keyup`
    // after the list opened is enough.
    await act(async () => {
      fireEvent.click(box);
      fireEvent.keyUp(box, { key: 'Enter' });
      // The layer re-reads the mark in a microtask; this lets it run.
      await Promise.resolve();
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('a mark with nothing to say draws nothing', () => {
  itDom('closes when the pointer moves to something with nothing to say', () => {
    const { facted, bare } = aPageWithAFact();

    pointAt(facted);
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // The seam this layer is built around: a `pointerover` on the mark the
    // pointer moved **to** is what closes the last one, so there is no
    // departure to miss. Proof: `clear()` replaced by an early `return` where
    // `hintAt` answers null — which is the per-control `onMouseEnter`-only
    // arrangement, and leaves the last card up for good. Watched failing on
    // `expected <div role="tooltip" …(2)></div> to be null`.
    pointAt(bare);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('an empty hint is a control with nothing to say, not a card with nothing in it', () => {
    vi.useFakeTimers();
    try {
      render(
        <div>
          <HintLayer />
          <button type="button" data-hint="">
            Reset layout
          </button>
        </div>,
      );

      // The attribute is written from a value that may be absent — a toggle
      // whose reason is only there while it is off — so an empty one is not a
      // fault.
      //
      // Proof: the `words === ''` half of the guard deleted, watched failing on
      // `expected SVGSVGElement{ …(2), …(2) } to be null` — a control with
      // nothing to say ringing for the whole wait before the empty card. The
      // fact case below failed in the same run, on `expected <div
      // role="tooltip" …(2)></div> to be null`.
      pointAt(screen.getByRole('button', { name: 'Reset layout' }));

      // Both read where each can be seen, for the tap case's reason.
      waitOut(RING_QUIET_MS + 100);
      expect(ring()).toBeNull();

      waitOut(TOOL_HINT_WAIT_MS);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('an empty fact is the same, and is not read as a hint on the same mark', () => {
    render(
      <div>
        <HintLayer />
        <span data-fact="">↳ nothing inherited</span>
      </div>,
    );

    // The fact is read first and decides both questions at once, so an empty
    // one has to stop there rather than falling through to a `data-hint` that
    // is not on this mark either.
    pointAt(screen.getByText('↳ nothing inherited'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
