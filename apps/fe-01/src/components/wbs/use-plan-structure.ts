import { type ExpandedState } from '@tanstack/react-table';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type ProjectApi } from '@/lib/wbs-api';

import { type DropRefusal, type DropZone, planMove } from './drag-drop';
import type { CellAttacher } from './editable-grid';
import type { FocusIntent } from './live-editing';
import { type CommitOutcome, unsent } from './live-editing';
import { normalizeNewlines, splitNameCell } from './name-notes';
import { type Toast } from './toasts';
import { type TreeRow } from './wbs-rows';

/**
 * What a drag leaves behind when it ends somewhere the table cannot see.
 *
 * A pointer released outside the window, or a peer's edit arriving mid-drag,
 * both end a gesture nobody let go of; the row would otherwise stay marked as
 * being dragged with nothing holding it.
 */
export function usePlanStructureEffects({
  setDragging,
  pushToast,
  setDropHint,
  workItems,
  focusIntent,
  gridElement,
  attachCell,
}: {
  setDragging: React.Dispatch<React.SetStateAction<string | null>>;
  pushToast: (toast: Toast) => void;
  setDropHint: React.Dispatch<React.SetStateAction<{ rowId: string; zone: DropZone } | null>>;
  workItems: TreeRow[];
  focusIntent: React.RefObject<FocusIntent>;
  gridElement: React.RefObject<HTMLElement | null>;
  attachCell: React.RefObject<CellAttacher>;
}) {
  /**
   * A drag does not survive the tree changing underneath it.
   *
   * Two things go wrong otherwise, and both reviewers found one each. The
   * browser does not reliably fire `dragend` on a source node that was replaced
   * mid-gesture, so `dragging` could stay set forever — after which merely
   * moving the pointer over the table drew drop markers, and a click moved a row
   * nobody had picked up. And `planMove` reads the *current* tree, so a peer who
   * reparents the target between pickup and release turns "below 010" into a
   * different move than the one on screen when the gesture started.
   *
   * Cancelling is the conservative answer to both: a drag lasts a second or two,
   * a concurrent edit inside it is rare, and being told to try again beats
   * either a stuck table or a row landing somewhere nobody aimed.
   */
  useEffect(() => {
    setDragging((current) => {
      // `info`, not `error`: nothing was refused and nothing was lost, so this
      // is context that may take itself off again rather than a failure
      // waiting to be dismissed.
      //
      // Pushed from inside the updater because `dragging` cannot join this
      // effect's dependencies — it would then re-run on every pickup and
      // cancel the drag it was meant to survive. StrictMode invokes an updater
      // twice, so this pushes twice under it; the stack collapses a repeated
      // message into one line, which is what makes that harmless.
      if (current !== null) {
        pushToast({
          kind: 'info',
          text: 'The table changed while you were dragging — try again.',
        });
      }
      return null;
    });
    setDropHint(null);
  }, [workItems, pushToast, setDragging, setDropHint]);

  // The whole of what this does, and every reason it is shaped this way, is
  // {@link FocusIntent.land}. It fires on the tree because that is the render
  // that can have brought the row the intent names into the DOM.
  useEffect(() => {
    focusIntent.current.land(gridElement.current, attachCell.current);
  }, [attachCell, focusIntent, gridElement, workItems]);
  return {};
}

/**
 * Adding a row, and the queue that keeps a held key from racing itself.
 *
 * Its own hook because it is the one structural write with a **queue**: the
 * button repeats under a held Enter, and two creates in flight for one parent
 * would both compute the same position from the same read.
 */
