import { type ComponentProps, useCallback, useEffect, useRef } from 'react';

type PassedThrough = Omit<
  ComponentProps<'input'>,
  'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'ref'
>;

/**
 * The two element types a cell can be.
 *
 * A `<textarea>` is what makes a long name wrap instead of scrolling out of
 * sight, and it carries the same `selectionStart`/`selectionEnd`/`value` the
 * keyboard code reads — so Tab, Backspace and the arrows keep working without
 * knowing which one they are standing in.
 */
export type CellElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * What became of an edit this cell sent.
 *
 * `refused` covers everything that left be-01 without the edit — a 4xx, a
 * dropped connection, a request that never went out. They are one event to a
 * cell: the only copy of what was typed is the one on screen.
 *
 * `unsent` is the commit that asked be-01 for nothing, and it is not the same
 * answer. A composite cell whose two texts differ only in their line endings
 * sends no patch; an estimate cell holds a half-typed trio as a draft it
 * renders from. Neither has anything for this component to hold back or to
 * correct, and calling either of them `landed` would be recording a write.
 */
export type CommitOutcome = 'landed' | 'refused' | 'unsent';

/** The answer a commit that sent nothing gives, as a settled promise. */
export const unsent = (): Promise<CommitOutcome> => Promise.resolve('unsent');

/**
 * Every mounted cell's own "leave this cell now", by the node it belongs to.
 *
 * The keyboard needs it: Cmd+Enter and Ctrl+N have to send what is in the box
 * **before** they move the focus or create a row, and the only thing they hold
 * is `event.currentTarget`. Reaching it through the node rather than plumbing
 * a commit thunk down to each of the four cell classes is what keeps the
 * routing matrix's cells identical to each other — one call, whichever kind of
 * box the chord was pressed in.
 *
 * A `WeakMap`, so a cell that unmounts takes its entry with it: a `Map` keyed
 * by element is a leak of every row anybody has ever scrolled past.
 */
const flushes = new WeakMap<CellElement, () => Promise<CommitOutcome>>();

/**
 * Commits `node` exactly as leaving it would, and answers what be-01 did.
 *
 * `unsent` for a box that is not a {@link CellInput} — the date cell and the
 * pickers, which write on the change or on the pick and hold no draft between
 * keystrokes. That is a modeled state rather than an unknown: those boxes have
 * nothing to flush, and the chord that called this still has to run.
 *
 * @param node The box the chord was pressed in.
 * @returns What be-01 did with what was in it, once the request has settled.
 */
export function flushCell(node: CellElement): Promise<CommitOutcome> {
  return flushes.get(node)?.() ?? unsent();
}

