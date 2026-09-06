import { type ReactNode, useEffect, useState } from 'react';

import { type RefusalWords, sentenceForRefusal } from '@/lib/refusal';

import { failureText } from './plan-refusal';

export interface SettingsSection {
  /** Whether a write this section asked for is still in the air. */
  busy: boolean;
  /** What refused the last attempt, in this section's own words, or null. */
  problem: string | null;
  /**
   * Says something this section refused **without** a round trip — a blank
   * name, a ladder that does not add up.
   *
   * Takes be-01's code rather than a sentence, so a locally-refused request
   * reads exactly as a refused one does and the surface keeps one wording table.
   */
  refuse: (code: string) => void;
  /** Drops the sentence, for a control that starts a fresh gesture. */
  clear: () => void;
  /**
   * Runs one write, re-reads the plan, and answers whether be-01 kept it.
   *
   * The boolean is the caller's: a blur has nothing left to decide once the
   * sentence is on screen, but a `Done` button does — it may only close over a
   * surface with nothing left to say.
   *
   * A refusal **keeps** what is on screen. The value the reader typed is what
   * the sentence beside it is about, and resetting it to be-01's would leave a
   * sentence explaining a value nobody can see.
   */
  attempt: (change: () => Promise<void>) => Promise<boolean>;
}

export interface SettingsSectionOptions {
  /** How this section words be-01's refusal codes — see {@link RefusalWords}. */
  words: RefusalWords;
  /**
   * Whether this section holds anything the modal must not close over.
   *
   * Computed by the section, because only it knows what unfinished means: a
   * half-typed name, an unanswered confirmation, a draft ladder. A write in
   * flight is **not** its business — this hook adds `busy` on its behalf.
   */
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** Re-reads the plan after a write landed. */
  onChanged: () => Promise<void>;
}

/**
 * The five things every panel in the project settings modal does, so that
 * adding a fifth stops being "copy `estimating-panel.tsx` and remember five
 * things".
 *
 * All four panels — steps, teams, priorities, estimating — held their own copy
 * of: two `useState`s, the two `onDirtyChange` effects, an `attempt` that
 * brackets a write with `busy`/`problem`, and the wording of a refusal. The
 * copies agreed, and the one they each had to remember separately is the one
 * that bites: the **withdrawal on unmount**. Without it the modal stays
 * un-closable over a section nobody is looking at.
 *
 * A hook rather than a wrapping component, because each panel's body is its
 * own: a component would take the whole form as `children` and hand these three
 * values back down through a render prop, which is the same three values by a
 * longer road.
 */
export function useSettingsSection(options: SettingsSectionOptions): SettingsSection {
  const { words, dirty, onDirtyChange, onChanged } = options;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `busy` counts as unfinished, which is why no panel has to remember to put
  // it in its own `dirty`: a write in the air is a thing the modal must not
  // close over.
  //
  // Proof (each panel's own, watched 2026-08-30): reported `false`
  // unconditionally, `refuses to close over a confirmation nobody has answered`
  // let Escape close over an open removal, and `an in-flight write holds the
  // modal open and is shown` let it close over the write.
  const unfinished = dirty || busy;
  useEffect(() => {
    onDirtyChange(unfinished);
  }, [unfinished, onDirtyChange]);
  // Withdrawn on unmount, and this is the half a new panel forgets: the modal
  // asks every section it has mounted, so one that never takes its claim back
  // leaves the modal refusing to close over a form that is gone.
  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  return {
    busy,
    problem,
    refuse: (code) => {
      setProblem(sentenceForRefusal(words, code));
    },
    clear: () => {
      setProblem(null);
    },
    attempt: async (change) => {
      setBusy(true);
      setProblem(null);
      try {
        await change();
        await onChanged();
        return true;
      } catch (thrown: unknown) {
        setProblem(sentenceForRefusal(words, failureText(thrown, 'request_failed')));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

/**
 * What a section says when something refused it, and nothing at all otherwise.
 *
 * `role="alert"`, because the reader has just pressed something and this is the
 * whole of what happened; a `status` would wait for a quiet moment to mention a
 * write that did not land. Four identical copies of these three lines until
 * 2026-09-02.
 */
export function SectionProblem({ problem }: { problem: string | null }): ReactNode {
  if (problem === null) return null;
  return (
    <p role="alert" className="text-destructive text-sm">
      {problem}
    </p>
  );
}
