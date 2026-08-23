import { type ComponentProps, useEffect, useRef } from 'react';

type PassedThrough = Omit<
  ComponentProps<'input'>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur'
>;

export interface DateFieldProps extends PassedThrough {
  /** The day the server holds, as `YYYY-MM-DD`, or `''` for no day at all. */
  value: string;
  /**
   * Sends the day in the box, as `YYYY-MM-DD` or `''` for "no day".
   *
   * Called on the way out of the field, on Enter, and the moment a day arrives
   * with no key behind it — a pick, which is a finished gesture. Only ever when
   * what is in the box differs from what was last sent or last read from the
   * server. A focus and a blur with nothing typed is not an edit — the same rule
   * {@link import('./cell-input').CellInput}'s `commit` keeps, for the same
   * reason: sending anyway writes the value that was on screen when the focus
   * arrived over whatever has happened since.
   */
  commit: (day: string) => void;
  /**
   * How this edit ended, called once, after {@link commit} has had its chance.
   *
   * `'commit'` for Enter and for leaving the field: the day in the box has been
   * sent, if it differed from the one already agreed. `'cancel'` for Escape:
   * the box is back to the day the server agreed, so the blur Escape causes has
   * nothing left to send.
   *
   * **`'cancel'` is about a typed edit, and only a typed edit.** A picked day
   * is already sent by the time Escape could arrive, so there is nothing left
   * to abandon and `agreed` is the picked day — Escape puts that same day back
   * and sends nothing. That is not a gap; see the class note above for why the
   * undo that would close it cannot be reached from a browser.
   *
   * Optional because the toolbar's project start date has no editor lifecycle
   * to report: it is always on screen, and leaving it is not closing it. The
   * table's earliest-start cell is the caller this exists for — it mounts this
   * component only while a cell is being edited, and this is what unmounts it.
   */
  onExit?: (how: 'commit' | 'cancel') => void;
}

