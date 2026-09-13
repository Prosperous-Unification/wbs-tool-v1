import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { type Factable, type Hintable } from '@/components/wbs/hint';

import type { CellElement } from './editable-grid';
import { LiveField, type SendEdit } from './live-editing';
import { splitNameCell } from './name-notes';

type PassedThrough = Omit<
  ComponentProps<'input'>,
  'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'ref'
>;

/**
 * The height of the box the reader is actually looking at, where that is not
 * the box the text lives in.
 *
 * Under {@link CellInputProps.renderFirstLine} a cell is two boxes: a
 * `<textarea>` holding the markdown **source**, and an `aria-hidden` box drawing
 * the **rendered** reading over it. Only the textarea is in the flow, so it is
 * the textarea's height that becomes the row's — and the two do not wrap alike.
 * `[The San Juan Mountains are beautiful](https://en.wikipedia.org/…)` is one
 * short line rendered and two long ones as source, so a row grew to fit text
 * nobody can see (Dany, 2026-08-30, row `010.1.1`).
 *
 * The drawn box is `position: absolute` with `top/left/right` pinned, so it is
 * the width of the cell and as tall as its own content — which is exactly the
 * measurement wanted. Its padding and border are the textarea's own
 * (`styles.css`), so the two heights are in the same units and neither needs
 * correcting to the other.
 *
 * Answers `null` where there is no drawn box — every cell that is not rendering
 * markdown, and every one that has the focus, where the drawn box is
 * `display: none` and the source is what is on screen. `offsetParent` is the
 * cheapest thing that distinguishes those: a `display: none` element has none.
 */
function drawnBoxHeight(node: HTMLTextAreaElement): number | null {
  const drawn = node.parentElement?.querySelector('[data-cell-rendered]');
  if (!(drawn instanceof HTMLElement) || drawn.offsetParent === null) return null;
  return drawn.scrollHeight;
}

