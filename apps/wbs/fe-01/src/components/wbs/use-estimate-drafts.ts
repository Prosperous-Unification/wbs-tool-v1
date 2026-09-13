import type * as React from 'react';
import { useCallback, useRef, useState } from 'react';

import type { PersonView, TeamView } from '@/lib/wbs-api';
import { type ProjectApi } from '@/lib/wbs-api';

import { pickableLabel, type PickerOption } from './creatable-picker';
import { type CellElement } from './editable-grid';
import {
  isTrioEmpty,
  parseTrioShorthand,
  type Point,
  POINTS,
  sendableTrio,
  showTrio,
  trioProblem,
  type TypedTrio,
} from './estimate-draft';
import { type CommitOutcome, unsent } from './live-editing';
import { splitMention } from './mention';
import { showDays } from './plan-number-format';
import { type TreeRow } from './wbs-rows';

/**
 * The three-point estimates as they are being typed, and the writes that settle
 * them.
 *
 * Drafts are keyed by row, step and point because a trio is typed one figure at
 * a time and the round trip is per figure: what is on screen has to be what was
 * typed, not what the last answer said.
 */
export function useEstimateDrafts({
  drafts,
  setDrafts,
  run,
  api,
}: {
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
}) {
  /**
   * Whether the numbers in the schedule columns mean anything.
   *
   * When be-01 could not order the graph it sends every row the same zeroed
   * schedule, and printing those is a page of `0`s that reads as "everything
   * happens on day zero" — a confident wrong answer of exactly the kind the
   * banner above is there to prevent. A reviewer caught the columns still doing
   * it while `verify.md` claimed they did not.
   */
  /**
   * One trio as it currently reads: the draft where there is one, the stored
   * figure where there is not.
   *
   * The draft wins because it is what the person typed and has not been told
   * off about yet. A stored figure showing through under it would be the tool
   * quietly disagreeing with the box.
   */
  const typedTrio = useCallback(
    (row: TreeRow, stepId: string): TypedTrio => {
      const stored = row.estimates[stepId];
      const read = (point: Point): string =>
        drafts[draftKey(row.id, stepId, point)] ?? showDays(stored, point);
      return {
        optimistic: read('optimistic'),
        realistic: read('realistic'),
        pessimistic: read('pessimistic'),
      };
    },
    [drafts],
  );

  const estimateValue = useCallback(
    (row: TreeRow, stepId: string, point: Point): string => typedTrio(row, stepId)[point],
    [typedTrio],
  );

  /**
   * What is wrong with this row-and-step's trio, or null.
   *
   * A parent's figures are rolled up rather than typed, so they are never
   * anyone's mistake: complaining about a sum the tool computed would be the
   * tool telling somebody off for its own arithmetic.
   */
  const trioProblemFor = useCallback(
    (row: TreeRow, stepId: string) => (row.rolledUp ? null : trioProblem(typedTrio(row, stepId))),
    [typedTrio],
  );

  /**
   * Forgets every draft of one row-and-step — the three boxes' and the folded
   * cell's — once be-01 has the answer.
   *
   * All four together, whichever of them was typed: they are drafts of one
   * estimate, and leaving the others behind would put a stale entry back on
   * screen the moment the step was folded or unfolded.
   *
   * Rebuilt without those keys rather than deleted from a copy: `delete` on a
   * computed key is banned here, and filtering says the same thing without
   * reaching into the object twice.
   */
  const forgetEstimateDrafts = useCallback(
    (rowId: string, stepId: string) => {
      setDrafts((current) => dropDrafts(current, estimateDraftKeys(rowId, stepId)));
    },
    [setDrafts],
  );

  /**
   * Takes a typed estimate box: holds it as a draft, and either sends the trio
   * once it can stand on its own or clears the stored one it just emptied.
   *
   * Nothing is repaired and nothing partial is sent — that is the whole of
   * Dany's "never edit estimates", and emptying boxes does not weaken it. A
   * deletion is only all three boxes reading empty against a trio be-01
   * actually holds; one or two empty boxes is a half-filled trio and stays a
   * complaint. The drafts for the trio are dropped only once be-01 has
   * accepted the write, so a refused request leaves what was typed on screen
   * to be corrected rather than swallowed.
   *
   * Proof: making the clear fire on `!== null` drafts instead of an empty trio
   * — i.e. on one emptied box — fails `does not clear when only two of the
   * three boxes are emptied` in `wbs-table.test.tsx`; watched, 2026-08-06.
   */
  const commitEstimate = useCallback(
    (row: TreeRow, stepId: string, point: Point, typed: string): Promise<CommitOutcome> => {
      const next = { ...typedTrio(row, stepId), [point]: typed };
      setDrafts((current) => ({
        // A box edited last drops the folded cell's pending shorthand for this
        // trio: one row and step has one draft, whichever way it was typed.
        // Proof: left as `...current`, `lets a box replace what the folded cell
        // was holding` fails — the refused `8/3/2` came back over the box's
        // own complaint. Watched, 2026-08-06.
        ...dropDrafts(current, new Set([combinedDraftKey(row.id, stepId)])),
        [draftKey(row.id, stepId, point)]: typed,
      }));
      const days = sendableTrio(next);
      if (days === null) {
        // `hasOwn` rather than a truthiness test: what matters is whether
        // be-01 holds a trio for this row and step at all, and a stored
        // `0 / 0 / 0` is one.
        if (isTrioEmpty(next) && Object.hasOwn(row.estimates, stepId)) {
          return run(async () => {
            await api.clearEstimate(row.id, stepId);
            forgetEstimateDrafts(row.id, stepId);
          });
        }
        // A half-filled trio is a complaint, not a request: what was typed
        // stays in `drafts`, which is where this cell's unsent text lives.
        return unsent();
      }
      return run(async () => {
        await api.setEstimate(row.id, stepId, days);
        forgetEstimateDrafts(row.id, stepId);
      });
    },
    [api, forgetEstimateDrafts, run, setDrafts, typedTrio],
  );

  /**
   * What the folded step column's cell reads: the pending shorthand if there
   * is one, and otherwise the stored estimate as {@link showTrio} prints it.
   *
   * **The stored trio, not be-01's computed final figure**, since
   * `estimate-triple-visible`. The figure was what this cell showed from
   * `role-columns-fold` until 2026-08-29, on the reasoning that a plan is read
   * by the final figure and the trio behind it is only what an estimator
   * types. Two things were wrong with it. The three numbers somebody chose
   * left the screen the moment they landed — Dany, 2026-08-29: *"i want to
   * keep seeing the values i've put in"* — with a hover card or an unfold as
   * the only ways back, and unfolding one step folds another. And it made this
   * the one box in the grid whose value at rest was not a legal way to have
   * typed what it stood for: `2.2` over a stored `2/2/3` stores
   * `2.2/2.2/2.2` when it is typed back.
   *
   * The figure has not gone anywhere — it stands beside the box, muted, where
   * it says something the shorthand does not. See the folded cell's
   * `data-folded-final`.
   *
   * The draft still wins while it exists, for the reason a box's does: it is
   * what the person typed and has not been told off about yet.
   */
  const combinedValue = useCallback(
    (row: TreeRow, stepId: string): string =>
      drafts[combinedDraftKey(row.id, stepId)] ?? showTrio(row.estimates[stepId]),
    [drafts],
  );

  /**
   * What is wrong with what the folded column is showing for one row and step,
   * or null.
   *
   * Two sources, never both at once: the folded cell's own shorthand if
   * something is pending there, and otherwise the three boxes' trio — which is
   * the complaint `role-columns-fold` put on the figure so a fold could not
   * hide one. Precedence rather than a merge, because the draft that exists is
   * the one somebody typed last, and it is the only one they can correct
   * without unfolding.
   */
  const combinedProblem = useCallback(
    (row: TreeRow, stepId: string): string | null => {
      // `hasOwn` rather than a nullish test: an empty draft is a person having
      // just emptied the cell, and it is the entry that reads as a clear —
      // reading it as "nothing pending here" would show the stored figure back
      // over the emptying.
      // Proof: returning null instead of the boxes' complaint fails `a folded
      // step cannot hide a complaint`, `marks the folded cell when the boxes
      // hold a trio that saves nothing` and `lets a box replace what the
      // folded cell was holding`. Watched, 2026-08-06.
      const key = combinedDraftKey(row.id, stepId);
      if (!Object.hasOwn(drafts, key)) return trioProblemFor(row, stepId)?.message ?? null;
      const entry = parseTrioShorthand(drafts[key]);
      return entry.kind === 'problem' ? entry.message : null;
    },
    [drafts, trioProblemFor],
  );

  /**
   * Takes a whole trio typed into one cell as `o/r/p`, and sends it in one
   * request — or holds it as a draft and complains, exactly as a box does.
   *
   * The shorthand is the estimating loop's short path: the step stays folded,
   * one cell takes `2/3/8`, and be-01 is asked once rather than three times.
   * `5` means `5/5/5` because the person typed one number meaning three equal
   * ones; nothing here invents a figure, and a trio that runs backwards, has
   * the wrong count or is not a number is refused whole — see
   * {@link parseTrioShorthand}.
   *
   * Emptying the cell against a stored trio clears it through the same
   * `clearEstimate` the three emptied boxes use; emptying it against nothing
   * stored asks for nothing.
   *
   * Proof: made to send a two-number entry (`parseTrioShorthand` returning a
   * trio for `2/3`), `sends nothing for two numbers where three were needed`
   * in `wbs-table.test.tsx` fails; watched, 2026-08-06.
   */
  const commitCombinedEstimate = useCallback(
    (row: TreeRow, stepId: string, typed: string, baseline: string): Promise<CommitOutcome> => {
      // The estimate half, always — {@link parseTrioShorthand} never sees a
      // mention. Two things follow, and both are refusals to send rather than
      // repairs: a cell left with `@ka` still in it whose estimate half is
      // what the cell was already showing has nothing to commit (`4.8@ka` is a
      // figure this tool computed and a search nobody finished, not somebody
      // asking for 4.8/4.8/4.8), and an *empty* estimate half beside a mention
      // is the select-on-focus rather than somebody clearing an estimate.
      // Emptying a cell with no `@` in it still clears it.
      const { estimate, mention: fragment } = splitMention(typed);
      if (fragment !== null && (estimate.trim() === '' || estimate === baseline)) return unsent();
      const entry = parseTrioShorthand(estimate);
      setDrafts((current) => ({
        // Last edit wins: this entry replaces whatever the three boxes were
        // holding unsent for the same trio. Translating it into three box
        // drafts instead would put figures into boxes nobody typed them into.
        // Proof: left as `...current`, `lets a folded entry replace what the
        // boxes were holding` fails — the box still held a `7` nobody could
        // see. Watched, 2026-08-06.
        ...dropDrafts(current, new Set(POINTS.map((point) => draftKey(row.id, stepId, point)))),
        // The estimate half, so a draft rendered back into the box can never
        // carry a mention somebody abandoned.
        [combinedDraftKey(row.id, stepId)]: estimate,
      }));
      if (entry.kind === 'problem') return unsent();
      if (entry.kind === 'empty') {
        // `hasOwn`, as above: a stored `0 / 0 / 0` is an estimate to clear.
        // Proof: inverted, `clears the stored trio when the cell is emptied`
        // and `asks for nothing when a cell with no estimate is emptied` both
        // fail — one clear lost, one deletion posted per cell tabbed through.
        // Watched, 2026-08-06.
        if (!Object.hasOwn(row.estimates, stepId)) return unsent();
        return run(async () => {
          await api.clearEstimate(row.id, stepId);
          forgetEstimateDrafts(row.id, stepId);
        });
      }
      return run(async () => {
        await api.setEstimate(row.id, stepId, entry.days);
        forgetEstimateDrafts(row.id, stepId);
      });
    },
    [api, forgetEstimateDrafts, run, setDrafts],
  );
  return {
    estimateValue,
    trioProblemFor,
    commitEstimate,
    combinedValue,
    combinedProblem,
    commitCombinedEstimate,
  };
}