/**
 * A `<input type="date">` that saves the date somebody typed, rather than every
 * date they passed through on the way to it.
 *
 * **The fault it exists for.** A native date input fires `change` on *every*
 * segment that completes, so typing a year digit by digit fires four of them:
 * `0002-08-17`, `0020-08-17`, `0202-08-17`, `2026-08-17`. Each one was
 * committed, each commit refetched the project, and the controlled `value`
 * re-rendered the box from the server's answer mid-word — so the year segment
 * reset under the caret and the remaining digits were lost. A plan typed into
 * on 2026-08-09 was saved starting in **year 0002**, and one intermediate year
 * (`82026`) was refused with a raw `http_422`. Observed live, in Chrome.
 *
 * **The rule, and it is one rule with one exception: the box is left, then it
 * is sent — unless nobody typed.** Nothing is committed while the field has the
 * focus and keys are landing in it, however many `change` events the browser
 * fires; Enter is the one way to send without leaving.
 *
 * **The exception, and what tells the two apart.** A day arriving from the
 * native calendar popup fires exactly one `change` with **no `keydown` in this
 * box since the focus arrived** — Chrome's picker is browser UI and delivers no
 * keys to the page — while segment typing is nothing *but* keydowns, one per
 * digit, each fired before the `change` it completes. So a `change` with no key
 * behind it is a pick, and a pick is sent at once. The year-`0002` fault is
 * untouched by that: every one of its four dates arrives behind a keystroke.
 *
 * That exception was bought on 2026-08-23, against `wbs-gantt-stale-on-start-date`
 * — Dany: *"changing the start date in WBS does not automatically re-render the
 * gantt chart."* It was never the chart: a Browser Use run against dev read the
 * table, the axis and the network around a picked day and **nothing had been
 * sent** (`queue/tasks/2026-08-23-wbs-gantt-stale-on-start-date.md`, chunk 2).
 * On the one control whose value is the whole screen's calendar, "saved when
 * you move on" reads as a screen that ignores you.
 *
 * **Escape does not undo a pick, and that is a measured limit rather than an
 * oversight.** A picked day is at the server before Escape could be pressed,
 * so an undo would have to *send the old day back* — which was written, and
 * then deleted, because **a browser cannot reach it**. The toolbar disables its
 * controls for the write's window (`wbs-table.tsx`, `disabled={busy}`), and
 * disabling a focused input drops the focus out of it: by the time a reader
 * could press Escape after a pick, the key goes to `<body>` and this component
 * never sees it. The row's editor loses the focus the same way. Watched in
 * Chromium on 2026-08-23 — with the undo in place, two `e2e/keyboard.spec.ts`
 * cases read `1 Jul` and `2026-09-09` where the undo claimed `—` and
 * `2026-06-01`, because the Escape they press never arrives. A branch
 * production cannot enter is a branch this codebase deletes.
 *
 * So Escape's contract is exactly what it was before the exception: it cancels
 * a **typed** edit, where nothing has been sent yet. That is the gesture it was
 * written for on 2026-08-09 and the only one it is claimed for.
 *
 * The remaining cost, and it is real, is the other half of that same window: a
 * reader who picks a day loses the focus out of the box a moment later, where
 * before they had already left it themselves. The day is saved either way.
 *
 * And **Tab does not leave a date input in Chrome**: it steps between the day,
 * month and year segments, so a keyboard leaves this box on the third Tab or on
 * Enter. Measured on 2026-08-09 rather than assumed — `document.activeElement`
 * was still the box after a Tab, which is why `e2e/gantt.spec.ts` blurs rather
 * than tabbing and why Enter is here at all. A row's `Not before` is
 * unaffected: the table's own `onTabKey` takes Tab from that cell and moves the
 * caret itself.
 *
 * **jsdom is no longer the whole oracle, and the tests say where each half
 * lives.** jsdom can be *told* there was a keydown, so it can check that the
 * rule branches on one; only a browser can say which gesture really produces
 * one. Both halves are in `e2e/keyboard.spec.ts`: a day picked with a `change`
 * the element fires itself, and a year typed digit by digit with
 * `pressSequentially`.
 *
 * **Uncontrolled while it is on screen**, which is the other half of the fault:
 * a `value` prop is React re-asserting the server's answer on every render, and
 * a re-assertion that lands between two keystrokes is the lost digit. The
 * server's answer is assigned to the node instead, and never over a reader who
 * is in the box — the same shape `CellInput` uses to hold a half-typed name
 * against a peer's edit.
 *
 * Proof: `commit` moved back onto an `onChange` here, the table's `holds a date
 * typed one segment at a time, and saves the one that was typed` failed on
 * `expected [ '0002-08-17', '0020-08-17', …(2) ] to deeply equal []` and its
 * `Not before` twin on `expected [ …(4) ] to deeply equal []`; the
 * `document.activeElement` guard in the effect removed, `never writes an answer
 * over a reader who is in the box` failed on `expected '2026-09-01' to be
 * '2026-08-17'`. All watched, 2026-08-09.
 */
