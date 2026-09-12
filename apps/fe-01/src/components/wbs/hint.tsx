import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { type AnchorRect, type DiagonalAnchor, HoverCard } from '@/components/wbs/hover-card';

/**
 * The attribute a control carries its **tool hint** in, in place of a `title`.
 *
 * A `title` is the **browser's** tooltip, not this app's: Chromium waits about
 * a second before showing one, draws it in the platform's own chrome rather
 * than the page's, and puts it where the pointer is rather than under the
 * control. Nothing in a stylesheet reaches any of that, and where a card and a
 * `title` describe the same pixels the browser's raced the app's — which
 * `start-date-hover-card` fixed for one cell and the folded step cell's own
 * comment had said a fortnight earlier.
 *
 * Dany, 2026-08-31: _"make sure that all places where we show hint — this is
 * not slow system hint, but custom instant pretty hint"_. So the words move to
 * this attribute, {@link HintLayer} draws them in the page's own card, and no
 * control in this app carries a `title` it means as a hint.
 *
 * The words here say **what the control does**, and since `tool-hints-wait`
 * they wait {@link TOOL_HINT_WAIT_MS} before they are drawn. Dany, 2026-09-01:
 * _"this must avoid unnecessary interruptions while moving the cursor over UI
 * elements, rn this is more annoying than useful when you already know what
 * buttons or UI elements do"_. Words about the reader's own project go in
 * {@link FACT_ATTRIBUTE} instead and still open at once.
 *
 * **The words stay in the DOM** rather than living in a closure, for the reason
 * `data-start-said` does: several oracles read a control's hint back out, and
 * none of them can hover. Anything that read a `title` reads this instead.
 */
export const HINT_ATTRIBUTE = 'data-hint';

/**
 * The attribute a mark carries its **project fact** in.
 *
 * The same card as {@link HINT_ATTRIBUTE}'s and the same layer draws it; the
 * one difference is that this one opens the moment the pointer arrives. The
 * split is by what the words are **about**, not by which mark carries them: who
 * a tag was inherited from, how many days a row can slip, where a link goes and
 * why an action was refused are all things the reader came to the plan to
 * learn, and a wait in front of them is a wait in front of the plan.
 *
 * It is sometimes decided per render rather than per call site. The reorder
 * grip says either _"Drag to move this row"_ — the tool, so `data-hint` — or
 * _"Frozen — unfreeze this row before moving it"_ — this row, so `data-fact`.
 * Such a site spreads whichever attribute the branch's words belong to.
 *
 * A mark carrying **both** is a fault rather than a precedence puzzle, and
 * `e2e/hints.spec.ts` sweeps the whole plan to say none does. Nesting is not
 * that fault: a fact chip inside a hinted toolbar is the arrangement the
 * nearest-wins rule exists for.
 */
export const FACT_ATTRIBUTE = 'data-fact';

/**
 * How long a pointer rests on a control before its tool hint is drawn.
 *
 * Two seconds, which is Dany's own number and is long on purpose: the reader
 * this change is for already knows what the button does and is trying to get
 * past it. A project fact waits none of it.
 *
 * It was three. Dany, 2026-09-01, having watched the shipped ring: _"change
 * 3000 to 2000, leave 400ms quiet"_. {@link RING_QUIET_MS} is deliberately not
 * scaled with it — the quiet is about a cursor **crossing** a control, which is
 * as fast as it ever was, so the whole of the second that came off is taken
 * from the ring's own sweep.
 */
export const TOOL_HINT_WAIT_MS = 2000;

/**
 * How much of that wait passes before the {@link WaitRing} is drawn at all.
 *
 * The whole of what makes a sweep across the toolbar leave nothing behind it. A
 * ring that appeared the instant the pointer crossed a control would be the
 * interruption this change removes, wearing a smaller costume.
 */
export const RING_QUIET_MS = 400;

/** What a component adds to its own props to let a caller give it a tool hint. */
export interface Hintable {
  [HINT_ATTRIBUTE]?: string;
}

/**
 * What a component adds to its own props to let a caller give it a project fact.
 *
 * Separate from {@link Hintable} rather than a `kind` beside one string, so the
 * attribute a call site writes is the whole of what says which it is — there is
 * no second value that can fall out of step with the words. A wrapper component's
 * props are an interface, not a set of intrinsic JSX attributes, so React's
 * blanket permission for `data-*` on a DOM element does not reach it:
 * `<Button data-fact="…">` is a type error until the component says it takes one.
 */
