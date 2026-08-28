import { type FormEvent, type KeyboardEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import {
  type AssumedAssigneeFlipView,
  roleRefusalSentence,
  type RoleUsage,
  type RoleView,
} from '@/lib/wbs-api';

import { commandChordIn } from './keyboard-bindings';
import { CARDS_BELOW, TABLE_NEEDS_HEIGHT } from './plan-renderer';
import { foldedTableMinWidth, type FrameLayoutState } from './table-frame';

/** What a work item's number is, or null once it is no longer in the tree on screen. */
export type NumberOf = (workItemId: string) => string | null;
/** Who somebody is, or null when the directory has no such person. */
export type NameOf = (personId: string) => string | null;

/**
 * How many of a thing, with the thing named singly or plurally.
 *
 * `2 estimates` and `1 assignment` in one sentence, from one place: two
 * spellings of a count is how a confirmation comes to read as though it were
 * about two different removals.
 */
const count = (howMany: number, thing: string): string =>
  `${String(howMany)} ${thing}${howMany === 1 ? '' : 's'}`;

/**
 * What removing a phase would take, as one sentence.
 *
 * The two counts always, even when one is zero: "1 estimate and 0 assignments"
 * is a complete answer, and a sentence that dropped the zero would leave the
 * reader wondering whether it had been asked.
 */
export function usageSentence(roleName: string, inUse: RoleUsage): string {
  return `Removing ${roleName} would delete ${count(inUse.estimates, 'estimate')} and ${count(
    inUse.assignments,
    'assignment',
  )}.`;
}

/**
 * What one assumed-assignee flip says, in the words of somebody reading a plan.
 *
 * "Assumed to be doing all of it" rather than `doesEveryPhase`: the field is
 * derived from a work item holding exactly one assignment, and the person it
 * names never agreed to anything — so the sentence has to say who is being
 * assumed, not report a flag.
 *
 * A work item the tree on screen no longer holds is named by nothing at all
 * rather than by its id: a uuid in a confirmation is a fact nobody can act on.
 * That is a state, not a fault — this list came from be-01 and the tree here is
 * a moment older.
 */
export function flipSentence(
  flip: AssumedAssigneeFlipView,
  numberOf: NumberOf,
  nameOf: NameOf,
): string {
  const who = (personId: string | null): string =>
    personId === null ? 'nobody' : (nameOf(personId) ?? 'somebody no longer in the directory');
  const named = numberOf(flip.workItemId) ?? 'A work item no longer on screen';
  return `${named}: ${who(flip.assumedNow)} is assumed to be doing all of it now, ${who(
    flip.assumedAfter,
  )} would be afterwards.`;
}

export interface PhasesDialogProps {
  /** The phases the table is currently drawing columns for. */
  roles: readonly RoleView[];
  /**
   * The plan the table is drawing, as far as a width depends on it.
   *
   * Passed down rather than assumed, because the figure below is the table's
   * own minimum and the table's minimum moves with this: a plan where nobody
   * has set an earliest start is 28px narrower than one where somebody has.
   */
  frameState: FrameLayoutState;
  /**
   * The reader's hidden columns, sanitised — what the table is really showing,
   * so the folded width quoted below is the width of that table and not of the
   * default one. `foldedTableMinWidth` throws on an id it does not know, which
   * is why the caller hands over its filtered list and never the stored one.
   */
  hiddenColumnIds: readonly string[];
  numberOf: NumberOf;
  nameOf: NameOf;
  addRole: (name: string) => Promise<RoleView>;
  renameRole: (roleId: string, name: string) => Promise<RoleView>;
  removeRole: (roleId: string, cascade: boolean) => Promise<{ ok: boolean; inUse?: RoleUsage }>;
  /** Re-reads the project, which is what puts the new columns on the table. */
  onChanged: () => Promise<void>;
}

/** A removal be-01 refused, and the decision the reader has not made yet. */
interface Confirming {
  role: RoleView;
  inUse: RoleUsage;
  cascade: boolean;
}

/**
 * The project's phases, and everything that can be done to them.
 *
 * The first production caller of {@link ModalContent}, which brings two rules
 * with it: the page's own keyboard is held back while this is open, and a
 * command chord aimed at a field **on** this surface is deliberately let
 * through — which is what makes Cmd/Ctrl+Enter available to submit with here.
 *
 * **Refusals are shown on the surface rather than raised as toasts.** A toast
 * appears in the corner of a page this dialog is covering, and every one of
 * these refusals is about the box somebody is typing in. They are also
 * sentences rather than be-01's codes; {@link roleRefusalSentence} is the one
 * place that translation happens.
 *
 * **Nothing here is optimistic.** Every change re-reads the project through
 * `onChanged` and the list redraws from what came back — the same rule the table
 * behind it keeps, and for the same reason: a phase list kept locally would be a
 * second answer to a question be-01 owns.
 */
export function PhasesDialog({
  roles,
  frameState,
  hiddenColumnIds,
  numberOf,
  nameOf,
  addRole,
  renameRole,
  removeRole,
  onChanged,
}: PhasesDialogProps) {
  /**
   * Whether the surface is up.
   *
   * Held here rather than by the caller, because the **trigger** is held here
   * too and the two belong together. Radix's `onCloseAutoFocus` calls
   * `preventDefault()` and then focuses `triggerRef` — so a dialog opened
   * without a {@link ModalTrigger} restores the focus to nothing at all: the
   * default restore has been cancelled and there is no trigger to put it back
   * on. The browser found it (`Escape closes it and gives the focus back to the
   * button that opened it`, `expect(locator).toBeFocused() failed`, activeElement
   * `<body>`), and the fix is to give Radix the button rather than to hand it a
   * ref of our own.
   */
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  /**
   * The names being typed over the phases' own, by role id.
   *
   * Only the ones somebody has touched: an entry that is absent means "as be-01
   * has it", so a phase renamed by somebody else redraws rather than being held
   * at the name this browser last read.
   */
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameShown = (role: RoleView): string => renamed[role.id] ?? role.name;

  /**
   * Runs one phase change, reports what refused it, and re-reads on success.
   *
   * The refusal is caught here rather than by the table's `run`: that one puts
   * be-01's code straight into a toast, which is the raw-code path this change
   * exists to close.
   */
  async function attempt(change: () => Promise<void>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await change();
      await onChanged();
    } catch (thrown: unknown) {
      setProblem(roleRefusalSentence(thrown instanceof Error ? thrown.message : 'request_failed'));
    } finally {
      setBusy(false);
    }
  }

  function submitNew(event: FormEvent): void {
    event.preventDefault();
    const clean = newName.trim();
    // Refused here rather than by be-01: the answer is the same either way and
    // this one arrives without a round trip. Trimmed rather than tested as
    // typed, because a name of spaces is what `name_required` is about.
    if (clean === '') {
      setProblem(roleRefusalSentence('name_required'));
      return;
    }
    void attempt(async () => {
      await addRole(clean);
      setNewName('');
    });
  }

  /**
   * Sends the name typed over this phase's, if it is a different one.
   *
   * Reached from Enter — the form's own submit — and from **leaving the box**,
   * which is the half that was missing. Every other text field in this product
   * commits on blur, so a rename typed and then abandoned by clicking the ✕ was
   * silently dropped: no PATCH, no toast, no mark on the field. Observed on
   * 2026-08-09, and `onOpenChange` clearing `renamed` is what made it silent.
   *
   * An empty name is a refusal rather than a no-op, on both paths: somebody who
   * cleared the box meant something by it, and a phase with no name is what
   * `name_required` is about.
   */
  function commitRename(role: RoleView): void {
    const clean = nameShown(role).trim();
    if (clean === '') {
      setProblem(roleRefusalSentence('name_required'));
      return;
    }
    if (clean === role.name) return;
    void attempt(async () => {
      await renameRole(role.id, clean);
      setRenamed((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== role.id)),
      );
    });
  }

  function submitRename(event: FormEvent, role: RoleView): void {
    event.preventDefault();
    commitRename(role);
  }

  /**
   * Asks for a removal without a cascade, which is always the first ask.
   *
   * be-01 removes a phase nothing points at outright, so a confirmation only
   * opens for one that would take something with it — asking anyway is how
   * people learn to confirm without reading.
   */
  function askToRemove(role: RoleView): void {
    void attempt(async () => {
      const outcome = await removeRole(role.id, false);
      if (outcome.ok) return;
      if (outcome.inUse === undefined) throw new Error('in_use');
      setConfirming({ role, inUse: outcome.inUse, cascade: false });
    });
  }

  function confirmRemoval(): void {
    if (confirming === null) return;
    // The whole of what the checkbox is for. Nothing is sent until it is
    // ticked, and it starts off — see the assertion in `phases-dialog.test.tsx`.
    if (!confirming.cascade) return;
    const role = confirming.role;
    void attempt(async () => {
      const outcome = await removeRole(role.id, true);
      if (!outcome.ok) throw new Error('in_use');
      setConfirming(null);
    });
  }

  /**
   * Cmd/Ctrl+Enter, which submits whatever form the keystroke was aimed at.
   *
   * The chord this surface can have at all only because `F shadcn-foundation`'s
   * second round let a command chord through to a field on a modal surface:
   * the first version of {@link usePageShortcutsSuspended} swallowed it in the
   * capture phase and this handler would never have run.
   *
   * `requestSubmit` rather than calling the handler directly, so the chord goes
   * through exactly the path Enter does — validation, the `submit` event, and
   * the one place each form's rules are written.
   */
  function onChord(event: KeyboardEvent<HTMLDivElement>): void {
    if (commandChordIn(event) !== 'next-or-create') return;
    const aimedAt = event.target;
    if (!(aimedAt instanceof HTMLElement)) return;
    const form = aimedAt.closest('form');
    if (form === null) return;
    event.preventDefault();
    form.requestSubmit();
  }

  /**
   * How wide the table would be with these phases folded.
   *
   * The phases' **real** ids, not their number: every width resolves per
   * column id, so a figure summed from stand-in ids would answer about columns
   * that do not exist while the table lays out the ones that do.
   */
  const minWidth = foldedTableMinWidth(
    roles.map((role) => role.id),
    frameState,
    hiddenColumnIds,
  );

  /** Opens and closes, and leaves nothing half-answered behind on the way out. */
  function onOpenChange(next: boolean): void {
    setOpen(next);
    // A confirmation the reader walked away from is not one they agreed to, and
    // a refusal about a box that is no longer on screen is a sentence about
    // nothing. Both go when the surface does.
    if (next) return;
    setConfirming(null);
    setProblem(null);
    setRenamed({});
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          title="Add, rename and remove the phases every work item is estimated by"
        >
          Phases
        </Button>
      </ModalTrigger>
      <ModalContent onKeyDown={onChord}>
        <ModalHeader>
          <ModalTitle>Phases</ModalTitle>
          <ModalDescription>
            The phases every work item on this plan is estimated by. Estimates and assignees follow
            them.
          </ModalDescription>
        </ModalHeader>

        {problem !== null && (
          <p role="alert" className="text-destructive text-sm">
            {problem}
          </p>
        )}

        {confirming === null ? (
          <>
            <ul className="flex flex-col gap-2">
              {roles.map((role) => (
                <li key={role.id} className="flex items-end gap-2">
                  <form
                    className="flex flex-1 flex-col gap-1"
                    onSubmit={(event) => {
                      submitRename(event, role);
                    }}
                  >
                    <Label htmlFor={`phase-${role.id}`}>{role.name}</Label>
                    <Input
                      id={`phase-${role.id}`}
                      value={nameShown(role)}
                      disabled={busy}
                      onChange={(event) => {
                        const typed = event.currentTarget.value;
                        setRenamed((current) => ({ ...current, [role.id]: typed }));
                      }}
                      onBlur={() => {
                        commitRename(role);
                      }}
                    />
                    <button type="submit" className="sr-only">
                      Rename {role.name}
                    </button>
                  </form>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      askToRemove(role);
                    }}
                  >
                    Remove {role.name}
                  </Button>
                </li>
              ))}
            </ul>

            <form className="flex items-end gap-2" onSubmit={submitNew}>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="phase-new">New phase</Label>
                <Input
                  id="phase-new"
                  value={newName}
                  disabled={busy}
                  onChange={(event) => {
                    setNewName(event.currentTarget.value);
                  }}
                />
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                Add phase
              </Button>
            </form>

            {/*
              The arithmetic, said out loud where the decision is made. Somebody
              adding a sixth phase is entitled to know what it costs before the
              table starts scrolling sideways under them, and the number is
              `table-frame.ts`'s own rather than a figure typed in here.
            */}
            {/*
              Renderer-neutral, and it has to be: this dialog opens from the
              phone's toolbar sheet too, where there is no table on screen to
              scroll and a sentence about one describes something the reader
              will never see. Both numbers are read from the modules that own
              them rather than typed in here.
            */}
            <p className="text-muted-foreground text-sm">
              {/*
                `needs` for one phase and `need` for several. {@link count}
                gets the noun right and the verb was written once, plurally,
                and never made to follow it — so a single-phase plan read
                `1 phase need ≥1123px`. Found on 2026-08-14 while measuring
                this very figure at 1280; it is the `and 1 others` defect #59
                corrected in the chart's blocking-set sentence, in the sentence
                next door. `phases-dialog.test.tsx` asserts the whole sentence
                now rather than a prefix that swept the verb up with the noun.
              */}
              {count(roles.length, 'phase')} {roles.length === 1 ? 'needs' : 'need'} ≥
              {String(minWidth)}px of width to sit side by side; a narrower window scrolls sideways,
              and under {String(CARDS_BELOW)}px wide or {String(TABLE_NEEDS_HEIGHT)}px tall the plan
              is drawn as cards instead.
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <p>{usageSentence(confirming.role.name, confirming.inUse)}</p>
            {confirming.inUse.assumedAssignees.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-sm">
                  It would also change who is assumed to be doing every phase of these:
                </p>
                <ul className="text-sm">
                  {confirming.inUse.assumedAssignees.map((flip) => (
                    <li key={flip.workItemId}>{flipSentence(flip, numberOf, nameOf)}</li>
                  ))}
                </ul>
              </div>
            )}
            <Label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={confirming.cascade}
                disabled={busy}
                onChange={(event) => {
                  const ticked = event.currentTarget.checked;
                  setConfirming((current) =>
                    current === null ? null : { ...current, cascade: ticked },
                  );
                }}
              />
              Delete them along with the phase
            </Label>
            <ModalFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Keep {confirming.role.name}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                // Off until the box is ticked, and the button says so rather
                // than the click quietly doing nothing.
                disabled={busy || !confirming.cascade}
                onClick={confirmRemoval}
              >
                Remove {confirming.role.name}
              </Button>
            </ModalFooter>
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