export function useAddWorkItem({
  flat,
  projectId,
  activeProject,
  run,
  api,
  focusIntent,
}: {
  flat: TreeRow[];
  projectId: string;
  activeProject: React.RefObject<string>;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
  focusIntent: React.RefObject<FocusIntent>;
}) {
  const siblingsOf = useCallback(
    (parentId: string | null) => flat.filter((row) => row.parentId === parentId),
    [flat],
  );

  /**
   * `Add work item` clicks waiting their turn, and the drain that spends them.
   *
   * The reason this exists rather than `disabled={busy}`: **a planner clicks
   * faster than the round trip and every click is a different row.** Measured
   * on dev — 6 clicks at 350ms produced 3 rows, 4 at 1500ms produced 4 — and
   * the losses were silent, because a click on a disabled button is not
   * refused, it simply never happens. The rest of the toolbar is right to
   * refuse: `Freeze all` twice is the same command asked twice, and holding it
   * back costs nothing. This one is the exception the convention needs.
   *
   * Refs rather than state, for the reason {@link run}'s neighbours are: two
   * clicks in one tick would both read the count from before either.
   *
   * **`afterId` is chained, never re-read.** The first click in a burst reads
   * the tree, which is current because nothing is in flight yet; every click
   * after it goes after the row the click before it made. That is both more
   * correct and cheaper than re-reading `siblingsOf` per iteration — the
   * refetch's state has not necessarily rendered by the time the next turn of
   * this loop runs, so a re-read could hand be-01 the same `afterId` twice and
   * stack the burst in reverse.
   */
  const addQueue = useRef({ projectId, queued: 0, draining: false });

  if (addQueue.current.projectId !== projectId) {
    // Orphan the old project's queue. Its in-flight request may finish, but
    // pending clicks do not become writes after the reader has left it, and a
    // click here receives a fresh drain immediately.
    addQueue.current = { projectId, queued: 0, draining: false };
  }

  const addWorkItem = useCallback(() => {
    const queue = addQueue.current;
    queue.queued += 1;
    if (queue.draining) return;
    queue.draining = true;
    void (async () => {
      try {
        let afterId = siblingsOf(null).at(-1)?.id ?? null;
        while (queue.queued > 0 && activeProject.current === queue.projectId) {
          queue.queued -= 1;
          const outcome = await run(async () => {
            const created = await api.createWorkItem(projectId, {
              parentId: null,
              afterId,
              name: '',
            });
            afterId = created.id;
            focusIntent.current.wants({ rowId: created.id, columnId: 'name' });
          });
          // A refused create ends the burst. The rows after it would be built
          // on an `afterId` that was never written, and be-01 has already said
          // why it said no — six more of the same toast is not more information.
          if (outcome === 'refused') queue.queued = 0;
        }
      } finally {
        queue.draining = false;
      }
    })();
  }, [activeProject, api, focusIntent, projectId, run, siblingsOf]);
  return { siblingsOf, addWorkItem };
}

/**
 * Every write that changes the plan's **shape** rather than a cell's value:
 * add, indent, outdent, move, duplicate, delete, drop, and the name commit that
 * can create a row.
 *
 * One hook because they share a rule the value writes do not — each of them
 * decides where the caret lands afterwards, and each has a refusal a reader can
 * act on (a frozen row, a drop into its own subtree).
 */