export function DateField({ value, commit, onExit, onKeyDown, onFocus, ...rest }: DateFieldProps) {
  const box = useRef<HTMLInputElement | null>(null);
  /**
   * Whether a key has landed in this box since the focus arrived — the one
   * thing that tells a typed segment from a picked day.
   *
   * `false` while it holds, so the next `change` is a pick and is sent at once.
   */
  const typedSinceFocus = useRef(false);
  /**
   * The day this box last agreed with the server about — what a commit is
   * compared against.
   *
   * Written on the way out as well as on the way in, so a second blur with
   * nothing typed in between sends nothing, and a refetch that answers with the
   * day just sent is not a change to react to.
   */
  const agreed = useRef(value);

  useEffect(() => {
    agreed.current = value;
    const node = box.current;
    if (node === null) return;
    // Never over a reader who is in the box: this is the assignment that used
    // to reset the year segment mid-word.
    if (node === document.activeElement) return;
    if (node.value !== value) node.value = value;
  }, [value]);

  const commitIfChanged = (): void => {
    const node = box.current;
    // The ref is this component's own wiring, not a condition to model: a blur
    // can only have come from the node React attached here.
    if (node === null) throw new Error('A date field was left without ever being attached.');
    const typed = node.value;
    if (typed === agreed.current) return;
    // A date input reports `''` for a date it cannot parse as well as for one
    // that was cleared, and `badInput` is what tells the two apart. Leaving a
    // half-typed date behind must not clear a constraint somebody set — that is
    // the same lost edit this whole component is about, one gesture along.
    // Proof: this line removed, `leaves a half-typed date alone instead of
    // clearing the day it had` failed on `expected [ '' ] to deeply equal []`.
    // Watched, 2026-08-09.
    if (typed === '' && node.validity.badInput) return;
    agreed.current = typed;
    commit(typed);
  };

  return (
    <input
      {...rest}
      type="date"
      ref={box}
      // Uncontrolled: see the note above. `defaultValue` seeds the box, the
      // effect keeps it in step, and neither of them writes over typing.
      defaultValue={value}
      onFocus={(event) => {
        typedSinceFocus.current = false;
        onFocus?.(event);
      }}
      onChange={() => {
        // Typing lands here too — once per completed segment, which is the
        // whole fault above — and typing is exactly what this returns for.
        if (typedSinceFocus.current) return;
        // No key since the focus arrived: the browser put this day in the box
        // itself, which is a pick, and a pick is a finished gesture. Sending it
        // now is the difference between a chart that follows the reader and one
        // that waits for them to click somewhere else first.
        commitIfChanged();
      }}
      onKeyDown={(event) => {
        // Before every branch below, including the ones that commit: from here
        // on this edit is typing, and typing is sent on the way out.
        typedSinceFocus.current = true;
        // Before the caller's handler, because the caller's is what moves the
        // caret on: `Ctrl/⌘ + Enter` from a row's date cell lands in the next
        // row, and the date has to have been sent by then.
        if (event.key === 'Enter') {
          // The commit is made first and reported second, deliberately: an
          // `onExit?.(commitAndSay())` never evaluates its argument when there
          // is no `onExit`, so the toolbar's date field would stop saving
          // anything at all. Watched — three cases in `date-field.test.tsx`
          // failed on `expected [] to deeply equal [ '2026-08-17' ]`.
          // 2026-08-09.
          commitIfChanged();
          onExit?.('commit');
        }
        if (event.key === 'Escape') {
          const node = box.current;
          // The ref is this component's own wiring: a keystroke can only have
          // come from the node React attached here.
          if (node === null)
            throw new Error('A date field took a key without ever being attached.');
          // **Back to the day the server agreed, and that is what makes the
          // blur after an Escape harmless**: `commitIfChanged` sends nothing
          // when the box already holds `agreed`, so there is no abandoned value
          // left for a blur to commit. A flag suppressing that blur instead was
          // written first and deleted: with the editor unmounted on the way out
          // there is no blur to suppress at all, and on the field that *does*
          // stay on screen — the toolbar's project start date — the flag was
          // unreachable behind this line. A check that could not fail.
          //
          // Proof: this line removed, `e2e/keyboard.spec.ts`'s `Escape puts the
          // project start date back, and leaving it does not send the abandoned
          // day` failed on `expected "2026-09-09" to be "2026-06-01"`.
          // Watched in Chromium, 2026-08-09.
          //
          // **Still `agreed` after the pick exception, and deliberately so.**
          // An undo restoring the day held at focus was written here and
          // deleted: after a pick the focus is already gone (the toolbar
          // disables its controls for the write's window), so no Escape ever
          // reaches this branch to run it. See the class note above for the two
          // browser cases that measured it.
          node.value = agreed.current;
          onExit?.('cancel');
        }
        onKeyDown?.(event);
      }}
      onBlur={() => {
        commitIfChanged();
        onExit?.('commit');
      }}
    />
  );
}
