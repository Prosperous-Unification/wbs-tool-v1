import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PriorityBandView, ProjectApi } from '@/lib/wbs-api';

import { cellIn, focusCellAt } from './editable-grid';
import { type CommitOutcome } from './live-editing';
import { priorityTyped } from './priority-cell';
import type { Toast } from './toasts';

/**
 * Which row of one date column is being edited, and the focus that owes it.
 *
 * One id keeps at most one editor open in each column. The effect moves focus
 * only after React has mounted or unmounted the corresponding cell.
 */
function useDateCellEditor(
  columnId: string,
  gridElement: React.RefObject<HTMLElement | null>,
): { editing: string | null; open: (rowId: string) => void; close: (rowId: string) => void } {
  const [editing, setEditing] = useState<string | null>(null);
  const owedFocus = useRef<string | null>(null);

  const open = useCallback((rowId: string) => {
    setEditing(rowId);
  }, []);

  const close = useCallback((rowId: string) => {
    owedFocus.current = rowId;
    setEditing((openRowId) => (openRowId === rowId ? null : openRowId));
  }, []);

  useEffect(() => {
    const grid = gridElement.current;
    if (grid === null) return;
    if (editing !== null) {
      const editor = cellIn(grid, { rowId: editing, columnId });
      if (editor !== undefined) focusCellAt(editor, 'all');
      return;
    }
    const rowId = owedFocus.current;
    if (rowId === null) return;
    owedFocus.current = null;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const cell = cellIn(grid, { rowId, columnId });
    if (cell !== undefined) focusCellAt(cell, 'all');
  }, [editing, columnId, gridElement]);

  return { editing, open, close };
}

/**
 * The per-row value writes that are not structure and not estimates: the name
 * and notes, the priority, the parallelism, the earliest start and its reason,
 * the deadline.
 *
 * One hook because they share the live-editing rule — a field holds what was
 * typed until the answer lands, and a peer's edit must not take the caret.
 */
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
  gridElement: React.RefObject<HTMLElement | null>;
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
   * Sets or clears one work item's deadline — the last day it may finish on.
   *
   * **The single field, and deliberately not the floor's pair one function
   * up.** `setNotBefore` clears in two fields because be-01 refuses a reason
   * with no date to be about; a deadline has no reason column beside it, which
   * was slice 1.1's choice, so `{ deadline: null }` is the whole of the clear
   * and a request naming `startNoEarlierThanReason` here would be sending a key
   * about a different constraint. Copying the pair across is the mistake this
   * comment exists to stop.
   *
   * Nothing is guarded here. A day before the project's first working day is
   * refused by be-01 with `deadline_before_project_start`, and it is left
   * refused there: this client holds no project start to compare against on
   * this path, and a client-side rule the server also keeps is how the two come
   * to disagree — the doctrine {@link setPriority} writes down.
   *
   * Proof: adding `{ startNoEarlierThanReason: null }` beside `deadline` here
   * made `plan-cells.test.tsx`'s `clears with the single field, never the floor
   * cell pair` fail 1 of 1: received the expected `{ deadline: null }` plus
   * `+ "startNoEarlierThanReason": null`. Watched 2026-09-07 after this writer
   * moved out of `wbs-table.tsx`.
   */
  const setDeadline = useCallback(
    (id: string, day: string | null) => {
      void run(() => api.patchWorkItem(id, { deadline: day }));
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
  const {
    editing: editingNotBefore,
    open: openNotBefore,
    close: closeNotBefore,
  } = useDateCellEditor('not-before', gridElement);
  const {
    editing: editingDeadline,
    open: openDeadline,
    close: closeDeadline,
  } = useDateCellEditor('deadline', gridElement);
  return {
    setNotBefore,
    setNotBeforeReason,
    setDeadline,
    setPriority,
    setParallelism,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
    editingDeadline,
    openDeadline,
    closeDeadline,
  };
}