export function usePlanStructure({
  dragging,
  setDragging,
  setDropHint,
  flat,
  pushToast,
  setExpanded,
  run,
  api,
  projectId,
  focusIntent,
  siblingsOf,
}: {
  dragging: string | null;
  setDragging: React.Dispatch<React.SetStateAction<string | null>>;
  setDropHint: React.Dispatch<React.SetStateAction<{ rowId: string; zone: DropZone } | null>>;
  flat: TreeRow[];
  pushToast: (toast: Toast) => void;
  setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
  projectId: string;
  focusIntent: React.RefObject<FocusIntent>;
  siblingsOf: (parentId: string | null) => TreeRow[];
}) {
  /**
   * Resolves a drop and sends the move, or refuses it out loud.
   *
   * The decision itself is `planMove`, which is pure and tested on its own; this
   * only turns the answer into a request or a sentence. Dropping into a
   * collapsed branch opens it, so the row is never moved somewhere invisible.
   */
  const dropOn = useCallback(
    (targetId: string, zone: DropZone, targetShowsChildren: boolean) => {
      const draggedId = dragging;
      setDragging(null);
      setDropHint(null);
      if (draggedId === null) return;

      // Whether the target's children are on screen changes what "below it"
      // means. The row that was dropped on knows; the planner is told rather
      // than left to guess, and stays pure.
      const plan = planMove(flat, draggedId, targetId, zone, targetShowsChildren);
      if (!plan.ok) {
        // `unchanged` says nothing: it is not a mistake, and a message for it
        // would fire every time someone put a row back.
        const message = REFUSAL_MESSAGES[plan.reason];
        if (message !== undefined) pushToast({ kind: 'error', text: message });
        return;
      }

      if (zone === 'into') setExpanded((current) => expandBranch(current, targetId));
      void run(() => api.moveWorkItem(draggedId, plan.parentId, plan.afterId));
    },
    [api, dragging, flat, pushToast, run, setDragging, setDropHint, setExpanded],
  );

  const addSibling = useCallback(
    (after: TreeRow) =>
      run(async () => {
        const created = await api.createWorkItem(projectId, {
          parentId: after.parentId,
          afterId: after.id,
          name: '',
        });
        focusIntent.current.wants({ rowId: created.id, columnId: 'name' });
      }),
    [api, focusIntent, projectId, run],
  );

  /**
   * Indent: the row becomes the last child of the sibling above it.
   *
   * `landOn` is the column the focus should come back to. It defaults to the
   * Name cell, which is where Tab is pressed from and where typing continues;
   * an Alt+arrow passes the column it was pressed in instead.
   */
  const indent = useCallback(
    (row: TreeRow, landOn = 'name') =>
      run(async () => {
        const siblings = siblingsOf(row.parentId);
        const index = siblings.findIndex((w) => w.id === row.id);
        // A ternary rather than `siblings.at(index - 1)`: at index 0 there is no
        // row above to indent under, and `.at(-1)` would return the last sibling
        // — quietly moving the row somewhere nobody asked for.
        const newParent = index > 0 ? siblings[index - 1] : undefined;
        if (newParent === undefined) return;
        const lastChild = newParent.subRows.at(-1) ?? null;
        await api.moveWorkItem(row.id, newParent.id, lastChild?.id ?? null);
        // After the move, not before: a refused request then leaves the focus
        // where the person left it rather than sending it after a row that
        // never went anywhere.
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
      }),
    [api, focusIntent, run, siblingsOf],
  );

  /** Outdent: the row becomes the next sibling of its own parent. */
  const outdent = useCallback(
    (row: TreeRow, landOn = 'name') =>
      run(async () => {
        if (row.parentId === null) return;
        const parent = flat.find((w) => w.id === row.parentId);
        if (parent === undefined) return;
        await api.moveWorkItem(row.id, parent.parentId, parent.id);
        // After the move, for the reason `indent` gives.
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
      }),
    [api, flat, focusIntent, run],
  );

  /**
   * Alt+Up / Alt+Down: the row swaps places with the sibling above or below it.
   *
   * Siblings only, and no wrap: at either end of a group the key does nothing.
   * Reparenting is Alt+Left/Right's job and the drag's, and a key that silently
   * moved a row into a different parent because it ran out of siblings would be
   * the outliner equivalent of falling off the end of the page.
   *
   * The request carries **ids read from the tree this render was drawn from** —
   * the parent it stays under and the sibling it lands after — never a computed
   * position. A tree that has since changed then produces a stale-but-valid move
   * for be-01 to judge (it refuses an `afterId` that is not a sibling of the
   * group) rather than an invented place nobody aimed at.
   */
  const moveAmongSiblings = useCallback(
    (row: TreeRow, direction: 'up' | 'down', landOn: string) => {
      const siblings = siblingsOf(row.parentId);
      const at = siblings.findIndex((sibling) => sibling.id === row.id);
      // Not in the tree on screen: a peer deleted the row between the render and
      // the keystroke. A modeled condition, like an arrow key on a cell that has
      // gone — not a move to guess at.
      if (at === -1) return;
      const swapWith = direction === 'down' ? at + 1 : at - 1;
      // The ends. Decided here rather than inside `run` so a held key at the top
      // of a group is not a request and a refetch per repeat.
      // Proof: replaced with a wrap to the other end of the group, `at the first
      // sibling it moves nothing` and `at the last sibling it moves nothing`
      // both failed on a move that was sent. Watched, 2026-08-06.
      if (swapWith < 0 || swapWith >= siblings.length) return;
      // Down: after the sibling it is passing. Up: after that sibling's own
      // predecessor, which is `null` — first in the group — when there is none.
      const afterId =
        direction === 'down'
          ? (siblings[swapWith]?.id ?? null)
          : (siblings[swapWith - 1]?.id ?? null);
      void run(async () => {
        await api.moveWorkItem(row.id, row.parentId, afterId);
        // Asked for only once be-01 has taken the move: a refused request leaves
        // the focus where the person left it rather than chasing a row that did
        // not go anywhere.
        // Proof: `landOn` hard-coded to `name` here and in `indent`/`outdent`,
        // and both `lands in the same column…` tests failed — the Name cell took
        // the focus. Watched, 2026-08-06.
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
      });
    },
    [api, focusIntent, run, siblingsOf],
  );

  /**
   * Copies a work item and everything under it, landing the caret on the copy.
   *
   * One request: be-01 writes the whole branch at once and sends the tree
   * afterwards, so there is nothing to reconstruct here and nothing to undo if
   * it is refused. The focus is asked for only after the copy has been taken,
   * for the reason every other focus intent here is asked for — a refusal must
   * leave the caret where the person left it rather than chase a row that does
   * not exist.
   */
  const duplicateRow = useCallback(
    (id: string) =>
      run(async () => {
        const copy = await api.duplicateWorkItem(id);
        focusIntent.current.wants({ rowId: copy.id, columnId: 'name' });
      }),
    [api, focusIntent, run],
  );

  /**
   * Deletes a work item and lands the focus where its place went.
   *
   * The children come up rather than going with it (`strategy: 'promote'`),
   * which is what the Delete button did and what the actions menu keeps.
   *
   * Where the caret lands: the Name of the next sibling in this row's own
   * group, else the row above it in the flattened tree, else nowhere — a plan
   * with one row leaves the focus on the ⋯ button the menu gave it back to.
   * The target is read from the tree **on screen before the request**, because
   * afterwards the row it was computed from is gone; for a parent, promoting
   * lifts the children into the gap, so the next sibling is below them rather
   * than immediately below it. That is the sibling group's own answer to "what
   * took its place", and it is written down because the other reading — the
   * first promoted child — is defensible too.
   *
   * Assigned only once be-01 has taken the delete, for the reason
   * {@link duplicateRow} gives: a refusal must leave the focus where the person
   * left it rather than move it into a row nobody deleted.
   *
   * Proof, three faults, all watched on 2026-08-08. The focus intent
   * removed: `lands the caret in the next sibling’s name after a delete` and
   * `lands the caret in the row above when the last row is deleted` both failed
   * on `expected <body>…</body> to be <textarea …>` — the deleted row takes its
   * own ⋯ button with it, so nothing is left holding the focus. `?? above`
   * dropped: the second of those failed alone. The assignment moved in front of
   * the `await`: `says why a delete was refused, moves the focus nowhere and
   * deletes nothing` failed on `expected <textarea …> to be <button …>`.
   */
  const deleteRow = useCallback(
    (row: TreeRow) =>
      run(async () => {
        const siblings = siblingsOf(row.parentId);
        const at = siblings.findIndex((sibling) => sibling.id === row.id);
        const nextSibling = at === -1 ? undefined : siblings[at + 1];
        const flatAt = flat.findIndex((each) => each.id === row.id);
        // A ternary rather than `flat.at(flatAt - 1)`: deleting the first row
        // has no row above, and `.at(-1)` would send the focus to the last one.
        const above = flatAt > 0 ? flat[flatAt - 1] : undefined;
        const landsOn = nextSibling ?? above;
        await api.removeWorkItem(row.id, {
          strategy: row.subRows.length > 0 ? 'promote' : undefined,
        });
        focusIntent.current.wants(
          landsOn === undefined ? null : { rowId: landsOn.id, columnId: 'name' },
        );
      }),
    [api, flat, focusIntent, run, siblingsOf],
  );

  /**
   * Commits the Name cell: a work item's name and its notes, typed as one text.
   *
   * **The diff is three-way, against the baseline rather than against the row
   * on screen**, and that is the whole reason this function exists. Every edit
   * refetches the tree, so a peer's change to the notes can arrive while this
   * cell is being typed in — `CellInput` holds it back (rule 2) and hands the
   * held value over as `baseline` on the way out. Comparing the typed fields
   * against `row.notes` instead would read that peer's note as one this user
   * had just deleted and send `notes: ''` over the top of it. Both reviewers
   * found that from opposite ends before a line of it was written.
   *
   * **One request for the changed subset**, so an edit that touches both fields
   * is one refusal, one journal entry and one Cmd+Z rather than two of each.
   * Nothing is sent when neither field moved, which is reachable without
   * anybody typing: a `<textarea>` normalises the newlines of whatever is
   * assigned to it, so a note be-01 holds with `\r\n` — from an API client or
   * another front end — differs from the box showing it as text while meaning
   * the same thing. Every focus-and-leave of that row would otherwise rewrite
   * it. That is where {@link normalizeNewlines} earns its place; the keyboard
   * cannot put a `\r` in here.
   *
   * Proof, five faults, all watched on 2026-08-08. `was` re-pointed at the
   * current row props off `flat`: `keeps a peer’s note when the name is what
   * was being typed` failed on `expected 'measure twice' to be 'their note'`
   * and `keeps a peer’s name when the notes are what was being typed` on
   * `expected 'Strip' to be 'Rewire the shed'` — each field replaced by the
   * stale one this client still had on screen. The `now.name === was.name`
   * guard dropped so the name is always sent: `sends only the field that
   * changed` failed on a patch carrying a name nobody retyped; the notes guard
   * dropped, the same test failed on the other half. `normalizeNewlines`
   * dropped from both sides: `does not rewrite a note that was stored with
   * Windows line endings` failed on `expected [['w1', …]] to deeply equal []`.
   * The `Object.keys(...).length === 0` return deleted: the same test failed
   * on `[['w1', {}]]`, an empty patch.
   */
  const commitNameCell = useCallback(
    (rowId: string, typed: string, baseline: string): Promise<CommitOutcome> => {
      const now = splitNameCell(normalizeNewlines(typed));
      const was = splitNameCell(normalizeNewlines(baseline));
      const patch = {
        ...(now.name === was.name ? {} : { name: now.name }),
        ...(now.notes === was.notes ? {} : { notes: now.notes }),
      };
      // Not `landed`: nothing was written. The two texts differ as text and
      // mean the same thing, so there is nothing unsaved for the cell to hold
      // and nothing for be-01 to have refused.
      if (Object.keys(patch).length === 0) return unsent();
      return run(() => api.patchWorkItem(rowId, patch));
    },
    [api, run],
  );

  /** Removes a wholly empty row, landing the focus on the row above it. */
  const removeEmptyRow = useCallback(
    (row: TreeRow) =>
      run(async () => {
        const at = flat.findIndex((w) => w.id === row.id);
        // A ternary rather than `flat.at(at - 1)`: removing the first row has
        // no row above, and `.at(-1)` would send the focus to the last one.
        const above = at > 0 ? flat[at - 1] : undefined;
        focusIntent.current.wants(
          above === undefined ? null : { rowId: above.id, columnId: 'name' },
        );
        await api.removeWorkItem(row.id);
      }),
    [api, flat, focusIntent, run],
  );
  return {
    dropOn,
    addSibling,
    indent,
    outdent,
    moveAmongSiblings,
    duplicateRow,
    deleteRow,
    commitNameCell,
    removeEmptyRow,
  };
}