export interface CellInputProps extends PassedThrough {
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
   * The cap is what keeps a long note from pushing the rest of the plan off
   * the screen now that the notes live in this box: past `maxRestRows` the
   * cell scrolls, and the rendered preview on hover is where a long note is
   * read.
   */
  autoSize?: boolean;
  /** Lines an auto-sizing cell will grow to at rest before it scrolls instead. */
  maxRestRows?: number;
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
   * @param typed What the box holds now.
   * @param baseline What it was showing when this typing began — rule 2's held
   * value, which is *not* the same as the current server value whenever a peer's
   * edit arrived mid-word and was held back. A cell that edits more than one
   * field at once (the Name cell holds the notes under the name) must diff
   * against this rather than against the row it renders from, or the field the
   * local user never touched reads as one they emptied. Cells with one field
   * ignore it: for them `typed !== baseline` is the whole answer, and this
   * component has already asked it.
   * @returns What be-01 did with it, once the request has settled — which is
   * what lets this component hold a refused draft against every later refetch
   * (rule 4) instead of leaving it in the DOM to be written over. A commit
   * that sends nothing answers {@link unsent}.
   */
  commit: (typed: string, baseline: string) => Promise<CommitOutcome>;
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
 * One editable cell of the table: an uncontrolled input that still follows the
 * server, without ever being remounted to do it.
 *
 * The obvious version of "follow the server" is `key={value}` on an input with a
 * `defaultValue` — a new key, a new node, and the new value is picked up because
 * the old node is gone. That shipped, and it meant a peer editing the field you
 * are typing in unmounted your input mid-word and dropped the focus to the body.
 * Every edit here refetches the whole tree (see {@link WbsTable}), so that is not
 * a rare collision: it is what happens whenever two people work on one row.
 *
 * So the node is kept and its `value` is assigned directly instead. Three rules,
 * and the third is the one worth reading twice:
 *
 * 1. A new server value is written into the node, not rendered — no remount, no
 *    lost focus, no lost caret.
 * 2. Nothing is written while the person is typing in this cell. Their word wins
 *    until they leave it, and their own blur is what resolves the disagreement.
 * 3. A blur sends only what actually differs from the value this cell was last
 *    showing. Clicking through a row writes nothing.
 * 4. A draft be-01 **refused** is held against every later refetch, focus or no
 *    focus. Rule 2 only holds while the cell has the focus, and a refusal
 *    arrives after the blur that caused it — so without this the only copy of
 *    the typed text sits in the DOM waiting for the next peer edit to erase it.
 * 5. The same text is not sent twice against the same baseline. `shown` stays
 *    on the old value until the refetch lands, so a second focus-and-leave
 *    inside that window looks exactly like a fresh edit to rule 3
 *    — and one gesture would become two journal entries and two Cmd+Zs.
 */
export function CellInput({
  value,
  commit,
  onAttach,
  onTyped,
  multiline = false,
  autoSize = false,
  maxRestRows = 4,
  ...rest
}: CellInputProps) {
  const element = useRef<CellElement | null>(null);
  /** The value this node is currently showing, as far as this component knows. */
  const shown = useRef(value);
  /** Whether anyone has typed here since `shown` and the node last agreed. */
  const typed = useRef(false);
  /** The newest server value, readable from a blur handler as well as an effect. */
  const latest = useRef(value);
  /**
   * Whether the box holds text be-01 was asked for and refused (rule 4).
   *
   * Not `typed`: that one is only consulted while the cell has the focus, and
   * by the time a refusal comes back the focus has gone — leaving it the only
   * thing standing between a person's two typed fields and the next refetch
   * would be leaving nothing there at all.
   */
  const refused = useRef(false);
  /**
   * The last submission this cell made, and what it was diffed against (rule 5).
   *
   * The baseline is half of it because it is what makes the record expire by
   * itself: once a refetch has moved `shown`, the same text typed again is a
   * different edit and is sent.
   *
   * `landing` is the third field because a flush is not only a blur. A chord
   * that flushes a cell whose blur is still out has to be given **that**
   * request's answer, not a settled `unsent`: `unsent` reads as "nothing is
   * happening here", and the chord would create a row or move the focus while
   * a patch that may yet be refused is in the air.
   */
  const sent = useRef<{
    typed: string;
    baseline: string;
    landing: Promise<CommitOutcome>;
  } | null>(null);

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
   */
  const resize = useCallback(
    (node: CellElement | null) => {
      if (!autoSize || node === null || !(node instanceof HTMLTextAreaElement)) return;
      const focused = node === document.activeElement;
      node.style.height = 'auto';
      node.style.height = `${String(node.scrollHeight)}px`;
      // Uncapped while it is being written in: the cap keeps the table
      // readable, it is not there to stop anyone writing.
      node.style.maxHeight = focused ? 'none' : `${String(maxRestRows * 1.4)}em`;
      node.style.overflowY = 'auto';
    },
    [autoSize, maxRestRows],
  );

  const sync = useCallback(() => {
    const input = element.current;
    if (input === null || latest.current === shown.current) return;
    // Rule 4, before rule 2 and without asking where the focus is: a refused
    // draft is unsaved text that exists nowhere else, and the refusal landed
    // after the blur that sent it. It is held until the person resolves it
    // themselves — by leaving the cell again, which retries it, or by putting
    // the box back to what it was showing, which abandons it.
    // Proof: deleted, `keeps a refused draft on screen when the next refetch
    // arrives` failed on `expected 'Rewire the shed\nmeasure twice' to be
    // 'Strip the wiring\nmeasure twice, cut …'`. Watched, 2026-08-08.
    if (refused.current) return;
    // Rule 2. `document.activeElement` rather than a focus/blur flag of our own:
    // the question is only ever asked about right now, and the DOM already knows
    // the answer without a second copy of it to keep in step.
    if (typed.current && input === document.activeElement) return;
    input.value = latest.current;
    shown.current = latest.current;
    typed.current = false;
  }, []);

  useEffect(() => {
    latest.current = value;
    sync();
    // After the sync, not before: the height has to follow the value the node
    // is actually showing, and a peer's edit arrives through `sync` rather
    // than through any keystroke of ours.
    resize(element.current);
  }, [value, sync, resize]);

  /**
   * What leaving a cell means, shared by both elements.
   *
   * Rule 3: only a value that actually differs from what this cell was last
   * showing is sent. Clicking through a row writes nothing. Rule 5 narrows
   * that further — the same text against the same baseline is a resubmission
   * of a request that is already out — and what the commit answers decides
   * whether rule 4 holds what is in the box from here on.
   *
   * The outcome is returned as well as acted on, because a blur is no longer
   * the only caller: Cmd+Enter and Ctrl+N flush the cell through
   * {@link flushCell} and have to know whether be-01 took it before they move
   * the focus or create a row. Rule 5 is what keeps that from doubling the
   * request — the blur the focus move causes arrives at a cell whose `shown`
   * has not advanced, sees its own submission recorded, and sends nothing.
   */
  const onLeave = (): Promise<CommitOutcome> => {
    const node = element.current;
    if (node === null) return unsent();
    // Cleared before either branch: it means "typed since `shown` and the node
    // last agreed", and leaving it set would have the *next* visit to this cell
    // hold back a peer's edit on the strength of typing that happened before
    // the focus ever left.
    typed.current = false;
    if (node.value !== shown.current) {
      // Rule 5. `shown` has not moved since the last submission, so this is
      // that submission again — the person clicked back into the cell and out
      // of it while the request was still out, and be-01 has already been
      // asked for exactly this. **The answer is the request's own**, so a
      // chord that flushed this cell waits for what be-01 does with it rather
      // than reading a settled `unsent` as permission to move.
      // Proof, two faults, both watched 2026-08-08. This branch deleted:
      // `sends one request however often the cell is left before it lands`
      // failed on `expected [ [ 'w1', { …(2) } ], …(1) ] to have a length of 1
      // but got 2`. The `return` narrowed back to `unsent()`: `a chord waits
      // for the blur’s patch that is still out, and a refusal makes nothing`
      // failed on `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]`
      // — a row created against a request nobody had heard back from.
      if (sent.current?.typed === node.value && sent.current.baseline === shown.current) {
        return sent.current.landing;
      }
      // No `sync()` afterwards: `shown` is deliberately left holding the old
      // value until the refetch this commit triggers comes back. Advancing it
      // here would be recording a write that has not happened yet, and a failed
      // request would then have nothing left to correct the cell from.
      //
      // `shown.current` is handed over as the baseline for the same reason it
      // is compared against here: it is what this box was showing when the
      // typing started, which a peer's edit held back by rule 2 has
      // deliberately not moved. A composite cell diffs its fields against it.
      const landing = commit(node.value, shown.current).then((outcome) => {
        if (outcome !== 'landed') {
          // Nothing of this edit is on the server — `refused` was turned down,
          // `unsent` never went — so the record of a submission goes with it
          // and leaving the cell again is a fresh ask rather than a duplicate.
          // Proof: this line removed, `sends a refused edit again when the
          // cell is left a second time` failed on `expected [] to deeply equal
          // [ [ 'w1', { …(2) } ] ]` — the retry dropped as a duplicate of a
          // request that never landed. Watched, 2026-08-08.
          sent.current = null;
          // Rule 4, and only for the refusal: an `unsent` commit is one where
          // the box and be-01 already agree, so there is no draft to hold.
          // Proof: this line removed, `keeps a refused draft on screen when
          // the next refetch arrives` failed on the same assertion the gate in
          // `sync` answers for — a refusal nothing records is a refusal
          // nothing can hold. Watched, 2026-08-08.
          refused.current = outcome === 'refused';
          return outcome;
        }
        refused.current = false;
        // The refetch this commit triggered lands *before* it resolves, so a
        // draft that rule 4 held back was held back through the one render
        // that carried its answer. Nothing else would come.
        sync();
        resize(element.current);
        return outcome;
      });
      // Recorded synchronously, before any continuation above can run: the
      // record is what a flush arriving in the meantime is answered from, and
      // the `sent.current = null` a refusal performs is a microtask away at
      // the earliest.
      sent.current = { typed: node.value, baseline: shown.current, landing };
      return landing;
    }
    // Nothing typed, or typed back to what it already said — so there is no
    // unsaved draft left to hold, and anything rule 2 or rule 4 held back
    // while the focus was here is safe to apply now.
    refused.current = false;
    sync();
    return unsent();
  };

  /**
   * The newest {@link onLeave}, so the one {@link flushes} holds is never a
   * render behind.
   *
   * Assigned during render for the reason `live` in `wbs-table.tsx` is: the
   * `commit` this closes over is rebuilt on every render, an effect would
   * publish it one render late, and a chord can be pressed before effects
   * flush. What is registered in the map is a stable thunk that reads this,
   * so a cell registers once per attach and still commits through its current
   * props.
   */
  const leave = useRef(onLeave);
  leave.current = onLeave;

  /** Attaches the node and joins it to {@link flushes}, on every attach. */
  const takeNode = (node: CellElement | null): void => {
    element.current = node;
    if (node === null) return;
    flushes.set(node, () => leave.current());
    onAttach?.(node);
  };

  /** One keystroke: this component's own bookkeeping, then the caller's. */
  const tookAKeystroke = (node: CellElement): void => {
    typed.current = true;
    onTyped?.(node);
  };

  const shared = {
    defaultValue: value,
    onChange: (event: { currentTarget: CellElement }) => {
      tookAKeystroke(event.currentTarget);
    },
  };

  if (multiline) {
    return (
      <textarea
        // The same props an input takes; React accepts the overlap and the two
        // elements agree on everything this component uses.
        {...(rest as ComponentProps<'textarea'>)}
        ref={(node) => {
          takeNode(node);
          // On attach as well as on change: a row arriving from a refresh has
          // never been typed in, and its name is exactly the one most likely
          // to be long.
          if (node !== null) resize(node);
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
          resize(event.currentTarget);
          void onLeave();
        }}
      />
    );
  }

  return (
    <input
      {...rest}
      ref={takeNode}
      {...shared}
      onBlur={() => {
        void onLeave();
      }}
    />
  );
}