/**
 * The `@` list inside an estimate cell — assigning the step's person from the
 * same box the figures are typed in.
 *
 * Here rather than with the assignments because what opens it is a keystroke in
 * a **draft**: the list is part of typing an estimate, not part of writing one.
 */
export function useEstimateMentions({
  foldedBox,
  foldedAtFocus,
  setMention,
  mention,
  people,
  assignTo,
  teams,
  createPersonFor,
}: {
  foldedBox: React.RefObject<CellElement | null>;
  foldedAtFocus: React.RefObject<string>;
  setMention: React.Dispatch<
    React.SetStateAction<{ rowId: string; stepId: string; typed: string } | null>
  >;
  mention: { rowId: string; stepId: string; typed: string } | null;
  people: PersonView[];
  assignTo: (id: string, stepId: string, personId: string | null) => void;
  teams: TeamView[];
  createPersonFor: (row: TreeRow, stepId: string, name: string) => void;
}) {
  /**
   * Takes the focus into a folded step's cell, remembering what it holds.
   *
   * Called from the box's own `onFocus`, before the select that cell has
   * always done — the value has to be read while it is still there.
   */
  const enterFoldedCell = useCallback(
    (box: CellElement) => {
      foldedBox.current = box;
      foldedAtFocus.current = box.value;
    },
    [foldedAtFocus, foldedBox],
  );

  /**
   * Reads a folded step's box on every keystroke and opens or closes its `@`
   * picker.
   *
   * The estimate half is not touched here and no draft is written: what has
   * been typed lives in the box until the cell is left, exactly as it did
   * before mentions existed. All this does is decide whether a list is open
   * and what it is filtered by.
   */
  const readFoldedCell = useCallback(
    (rowId: string, stepId: string, box: CellElement) => {
      const { mention: fragment } = splitMention(box.value);
      setMention(fragment === null ? null : { rowId, stepId, typed: fragment });
    },
    [setMention],
  );

  /**
   * Takes the `@fragment` back out of the focused folded box, leaving the
   * estimate half exactly as it was.
   *
   * The empty case is the one worth reading: a cell is selected on focus, so
   * `@` typed straight into one replaces the figure it was showing, and an
   * empty estimate half committed on the blur that follows would clear an
   * estimate the person never touched. So an empty half is put back to what
   * the cell held when the focus arrived. Emptying a cell deliberately — with
   * no `@` in it — still clears the estimate, which is the gesture the cheat
   * sheet documents.
   */
  const takeMentionOut = useCallback(() => {
    const box = foldedBox.current;
    if (box !== null) {
      const { estimate } = splitMention(box.value);
      box.value = estimate.trim() === '' ? foldedAtFocus.current : estimate;
    }
    setMention(null);
  }, [foldedAtFocus, foldedBox, setMention]);

  /**
   * Closes the `@` list and leaves the box exactly as it is — Escape's answer,
   * and the same one every picker in this table gives it.
   */
  const closeMention = useCallback(() => {
    setMention(null);
  }, [setMention]);

  /** Leaves a folded cell: the mention goes with the focus, the estimate stays. */
  const leaveFoldedCell = useCallback(() => {
    takeMentionOut();
    foldedBox.current = null;
  }, [foldedBox, takeMentionOut]);

  /**
   * What the `@` picker in one folded cell is offering.
   *
   * The same three kinds of entry the unfolded assignee column has, in the
   * order they are read in: the people whose names contain what was typed,
   * `Add "…"` when nothing matches it exactly, and `Remove …` when somebody is
   * already assigned. Enter takes the first of them, which is
   * {@link CreatablePicker}'s rule — so `Remove` is first on a bare `@` and
   * nowhere else, and `@ka⏎` can never be the gesture that unassigns anybody.
   */
  const mentionOptions = useCallback(
    (row: TreeRow, stepId: string): PickerOption[] => {
      const open = mention;
      if (open?.rowId !== row.id || open.stepId !== stepId) return [];
      const wanted = open.typed.trim().toLowerCase();
      const assigned = row.assignees[stepId];
      const assignedPerson = people.find((each) => each.id === assigned);
      const matching = people.filter(
        (each) => wanted === '' || each.name.toLowerCase().includes(wanted),
      );
      const exact = people.some((each) => each.name.toLowerCase() === wanted);
      return [
        ...(wanted === '' && assignedPerson !== undefined
          ? [
              {
                key: '(remove)',
                label: `Remove ${assignedPerson.name}`,
                selected: false,
                take: () => {
                  assignTo(row.id, stepId, null);
                  takeMentionOut();
                },
              },
            ]
          : []),
        ...matching.map((each) => ({
          key: each.id,
          label: pickableLabel({
            id: each.id,
            name: each.name,
            detail:
              each.teamIds.length === 0
                ? 'free agent'
                : each.teamIds
                    .map((id) => teams.find((team) => team.id === id)?.name ?? '?')
                    .join(', '),
          }),
          selected: each.id === assigned,
          take: () => {
            assignTo(row.id, stepId, each.id);
            takeMentionOut();
          },
        })),
        ...(wanted !== '' && !exact
          ? [
              {
                key: '(add)',
                label: `Add “${open.typed.trim()}”`,
                selected: false,
                take: () => {
                  createPersonFor(row, stepId, open.typed.trim());
                  takeMentionOut();
                },
              },
            ]
          : []),
      ];
    },
    [assignTo, createPersonFor, mention, people, takeMentionOut, teams],
  );
  return { enterFoldedCell, readFoldedCell, closeMention, leaveFoldedCell, mentionOptions };
}

