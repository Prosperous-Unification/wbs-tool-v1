import type { ExpandedState } from '@tanstack/react-table';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type Caret, type CellRef, commandMove, type Direction, nextCell } from './cell-navigation';
import {
  type CellElement,
  cellIn,
  editableGrid,
  focusAdjacentCell,
  focusCellAt,
  gridOf,
  isCellElement,
} from './editable-grid';
import { altMoveIn, type Command, commandChordIn, undoChord } from './keyboard-bindings';
import { opensCheatSheet } from './keyboard-cheat-sheet';
import { type CommitOutcome, flushCell, FocusIntent } from './live-editing';
import type { EstimateGaps } from './plan-completeness';
import { type Toast, toastKey } from './toasts';
import { expandBranch, FROZEN_REFUSAL } from './use-plan-structure';
import { type TreeRow } from './wbs-rows';
import { rowWords } from './work-item-words';

/** Coordinates the table’s plan keyboard state and actions. */
export function usePlanKeyboardEffects({
  setCheatSheetOpen,
  stepStack,
  armedDelete,
  pushToast,
  setArmedDelete,
  dismissToast,
  dReleased,
}: {
  setCheatSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  stepStack: (direction: 'undo' | 'redo') => Promise<void>;
  armedDelete: { rowId: string; number: string } | null;
  pushToast: (toast: Toast) => void;
  setArmedDelete: React.Dispatch<React.SetStateAction<{ rowId: string; number: string } | null>>;
  dismissToast: (key: string) => void;
  dReleased: React.MutableRefObject<boolean>;
}) {
  /**
   * `?` anywhere on the page opens the cheat sheet.
   *
   * On the window rather than on the table, because the point is that it works
   * from wherever the reader is — and because the keys it documents are spread
   * over the cells, the toolbar and two pickers, none of which is a single
   * element to hang this on. {@link opensCheatSheet} is what keeps it out of
   * the text boxes: it judges the event's target, so a `?` on its way into a
   * name or the Find box is left alone.
   *
   * Never `preventDefault`: the keystrokes this takes are the ones no field
   * wanted.
   */
  useEffect(() => {
    const openOnQuestionMark = (event: KeyboardEvent) => {
      if (!opensCheatSheet(event, event.target)) return;
      setCheatSheetOpen(true);
    };
    window.addEventListener('keydown', openOnQuestionMark);
    return () => {
      window.removeEventListener('keydown', openOnQuestionMark);
    };
  }, [setCheatSheetOpen]);

  /**
   * Cmd/Ctrl+Z anywhere on the page, and Shift with it to go the other way.
   *
   * On the window for the same reason `?` is: the change being reversed could
   * have been made from any cell, any picker or the toolbar, and there is no
   * one element to hang it on. {@link undoChord} is what keeps it out of the
   * text boxes, where the browser's own undo is better than anything this
   * could offer for a word somebody is halfway through typing.
   *
   * `preventDefault` here and nowhere else in this file's listeners: this is
   * the one chord a browser would otherwise act on itself, undoing text in
   * whatever field it last remembers rather than the change that was asked for.
   */
  useEffect(() => {
    const walk = (event: KeyboardEvent) => {
      const direction = undoChord(event, event.target);
      if (direction === null) return;
      event.preventDefault();
      void stepStack(direction);
    };
    window.addEventListener('keydown', walk);
    return () => {
      window.removeEventListener('keydown', walk);
    };
  }, [stepStack]);

  /**
   * Everything that takes a pending Ctrl+D off, other than another keystroke.
   *
   * The arm is a promise about one row, made in a toast, and it is kept only
   * while the reader is still looking at the row it was made about. Leaving the
   * cell — by Tab, by a chord, or by clicking somewhere else entirely — ends
   * it; so does the window losing the focus, the tab being hidden, and the
   * three seconds running out. Nothing here is a nicety: a row that stays armed
   * across a coffee break is a Ctrl+D that deletes something the person has
   * stopped thinking about.
   *
   * `focusout` rather than a blur handler on the cell: the focus can leave by
   * the pointer, and the cell that was armed may not be the one that had it.
   *
   * **The toast belongs to this effect**, which is the whole of the second
   * change here. It used to be pushed from `armOrDeleteRow` and never taken
   * off, so "Ctrl+D again deletes 020" outlived every one of the ways above —
   * and the delete itself — for the five seconds an info toast lasts. Pushing
   * it where the arm begins and dismissing it in the cleanup ties the sentence
   * to the state that makes it true, re-arms included: a fresh arm is a fresh
   * object, so the cleanup takes the old sentence off before the new one goes
   * up.
   *
   * Proof, two faults. This effect's listeners removed: `leaving the cell
   * disarms it, however the focus went` failed with the row still tinted —
   * watched 2026-08-08. The `dismissToast` below dropped: `the arm toast
   * leaves with the arm, however the arm ends`, `the arm toast leaves when the
   * delete it promised happens` and `a peer renumbering the armed row disarms
   * it` all failed on `expected [ … ] to not include 'Ctrl+D again deletes 020
   * — its children move up'` — watched 2026-08-09.
   */
  useEffect(() => {
    if (armedDelete === null) return undefined;
    const promise: Toast = {
      // `info`: it is context with a way out of it, not a failure waiting to be
      // dismissed — and it takes itself off if the reader walks away.
      kind: 'info',
      text: `Ctrl+D again deletes ${armedDelete.number} — its children move up`,
    };
    pushToast(promise);
    const disarm = () => {
      setArmedDelete(null);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') disarm();
    };
    // A fresh timer per arm, because `armedDelete` is a fresh object per arm:
    // re-arming the same row starts the three seconds again.
    const expiry = setTimeout(disarm, ARM_WINDOW_MS);
    window.addEventListener('focusout', disarm);
    window.addEventListener('blur', disarm);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      dismissToast(toastKey(promise));
      clearTimeout(expiry);
      window.removeEventListener('focusout', disarm);
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [armedDelete, pushToast, dismissToast, setArmedDelete]);

  /**
   * A `keyup` of D, which is what the confirming press waits for.
   *
   * On the window rather than on the cell: the chord is pressed in a cell, and
   * the key can be let go after the focus has moved or with the pointer
   * somewhere else entirely. Missing the release would leave a row that can
   * never be confirmed, which is the failure mode that reads as "the shortcut
   * is broken".
   */
  useEffect(() => {
    const released = (event: KeyboardEvent) => {
      if (event.key === 'd' || event.key === 'D') dReleased.current = true;
    };
    window.addEventListener('keyup', released);
    return () => {
      window.removeEventListener('keyup', released);
    };
  }, [dReleased]);
  return {};
}

/** Coordinates the table’s plan keyboard state and actions. */
export function usePlanKeyboard({
  outdent,
  indent,
  drafts,
  removeEmptyRow,
  busy,
  pushToast,
  moveAmongSiblings,
  setArmedDelete,
  armedDelete,
  dReleased,
  deleteRow,
  commandInFlight,
  addSibling,
}: {
  outdent: (row: TreeRow, landOn?: string) => Promise<CommitOutcome>;
  indent: (row: TreeRow, landOn?: string) => Promise<CommitOutcome>;
  drafts: Record<string, string>;
  removeEmptyRow: (row: TreeRow) => Promise<CommitOutcome>;
  busy: boolean;
  pushToast: (toast: Toast) => void;
  moveAmongSiblings: (row: TreeRow, direction: 'up' | 'down', landOn: string) => void;
  setArmedDelete: React.Dispatch<React.SetStateAction<{ rowId: string; number: string } | null>>;
  armedDelete: { rowId: string; number: string } | null;
  dReleased: React.MutableRefObject<boolean>;
  deleteRow: (row: TreeRow) => Promise<CommitOutcome>;
  commandInFlight: React.MutableRefObject<boolean>;
  addSibling: (after: TreeRow) => Promise<CommitOutcome>;
}) {
  /**
   * The Name cell's own keys: Tab and Backspace, and nothing else.
   *
   * Enter is deliberately absent. It made a work item until `command-keys`,
   * and it is now the browser's own newline — which is what lets a note be
   * typed under the name in the box that holds both. A new work item is Ctrl+N
   * (Alt+N on the keyboards Chrome keeps Ctrl+N for) or Cmd/Ctrl+Enter at the
   * end of the plan; see {@link onCommandKey}.
   *
   * Proof: the `preventDefault + addSibling` branch put back, `Enter in a name
   * is a newline, and makes nothing` failed on `expected true to be false` —
   * the key taken, and no note typeable under any name. Watched, 2026-08-08.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, row: TreeRow) => {
      if (event.key === 'Tab') {
        const input = event.currentTarget;
        // Either element: the Name cell is a textarea so a long name wraps,
        // and both carry the selection fields `caretOf` reads.
        if (!isCellElement(input)) return;
        const caret = caretOf(input);
        // One rule for the structure keys: they fire at position zero, where
        // the key has no text meaning. Anywhere else — or over a selection —
        // Tab is what it is in any table: the next field, text selected the
        // way the browser's own Tab leaves it. At the grid's edge the key is
        // left to the browser rather than eaten.
        if (caret.atStart && !caret.hasSelection) {
          event.preventDefault();
          void (event.shiftKey ? outdent(row) : indent(row));
          return;
        }
        const moved = focusAdjacentCell(
          input,
          { rowId: row.id, columnId: 'name' },
          event.shiftKey ? -1 : 1,
        );
        if (moved) event.preventDefault();
        return;
      }
      if (event.key === 'Backspace') {
        // At position zero this key deletes nothing, so it is free — and
        // "backspace at the start of the line" is the outliner reflex for
        // "this does not belong under here". A selection keeps the key: the
        // user is deleting text, even when the selection touches the start.
        // Skipped rather than thrown on a non-input target, same as the grid.
        const input = event.currentTarget;
        if (!isCellElement(input)) return;
        const caret = caretOf(input);
        if (!caret.atStart || caret.hasSelection) return;
        if (row.parentId !== null) {
          event.preventDefault();
          void outdent(row);
          return;
        }
        // At root level outdenting has nowhere left to go, so this is Dany's
        // "backspace again": a wholly empty item is removed, the way the last
        // empty bullet of a list is. The Name is judged by the input rather
        // than the committed value — deleting every character and pressing
        // Backspace once more is one gesture, and blur has not happened yet.
        // Anything the item still holds vetoes the removal: content is only
        // ever deleted by the actions menu, never by a keystroke reflex.
        //
        // `input.value` is now both fields in one read: this box holds the
        // notes under the name, so a row with a note is not empty and cannot
        // be emptied by deleting the name off the top of it. `row.notes` is
        // the committed half of the same question, and it is not redundant:
        // emptying the box is not the same as having emptied the work item,
        // because the blur that would send the emptying has not happened and
        // everyone else still has the note.
        //
        // Proof, both conjuncts, watched 2026-08-08. `row.notes` dropped: `a
        // note that has not been deleted yet still vetoes the removal` failed
        // on `expected [['w1']] to deeply equal []` — a row deleted out from
        // under a note nobody had committed a deletion of. `input.value`
        // dropped: `anything the item holds vetoes the backspace removal`
        // failed on `expected [['w3']] to deeply equal []`, the row whose note
        // was typed and committed in this same box.
        const empty =
          input.value === '' &&
          row.notes === '' &&
          row.subRows.length === 0 &&
          row.dependsOn.length === 0 &&
          Object.keys(row.estimates).length === 0 &&
          // A half-typed estimate is not stored yet — it is a draft waiting for
          // the rest of its trio — and deleting the row would take it with it
          // without ever having shown it as saved. Typing counts as content.
          !Object.keys(drafts).some((key) => key.startsWith(`${row.id}::`));
        if (!empty) return;
        event.preventDefault();
        void removeEmptyRow(row);
      }
    },
    [drafts, indent, outdent, removeEmptyRow],
  );

  /**
   * Tab: the next field, or the previous one, from any cell in the grid.
   *
   * Every editable cell but the Name has this and nothing else for the key. The
   * Name's own handler holds the outliner special case — at the very start of
   * the text Tab indents the row and Shift+Tab outdents it — and everywhere
   * else in the text it makes this same move.
   *
   * The grid is the table, not one row: at the end of a row Tab walks into the
   * first field of the next. Only at the grid's own edge — past the last
   * editable cell of the last row — does `focusAdjacentCell` return false and
   * the key go to the browser, which lands on that row's ⋯ button. That is the
   * point rather than a leak: the actions are reachable at the end of the table
   * and never from the middle of a row, and no focus trap is added to stop a
   * reader Tabbing out of the table altogether. One stop per row since the
   * actions became a menu; it was two while they were buttons.
   *
   * Proof: dropped from the handler chain, `walks every field of a row in turn,
   * and on into the next row` failed at the first cell that no longer moved.
   * Watched, 2026-08-07.
   */
  const onTabKey = useCallback((event: React.KeyboardEvent, rowId: string, columnId: string) => {
    if (event.key !== 'Tab') return;
    const input = event.currentTarget;
    // Skipped rather than thrown on a target that is not a cell, the same way
    // the rest of the grid treats markup it did not write.
    if (!isCellElement(input)) return;
    const moved = focusAdjacentCell(input, { rowId, columnId }, event.shiftKey ? -1 : 1);
    if (moved) event.preventDefault();
  }, []);

  /**
   * Moves the focus between cells, or lets the browser have the key.
   *
   * The grid is read from the table's own DOM at the moment the key arrives, not
   * from a ref written during render. A ref written in render publishes rows
   * that React may not have committed — or may abandon — and a key pressed in
   * that window would look up a row the DOM does not have. Both reviewers found
   * that; the committed DOM is the only thing that cannot be ahead of itself.
   *
   * `:not([readonly])` is what keeps focus off a parent's rolled-up figures.
   * They are real numbers worth reading, and they are also numbers no keystroke
   * can change, which is the same reason the derived number column is not here.
   */
  const onArrowKey = useCallback(
    (event: React.KeyboardEvent<CellElement>, rowId: string, columnId: string) => {
      const container = gridOf(event.currentTarget);
      if (container === null) return;
      const grid = editableGrid(container);

      const move = nextCell(
        grid.map((g) => g.cell),
        { rowId, columnId },
        event.key,
        caretOf(event.currentTarget),
        {
          isComposing: event.nativeEvent.isComposing,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        },
      );
      if (move === null) return;

      const next = grid.find(
        (g) => g.cell.rowId === move.to.rowId && g.cell.columnId === move.to.columnId,
      )?.input;
      if (next === undefined) return;
      // Only now, and only because the move is happening: an unconditional
      // `preventDefault` would take the caret keys away from every input.
      event.preventDefault();
      focusCellAt(next, move.caretAt === 'start' ? 0 : next.value.length);
    },
    [],
  );

  /**
   * Alt and an arrow: restructure the row this cell belongs to.
   *
   * The four keys carry structure from **any** cell and **any** caret position,
   * which is what Tab and Backspace cannot do — those type, so they restructure
   * only at position zero of the Name cell where the keystroke has no text
   * meaning. Alt+arrow types nothing here: `nextCell` already leaves every
   * modified arrow to the browser, so the grid gives nothing up by taking these.
   *
   * `preventDefault` for every arrow this owns, including the edges and the
   * refusals. On macOS an un-prevented Alt+arrow jumps a word or a paragraph
   * and inserts a character into the field as well; a key handled halfway is
   * worse than either outcome. The trade — word-jump is no longer Alt's in
   * these cells — is stated in the change's proposal, and plain arrows and
   * Cmd+arrow still walk the caret.
   *
   * Not attached globally: it lives on the cells that route their own keys,
   * which is every cell of the grid. It reached only some of them until
   * `table-mechanics` — the dependency picker, the two `CreatablePicker`
   * columns and the earliest-start cell each swallowed it, so "from any cell"
   * was false in three cell classes at once. What lets a picker hand it back
   * without handing back the chords that make and destroy a row is
   * {@link escapesAnOpenList}.
   */
  const onAltMove = useCallback(
    (event: React.KeyboardEvent, row: TreeRow, columnId: string) => {
      // Which arrows this owns, and under which modifiers, is {@link altMoveIn}
      // — shared with the open `@` list, which has to recognize exactly the
      // same keystrokes in order to swallow them.
      const move = altMoveIn(event);
      if (move === null) return;
      // Proof: removed, nine of this block's tests failed on a key the browser
      // would still have acted on. Watched, 2026-08-06.
      event.preventDefault();
      // A held arrow repeats, and each repeat is a request and a refetch.
      // Dropped rather than queued while one is in flight: the tree the next
      // press would be judged against has not come back yet.
      // Proof: removed, `drops a second alt+down while the first is in flight`
      // failed with two moves asked for. Watched, 2026-08-06.
      if (busy) return;
      // be-01 refuses this too, and is the authority. Refusing here is what
      // lets the reason be read — the drag's own sentence, so one rule does not
      // acquire two wordings.
      // Proof: removed, `refuses to move a frozen row and says why` failed on
      // the move it sent. Watched, 2026-08-06.
      if (row.frozenNumber !== null) {
        pushToast({ kind: 'error', text: FROZEN_REFUSAL });
        return;
      }
      if (move === 'up' || move === 'down') {
        moveAmongSiblings(row, move, columnId);
        return;
      }
      void (move === 'indent' ? indent(row, columnId) : outdent(row, columnId));
    },
    [busy, indent, moveAmongSiblings, outdent, pushToast],
  );

  /** Takes the tint and the pending delete off, whatever the reason. */
  const disarmDelete = useCallback(() => {
    setArmedDelete(null);
  }, [setArmedDelete]);

  /**
   * Moves the focus to a cell by the chord's own grid walk, and says whether
   * there was one to move to.
   *
   * The DOM's grid, read at the moment the key arrives, for the reason
   * {@link onArrowKey} gives: a ref written during render can be ahead of what
   * React has committed.
   */
  const moveByCommand = useCallback(
    (input: CellElement, from: CellRef, direction: Direction): boolean => {
      const container = gridOf(input);
      if (container === null) return false;
      const grid = editableGrid(container);
      const move = commandMove(
        grid.map((g) => g.cell),
        from,
        direction,
      );
      if (move === null) return false;
      const next = grid.find(
        (g) => g.cell.rowId === move.to.rowId && g.cell.columnId === move.to.columnId,
      )?.input;
      if (next === undefined) return false;
      focusCellAt(next, move.caretAt === 'start' ? 0 : next.value.length);
      return true;
    },
    [],
  );

  /**
   * The Name cell of the row after this one, or undefined on the last row.
   *
   * Read out of the committed grid rather than out of `flat`, so "the next row"
   * means the next row **on screen**: a collapsed branch's children are not
   * cells, and Cmd+Enter must not land in one of them.
   */
  const nextRowName = useCallback((input: CellElement, rowId: string): CellElement | undefined => {
    const container = gridOf(input);
    if (container === null) return undefined;
    const grid = editableGrid(container);
    const rowIds = [...new Set(grid.map((g) => g.cell.rowId))];
    const at = rowIds.indexOf(rowId);
    // `< 0` before the lookup, for `focusAdjacentCell`'s reason: `.at(-1)`
    // would read the last row of the table as the one after this one.
    if (at === -1) return undefined;
    const next = rowIds.at(at + 1);
    return next === undefined
      ? undefined
      : grid.find((g) => g.cell.rowId === next && g.cell.columnId === 'name')?.input;
  }, []);

  /**
   * Ctrl+D: arm this row, or delete the one already armed.
   *
   * **Nothing here destroys anything on one gesture, and that is the price of
   * putting a delete on a chord at all.** The first press tints the row and
   * says what the second one will do; the second press has to satisfy all of
   * it — the same row, a `keyup` of D since the arm, and a press rather than a
   * key repeat.
   *
   * Proof, four faults, all watched 2026-08-08. The `repeat` conjunct removed:
   * `a repeat after the confirming press does not arm the row that took its
   * place` failed on `expected '020' to be null` — the key still down as the
   * row went, arming whatever slid up into it. The `dReleased` conjunct
   * removed: `two presses with no release between them only re-arm` failed on
   * `expected null to be '020'` — one gesture destroying a row, so there was
   * no arm left to find. The same-row conjunct removed: `arming 020 and
   * pressing Ctrl+D on 030 arms 030 and deletes neither` failed on `expected
   * null to be '030'`, the second press deleting a row the arm never pointed
   * at. The frozen refusal removed: `a frozen row refuses to arm and says how
   * to unfreeze it` failed on `expected [ Array(1) ] to include '020 is frozen
   * — unfreeze it first'`.
   *
   * @param row The row the chord was pressed in.
   * @param repeat Whether the browser says this is a held key repeating.
   */
  const armOrDeleteRow = useCallback(
    (row: TreeRow, repeat: boolean) => {
      // A key repeat is neither an arm nor a confirm. Before the frozen
      // refusal too, so a held chord on a frozen row is one sentence.
      if (repeat) return;
      if (row.frozenNumber !== null) {
        pushToast({
          kind: 'error',
          text: `${rowWords(row.number, row.name)} is frozen — unfreeze it first`,
        });
        disarmDelete();
        return;
      }
      if (armedDelete !== null && armedDelete.rowId === row.id && dReleased.current) {
        disarmDelete();
        void deleteRow(row).then((outcome) => {
          if (outcome !== 'landed') return;
          // The way back, in the sentence that says it happened: this is the
          // one chord in the table that takes work away.
          pushToast({
            kind: 'info',
            text: `Deleted ${rowWords(row.number, row.name)} — Cmd+Z restores`,
          });
        });
        return;
      }
      dReleased.current = false;
      // The state only. The sentence that goes with it is pushed — and taken
      // off again — by the effect that owns the arm, so it cannot outlive the
      // arm it describes.
      setArmedDelete({ rowId: row.id, number: row.number });
    },
    [armedDelete, dReleased, deleteRow, disarmDelete, pushToast, setArmedDelete],
  );

  /**
   * The command chords, from whichever cell they were pressed in.
   *
   * One handler for every cell class rather than one listener on the window,
   * which is what keeps `isTypingInto` and the undo/redo page-level guard out
   * of this entirely: these chords are only ever meant *inside* the grid, and a
   * global listener would have to reconstruct which cell it was standing in.
   * Each cell class calls this from its own `onKeyDown`, and the cells whose
   * picker list is open do not call it at all — the open list owns the
   * keyboard, and Escape is how it is given back.
   *
   * `preventDefault` for every chord this claims, including the ones that turn
   * out to have nowhere to go. Ctrl+H at the left edge of the table is still
   * Ctrl+H, and Chrome's answer to it is the history.
   *
   * The three chords that write flush the cell first and **await** it: the same
   * commit a blur runs, through {@link flushCell}, so what was typed is be-01's
   * before a row is created or the focus moves — and so a refusal leaves the
   * caret where it was with nothing created. Rule 5 in `cell-input.tsx` is what
   * keeps the blur that follows from sending it again.
   *
   * Proof, three faults, all watched 2026-08-08. The `await` dropped, the
   * outcome hard-coded to `landed` and the flush fired and forgotten: `waits
   * for the save to land before it creates anything` failed on `expected
   * [ 'patch', 'create' ] to deeply equal [ 'patch' ]` — a row created against
   * an answer nobody had. The `refused` return removed: `a refused save leaves
   * the caret where it was and makes no row` failed on `expected [ '010',
   * '020', '030', '040' ] to deeply equal [ '010', '020', '030' ]`. The
   * `preventDefault` removed: `a chord at the grid’s edge is consumed rather
   * than leaking to the browser` failed on `expected false to be true`.
   */
  const onCommandKey = useCallback(
    (event: React.KeyboardEvent, row: TreeRow, columnId: string) => {
      const command: Command | null = commandChordIn(event);
      if (command === null) {
        // Every other keystroke is what disarms a pending Ctrl+D — except the
        // modifiers, which are how the second Ctrl+D is reached at all. agy #9.
        if (!MODIFIER_KEYS.has(event.key)) disarmDelete();
        return;
      }
      event.preventDefault();
      if (command === 'delete') {
        armOrDeleteRow(row, event.nativeEvent.repeat);
        return;
      }
      // Any command that is not the confirm is a keystroke like any other.
      disarmDelete();
      const input = event.currentTarget;
      if (!isCellElement(input)) return;
      if (command !== 'new-item' && command !== 'next-or-create') {
        moveByCommand(input, { rowId: row.id, columnId }, command);
        return;
      }
      // Read now, not in the continuation: `currentTarget` is nulled the
      // moment this handler returns, and the tree the next row is found in is
      // the one that was on screen when the chord was pressed.
      const landsOn = nextRowName(input, row.id);
      if (commandInFlight.current) return;
      commandInFlight.current = true;
      void (async () => {
        try {
          const outcome = await flushCell(input);
          // A refused save is the only copy of what was typed. The caret stays
          // in it, and nothing is created above or below it.
          if (outcome === 'refused') return;
          // The next row, where there is one — and a new sibling where there
          // is not, which is what makes this the chord that walks a plan being
          // written. Ctrl+N is the one that creates mid-table.
          if (command === 'next-or-create' && landsOn !== undefined) {
            // Selected on arrival, the way every other keyboard move into a
            // cell in this table leaves it.
            focusCellAt(landsOn, 'all');
            return;
          }
          await addSibling(row);
        } finally {
          commandInFlight.current = false;
        }
      })();
    },
    [addSibling, armOrDeleteRow, commandInFlight, disarmDelete, moveByCommand, nextRowName],
  );
  return { onKeyDown, onTabKey, onArrowKey, onAltMove, onCommandKey };
}

/**
 * The keys that are held rather than pressed, which a pending Ctrl+D survives.
 *
 * agy #9: reaching the second Ctrl+D means holding Control down, and on many
 * keyboards letting it go and taking it again. Every one of those is a
 * `keydown` of its own, and disarming on them would make the chord unusable by
 * anybody who does not press both keys in one motion.
 *
 * Proof: the exemption removed so every keydown disarms, `any other keystroke
 * disarms it, and a modifier on its own does not` failed on `expected null to
 * be '020'`. Watched, 2026-08-08.
 */
export const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']);

/**
 * How long an armed Ctrl+D waits for its second press.
 *
 * Long enough to read the toast that says what it will do, short enough that a
 * row cannot still be armed when the reader has moved on and forgotten. The
 * timer is the *only* thing that expires an arm — there is no second elapsed
 * check at the confirm, because a check the timer has already made unreachable
 * is a check that cannot fail.
 */
export const ARM_WINDOW_MS = 3000;

/** The armed row's tint: a warning, and the only thing on screen that says so. */
export const ARMED_TINT = 'var(--grid-armed)';

/**
 * What the caret in an input is doing, for `nextCell` to decide on.
 *
 * `selectionStart`/`selectionEnd` are `null` on inputs that do not support them;
 * treated as "not at either end", which leaves the key to the browser rather
 * than guessing a jump nobody asked for.
 */
export function caretOf(input: CellElement): Caret {
  // The one place the two element types are told apart for the keyboard: a
  // `<textarea>` is the Name cell, which holds the notes under the name, and
  // {@link nextCell} gives Up and Down to the text there.
  //
  // Proof, both directions, watched 2026-08-08. Hard-coded `true`: `still
  // walks a column of one-line boxes from any caret position` failed on
  // `expected true to be false` — an estimate column that could no longer be
  // filled downwards from mid-number. Hard-coded `false`: `keeps ↑ and ↓ in
  // the name until the caret has run out of text` failed on the reverse.
  const multiline = input instanceof HTMLTextAreaElement;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (start === null || end === null) {
    return { atStart: false, atEnd: false, hasSelection: false, multiline };
  }
  return {
    atStart: start === 0,
    atEnd: end === input.value.length,
    hasSelection: start !== end,
    multiline,
  };
}

/** Coordinates plan keyboard for the table's current render. */
export function usePlanReadiness({
  flat,
  gaps,
  gapVisit,
  unfoldedSteps,
  setExpanded,
  setGapVisit,
  gridElement,
}: {
  flat: TreeRow[];
  gaps: EstimateGaps;
  gapVisit: { rowId: string; cell: CellRef } | null;
  unfoldedSteps: readonly string[];
  setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  setGapVisit: React.Dispatch<React.SetStateAction<{ rowId: string; cell: CellRef } | null>>;
  gridElement: React.MutableRefObject<HTMLElement | null>;
}) {
  /**
   * The work items between `rowId` and the root, nearest first.
   *
   * Terminates because `flat` is built by walking the nested tree down from
   * its roots: every row in it is reachable from a root, so its parent chain
   * is finite. A `parentId` cycle leaves both rows out of the tree `toTree`
   * builds, and so out of `flat` and out of this.
   */
  const ancestorsOf = useCallback(
    (rowId: string): string[] => {
      const above: string[] = [];
      let next = flat.find((row) => row.id === rowId)?.parentId ?? null;
      while (next !== null) {
        // Copied to a `const` because the closure below reads it: TypeScript
        // drops the narrowing of a reassigned `let` inside a callback.
        const parentId = next;
        above.push(parentId);
        next = flat.find((row) => row.id === parentId)?.parentId ?? null;
      }
      return above;
    },
    [flat],
  );

  /**
   * Walks to the next leaf the plan has no estimate for, and asks for the
   * focus in the cell that estimates it.
   *
   * The readiness badge's only behaviour. It reads nothing and writes nothing:
   * a plan is judged complete or not by {@link findEstimateGaps}, and this
   * carries the eye there. The cell aimed at is the **first step that leaf is
   * missing** — a row costed for Dev and not QA is stood in front of its QA
   * cell, because pointing at the number that is already there would be the
   * tool asking for work that is done.
   *
   * The walk wraps, and a leaf inside a closed branch opens its ancestors on
   * the way: focusing a cell that is not on screen is a keystroke landing
   * somewhere nobody can see.
   */
  const walkToNextGap = useCallback(() => {
    if (gaps.leaves.length === 0) return;
    const at =
      gapVisit === null ? -1 : gaps.leaves.findIndex((leaf) => leaf.rowId === gapVisit.rowId);
    // `-1` is both "nothing visited yet" and "the row visited has since been
    // estimated, or deleted". Both start at the top, which is the only place
    // that is still true about the list as it now stands.
    // Proof: `-1` folded up to `0` instead, `starts again from the top when
    // the leaf it was on has been estimated` failed one row further down the
    // list than anybody asked for. Watched, 2026-08-06.
    //
    // The modulo wraps. Proof: replaced with a clamp to the last entry, `moves
    // on to the next leaf on the next click, and wraps at the end` failed on
    // the third click, which sat where it was. Watched, 2026-08-06.
    //
    // Both indexes below are in range without a guard: the list is not empty,
    // and `findEstimateGaps` never reports a leaf that is missing no step at
    // all. Guards for them were written and `no-unnecessary-condition` refused
    // them — dead branches, which is exactly the check that cannot fail.
    const next = gaps.leaves[(at + 1) % gaps.leaves.length];
    const stepId = next.missingStepIds[0];
    // Which cell edits this step depends on the fold: the combined cell while
    // the step is folded, and the optimistic box while it is not, because
    // `combined-trio-entry` deliberately never shows both editors at once.
    // Proof: hard-coded to the folded cell, `lands in the first box while the
    // step is unfolded, where the trio is typed` failed with the focus left on
    // the body — the column it named is not an editable cell while the step is
    // open. Watched, 2026-08-06.
    const columnId = unfoldedSteps.includes(stepId) ? `${stepId}-optimistic` : `${stepId}-final`;
    // Proof: removed, `opens a collapsed branch rather than focusing a cell
    // nobody can see` failed with the child row still hidden. Watched,
    // 2026-08-06.
    setExpanded((current) => ancestorsOf(next.rowId).reduce(expandBranch, current));
    setGapVisit({ rowId: next.rowId, cell: { rowId: next.rowId, columnId } });
  }, [ancestorsOf, gapVisit, gaps.leaves, setExpanded, setGapVisit, unfoldedSteps]);

  /**
   * Lands the focus on the cell the readiness walk asked for.
   *
   * An effect rather than a `focus()` in the click, because the click may have
   * opened a branch as well: the row it names is not in this component's DOM
   * until the render carrying that expansion is committed. Both state updates
   * are made in one handler, so they batch into one render and this runs after
   * it — reading the committed DOM, which is the only thing that cannot be
   * ahead of itself.
   *
   * A cell that is not there is left alone: a peer's refetch can remove the
   * row between the click and this, which is a modeled condition, and the next
   * click starts the walk from the top anyway.
   */
  useEffect(() => {
    const grid = gridElement.current;
    if (gapVisit === null || grid === null) return;
    const arrived = cellIn(grid, gapVisit.cell);
    if (arrived === undefined) return;
    // Proof: removed, five of this block's tests failed with the focus left
    // wherever the last created row had put it. Watched, 2026-08-06.
    //
    // Selected, the way every arrival at an estimate cell is: the value at
    // rest is a computed figure, and a caret dropped inside `4` turns the next
    // `2/3/8` into `2/3/84`.
    focusCellAt(arrived, 'all');
  }, [gapVisit, gridElement]);
  return { walkToNextGap };
}
/** Coordinates plan keyboard for the table's current render. */
export function useRowNavigation({
  gridElement,
}: {
  gridElement: React.MutableRefObject<HTMLElement | null>;
}) {
  /**
   * Takes the plan to one row: its name cell gets the caret and is scrolled to.
   *
   * The Gantt panel's way back into the editor, and it works on both faces
   * because it names a **cell** rather than a piece of markup — `cellIn` reads
   * the committed `[data-grid]`, which is the `<table>` at laptop width and the
   * card list below the breakpoint (`M mobile-cards`' contract). A column the
   * cards do not render would work on one face and quietly do nothing on the
   * other, which is why the negative for this is pointed at exactly that.
   *
   * Both absences are modeled rather than thrown on: a chart can outlive the
   * row it was drawn from by one refetch, and there is nothing to take anybody
   * to then.
   */
  const goToRow = useCallback(
    (rowId: string) => {
      const grid = gridElement.current;
      if (grid === null) return;
      const cell = cellIn(grid, { rowId, columnId: 'name' });
      if (cell === undefined) return;
      cell.focus();
      // jsdom has no `scrollIntoView`; that boundary is the test environment, not
      // a browser this will meet. The same guard the pickers use.
      if (typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest' });
    },
    [gridElement],
  );
  return { goToRow };
}
/** Coordinates plan keyboard for the table's current render. */
export function usePlanKeyboardState() {
  /** Whether the key bindings are on screen. See {@link KeyboardCheatSheet}. */
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);

  /**
   * The row one Ctrl+D has pointed at, waiting for the second one that deletes
   * it — or null, which is almost always.
   *
   * The **number** is held beside the id because the toast promised it: "Ctrl+D
   * again deletes 020". A refresh that renumbered the row, or moved it, or took
   * it away has made that sentence untrue, and an arm whose sentence is untrue
   * is disarmed rather than re-aimed. A fresh object per arm, because it is
   * what the three-second timer fires on: re-arming the same row restarts it.
   *
   * State rather than a ref: the armed row is tinted, so this is rendered.
   * Read through {@link live} for the reason `openMenuRowId` is.
   */
  const [armedDelete, setArmedDelete] = useState<{ rowId: string; number: string } | null>(null);

  /**
   * Whether D has been let go since the arm, which the confirm waits for.
   *
   * A ref, because nothing renders it, and it is the guard that makes a *held*
   * Ctrl+D harmless: a key that is still down has produced no `keyup`, so the
   * second press it appears to make can never be one. `event.repeat` is the
   * other half — see {@link onCommandKey}.
   */
  const dReleased = useRef(false);

  /**
   * Whether a command chord's request is still out.
   *
   * A ref rather than `busy`, and the difference is the whole of what it buys:
   * `busy` is state, so two chords in one tick both read the value from before
   * either of them ran. Two Cmd+Enters on the last row are one gesture arriving
   * twice; without this they are two work items.
   */
  const commandInFlight = useRef(false);

  /**
   * Where a structural edit has asked the focus to go once its refetch lands.
   *
   * A ref holding one object for the life of the component, so the two things
   * that read it — the effect below and the Name cell's `onAttach` — are
   * talking about the same intent whichever render they were built in.
   */
  const focusIntent = useRef(new FocusIntent());

  /**
   * Where the readiness walk has got to: the leaf it last put the focus in,
   * and the cell it asked for.
   *
   * The row rather than an index into the list of gaps, because that list is
   * rebuilt by every edit — estimating the row you were standing on takes it
   * out, and an index would then point at whichever row slid into its place. A
   * row that has left the list starts the walk again from the top.
   *
   * A fresh object on every click on purpose: it is what the effect below
   * fires on, so a plan with one gap left focuses that same cell again rather
   * than the button doing nothing.
   */
  const [gapVisit, setGapVisit] = useState<{ rowId: string; cell: CellRef } | null>(null);

  /**
   * The rendered grid, so the focus can be found in the DOM that is committed.
   *
   * An `HTMLElement` rather than an `HTMLTableElement` since `M mobile-cards`:
   * it holds the `<table>` at laptop width and {@link PlanCards}' list below the
   * breakpoint. {@link editableGrid} and the rest of `editable-grid.ts` only ever
   * ask it for `[data-cell]` descendants, so neither of them knows the
   * difference.
   */
  const gridElement = useRef<HTMLElement | null>(null);
  return {
    cheatSheetOpen,
    setCheatSheetOpen,
    armedDelete,
    setArmedDelete,
    dReleased,
    commandInFlight,
    focusIntent,
    gapVisit,
    setGapVisit,
    gridElement,
  };
}