export interface Factable {
  [FACT_ATTRIBUTE]?: string;
}

/** The selector {@link HintLayer} finds a hinted or facted mark by. */
const HINTED = `[${FACT_ATTRIBUTE}],[${HINT_ATTRIBUTE}]`;

/** The id of the one card this layer draws, so a hinted control can point at it. */
const HINT_CARD_ID = 'hint-card';

/**
 * Where a mark's card is placed from, **as the card's own prop**.
 *
 * A union of one key each rather than two optionals, because the two are two
 * placements of one card and a reading carrying both is a state {@link
 * HoverCard} has no answer for. Spread straight into the card, so nothing has to
 * stay in step with anything: the measurement decides the placement.
 */
type HintPlacement = { anchor: AnchorRect } | { diagonal: DiagonalAnchor };

/** What the layer is showing or waiting to show. */
interface OpenHint {
  words: string;
  /**
   * Where the card stands: **diagonally** past its cell and row for a mark
   * inside the plan's own scrolling frame, and under the mark for one outside
   * it.
   *
   * Dany, 2026-09-11: *"implement 'diagonal' pop-up for ALL columns including
   * PRIO, not before, deadline, end, slack; ALL of them, must have same look and
   * feel"*. A card over a cell's mark covers the rows below it and a plan is
   * read down a column — so every card inside the frame clears both its column
   * and its row, exactly as the cards that open from a cell have since
   * `cards-open-diagonally`.
   *
   * A card under a **toolbar** control covers nothing but the header, and a row
   * of small buttons whose cards jumped left and right would be worse for it —
   * so the frame is what decides, not the layer.
   */
  placement: HintPlacement;
  /** The mark the words belong to, held so `aria-describedby` can be taken off it again. */
  node: HTMLElement;
  /** Whether these words wait — true for a tool hint, false for a project fact. */
  waits: boolean;
}

/** Where the ring is drawn, in viewport coordinates. */
interface RingAt {
  left: number;
  top: number;
}

/** How far down and right of the cursor the ring sits, in CSS pixels. */
const RING_OFFSET_PX = 14;

/** How wide the ring's box is, in CSS pixels. */
const RING_SIZE_PX = 14;

/** The radius its two circles are drawn at, inside that box, leaving room for the stroke. */
const RING_RADIUS = 6;

/** How thick they are drawn. */
const RING_STROKE = 2;

/**
 * The mark drawn beside the cursor while a tool hint is waiting to open.
 *
 * The only sign that a control has anything to say, now that saying it takes
 * two seconds — and it is the reason the wait is discoverable rather than a
 * feature nobody finds. Not a control: no focus, no pointer events, no place in
 * any keyboard grid, and `role="presentation"` so a screen reader ignores it
 * outright. Anybody on a keyboard gets the card itself, at once.
 *
 * **The fill is a CSS animation rather than per-frame state.** A ring that
 * re-rendered this layer sixty times a second while the pointer rests would
 * charge that cost on every control in the app; the browser can sweep a
 * `stroke-dashoffset` on its own. `wait-ring-fill` in `styles.css` holds the
 * keyframes, and honours `prefers-reduced-motion` by drawing a still ring.
 *
 * Portalled to the document for the reason an anchored {@link HoverCard} is:
 * the cursor can be over the Gantt's `<svg>`, which can hold no HTML at all,
 * and every scrolling ancestor between here and there clips.
 */
function WaitRing({ at }: { at: RingAt }): React.JSX.Element {
  // Kept inside the window on the two edges the offset pushes towards. A ring
  // half off the screen is a ring the reader cannot read the progress of.
  const left = Math.min(at.left + RING_OFFSET_PX, window.innerWidth - RING_SIZE_PX);
  const top = Math.min(at.top + RING_OFFSET_PX, window.innerHeight - RING_SIZE_PX);
  const circumference = 2 * Math.PI * RING_RADIUS;
  const centre = RING_SIZE_PX / 2;
  return createPortal(
    <svg
      data-wait-ring=""
      role="presentation"
      width={RING_SIZE_PX}
      height={RING_SIZE_PX}
      viewBox={`0 0 ${String(RING_SIZE_PX)} ${String(RING_SIZE_PX)}`}
      style={{
        position: 'fixed',
        left,
        top,
        // Above the card's own 20, so a ring that outlives a card by a frame is
        // never drawn behind one.
        zIndex: 21,
        pointerEvents: 'none',
      }}
    >
      <circle
        cx={centre}
        cy={centre}
        r={RING_RADIUS}
        fill="none"
        stroke="var(--border)"
        strokeWidth={RING_STROKE}
      />
      <circle
        className="wait-ring-fill"
        cx={centre}
        cy={centre}
        r={RING_RADIUS}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference}
        // From twelve o'clock rather than three, which is where a reader looks
        // for the start of a dial.
        transform={`rotate(-90 ${String(centre)} ${String(centre)})`}
        style={{ animationDuration: `${String(TOOL_HINT_WAIT_MS - RING_QUIET_MS)}ms` }}
      />
    </svg>,
    document.body,
  );
}