/** The key one estimate box's draft is held under: one row, one step, one point. */
export const draftKey = (rowId: string, stepId: string, point: Point): string =>
  `${rowId}::${stepId}::${point}`;

/**
 * The key the folded cell's `o/r/p` draft is held under: one row, one step.
 *
 * The same `drafts` record as the boxes, because there is one pending
 * estimate per row and step however it was typed — see
 * {@link commitCombinedEstimate} for the rule that keeps it one. `combined`
 * cannot collide with a {@link Point}, which is what makes one record safe.
 */
export const combinedDraftKey = (rowId: string, stepId: string): string =>
  `${rowId}::${stepId}::combined`;

// SHORTHAND_HELP moved onto {@link FoldedStepCard}: the card is the folded
// cell's one hint, and the native `title` that used to say this raced it.

/**
 * The drafts record without the named keys.
 *
 * Rebuilt rather than copied and `delete`d: `delete` on a computed key is
 * banned here, and filtering says the same thing without reaching into the
 * object twice.
 */
export const dropDrafts = (
  drafts: Readonly<Record<string, string>>,
  gone: ReadonlySet<string>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(drafts).filter(([key]) => !gone.has(key)));

/**
 * The step a draft key belongs to — `rowId::stepId::point` — or null when the
 * key is not one this table wrote.
 *
 * Null rather than an empty string for a malformed key: every draft in this
 * record is written by {@link draftKey} or {@link combinedDraftKey}, so a key of
 * any other shape is a fault rather than a draft for the empty step, and the
 * sanitizer below keeps it rather than dropping it silently.
 */