export interface CellInputProps extends PassedThrough, Hintable, Factable {
  /**
   * Which cell of the grid this is — `rowId::columnId`, the same string every
   * other part of the keyboard finds a cell by.
   *
   * Rendered as this box's `data-cell` rather than passed beside one: two
   * spellings of one identity is how the navigation and the held refusal come
   * to disagree about which box they are talking about.
   *
   * Required, and that is the point: a cell with no identity has nowhere to
   * leave a refused draft, and a component that silently held nothing would be
   * the hold that cannot fail.
   */
  cellKey: string;
  /**
   * Renders a `<textarea>` instead of an `<input>`, so the text wraps.
   *
   * The Name cell is the one that uses it, and it holds real newlines: the
   * first line is the work item's name and everything under it is its notes
   * (`name-notes.ts`). Enter is the browser's own newline there since
   * `command-keys` — a new work item is Ctrl+N, or Cmd/Ctrl+Enter at the end
   * of the plan.
   */
  multiline?: boolean;
  /** Rows at rest. Only meaningful with `multiline`; a `<textarea>` prop, not an input's. */
  rows?: number;
  /**
   * Grows the box to fit its text instead of cropping it at `rows`.
   *
   * Dany, 2026-08-06: the name "must wrap instead of cutting text". A textarea
   * wraps, but at one row it still hides everything past the first line — the
   * name reads as `…dlkfjas;` and the rest is a guess. With this on, the height
   * follows the content whether or not the cell has the focus, capped by
   * `maxRestRows` so one essay does not push the table off the screen.
   *
   * What keeps a long note from pushing the rest of the plan off the screen
   * now that the notes live in this box is one of two things, per face: the
   * card's is `maxRestRows`, past which the cell scrolls; the table's is
   * {@link CellInputProps.restShowsFirstLineOnly}, which gives the notes no
   * height at rest at all. The rendered preview on hover is where the table's
   * are read.
   */
  autoSize?: boolean;
  /**
   * Lines an auto-sizing cell will grow to at rest before it scrolls instead.
   *
   * Ignored under {@link CellInputProps.restShowsFirstLineOnly}, which decides
   * the at-rest height by measuring rather than by counting lines.
   */
  maxRestRows?: number;
  /**
   * Shows only the first line of the text while the cell is not being written
   * in — the whole of it, wrapped, and nothing under it.
   *
   * The Name cell's, and the reason it exists: that box holds the name on its
   * first line and the notes under it (`name-notes.ts`), so a plan with notes
   * was mostly notes at rest and the name — the one part that must always be
   * readable — competed for its own box. At rest the height is the wrapped
   * height of the first line at this box's current width, **measured**: a name
   * long enough to wrap is still shown whole, which is why `maxRestRows` does
   * not bind a cell that sets this.
   *
   * Hidden rather than clipped-but-scrollable: `overflow-y: hidden` at rest and
   * `auto` while focused. A clamped box that still scrolled would put the notes
   * one wheel-turn away, which is the height cap this replaces wearing a hat.
   *
   * The card face deliberately does not set it — a phone has no hover, so edit
   * would be the only place left to read a note.
   */
  restShowsFirstLineOnly?: boolean;
  /**
   * Draws the **first line** of this cell as something other than the raw text
   * while nobody is writing in it.
   *
   * The Name cell's only, and what it draws is the name's inline markdown —
   * `inline-markdown.tsx`. A `<textarea>` holds characters and cannot hold an
   * `<em>`, so the rendered reading is a second box laid over the first: the
   * textarea stays exactly what it was — the value, the measurement, the focus,
   * the commit — and at rest its own ink is transparent and this box is what a
   * reader sees. The two rules that arrange that are in `styles.css`, keyed on
   * the `data-rendered-at-rest` attribute this prop adds.
   *
   * The overlay is **out of the flow** (`position: absolute`), which is what
   * makes "nothing a name contains may change a row's height" true by
   * construction rather than by measurement — and is why the browser gate
   * measures the rendered box itself as well as the row it stands in.
   *
   * The lines under the first are drawn as the text they are: on the card face,
   * which shows the notes at rest, they are a note nobody asked to have parsed
   * twice. Where {@link CellInputProps.restShowsFirstLineOnly} is set there are
   * no such lines to draw.
   */
  renderFirstLine?: (line: string) => ReactNode;
  /** What the server says this cell holds, as it should read on screen. */
  value: string;
  /**
   * Sends what the cell holds, on blur, and only when that differs from the
   * value this cell was last showing.
   *
   * A focus and a blur with nothing typed is not an edit. Sending one anyway
   * writes the value that was on screen when the focus arrived over whatever has
   * happened since — which is a peer's edit reverted by someone who only clicked
   * through the row.
   *
   * The rules that decide whether this is called at all, and what happens to
   * what it answers, are {@link LiveField}'s — this component only renders one.
   */
  commit: SendEdit;
  /**
   * Called with the node every time React attaches it, which is more than once —
   * the ref callback is rebuilt on each render. Must be idempotent.
   */
  onAttach?: (element: CellElement) => void;
  /**
   * Called with the node on every keystroke, before anything is committed.
   *
   * For a cell that has to react to text as it is typed rather than when it is
   * left — the folded estimate cell opens its `@` people picker from here. It
   * is deliberately given the node rather than the text: the caller both reads
   * what is in the box and, on a pick, writes the mention back out of it.
   *
   * A prop rather than the `onInput` this component would otherwise pass
   * through: `onChange` is the event this component already treats as "somebody
   * typed here", and hanging a second meaning off a second name for the same
   * event is how the two come to disagree about which keystrokes counted.
   */
  onTyped?: (box: CellElement) => void;
}

/**
 * One editable cell of the table, as a box: the DOM face of a {@link LiveField}.
 *
 * Everything about *what a field knows* — the value the server last sent, the
 * word somebody is halfway through, the draft be-01 refused, the request that
 * is still out — is the field's, and lives in `live-editing.ts` so that a
 * second renderer can mount the same field. What is left here is the part that
 * is genuinely about an `<input>`: which of the two elements to render, the
 * height a textarea takes, and which browser events mean "somebody typed" and
 * "somebody left".
 */