/**
 * The one card every hint in this app is drawn in, mounted once per document.
 *
 * **One listener and one piece of state**, and that is the whole of why it is a
 * layer rather than a wrapper component at ninety-odd call sites. Every
 * `pointerover` replaces the reading outright — the hinted mark the pointer is
 * now inside, or none — so there is no departure to miss and no stale opening
 * that can outlive the pointer. A per-control `onMouseEnter` / `onMouseLeave`
 * pair is the arrangement that can drop half of itself; this one cannot,
 * because there is nothing to drop.
 *
 * `pointerover` alone closes as well as opens: the pointer is always inside
 * some element or other, so leaving a hinted mark fires the event on whatever
 * it moved to, and that element's `closest` answers null. `pointerleave` on the
 * document is the one case the bubbling event cannot report — the pointer
 * leaving the window entirely.
 *
 * **Two kinds of words, one card.** {@link FACT_ATTRIBUTE} opens at once;
 * {@link HINT_ATTRIBUTE} waits {@link TOOL_HINT_WAIT_MS} with a {@link
 * WaitRing} beside the cursor for the last of it. The nearest of the two wins,
 * which is what lets a fact chip live inside a hinted toolbar.
 *
 * **The touch seam**, as on the Gantt's bars and the table's rows: Chromium
 * synthesizes a whole mouse sequence from a tap, and a tap has no departure
 * behind it, so a card opened on one would be stuck on whatever was touched
 * last. Only a mouse opens a hint; a phone gets the control's own label.
 *
 * A **disabled `Button` is out of reach**, and it is a real limit rather than
 * an oversight. `buttonVariants`' base carries `disabled:pointer-events-none`,
 * so a disabled control is not a hit target and no `pointerover` ever names it
 * — measured in Chromium, `elementFromPoint` at a disabled Undo's own centre
 * answering the toolbar `<div>`. The controls that affects are Undo, Redo and
 * Reset layout, whose hints restate what their labels already say. Where the
 * hint is the *reason* a control is off, it is written on the live `<label>`
 * around the control rather than on the disabled `<input>` inside it —
 * `wbs-table.tsx`'s facet boxes — so that sentence still reaches a reader.
 *
 * The keyboard opens the same card from `focusin`, with **no wait of either
 * kind**, for the reason the Start cell's does: a `title` on a focusable
 * control is announced as its description, so a card only a pointer can open is
 * data withheld from anybody who does not use one. There is also no cursor to
 * put a ring beside. Escape closes it without leaving the control.
 *
 * **A click is not a keyboard focus.** Chromium focuses a `<button>` on
 * mousedown, so clicking a hinted control fires `focusin` on a mark the pointer
 * is already attending — and an instant card there would undo the wait for
 * every toolbar button in the app, which is the whole change. The guard is the
 * same node-identity check the pointer path uses: a focus that lands on the
 * mark already being attended changes nothing.
 */
