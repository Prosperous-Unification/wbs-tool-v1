import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PRIORITY_BAND_REFUSALS, type PriorityBandView } from '@/lib/wbs-api';

import { priorityBandStyleOf } from './priority-band-style';
import type { SettingsSectionReport } from './teams-panel';
import { SectionProblem, useSettingsSection } from './use-settings-section';

/** One rung as its three boxes hold it — text, because a half-typed number is text. */
export interface BandDraft {
  label: string;
  startsAt: string;
  defaultValue: string;
}

/** The ladder as five drafts, which is what the boxes are bound to. */
export function draftsOf(bands: readonly PriorityBandView[]): BandDraft[] {
  return bands.map((band) => ({
    label: band.label,
    startsAt: String(band.startsAt),
    defaultValue: String(band.defaultValue),
  }));
}

/**
 * What a rung's drafts amount to, or `null` where one of the numbers is not one.
 *
 * `Number('')` is `0` and `Number('1e999')` is `Infinity`, and both would travel
 * as a number be-01 refuses with a code about whole numbers — which is a true
 * sentence about the wrong mistake. An empty box and an unsendable draft are
 * refused here, on the surface, in the words of the thing that is actually
 * wrong. Everything else — a default outside its band, a cut below the one
 * beneath it — is be-01's to refuse, because `priorityLadderProblem` is the one
 * guard and a second copy here is a rule free to disagree with it. The same
 * bargain `TeamsPanel`'s `commit` makes one section along.
 *
 * Proof: the `Number.isSafeInteger` arm replaced by a bare `Number(draft)`, and
 * `refuses an empty box here rather than sending a zero` failed on `expected
 * "spy" to not be called at all, but actually been called 1 times` — a ladder on
 * its way out with a band starting at 0. Watched 2026-08-14.
 */
export function ladderOfDrafts(drafts: readonly BandDraft[]): PriorityBandView[] | null {
  const bands: PriorityBandView[] = [];
  for (const draft of drafts) {
    const startsAt = Number(draft.startsAt.trim());
    const defaultValue = Number(draft.defaultValue.trim());
    if (draft.startsAt.trim() === '' || !Number.isSafeInteger(startsAt)) return null;
    if (draft.defaultValue.trim() === '' || !Number.isSafeInteger(defaultValue)) return null;
    bands.push({ startsAt, label: draft.label, defaultValue });
  }
  return bands;
}

/**
 * What a rung holds, in words — `1 to 20`, and `81 and above` for the top rung.
 *
 * Derived from the **drafts** rather than from what be-01 has, so somebody moving
 * a cut watches the two bands either side of it change as they type. That is the
 * whole reason this surface can be understood: a band is stored as a start, and a
 * reader thinks in ranges.
 */
export function bandRangeWords(drafts: readonly BandDraft[], at: number): string {
  const own = drafts.at(at);
  if (own === undefined) return '';
  const above = at + 1 < drafts.length ? drafts.at(at + 1) : undefined;
  if (above === undefined) return `${own.startsAt} and above`;
  // An emptied box above is *unknown*, not zero. `Number('')` is `0`, so a bare
  // parse would draw `1 to -1` in the row below the one somebody is part-way
  // through retyping — a range that reads as a defect in their ladder rather than
  // as a box they have not finished. Watched 2026-08-14, on
  // `says the start alone while the box above it is half-typed`.
  const ends = above.startsAt.trim() === '' ? Number.NaN : Number(above.startsAt) - 1;
  if (!Number.isSafeInteger(ends)) return `${own.startsAt} and above`;
  return `${own.startsAt} to ${String(ends)}`;
}

export interface PrioritiesPanelProps extends SettingsSectionReport {
  /** This plan's ladder as be-01 has it — five rungs, most important first. */
  bands: readonly PriorityBandView[];
  /** Replaces the whole ladder. Throws be-01's refusal code. */
  setBands: (bands: readonly PriorityBandView[]) => Promise<void>;
  /** Re-reads the plan, which is what redraws every face in the new labels. */
  onChanged: () => Promise<void>;
  /**
   * Asks the modal to close — from `Save` once the ladder has landed, and from
   * `Cancel` with the drafts put back. The panel is clean when it calls this and
   * says so by calling it; see `TeamsPanelProps.onDone`.
   */
  onDone: () => void;
}

/**
 * What this plan calls its priority numbers.
 *
 * **A panel and not a dialog since `project-config-modal`** (2026-08-30): one of
 * three sections of `ProjectSettingsModal`, which owns the shell, the trigger,
 * the title and the close. `openspec/changes/priority-bands/design.md` D5 put
 * this beside the teams box as the same class of fact — a project's own
 * configuration, edited from the plan's toolbar — and the modal is that
 * sentence made into one surface.
 *
 * One thing is deliberately **not** `TeamsPanel`'s, and it is the difference
 * between the two facts. A capacity is one number about one team, so that panel
 * commits per box on blur and each write stands alone. A ladder is five rungs
 * that are only a ladder **together** — moving `High` down to 15 is invalid until
 * `Medium` moves too — so committing per box would refuse every intermediate
 * state somebody has to type through. Here the drafts are held and **Save** sends
 * the whole ladder once. design.md D4.
 *
 * **The drafts are seeded once, on mount.** The panel is mounted when the modal
 * opens and unmounted when it closes, so a reader who has it shut sees a peer's
 * re-cut the next time they open it, and a reader who has typed keeps what they
 * typed. This used to be done on the dialog's own open transition, after a
 * `useEffect(..., [bands, open])` reseeding on every tree read produced 77
 * `not wrapped in act(...)` warnings in one CI run (2026-08-14); the mount is
 * that transition now.
 *
 * Nothing is optimistic. The write re-reads the plan through `onChanged`, and a
 * refused ladder leaves the boxes as they were typed with the refusal on the
 * surface — a sentence here rather than a toast in the corner of the page this
 * panel is covering, because every refusal is about a box somebody is looking
 * at.
 */