export function CellInput({
  cellKey,
  value,
  commit,
  onAttach,
  onTyped,
  multiline = false,
  autoSize = false,
  maxRestRows = 4,
  restShowsFirstLineOnly = false,
  renderFirstLine,
  ...rest
}: CellInputProps) {
  /**
   * This face's field. Constructed once per mount, which is what re-derives
   * everything but the held refusal from the server value — see
   * {@link LiveField} for what a new face inherits and what it does not.
   */
  const held = useRef<LiveField>(undefined);
  held.current ??= new LiveField(cellKey, value);
  const field = held.current;

  /**
   * The box this face is rendering right now, or null between mounts.
   *
   * A second reference to the node the field already holds, and it is here for
   * the one caller that has no other way to reach it: the window-resize
   * re-measure below fires from outside React and outside any event of this
   * cell's. The field's own copy is private on purpose — everything else that
   * touches the node does so through an event that carries it.
   */
  const box = useRef<CellElement | null>(null);

  /**
   * Sets the height to the text's own height, and caps how tall that gets
   * while the cell is not being written in.
   *
   * `height = 'auto'` first, always: without it `scrollHeight` reports the
   * height the box already has, so a box that grew could never shrink again
   * when the text was deleted.
   *
   * The cap is `max-height` in `em` rather than arithmetic on `scrollHeight`.
   * The first attempt divided `scrollHeight` by `rows` to get a line height,
   * which at one row is the whole content — so the cap computed to four times
   * the text and never capped anything. Ems are the browser's own line
   * measurement and need no guess.
   *
   * Under {@link CellInputProps.restShowsFirstLineOnly} the at-rest height is
   * the first line's instead, and the browser is asked for it the only way it
   * answers such a question: the box is made to hold that line alone for the
   * length of one `scrollHeight` read. The swap is safe on two counts and on
   * no others — it is synchronous, so nothing else can run between taking the
   * text out and putting it back, and it never happens while the cell has the
   * focus, where it would drop the caret to the end. Everything downstream —
   * the blur that follows, {@link LiveField}'s diff against its baseline, the
   * next person to click into the cell — sees the whole text.
   */
  const resize = useCallback(
    (node: CellElement | null) => {
      if (!autoSize || node === null || !(node instanceof HTMLTextAreaElement)) return;
      const focused = node === document.activeElement;
      const clamped = restShowsFirstLineOnly && !focused;
      // `height = 'auto'` before the swap as well as before the read: the
      // measurement below is of the text, not of the box it is currently in.
      node.style.height = 'auto';
      const whole = node.value;
      // A `<textarea>`'s `value` setter parks the caret at the end of the text
      // and drops any selection with it — on a box the focus has left as much
      // as on one it has not, and Chromium keeps a selection on an unfocused
      // box for as long as it is mounted. Somebody who selected a phrase and
      // clicked away would come back to a caret at the end of their notes
      // instead; the swap has to leave no trace of itself. Direction is read
      // here too: the setter resets that to `none`, and a range restored the
      // other way round is a Shift+Arrow that grows from the wrong end.
      // Proof, two faults, both watched in Chromium on 2026-08-09, with `a
      // selection left in the name survives the measurement the blur makes`.
      // The save and restore removed: `the measurement moved the caret of a box
      // nobody was in — Expected {start: 6, end: 9}, Received {start: 272, end:
      // 272}`, the end of the whole text. The direction pinned to `'none'`:
      // `Expected: "forward", Received: "none"`.
      // All three read straight off the node: a `<textarea>` always has a
      // selection to report, which is why none of them needs a fallback and
      // why the narrowing above is what makes that true.
      const selection = {
        start: node.selectionStart,
        end: node.selectionEnd,
        direction: node.selectionDirection,
      };
      // The same rule that decides which part of this box is the name, called
      // rather than copied — a second `indexOf('\n')` here is how the box and
      // the field come to disagree about where the first line ends.
      if (clamped) node.value = splitNameCell(whole).name;
      node.style.height = `${String(drawnBoxHeight(node) ?? node.scrollHeight)}px`;
      if (clamped) {
        node.value = whole;
        node.setSelectionRange(selection.start, selection.end, selection.direction);
      }
      // Uncapped while it is being written in: the cap keeps the table
      // readable, it is not there to stop anyone writing. Uncapped at rest too
      // when the first line is all that shows — the height above is already
      // the whole of what there is to see, and a cap over it would crop a name
      // that wrapped.
      node.style.maxHeight =
        focused || restShowsFirstLineOnly ? 'none' : `${String(maxRestRows * 1.4)}em`;
      // Hidden, not `auto`: a clamped box that scrolled would hand back the
      // notes a wheel-turn at a time.
      node.style.overflowY = clamped ? 'hidden' : 'auto';
    },
    [autoSize, maxRestRows, restShowsFirstLineOnly],
  );

  /**
   * What the box holds while nobody is writing in it, which is what the
   * rendered box draws — see {@link CellInputProps.renderFirstLine}.
   *
   * **Not the `value` prop.** That is what the *server* last said, and the box
   * is deliberately uncontrolled: it also holds a draft be-01 refused (rule 4
   * of {@link LiveField}), and it holds what somebody has just typed for as
   * long as the request is out. At rest the box's own ink is transparent, so a
   * rendered box drawn from the server's value would show the reader the **old**
   * name over their own edit — the whole of `D directory-page`'s lesson, in the
   * window between a blur and an answer.
   *
   * Held rather than derived because the box is a DOM node with a value nothing
   * in React owns. It is written at the three moments the box is at rest and
   * never on a keystroke: the rendered box is not on screen while the cell has
   * the focus, and a state write per keystroke is what {@link LiveField} exists
   * to avoid.
   */
  const [restText, setRestText] = useState(value);

  /**
   * Measures the box and takes down what it now holds — the two things that
   * have to happen together every time its text changes without a keystroke.
   */
  const showsAtRest = useCallback(
    (node: CellElement | null): void => {
      resize(node);
      if (node !== null && renderFirstLine !== undefined) setRestText(node.value);
    },
    [resize, renderFirstLine],
  );

  // Assigned during render rather than in an effect, and that is deliberate:
  // `commit` closes over the row this cell belongs to and is rebuilt on every
  // render, an effect would publish it one render late, and a chord can be
  // pressed before effects flush. `LiveField.send` says the same thing from
  // the other side.
  field.send = commit;
  field.afterSync = showsAtRest;

  // `resize` is a dependency as well as the value: it is rebuilt when the cap
  // changes, and the box has to be re-measured against the new one.
  useEffect(() => {
    field.serverSaid(value);
  }, [field, value, resize]);

  /**
   * Re-measures once the drawn box holds what it is about to draw.
   *
   * {@link showsAtRest} calls {@link resize} and *then* writes
   * {@link restText}, so the measurement inside it reads the drawn box as it
   * was one name ago — the height of the previous reading, on the new one. A
   * layout effect keyed on the text is the first moment the drawn box holds
   * the new content, and it runs before the browser paints, so the corrected
   * height is the only one anybody sees.
   *
   * `useLayoutEffect` and not `useEffect` for exactly that: the same thing on
   * a passive effect is a frame of the wrong row height per edit.
   *
   * Proof: written as `useEffect`, `the row is as tall as the reading, not as
   * the source` still passed — a passive effect flushes before Playwright can
   * ask, so the browser cannot be the oracle for the flicker and this one is
   * left as a reasoned choice rather than a claim. What the test *does* watch
   * is the effect deleted altogether — see `e2e/name-markdown.spec.ts`.
   */
  useLayoutEffect(() => {
    const node = box.current;
    if (!autoSize || renderFirstLine === undefined) return;
    if (!(node instanceof HTMLTextAreaElement)) return;
    resize(node);
  }, [restText, autoSize, renderFirstLine, resize]);

  /**
   * Re-measures the clamped height when the window changes size.
   *
   * The at-rest height is the first line's height **at this box's width**, and
   * the width moves without anybody touching the cell: Name is the column that
   * absorbs whatever the fixed ones leave (`table-frame.ts`), so a window
   * dragged narrower gives it fewer pixels and a name that fitted two lines
   * needs four. Nothing else re-measures — attach, a keystroke, a focus, a blur
   * and a sync are the five, and a window resize is none of them. Under the old
   * `em` cap the stale height was scrollable; under the clamp it is
   * `overflow: hidden`, so the lines the name grew are simply not there.
   *
   * A `resize` listener rather than a `ResizeObserver`, which is the obvious
   * tool and is not available: **jsdom ships neither**, and the repository
   * already made this choice once for the same reason —
   * `useRendererForViewport` in `plan-renderer.ts` reads `window.innerWidth` on
   * this event because `matchMedia` is absent there too. An observer would
   * throw in every test that mounts a table. Nothing is debounced, here or
   * there: one `scrollHeight` read per cell per event is what the browser does
   * on every keystroke in the cell anyway.
   *
   * Only for the clamped cell. The card face's height follows its content
   * whatever the width, and a listener per cell for a measurement that cannot
   * change is a cost with no answer.
   *
   * Proof: the listener removed, `a name that wraps further in a narrower
   * window is still shown whole` failed on `a line of the name is hidden after
   * the window was made narrower — Expected: < 0.5, Received: 3.854…` — very
   * nearly four lines of a name, invisible. Watched in Chromium, 2026-08-09.
   */
  useEffect(() => {
    if (!autoSize || !restShowsFirstLineOnly) return undefined;
    const remeasure = (): void => {
      resize(box.current);
    };
    window.addEventListener('resize', remeasure);
    return () => {
      window.removeEventListener('resize', remeasure);
    };
  }, [autoSize, restShowsFirstLineOnly, resize]);

  const takeNode = (node: CellElement | null): void => {
    box.current = node;
    field.takeNode(node);
    if (node !== null) onAttach?.(node);
  };

  /** One keystroke: the field's own bookkeeping, then the caller's. */
  const tookAKeystroke = (node: CellElement): void => {
    field.tookAKeystroke();
    onTyped?.(node);
  };

  const shared = {
    'data-cell': cellKey,
    defaultValue: value,
    onChange: (event: { currentTarget: CellElement }) => {
      tookAKeystroke(event.currentTarget);
    },
  };

  if (multiline) {
    const textBox = (
      <textarea
        // The same props an input takes; React accepts the overlap and the two
        // elements agree on everything this component uses.
        {...(rest as ComponentProps<'textarea'>)}
        // The hook the two `styles.css` rules hang off: this box's ink goes
        // transparent while it is not being written in, and the rendered box
        // beside it goes away while it is.
        data-rendered-at-rest={renderFirstLine === undefined ? undefined : ''}
        ref={(node) => {
          takeNode(node);
          // On attach as well as on change: a row arriving from a refresh has
          // never been typed in, and its name is exactly the one most likely
          // to be long. Through {@link showsAtRest} rather than `resize`,
          // because `takeNode` above is where a draft be-01 refused is put
          // back into the box, and the rendered box has to show that draft
          // rather than the value the server still believes.
          showsAtRest(node);
        }}
        {...shared}
        onChange={(event) => {
          tookAKeystroke(event.currentTarget);
          resize(event.currentTarget);
        }}
        onFocus={(event) => {
          // The cap comes off while the cell is being written in and goes back
          // on when it is left: `resize` reads `document.activeElement` for
          // which of the two this is.
          resize(event.currentTarget);
          rest.onFocus?.(event as unknown as React.FocusEvent<HTMLInputElement>);
        }}
        onBlur={(event) => {
          // What the reader is leaving behind, taken down before the request
          // goes out: the rendered box shows the edit at once rather than the
          // name the server still has.
          showsAtRest(event.currentTarget);
          void field.leave();
        }}
      />
    );
    if (renderFirstLine === undefined) return textBox;

    const { name, notes } = splitNameCell(restText);
    return (
      // The positioned ancestor the rendered box is placed against, and nothing
      // else: `block` so it takes the cell's width the way the textarea used to
      // take it, and no box of its own to be seen. The Name cell's own
      // positioned wrapper is one level up and stays where the notes marker and
      // the hover preview are placed against it.
      <span style={{ position: 'relative', display: 'block', minWidth: 0 }}>
        {textBox}
        <span
          // Read by the box the reader sees; the textarea beside it is what the
          // screen reader and the keyboard have, so this one is hidden from
          // both — it has no tab stop, no step, and no name of its own to say
          // twice.
          aria-hidden="true"
          data-cell-rendered={cellKey}
          // The caller's own class and **not** its `style`: the class is what
          // gives the box its padding and its type (the phone card's `p-2
          // text-base`), and putting it on both boxes is what keeps the drawn
          // text over the typed text — one spelling, two boxes. The `style`
          // object is deliberately left off: the table's carries the
          // search-match tint, which is the textarea's to paint and would be
          // hidden by a second box painting it again. Everything else this box
          // needs is the `[data-cell-rendered]` rule in `styles.css`, in a
          // layer a caller's utility class outranks.
          className={rest.className}
        >
          {renderFirstLine(name)}
          {/*
            The notes, where this face shows them at rest — as the text they
            are. The newline is the separator `composeNameCell` writes, put back
            so the two lines read as two lines under `white-space: pre-wrap`.
          */}
          {!restShowsFirstLineOnly && notes !== '' ? `\n${notes}` : null}
        </span>
      </span>
    );
  }

  return (
    <input
      {...rest}
      ref={takeNode}
      {...shared}
      onBlur={() => {
        void field.leave();
      }}
    />
  );
}