export function HintLayer(): React.JSX.Element {
  const [open, setOpen] = useState<OpenHint | null>(null);
  const [ring, setRing] = useState<RingAt | null>(null);

  useEffect(() => {
    /**
     * Where this mark's card stands, measured **now**.
     *
     * Inside the plan's frame it stands diagonally, and the two axes clear two
     * different boxes: the mark's **cell** horizontally and its **row**
     * vertically. Not the mark itself — a fact's mark is often a word or a glyph
     * inside a much wider cell, Slack's being four characters in a 56px column,
     * and a card placed against the glyph stands in the middle of the lane it
     * was meant to leave alone. Where the mark is in the frame but in no cell —
     * a `<th>`'s hint, a facet box in the frame's own padding — the mark is its
     * own column and its own row, which is the same promise about a smaller box.
     *
     * Outside the frame the card opens under its mark, unchanged: the toolbar's
     * own cards cover nothing but the header.
     *
     * The frame is intersected with the window because a `position: fixed` card
     * is clipped by neither, so the clamp {@link diagonalPlacement} applies is
     * the whole of what keeps the card inside the plan. `HoverCard`'s in-cell
     * branch measures the same intersection.
     */
    const placementOf = (node: Element): HintPlacement => {
      const box = node.getBoundingClientRect();
      const port = node.closest('[data-table-frame]')?.getBoundingClientRect();
      if (port === undefined) {
        return { anchor: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
      }
      const cell = node.closest('td,th')?.getBoundingClientRect();
      const row = node.closest('tr')?.getBoundingClientRect();
      return {
        diagonal: {
          clear: {
            left: cell?.left ?? box.left,
            right: cell?.right ?? box.right,
            top: row?.top ?? box.top,
            bottom: row?.bottom ?? box.bottom,
          },
          frame: {
            left: Math.max(0, port.left),
            right: Math.min(window.innerWidth, port.right),
            top: Math.max(0, port.top),
            bottom: Math.min(window.innerHeight, port.bottom),
          },
        },
      };
    };

    /** The hinted mark an event happened inside, and the words it carries. */
    const hintAt = (target: EventTarget | null): OpenHint | null => {
      if (!(target instanceof Element)) return null;
      const node = target.closest(HINTED);
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return null;
      // The fact is read first and decides both questions at once: a mark with
      // one attribute answers on that one, and the nesting case is already
      // settled by `closest` having found the nearest of the two.
      const fact = node.getAttribute(FACT_ATTRIBUTE);
      const words = fact ?? node.getAttribute(HINT_ATTRIBUTE);
      // An empty hint is a mark that has nothing to say today — a toggle whose
      // reason is only there while it is off, say — and is not a fault: the
      // attribute is written from a value that may be absent. No card.
      if (words === null || words === '') return null;
      return {
        words,
        placement: placementOf(node),
        // Narrowed rather than cast: an `SVGElement` is an `HTMLElement` for
        // everything used here — `setAttribute`, `removeAttribute` — but the
        // two do not share a type, so the state holds the wider one.
        node: node as HTMLElement,
        waits: fact === null,
      };
    };

    /**
     * The mark the layer is showing or waiting for, and the two timers of a wait.
     *
     * Closure variables rather than refs because nothing renders from them and
     * every reader is inside this effect, which is mounted once. `attending` is
     * what makes a `pointerover` from a descendant of the mark already being
     * attended a no-op instead of a restarted wait.
     */
    let attending: HTMLElement | null = null;
    /**
     * Where the cursor was when it last pressed, or null once it has moved.
     *
     * The quiet a press buys has to survive the page redrawing underneath a
     * cursor that has not moved, and that is not a rare case — it is what every
     * control that opens a dialog does. Measured in Chromium: pressing
     * `Keyboard shortcuts` and closing its dialog fires `pointerover DIV
     * mark=none` and then `pointerover svg mark=BUTTON`, both at
     * `834.47998046875,65` — the press's own coordinates, because the pointer
     * is exactly where it was and only the elements under it changed. Read as
     * departures, those two restart the wait and the card arrives two seconds
     * after the dialog closes, over a button the reader has just used.
     *
     * So the departure that ends a press's quiet is the **cursor** moving, not
     * the mark under it changing. Compared exactly rather than within a
     * tolerance: the churn events re-report the same double, and "the cursor
     * did not move" is the claim being made.
     */
    let pressedAt: { x: number; y: number } | null = null;
    let opening: ReturnType<typeof setTimeout> | null = null;
    let ringing: ReturnType<typeof setTimeout> | null = null;

    const moved = (event: PointerEvent): void => {
      setRing({ left: event.clientX, top: event.clientY });
    };

    /** Ends a wait — its timers, its cursor listener and its ring — leaving any open card alone. */
    const stopWaiting = (): void => {
      if (opening !== null) {
        clearTimeout(opening);
        opening = null;
      }
      if (ringing !== null) {
        clearTimeout(ringing);
        ringing = null;
      }
      // Removed unconditionally: `removeEventListener` for a listener that was
      // never added is a no-op, and the alternative is a second flag that can
      // fall out of step with the one that matters.
      document.removeEventListener('pointermove', moved);
      setRing(null);
    };

    const clear = (): void => {
      attending = null;
      stopWaiting();
      setOpen(null);
    };

    /** Begins attending a mark: a fact is drawn now, a tool hint after its wait. */
    const attend = (at: OpenHint, from: RingAt): void => {
      clear();
      attending = at.node;
      if (!at.waits) {
        setOpen(at);
        return;
      }
      ringing = setTimeout(() => {
        ringing = null;
        setRing(from);
        // Added only for the part of the wait the ring is drawn in, so a page
        // at rest has no per-move work at all.
        document.addEventListener('pointermove', moved);
      }, RING_QUIET_MS);
      opening = setTimeout(() => {
        opening = null;
        stopWaiting();
        // Measured **now** and not when the pointer arrived. Two seconds is
        // long enough for the table under a resting pointer to have settled,
        // scrolled or grown a row, and a card placed from rectangles that old is
        // a card beside where its control used to be.
        setOpen({ ...at, placement: placementOf(at.node) });
      }, TOOL_HINT_WAIT_MS);
    };

    /**
     * A press on the mark being attended, which ends its wait and draws nothing.
     *
     * Dany, 2026-09-01: _"if user clicks and interacts with the element, no need
     * to show the tooltip; only show tooltip after prolonged hover without
     * clicks"_. The wait reads a resting pointer as a reader who does not know
     * what the control does; a reader who has pressed it has answered that
     * themselves, and the card would arrive two seconds later over whatever
     * the press just did.
     *
     * **`pointerdown` and not `click`.** Chromium focuses a `<button>` on
     * mousedown, so the press's own `focusin` reaches {@link focused} before a
     * click listener would ever run — and that path opens with no wait at all.
     * Cancelling on the press is what puts this ahead of the focus rather than
     * behind it.
     *
     * **`stopWaiting()` and not `clear()`**, which is the difference between
     * ending a wait and closing a card. A {@link FACT_ATTRIBUTE} mark has no
     * wait to end and its card is already open — the words are about the
     * reader's own plan, and pressing an inherited tag does not make where it
     * came from less worth reading.
     *
     * **It marks the cursor, not the mark.** `attending` is left exactly as it
     * was, so a `pointerover` from a child of this mark is still an early
     * return in {@link pointed} and the press's own `focusin` is still one in
     * {@link focused}, both on the same node identity. What is recorded is
     * {@link pressedAt} — where the cursor stood — and only so that the redraw
     * a press causes is not read as the reader moving. Move the cursor and the
     * quiet is over: there is no mark to un-mark, and the next rest waits its
     * full two seconds.
     */
    const pressed = (event: PointerEvent): void => {
      if (attending === null) return;
      if (!(event.target instanceof Node)) return;
      if (!attending.contains(event.target)) return;
      pressedAt = { x: event.clientX, y: event.clientY };
      stopWaiting();
    };

    const pointed = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      if (pressedAt !== null) {
        // The cursor is where it was left: whatever this event says is under it
        // now, the reader has not moved and the press still stands. Returning
        // rather than clearing, because there is nothing open to close — the
        // press ended the wait — and clearing would drop the very identity the
        // rest of this layer reads.
        if (event.clientX === pressedAt.x && event.clientY === pressedAt.y) return;
        pressedAt = null;
      }
      const at = hintAt(event.target);
      if (at === null) {
        clear();
        return;
      }
      // A `pointerover` bubbling from a descendant of the mark already being
      // attended: the wait it started is still the right one, and restarting it
      // would make a hint on a control with children unreachable.
      if (at.node === attending) return;
      attend(at, { left: event.clientX, top: event.clientY });
    };
    const left = (): void => {
      // The pointer leaving the window is a departure nothing has to be
      // measured against, so it ends a press's quiet outright.
      pressedAt = null;
      clear();
    };
    /**
     * What a scroll or a resize does, which is **not** what leaving does.
     *
     * An open card is placed from a rectangle measured once, so anything that
     * moves its control out from under it closes the card rather than leaving
     * it adrift. A card that is still being **waited** for has nothing placed
     * yet and re-measures when it fires, so a scroll leaves the wait running.
     *
     * That distinction matters because cancelling a wait kills the hint
     * outright: the pointer has not moved, so no further `pointerover` will
     * ever restart it, and two seconds is a long window for something on the
     * page to move. It is reasoning rather than a sighting — the bug that sent
     * me looking here turned out to be `focused`'s, and no scroll was in the
     * log at all — but the behaviour is asserted either way, in
     * `hint.test.tsx`'s `leaves a waiting tool hint running when the page
     * settles under the pointer`, watched failing with this guard removed. A
     * browser case for it was written twice and shipped neither time; see the
     * note in `e2e/hints.spec.ts` for what is wrong with both oracles.
     */
    const settled = (): void => {
      if (opening !== null) return;
      clear();
    };
    const focused = (event: FocusEvent): void => {
      const at = hintAt(event.target);
      // **A focus that lands on nothing says nothing about the pointer.** This
      // path only ever opens; departure is `blurred`'s, and `blurred` is
      // narrowed to the mark being attended.
      //
      // Clearing here was the bug the whole change nearly shipped with. Add a
      // work item and rest on `Gantt`: the write hands the keyboard to the new
      // row's Name box a few milliseconds later, that `focusin` names a
      // `<textarea>` with no words of its own, and the wait the pointer had
      // just started was cancelled — with the pointer still on the button and
      // no further `pointerover` to ever restart it. Every toolbar hint went
      // dead for the rest of the visit. Measured in Chromium at 900×500, the
      // document's own listeners logged: `59 pointerover BUTTON "Draw the
      // schedule un"`, `94 focusout BUTTON`, `99 focusin TEXTAREA`, and no
      // card at ten seconds.
      if (at === null) return;
      // The pointer got here first — a click, most likely. Its own rules apply,
      // wait and all.
      if (at.node === attending) return;
      clear();
      attending = at.node;
      setOpen(at);
    };
    const blurred = (event: FocusEvent): void => {
      // Narrowed to the mark being attended, so a focus moving elsewhere on the
      // page does not cancel a wait the pointer is in the middle of.
      if (!(event.target instanceof Node)) return;
      if (attending?.contains(event.target) !== true) return;
      clear();
    };
    const escaped = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clear();
    };

    document.addEventListener('pointerover', pointed);
    document.addEventListener('pointerdown', pressed);
    document.addEventListener('pointerleave', left);
    document.addEventListener('focusin', focused);
    document.addEventListener('focusout', blurred);
    document.addEventListener('keydown', escaped);
    // Capture, because the scroll that matters is the table frame's and a
    // scroll event does not bubble. See {@link settled} for why this is not
    // `left`.
    document.addEventListener('scroll', settled, true);
    window.addEventListener('resize', settled);
    return () => {
      document.removeEventListener('pointerover', pointed);
      document.removeEventListener('pointerdown', pressed);
      document.removeEventListener('pointerleave', left);
      document.removeEventListener('focusin', focused);
      document.removeEventListener('focusout', blurred);
      document.removeEventListener('keydown', escaped);
      document.removeEventListener('scroll', settled, true);
      window.removeEventListener('resize', settled);
      // The wait outlives the listeners otherwise: a timer already scheduled
      // would open a card into an unmounted layer.
      stopWaiting();
    };
  }, []);

  /*
    The description, written onto the mark itself while its card is open.

    Imperative because the mark is not this component's to render — it is any of
    ninety-odd elements across the app — and `aria-describedby` has to name an
    id that exists. The cleanup takes it off again, so a mark that has been
    hinted is indistinguishable at rest from one that never was.

    A mark that already had an `aria-describedby` keeps it: the hint is added to
    the list and removed from it, rather than replacing what was there.
  */
  useEffect(() => {
    if (open === null) return undefined;
    const { node } = open;
    const had = node.getAttribute('aria-describedby');
    node.setAttribute('aria-describedby', had === null ? HINT_CARD_ID : `${had} ${HINT_CARD_ID}`);
    return () => {
      if (had === null) node.removeAttribute('aria-describedby');
      else node.setAttribute('aria-describedby', had);
    };
  }, [open]);

  return (
    <>
      {ring === null ? null : <WaitRing at={ring} />}
      {open === null ? null : (
        <HoverCard id={HINT_CARD_ID} {...open.placement} compact>
          {/*
            `pre-line`, so a mark whose words are **several** — the schedule
            cue's, which carries a block per schedule, one comparing the two
            optimized ones, what the three algorithms are, and the solver
            identity — reads as the paragraphs it was written as rather than as
            one run-on line. An attribute value keeps its newlines; only the
            rendering collapses them, and this is where.

            Every other hint in the app is one line and is unaffected: `pre-line`
            collapses runs of spaces exactly as `normal` does and wraps the same
            way. What it does not do is preserve **leading** spaces, which is
            why the cue's own lines carry none.
          */}
          <span style={{ whiteSpace: 'pre-line' }}>{open.words}</span>
        </HoverCard>
      )}
    </>
  );
}
