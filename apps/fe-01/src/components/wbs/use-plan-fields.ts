import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PriorityBandView, ProjectApi } from '@/lib/wbs-api';

import { cellIn, focusCellAt } from './editable-grid';
import { type CommitOutcome } from './live-editing';
import { priorityTyped } from './priority-cell';
import type { Toast } from './toasts';

/** Coordinates plan fields for the table's current render. */
export function usePlanFields({
  run,
  api,
  priorityBands,
  pushToast,
  gridElement,
}: {
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
  priorityBands: PriorityBandView[];
  pushToast: (toast: Toast) => void;
  gridElement: React.MutableRefObject<HTMLElement | null>;
}) {
  /**
   * Sets or clears one work item's "not before" day.
   *
   * A floor rather than a pin, which be-01 enforces: everything that depends
   * on this row still moves with it, and a predecessor finishing later still
   * wins. Dany's call — it keeps the calendar and the dependency tree from
   * being able to contradict each other.
   *
   * **Clearing the day clears the words with it, in the same request.** Since
   * #81 the pair is a rule be-01 checks inside the transaction that would write
   * it: a reason with no date to be about is `not_before_reason_needs_a_date`,
   * **400**. So a bare `{ startNoEarlierThan: null }` is a refusal on every row
   * somebody has explained — the date would stop clearing, in the reader's
   * face, on exactly the rows that have the most typed into them. Refused
   * rather than cascaded is be-01's call and the right one; the client that
   * cleared the date is the one place that knows the words are meant to go too.
   *
   * Setting a day names only the day, **unless the caller names the words too**.
   * The table's two boxes are edited one at a time and each sends its own
   * field, so the date box omits `reason` and the words on a row that already
   * has some stay true of the new date — a set that silently blanked them would
   * be the deletion above wearing the other hat. A card's sheet edits both at
   * once and passes both, which is why `reason` is *optional* rather than
   * absent: `undefined` means "not this caller's business", `null` means "take
   * the words off".
   *
   * **One patch and never two, which is the whole reason the parameter is here
   * rather than a second `run` at the call site.** `run` is fire-and-forget —
   * callers say `void run(…)` — so a date request and a reason request issued
   * back to back are not ordered, and the pair rule above turns the losing
   * order into a **400** on the row somebody just explained. be-01 checks the
   * pair inside one transaction; this sends it as one.
   *
   * Proof: the second field dropped from the null arm, `clearing a not-before
   * date clears the words with it` fails on `expected [ { startNoEarlierThan:
   * null } ] to deeply equal [ { startNoEarlierThan: null,
   * startNoEarlierThanReason: null } ]`. Watched, 2026-08-18.
   */
  const setNotBefore = useCallback(
    (id: string, day: string | null, reason?: string | null) => {
      void run(() =>
        api.patchWorkItem(
          id,
          day === null
            ? { startNoEarlierThan: null, startNoEarlierThanReason: null }
            : reason === undefined
              ? { startNoEarlierThan: day }
              : // The blank box is `null` and never `''`, {@link setNotBeforeReason}'s
                // own call: one spelling of "nobody has said", and the one thing
                // be-01 cannot see from a field that is simply absent.
                {
                  startNoEarlierThan: day,
                  startNoEarlierThanReason:
                    reason === null || reason.trim() === '' ? null : reason.trim(),
                },
        ),
      );
    },
    [api, run],
  );

  /**
   * Sets or clears the words about one work item's "not before" day.
   *
   * A sentence, not a state. It moves no date and reaches no other row — the
   * date is the whole of the constraint and this is the whole of the
   * explanation (`openspec/changes/not-before-reason/proposal.md`).
   *
   * A blank box is `null`, not `''`, so there is one spelling of "nobody has
   * said" — the same call `setPriority` makes about an emptied number, and the
   * one thing be-01 cannot see from a request that omits the field entirely.
   *
   * **What is deliberately not decided here: whether the row may have words at
   * all.** Typing a reason onto a row with no date is refused by be-01 with the
   * pair rule above, and it is left refused there rather than guarded in this
   * client. A client-side rule the server does not share is how the two come to
   * disagree, which is the doctrine {@link setPriority} already writes down.
   */
  const setNotBeforeReason = useCallback(
    (id: string, typed: string) => {
      const said = typed.trim();
      void run(() =>
        api.patchWorkItem(id, { startNoEarlierThanReason: said === '' ? null : said }),
      );
    },
    [api, run],
  );

  /**
   * Sets or clears one work item's priority, from what was typed into its cell.
   *
   * An ordering, which be-01 honours in its leveller's queue — never a
   * date and never a constraint: a work item with a priority still waits for its
   * dependencies, its floor and its calendar. The bars move because the engine
   * moved them.
   *
   * The parse is deliberately narrow and the refusal is be-01's. Everything
   * that is not an empty box is sent as a number and answered on: a `0`, a
   * `-1` or a `1.5` comes back a 400 and the draft stays in the box the way
   * every other refused edit does, rather than being silently swallowed by a
   * client-side rule the server does not share. What is decided here is only
   * the one thing be-01 cannot see — an emptied box is `null`, not `0`, and
   * `Number('')` is `0`.
   */
  const setPriority = useCallback(
    (id: string, typed: string): Promise<CommitOutcome> => {
      // A band's own name resolves to the number it writes, **before** anything
      // is parsed as a number. That is the manual-or-label half of Dany's ask
      // arriving through one commit path rather than two: a picked line and a
      // typed name and a typed number all become one `patch`, one journal entry
      // and one undo. `priorityTyped` owns the rule and the order in it.
      const trimmed = priorityTyped(priorityBands, typed).trim();
      if (trimmed === '') return run(() => api.patchWorkItem(id, { priority: null }));
      // `Number` rather than `parseInt`: `parseInt('1.5')` is 1 and
      // `parseInt('2x')` is 2, so both would go out as priorities nobody typed.
      // `Number` answers `NaN` for either.
      const asNumber = Number(trimmed);
      // The one refusal this client makes on its own, and only because it
      // cannot be asked: JSON has no literal for `NaN` **or for `Infinity`**, so
      // a request carrying either arrives as `null` — which is what clears a
      // priority. `Number.isFinite` rather than `Number.isNaN` for exactly that
      // reason: `Number('1e999')` is `Infinity`, is not `NaN`, and would go out
      // as somebody's priority silently wiped. The same trap, on stored column
      // widths, is why {@link rememberedWidthOverrides} range-checks.
      //
      // Everything that *is* a finite number goes out and is answered on, `0`
      // and `-1` and `1.5` included: the rule about what a priority may be is
      // be-01's, and a second copy of it here is a rule that can quietly
      // disagree.
      //
      // Proof: written back as `Number.isNaN`, `says so, and sends nothing,
      // when what was typed is a number too big to be one` failed on `expected
      // [ { priority: null } ] to deeply equal []` — the clear request, sent
      // from a typed `1e999`. Watched, 2026-08-11.
      if (!Number.isFinite(asNumber)) {
        pushToast({ kind: 'error', text: 'A priority is a whole number from 1 upward.' });
        return Promise.resolve<CommitOutcome>('refused');
      }
      return run(() => api.patchWorkItem(id, { priority: asNumber }));
    },
    [api, priorityBands, pushToast, run],
  );

  /**
   * Sets or resets how many people may work on one item at once, from what was
   * typed into its In-parallel cell.
   *
   * The same shape as {@link setPriority} one column along, and deliberately
   * the same: an emptied box is the one thing be-01 cannot see — `Number('')`
   * is `0`, which is a refusal rather than a reset — and everything else is
   * sent and answered on, `0`, `-1`, `1.5` and `1001` included. The rule about
   * what a parallelism may be lives in `capacity-write-paths` at be-01's
   * boundary; a second copy here is a rule that can quietly disagree with it.
   *
   * `null` is a **reset to 1** and not a clear: 1 and unset are the same fact —
   * one at a time — and the column is `NOT NULL DEFAULT 1`, which is why an
   * emptied cell renders blank rather than showing the 1 it stores.
   */
  const setParallelism = useCallback(
    (id: string, typed: string): Promise<CommitOutcome> => {
      const trimmed = typed.trim();
      if (trimmed === '') return run(() => api.patchWorkItem(id, { maxParallel: null }));
      const asNumber = Number(trimmed);
      // {@link setPriority}'s refusal, for its reason: JSON has no literal for
      // `NaN` or `Infinity`, so either would arrive as `null` — which here is
      // the reset, so a typed `1e999` would silently put the item back to one
      // at a time instead of being refused.
      if (!Number.isFinite(asNumber)) {
        pushToast({ kind: 'error', text: 'People at once is a whole number from 1 to 1000.' });
        return Promise.resolve<CommitOutcome>('refused');
      }
      return run(() => api.patchWorkItem(id, { maxParallel: asNumber }));
    },
    [api, pushToast, run],
  );

  /**
   * The row whose earliest-start cell is being edited, or none.
   *
   * One id rather than a set, which is the whole of "at most one editor on the
   * page": every other row's cell is the short date as text, and a native date
   * input is 138px of furniture the 84px column has no room for. It is also
   * what took `not-before` from 146px to 84 — the column had to hold an editor
   * on every row until 2026-08-09.
   */
  const [editingNotBefore, setEditingNotBefore] = useState<string | null>(null);

  /**
   * The row whose earliest-start cell is owed the focus back, once the editor
   * closing on it has actually gone from the DOM.
   *
   * A ref and an effect rather than a call, because the cell to focus does not
   * exist yet at the moment the editor asks to close: it is rendered by the
   * same pass that unmounts the editor.
   */
  const notBeforeOwedFocus = useRef<string | null>(null);

  /** Opens the editor on one row's earliest-start cell, closing any other. */
  const openNotBefore = useCallback((rowId: string) => {
    setEditingNotBefore(rowId);
  }, []);

  /**
   * Closes the editor and gives the cell it was on the focus back.
   *
   * The way out — {@link DateField}'s `onExit` — is not branched on here, and
   * that is deliberate: the day has been sent or it has not, by then, and the
   * editor closes either way. What the two answers are for is the editor's own
   * suppression of the blur an Escape causes, which is `date-field.tsx`'s.
   */
  const closeNotBefore = useCallback((rowId: string) => {
    notBeforeOwedFocus.current = rowId;
    setEditingNotBefore((editing) => (editing === rowId ? null : editing));
  }, []);

  /**
   * Puts the focus where opening or closing an editor has just moved it.
   *
   * Both directions in one effect, because both need the same thing and cannot
   * have it any sooner: the element to focus is rendered by the very pass that
   * mounted or unmounted the editor. An `autoFocus` would cover the opening
   * half and nothing at all of the closing half, which is the half the
   * contract is about.
   */
  useEffect(() => {
    const grid = gridElement.current;
    if (grid === null) return;
    if (editingNotBefore !== null) {
      const editor = cellIn(grid, { rowId: editingNotBefore, columnId: 'not-before' });
      // Gone before the focus reached it — a peer deleted the row, or a search
      // narrowed it away. A modeled absence: there is nothing to focus.
      if (editor !== undefined) focusCellAt(editor, 'all');
      return;
    }
    const rowId = notBeforeOwedFocus.current;
    if (rowId === null) return;
    notBeforeOwedFocus.current = null;
    // Only where nothing else has claimed it. `Ctrl/⌘ + Enter` from this cell
    // commits, closes **and** moves to the next row — putting the focus back on
    // the cell it left would undo the chord.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const cell = cellIn(grid, { rowId, columnId: 'not-before' });
    if (cell === undefined) return;
    focusCellAt(cell, 'all');
  }, [editingNotBefore, gridElement]);
  return {
    setNotBefore,
    setNotBeforeReason,
    setPriority,
    setParallelism,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
  };
}
