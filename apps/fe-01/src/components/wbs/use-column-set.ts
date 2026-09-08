import { useCallback, useMemo, useState } from 'react';

import { type StepView } from '@/lib/wbs-api';

import { COLUMN_LABELS } from './plan-toolbar';
import { rememberedHiddenColumns, rememberHiddenColumns } from './remembered-layout';
import { hideableColumnIds } from './table-frame';

/**
 * Which columns this reader has hidden, and which the table offers to hide.
 *
 * The hide-list is remembered per project and per browser, so a column the
 * table learns to draw later is on screen by default without anybody's storage
 * being touched. Steps join and leave the offered set as the project's do.
 */
export function useColumnSet({ projectId, steps }: { projectId: string; steps: StepView[] }) {
  /**
   * Steps whose columns are unfolded — the three points, next to the final
   * figure and its assignee, which are always on screen.
   *
   * **A set, and any number of them.** It was an accordion until
   * `unfolding-may-scroll` — unfolding a step folded whichever was open —
   * because a folded step costs 96px and an unfolded one 348, and one open
   * step already needs more width than a 1280 laptop has. That arithmetic is
   * unchanged and it is not what the rule was worth: a reader comparing two
   * steps' three points had to hold one of them in their head, and a table
   * that reshuffles itself when you open something reads as a bug whatever it
   * is protecting.
   *
   * **Horizontal scrolling is the accepted cost, and only here.** Dany's call,
   * 2026-08-08 (U3): with anything unfolded the frame MAY scroll sideways, and
   * the pinned handle, number and name are what make that readable. Folded,
   * the no-scroll guarantee is exactly what it was — that is the state a plan
   * is read in, and `e2e/layout.spec.ts` still holds it at every laptop width
   * in the matrix.
   *
   * A list rather than a `Set` because it is what the column builder asks
   * (`unfoldedSteps.includes(step.id)`) and what the `columns` memo may depend
   * on. Local state, not shared: my unfolding must not reshuffle anyone else's
   * table.
   */
  const [unfoldedSteps, setUnfoldedSteps] = useState<readonly string[]>([]);

  /**
   * The hide-list as this browser remembers it for this project, whole — see
   * {@link rememberedHiddenColumns} for why it is not judged on read.
   */
  const [storedHiddenColumns, setStoredHiddenColumns] = useState<readonly string[]>(() =>
    rememberedHiddenColumns(projectId),
  );

  /**
   * The columns this reader has hidden **and this table could show**: the
   * stored list less any id that is neither a hideable column nor one of this
   * project's steps. A typo in storage, or a step since deleted, hides nothing
   * and is never handed to `foldedTableMinWidth`, which throws on it by design.
   *
   * A memo on the two things it reads, so its identity moves only when one of
   * them does — it is a `columns` dependency, and every change of identity
   * there remounts every cell.
   */
  const hiddenColumnIds = useMemo(() => {
    const hideable = hideableColumnIds(steps.map((step) => step.id));
    return storedHiddenColumns.filter((id) => hideable.includes(id));
  }, [steps, storedHiddenColumns]);

  /**
   * What the Columns control offers: every hideable column with the word the
   * reader knows it by. A hideable id with no word is a column added to
   * `table-frame.ts` and not here — thrown, not skipped, or the column would be
   * one nobody can hide back.
   */
  const offeredColumns = useMemo(
    () =>
      hideableColumnIds(steps.map((step) => step.id)).map((id) => {
        const label = COLUMN_LABELS.get(id) ?? steps.find((step) => step.id === id)?.name;
        if (label === undefined) throw new Error(`no label for hideable column "${id}"`);
        return { id, label };
      }),
    [steps],
  );

  /**
   * Hides a shown column, or shows a hidden one — and writes the list, which is
   * the one moment it is written (see {@link rememberedHiddenColumns}). Written
   * from the sanitised list rather than the stored one, as a drag writes the
   * widths in force: an id for a step this project no longer holds is dropped
   * the first time the reader touches the control.
   */
  function toggleColumn(columnId: string): void {
    const next = hiddenColumnIds.includes(columnId)
      ? hiddenColumnIds.filter((hidden) => hidden !== columnId)
      : [...hiddenColumnIds, columnId];
    setStoredHiddenColumns(next);
    rememberHiddenColumns(projectId, next);
  }

  /**
   * Unfolds a step, or folds it again — and leaves every other step alone.
   *
   * The one writer, which is why the rule it keeps is stated on the state
   * above rather than here. It was `current.includes(stepId) ? [] : [stepId]`
   * until `unfolding-may-scroll`: the second arm is what made this an
   * accordion, and the first folded the open one whichever step was clicked.
   *
   * Proof: written as `current.includes(stepId) ? [] : [stepId]` again,
   * `unfolds each step on its own, and leaves the others open` failed on
   * `Unable to find a label with the text of: Dev optimistic for 010`, with
   * `walks both open steps in turn, and the grid arrows cross between them`
   * beside it and — in Chromium — `opens every step at once, scrolls the frame
   * for it, and holds the pinned block` on the same missing box. Watched on
   * h2puni, 2026-08-12 (fault 1).
   */
  const toggleStep = useCallback((stepId: string) => {
    setUnfoldedSteps((current) =>
      current.includes(stepId) ? current.filter((each) => each !== stepId) : [...current, stepId],
    );
  }, []);
  return {
    unfoldedSteps,
    setStoredHiddenColumns,
    hiddenColumnIds,
    offeredColumns,
    toggleColumn,
    toggleStep,
  };
}