export const stepOfDraftKey = (key: string): string | null => key.split('::')[1] ?? null;

/**
 * The step whose column a cell key names — `rowId::<stepId>-final` or
 * `rowId::<stepId>-<point>` — or null when the column is not a step's.
 *
 * The suffix rule is {@link widthFor}'s, and for the same reason: a step's half
 * of the id is whatever the project called it, so the only thing that can be
 * matched is the end. Name, Depends on and the date box answer null and are
 * never purged by a step going.
 */
export function stepOfCellKey(cellKey: string): string | null {
  const columnId = cellKey.slice(cellKey.indexOf('::') + 2);
  const at = columnId.lastIndexOf('-');
  if (at < 1) return null;
  const suffix = columnId.slice(at + 1);
  if (suffix !== 'final' && !(POINTS as readonly string[]).includes(suffix)) return null;
  return columnId.slice(0, at);
}

/** The row a cell key belongs to — the half before the `::` {@link cellKey} joins on. */
export const rowOfCellKey = (key: string): string => key.slice(0, key.indexOf('::'));

/** Every key one row-and-step's pending estimate can be held under. */
export const estimateDraftKeys = (rowId: string, stepId: string): ReadonlySet<string> =>
  new Set([
    ...POINTS.map((point) => draftKey(rowId, stepId, point)),
    combinedDraftKey(rowId, stepId),
  ]);