export function PrioritiesPanel({
  bands,
  setBands,
  onChanged,
  onDirtyChange,
  onDone,
}: PrioritiesPanelProps) {
  const [drafts, setDrafts] = useState<BandDraft[]>(() => draftsOf(bands));

  /**
   * Dirty while the boxes say something the saved ladder does not. Compared
   * field by field against the ladder as be-01 has it **now**, so a peer's
   * re-cut that happens to match what was typed reads as clean rather than as
   * an edit to lose. A write in flight is {@link useSettingsSection}'s to add.
   */
  // Built once, not once per band: it was inside the predicate, so a
  // twelve-rung ladder rebuilt twelve copies of itself to answer one question,
  // on every render of the panel.
  const savedDrafts = draftsOf(bands);
  const dirty = drafts.some((draft, at) => {
    const saved = savedDrafts.at(at);
    return (
      saved?.label !== draft.label ||
      saved.startsAt !== draft.startsAt ||
      saved.defaultValue !== draft.defaultValue
    );
  });
  const section = useSettingsSection({
    words: PRIORITY_BAND_REFUSALS,
    dirty,
    onDirtyChange,
    onChanged,
  });

  function edit(at: number, field: keyof BandDraft, value: string): void {
    setDrafts((current) =>
      current.map((draft, index) => (index === at ? { ...draft, [field]: value } : draft)),
    );
  }

  async function save(): Promise<void> {
    const ladder = ladderOfDrafts(drafts);
    if (ladder === null) {
      // Refused without a round trip: a box that is not a whole number is not a
      // rung, and be-01 would answer the same thing a request later.
      section.refuse('band_start_must_be_a_whole_number_from_1');
      return;
    }
    // The drafts are kept on a refusal — see {@link SettingsSection.attempt} —
    // and `onDone` only on the write that landed.
    if (await section.attempt(() => setBands(ladder))) onDone();
  }

  /** Puts the ladder back as be-01 has it and leaves — the drafts are the only thing to discard. */
  function cancel(): void {
    setDrafts(draftsOf(bands));
    section.clear();
    onDone();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        What this plan calls its priority numbers. A band starts where you say and ends where the
        next one begins, so every number has exactly one name. The number a band writes is what
        picking its name in the Prio column puts on a row. Every band is this plan’s own.
      </p>

      <SectionProblem problem={section.problem} />

      <ul className="flex flex-col gap-2">
        {drafts.map((draft, at) => {
          // The swatch is the **saved** ladder's colour for this rung, which is
          // a colour of the rank and not of anything being typed: the rank
          // cannot change here, so the dot beside a row somebody is renaming
          // stays the colour that row will still be.
          const paint = priorityBandStyleOf(bands, bands.at(at)?.startsAt ?? 1);
          return (
            <li key={`band-${String(at)}`} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                data-priority-swatch={at}
                className="size-3 shrink-0 rounded-full"
                style={{ background: paint?.ink ?? 'var(--muted-foreground)' }}
              />
              <Input
                className="h-8 min-w-0 flex-1"
                aria-label={`Name of band ${String(at + 1)}`}
                value={draft.label}
                disabled={section.busy}
                onChange={(event) => {
                  edit(at, 'label', event.currentTarget.value);
                }}
              />
              <Input
                className="h-8 w-16 shrink-0 text-right"
                aria-label={`${draft.label} starts at`}
                inputMode="numeric"
                value={draft.startsAt}
                disabled={section.busy}
                onChange={(event) => {
                  edit(at, 'startsAt', event.currentTarget.value);
                }}
              />
              <span
                data-priority-range={at}
                className="text-muted-foreground w-24 shrink-0 text-right text-sm"
                // The range a start amounts to, recomputed as the boxes change.
                // A band is stored as a start and read as a range, and this is
                // the only place the reader is shown the second.
                data-fact={`${draft.label} holds priorities ${bandRangeWords(drafts, at)}.`}
              >
                {bandRangeWords(drafts, at)}
              </span>
              <Input
                className="h-8 w-16 shrink-0 text-right"
                aria-label={`${draft.label} writes`}
                inputMode="numeric"
                value={draft.defaultValue}
                disabled={section.busy}
                onChange={(event) => {
                  edit(at, 'defaultValue', event.currentTarget.value);
                }}
              />
            </li>
          );
        })}
      </ul>

      <p className="text-muted-foreground text-sm">
        Changing a band renames what this plan’s numbers are called. It moves no dates — a priority
        still decides only who gets a shared person first.
      </p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" type="button" disabled={section.busy} onClick={cancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={section.busy}
          onClick={() => {
            void save();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
