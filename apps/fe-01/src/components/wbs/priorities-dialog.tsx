import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import { priorityBandRefusalSentence, type PriorityBandView } from '@/lib/wbs-api';

import { priorityBandStyleOf } from './priority-band-style';

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
 * bargain `TeamsDialog.commit` makes one dialog along.
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

export interface PrioritiesDialogProps {
  /** This plan's ladder as be-01 has it — five rungs, most important first. */
  bands: readonly PriorityBandView[];
  /** Replaces the whole ladder. Throws be-01's refusal code. */
  setBands: (bands: readonly PriorityBandView[]) => Promise<void>;
  /** Re-reads the plan, which is what redraws every face in the new labels. */
  onChanged: () => Promise<void>;
}

/**
 * What this plan calls its priority numbers.
 *
 * **`TeamsDialog` is the precedent one button along**, and this is deliberately
 * its shape: a project's own configuration, edited from the plan's toolbar, on a
 * surface whose trigger lives in this component because Radix restores focus to
 * the trigger on close and to nothing at all without one.
 * `openspec/changes/priority-bands/design.md` D5.
 *
 * One thing is deliberately **not** `TeamsDialog`'s, and it is the difference
 * between the two facts. A capacity is one number about one team, so that dialog
 * commits per box on blur and each write stands alone. A ladder is five rungs
 * that are only a ladder **together** — moving `High` down to 15 is invalid until
 * `Medium` moves too — so committing per box would refuse every intermediate
 * state somebody has to type through. Here the drafts are held and **Save** sends
 * the whole ladder once. design.md D4.
 *
 * Nothing is optimistic. The write re-reads the plan through `onChanged`, and a
 * refused ladder leaves the boxes as they were typed with the refusal on the
 * surface — a sentence here rather than a toast in the corner of the page this
 * dialog is covering, because every refusal is about a box somebody is looking
 * at.
 */
export function PrioritiesDialog({ bands, setBands, onChanged }: PrioritiesDialogProps) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<BandDraft[]>(() => draftsOf(bands));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function edit(at: number, field: keyof BandDraft, value: string): void {
    setDrafts((current) =>
      current.map((draft, index) => (index === at ? { ...draft, [field]: value } : draft)),
    );
  }

  async function save(): Promise<void> {
    const ladder = ladderOfDrafts(drafts);
    if (ladder === null) {
      setProblem('Every band needs a whole number to start at and a whole number to write.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await setBands(ladder);
      await onChanged();
      setOpen(false);
    } catch (thrown: unknown) {
      // The drafts are kept on a refusal: the ladder on screen is what the reader
      // typed and what the sentence beside it is about, and resetting it to
      // be-01's would leave a sentence explaining a value nobody could see.
      setProblem(
        priorityBandRefusalSentence(thrown instanceof Error ? thrown.message : 'request_failed'),
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens and closes, and takes the ladder from be-01 on the way through in both
   * directions.
   *
   * **On the transition and not in an effect**, which is the correction rather
   * than the first shape. Written as `useEffect(..., [bands, open])` that reseeds
   * whenever the surface is shut, it fired on every tree read — `bands` is a
   * fresh array from every payload — so every refetch anywhere in the app queued
   * a `setDrafts` from a component that is not on screen. Harmless in a browser
   * and very loud in a test: 77 `An update to PrioritiesDialog inside a test was
   * not wrapped in act(...)` in one CI run, watched 2026-08-14.
   *
   * Seeding on open is the same guarantee with none of that. A reader who has
   * this shut sees a peer's re-cut the next time they open it; a reader who has
   * it open and has typed into it keeps what they typed, which is what
   * {@link PrioritiesDialog} promises and what an effect reseeding under their
   * hands would break.
   */
  function onOpenChange(next: boolean): void {
    setOpen(next);
    setProblem(null);
    setDrafts(draftsOf(bands));
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          title="Say what this plan calls its priority numbers"
        >
          Priorities
        </Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Priorities on this plan</ModalTitle>
          <ModalDescription>
            What this plan calls its priority numbers. A band starts where you say and ends where
            the next one begins, so every number has exactly one name. The number a band writes is
            what picking its name in the Prio column puts on a row. Every band is this plan’s own.
          </ModalDescription>
        </ModalHeader>

        {problem !== null && (
          <p role="alert" className="text-destructive text-sm">
            {problem}
          </p>
        )}

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
                  disabled={busy}
                  onChange={(event) => {
                    edit(at, 'label', event.currentTarget.value);
                  }}
                />
                <Input
                  className="h-8 w-16 shrink-0 text-right"
                  aria-label={`${draft.label} starts at`}
                  inputMode="numeric"
                  value={draft.startsAt}
                  disabled={busy}
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
                  title={`${draft.label} holds priorities ${bandRangeWords(drafts, at)}.`}
                >
                  {bandRangeWords(drafts, at)}
                </span>
                <Input
                  className="h-8 w-16 shrink-0 text-right"
                  aria-label={`${draft.label} writes`}
                  inputMode="numeric"
                  value={draft.defaultValue}
                  disabled={busy}
                  onChange={(event) => {
                    edit(at, 'defaultValue', event.currentTarget.value);
                  }}
                />
              </li>
            );
          })}
        </ul>

        <p className="text-muted-foreground text-sm">
          Changing a band renames what this plan’s numbers are called. It moves no dates — a
          priority still decides only who gets a shared person first.
        </p>

        <ModalFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void save();
            }}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