/**
 * The one sentence a frozen row's refusal says, however the move was asked for.
 *
 * Named rather than reached for through {@link REFUSAL_MESSAGES}: that record is
 * `Partial`, so every read of it is a `string | undefined` the keyboard path
 * would have to invent a fallback for — and two spellings of one refusal is how
 * a drag and a keystroke come to disagree about the same rule.
 */
export const FROZEN_REFUSAL = 'That row’s number is frozen. Unfreeze it before moving it.';

/**
 * What a refused drop says out loud.
 *
 * `unchanged` is absent deliberately: dropping a row back where it was is not a
 * mistake anyone needs telling about, and a message for it would fire constantly.
 */
export const REFUSAL_MESSAGES: Partial<Record<DropRefusal, string>> = {
  frozen: FROZEN_REFUSAL,
  cycle: 'A row cannot be moved inside itself.',
  not_found: 'That row is no longer here — the table has been refreshed.',
};

/**
 * Opens `rowId`, whatever shape the expansion state is currently in.
 *
 * TanStack models "everything is open" as the boolean `true`, and a specific set
 * as a record. Dropping into a branch that is closed has to open it — a row that
 * lands somewhere invisible reads as a move that did nothing.
 */
export function expandBranch(current: ExpandedState, rowId: string): ExpandedState {
  if (current === true) return true;
  return { ...current, [rowId]: true };
}

/**
 * The row being dragged, and the zone the drop would land in.
 *
 * Two pieces of state rather than one: the row is set when the gesture starts
 * and the zone changes on every pointer move across a target, so folding them
 * would re-render the dragged row on each of those moves.
 */
export function usePlanDragState() {
  const [dragging, setDragging] = useState<string | null>(null);

  const [dropHint, setDropHint] = useState<{ rowId: string; zone: DropZone } | null>(null);
  return { dragging, setDragging, dropHint, setDropHint };
}