/**
 * The drafts themselves, and the mention the caret is inside.
 *
 * Held apart from the writers so a keystroke moves this and nothing else: the
 * cells read their own draft by key, and a re-render of the whole set on every
 * character is what this shape avoids.
 */
export function useEstimateDraftState() {
  /**
   * Estimate boxes whose typed value has not been accepted by be-01 yet, by
   * {@link draftKey}.
   *
   * These outlive the input they were typed into, on purpose. A trio is only
   * sent once all three read sensibly, so `5` typed into an empty row's
   * optimistic box is a number with nowhere to live until the other two
   * arrive — and holding it in the DOM alone would lose it to the next
   * refresh, which any peer's edit triggers. Cleared for the whole trio the
   * moment it is sent.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * The `@` mention open in a folded step's cell: whose cell, and what has been
   * typed after the `@`.
   *
   * One at a time, for `depPicker`'s reason: one box is being typed into. The
   * column reads it through the stable contract in `plan-live.ts`.
   *
   * `typed: ''` is a bare `@` — everybody offered — and is not the same as no
   * mention at all. {@link splitMention} is what tells the two apart.
   */
  const [mention, setMention] = useState<{ rowId: string; stepId: string; typed: string } | null>(
    null,
  );

  /**
   * The folded estimate box that has the focus, and what it was showing when
   * the focus arrived.
   *
   * Both are the `@` gesture's, and both are refs rather than state because
   * neither is rendered: the node is what the mention is stripped out of, and
   * the focus-time value is what goes back in when the estimate half turns out
   * to be empty. That case is not somebody clearing an estimate — it is the
   * select-on-focus this cell has always done, with `@` typed over the whole
   * selection. Clearing an estimate is emptying the cell with no `@` in it.
   */
  const foldedBox = useRef<CellElement | null>(null);

  const foldedAtFocus = useRef('');
  return { drafts, setDrafts, mention, setMention, foldedBox, foldedAtFocus };
}
