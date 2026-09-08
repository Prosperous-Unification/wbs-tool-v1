import type * as React from 'react';
import { useCallback, useEffect } from 'react';

import type { ProjectApi, StepView } from '@/lib/wbs-api';

import { pickerEntries } from './dep-picker';
import { parseDependencies, unknownMessage } from './depends-input';
import { type CommitOutcome } from './live-editing';
import { failureText } from './plan-refusal';
import type { Toast } from './toasts';
import type { PlanReadScope } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/**
 * The plan's edges: what a row waits for, what the picker may offer, and what
 * be-01 would refuse.
 *
 * The refusals are computed here rather than discovered on the write, so the
 * picker can grey a choice out instead of accepting it and failing.
 */
export function usePlanDependencies({
  flat,
  pushToast,
  setBusy,
  api,
  refreshOrMarkStale,
  setDepPicker,
  run,
  steps,
}: {
  flat: TreeRow[];
  pushToast: (toast: Toast) => void;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  api: ProjectApi;
  refreshOrMarkStale: (scope?: PlanReadScope) => Promise<void>;
  setDepPicker: React.Dispatch<
    React.SetStateAction<{ rowId: string; typed: string; highlightId: string | null } | null>
  >;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  steps: StepView[];
}) {
  /**
   * The callbacks the cells use, read through a ref rather than closed over.
   *
   * `busy` was already kept out of the dependency list below, for the reason
   * that comment gives. It was not enough: `onKeyDown` reaches `flat` through
   * `indent` and `outdent`, and `flat` is rebuilt by every refresh — so every
   * edit by anyone else remounted every cell in the table and took the focus and
   * the half-typed value of whoever was mid-sentence. Two reviewers found it.
   *
   * Assigned during render on purpose, not in an effect: a cell can fire before
   * effects flush after a re-render, and a handler one render stale would act on
   * the tree that was on screen a moment ago.
   */
  /**
   * The work items an id list names — number and name — in the order given.
   *
   * A dependency is stored by id and read by number, because an id is not
   * something anyone can look at. A row whose predecessor has since been deleted
   * simply drops out of the list rather than rendering a blank chip — the tree
   * refetches on every change, so this cannot be stale for long.
   *
   * The name rides along with the number because a chip reading `010` is a
   * question, and the hover card over those chips is where it is answered. One
   * pass over `flat` for both: two readers looking up the same rows by id is
   * two loops and one more place for the list to come out in a different order.
   */
  const dependenciesOf = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const found = flat.find((row) => row.id === id);
        return found === undefined ? [] : [{ id, number: found.number, name: found.name }];
      }),
    [flat],
  );

  /**
   * Adds the dependencies a typed list of *numbers* names — several at once.
   *
   * Numbers, not ids: numbers are what is on screen, and a typo is then a number
   * nobody has rather than a 404 carrying a uuid that means nothing to whoever
   * is reading it.
   *
   * Several, because a row that waits for three things is ordinary and typing
   * `010, 020, 030` once beats three rounds of type-Enter. Each is still its own
   * request — be-01 judges every edge against the graph including the ones just
   * added, so asking it to take a batch would mean teaching it a second way to
   * do the same thing.
   *
   * Partial success is deliberate. A typo in the middle keeps the numbers around
   * it, and one refused as a cycle keeps the rest; what landed is visible in the
   * chips and what did not is named. All-or-nothing here would throw away four
   * correct entries over a fifth.
   *
   * **One toast for the whole list**, however many entries were refused. Both
   * UX reviewers killed a toast per change for being noise, and three boxes
   * saying three halves of one answer is that failure wearing a different hat:
   * a typed list is one gesture and its outcome is one sentence.
   */
  const dependOn = useCallback(
    (successorId: string, typed: string) => {
      const { found, unknown } = parseDependencies(typed, flat);
      const notThere = unknownMessage(unknown);
      if (found.length === 0) {
        if (notThere !== null) pushToast({ kind: 'error', text: notThere });
        return;
      }

      // Not routed through `run`, deliberately. `run` models all-or-nothing:
      // one request, and a throw abandons the reread. Here a partial success is
      // a real outcome — some edges land, some are refused, and both the new
      // chips and the reasons have to survive. Through `run` a refusal skipped
      // the refresh that would have shown the edges that did land.
      void (async () => {
        setBusy(true);
        const refused: string[] = [];
        try {
          for (const predecessor of found) {
            try {
              await api.addDependency(successorId, predecessor.id);
            } catch (thrown: unknown) {
              // Collected rather than rethrown, so one refusal does not abandon
              // the numbers after it. The reason is be-01's own word — `cycle`,
              // `ancestor` — beside the number it belongs to.
              //
              // The **word** here and a sentence everywhere else, deliberately:
              // this list is already inside one (`These were refused: 010
              // (cycle), 020 (ancestor).`), and five sentences spliced into a
              // sixth is not a sentence. A single entry taken from the picker
              // goes through `run` and does get {@link refusalSentence}.
              refused.push(`${predecessor.number} (${failureText(thrown, 'refused')})`);
            }
          }
          // Never rejects: a failed reread raises the banner and returns, so
          // the refusals below are still reported. The two are different facts
          // and a reader who saw only one of them would be misled either way.
          await refreshOrMarkStale();
        } finally {
          setBusy(false);
        }
        const problems = [
          notThere,
          refused.length === 0
            ? null
            : `${refused.length === 1 ? 'Refused' : 'These were refused'}: ${refused.join(', ')}.`,
        ].filter((line): line is string => line !== null);
        // Proof: split into one push per line, `reports every refused
        // dependency in one toast, not one each` failed with two. Watched,
        // 2026-08-06.
        if (problems.length > 0) pushToast({ kind: 'error', text: problems.join(' ') });
      })();
    },
    [api, flat, pushToast, refreshOrMarkStale, setBusy],
  );

  /**
   * The rows the picker may offer `forRow`, narrowed by what is typed, each
   * marked with the refusal be-01 would answer with.
   *
   * Recomputed from `flat` on every render rather than remembered: a peer's
   * edit lands as a whole new tree, and a list that kept yesterday's marks
   * would grey a row that has since moved out of this one.
   */
  const depEntriesFor = useCallback(
    (forRow: { id: string; dependsOn: readonly string[] }, typed: string) =>
      pickerEntries(flat, forRow, typed),
    [flat],
  );

  /**
   * Adds the picked dependency and keeps the picker open, cleared, for the
   * next one — picking three predecessors is one visit, not three.
   *
   * The `run` outcome is handed back rather than swallowed, so the card's
   * sheet can model the in-flight edge: a second tap on the same option must
   * not send the same write twice (the card locks it until this resolves).
   */
  const pickDependency = useCallback(
    (successorId: string, predecessorId: string): Promise<CommitOutcome> => {
      setDepPicker((current) =>
        current === null ? null : { ...current, typed: '', highlightId: null },
      );
      return run(() => api.addDependency(successorId, predecessorId));
    },
    [api, run, setDepPicker],
  );

  /** Moves the picker highlight by `delta` over `entryIds`, clamped. */
  const moveDepHighlight = useCallback(
    (rowId: string, delta: 1 | -1, entryIds: readonly string[]) => {
      if (entryIds.length === 0) return;
      setDepPicker((current) => {
        if (current?.rowId !== rowId) return current;
        const at = current.highlightId === null ? -1 : entryIds.indexOf(current.highlightId);
        // From nothing highlighted — or a highlight whose row left the list —
        // Down enters at the top and Up at the bottom.
        const from = at === -1 ? (delta === 1 ? -1 : entryIds.length) : at;
        const to = Math.min(entryIds.length - 1, Math.max(0, from + delta));
        return { ...current, highlightId: entryIds[to] ?? null };
      });
    },
    [setDepPicker],
  );

  // A steps change rebuilds the column definitions and remounts every cell —
  // the one remount this table still allows itself. React fires no blur on an
  // unmounted input, so an open picker would stay open under a fresh, unfocused
  // cell with no keyboard attached to it. Closed instead.
  useEffect(() => {
    setDepPicker(null);
  }, [setDepPicker, steps]);
  return { dependenciesOf, dependOn, depEntriesFor, pickDependency, moveDepHighlight };
}
