import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import { type Remembered, rememberedText } from '@/lib/remembered';

import { EstimatingPanel, type EstimatingPanelProps } from './estimating-panel';
import { OptimizationSettingsPanel, type OptimizationSettingsProps } from './optimization-settings';
import { PrioritiesPanel, type PrioritiesPanelProps } from './priorities-panel';
import { StepsPanel, type StepsPanelProps } from './steps-panel';
import { TeamsPanel, type TeamsPanelProps } from './teams-panel';
import { SettingsIcon } from './toolbar-icons';

/**
 * The three things a project configures about itself, in the order the tab
 * list shows them — the order the three toolbar buttons stood in until
 * `project-config-modal` folded them into this one surface.
 */
export type SettingsSection = 'teams' | 'priorities' | 'steps' | 'estimating' | 'optimization';

const SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'teams', label: 'Teams' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'steps', label: 'Steps' },
  { id: 'estimating', label: 'Estimating' },
  { id: 'optimization', label: 'Optimization' },
];

const FIRST_SECTION: SettingsSection = 'teams';

/** Whether a value read from storage names a section this modal has. */
export function isSettingsSection(claimed: unknown): claimed is SettingsSection {
  return SECTIONS.some((section) => section.id === claimed);
}

/**
 * Where this browser remembers which section of a project's settings was last
 * open. Per project and per browser, as every other remembered plan preference
 * in `wbs-table.tsx` is — a reader who came back to adjust capacity twice lands
 * on capacity, and be-01 is never told.
 */
const sectionKey = (projectId: string): string => `wbs.projectSettingsSection.${projectId}`;

/**
 * The section this browser last left open for `projectId`, or the first one.
 *
 * The stored value is a claim, not a fact, read the way `rememberedHiddenColumns`
 * reads its key: anything that is not the id of a section this modal offers is
 * **dropped, key and all**, and the first section shown. Not the R5 throw — the
 * alternative is a settings surface that cannot be opened until somebody clears
 * storage by hand, over a preference about which tab was in front — and not a
 * default-through either, which would keep the bad value for the next read.
 *
 * Proof: the `isSettingsSection` guard replaced by an unchecked cast, and
 * `an unrecognised remembered section is dropped` failed on
 * `expect(element).toHaveAttribute("aria-selected", "true")` — a stored `7`
 * selecting no tab at all, with nothing on the surface. Watched 2026-08-30.
 */
export function rememberedSettingsSection(projectId: string): SettingsSection {
  return storedSection(projectId).readAndDrop() ?? FIRST_SECTION;
}

export function rememberSettingsSection(projectId: string, section: SettingsSection): void {
  storedSection(projectId).write(section);
}

/**
 * One project's open section, stored as **bare text** — see
 * {@link rememberedText} for why that cannot become JSON now.
 */
const storedSection = (projectId: string): Remembered<SettingsSection> =>
  rememberedText(sectionKey(projectId), isSettingsSection);

/** What each section gets from the plan, less what the modal itself supplies. */
type SectionOwn<P> = Omit<P, 'onDirtyChange' | 'onDone'>;

export interface ProjectSettingsModalProps {
  projectId: string;
  /**
   * How the control that opens this reads on the bar it sits in.
   *
   * `glyph` for the wide toolbar, where a gear says what eighteen characters
   * would and the width is the scarce resource (`design.md` D5); `labelled`
   * for the phone's `Plan actions` sheet, which lists its controls by name and
   * has the room. Both carry the same accessible name.
   */
  trigger: 'glyph' | 'labelled';
  teams: SectionOwn<TeamsPanelProps>;
  priorities: SectionOwn<PrioritiesPanelProps>;
  steps: SectionOwn<StepsPanelProps>;
  /**
   * The arithmetic the plan's days are computed with — the PERT coefficients
   * and the rounding a step's figure is charged at.
   *
   * Here rather than on the toolbar for the reason `dep-reach-whole-item` gives
   * about the reach: a project-wide statement about **how the plan is computed**
   * belongs beside the teams' capacity and the priority ladder, not on a bar
   * whose width is the scarce resource.
   */
  estimating: SectionOwn<EstimatingPanelProps>;
  /** Absent only before the first plan read or when this backend has no optimizer. */
  optimization?: SectionOwn<OptimizationSettingsProps>;
}

/**
 * One modal for everything a project configures about itself: its teams and
 * their capacity, its priority ladder, and its steps.
 *
 * Three toolbar buttons each opened a `Modal` of its own until
 * `project-config-modal` (2026-08-30). Each was a thing somebody sets once and
 * then leaves for weeks, sitting permanently beside `Add work item` and `Undo`
 * on a bar whose width is the scarce resource. The three surfaces are three
 * **panels** of this one now — moved, not rewritten: same boxes, same writes,
 * same refusals, same accessible names. What changed is who mounts them.
 *
 * **One shell, never three nested.** A modal inside a modal is two focus traps,
 * and Radix restores the focus to the inner trigger on close — inside the outer
 * modal, the thing the reader was leaving. `P phases-ui` already cost 49
 * unrelated tests when a `ModalContent` merely being *declared* suspended the
 * page's keyboard; two live shells is that fault with a second copy
 * (`design.md` D1).
 *
 * **The inactive panels stay mounted and `hidden`** (D2). Unmounting them would
 * discard a half-typed capacity when the reader glanced at the ladder — the
 * "does not take the focus or the half-typed value" fault class `AGENTS.md`
 * records from 2026-08-06. The cost is three panels' render at once; each reads
 * the plan's existing data rather than fetching its own.
 *
 * **Closing over an edit is refused, and the refusal shows where** (D3). Each
 * panel reports whether it holds an uncommitted draft or a write in flight;
 * Escape, the ✕ and a click outside all go through {@link requestClose}, which
 * refuses while any does and switches to the first section that does. Switching
 * rather than only announcing: a refusal naming a section the reader cannot see
 * is a refusal they have to go looking for.
 *
 * The trigger lives here for the reason the three dialogs each held their own:
 * Radix's `onCloseAutoFocus` cancels the default restore and focuses its
 * **trigger**, so a modal opened without a `ModalTrigger` puts the focus on
 * nothing at all — watched, `plan-cards.test.tsx`'s `closing project settings
 * puts the focus back on its trigger` failing on `expected <body …> to be
 * <button …>` with a plain `Button` in its place. It carries no
 * `data-takes-the-focus`, and that is a description rather than a guard: the
 * sheet reads that mark only off a control that closes the sheet, and a control
 * that opens a surface of its own never does (`closingControlIn`), so the
 * attribute's presence or absence here changes nothing. The distinction
 * `wbs-table.tsx` draws for `⌨` versus `Add work item` is the right one; it is
 * just not one this button is ever asked.
 */
export function ProjectSettingsModal({
  projectId,
  trigger,
  teams,
  priorities,
  steps,
  estimating,
  optimization,
}: ProjectSettingsModalProps) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<SettingsSection>(FIRST_SECTION);
  /**
   * The sections holding something a close would lose.
   *
   * A ref **and** state, deliberately. The ref is what {@link requestClose}
   * reads, because it is asked from Radix's own dismissal handlers and from a
   * panel's `Done` in the same tick as the state change that would have
   * emptied it — a read of state there is a read of the previous render. The
   * state is what renders the refusal sentence, and it follows the ref by one
   * render, which is soon enough for a sentence.
   */
  const dirtyRef = useRef(new Set<SettingsSection>());
  const [dirtySections, setDirtySections] = useState<readonly SettingsSection[]>([]);
  /**
   * Whether a close has been refused since the modal opened. The sentence it
   * earns is shown only while something is still held — see {@link holding} —
   * so a refusal whose cause has since landed says nothing stale.
   */
  const [refused, setRefused] = useState(false);

  const publishDirty = (): void => {
    setDirtySections(SECTIONS.map((s) => s.id).filter((id) => dirtyRef.current.has(id)));
  };

  /**
   * One stable reporter per section, so a panel's `useEffect` on it runs on
   * dirtiness alone. A new function per render would re-run every panel's
   * effect on every render of this modal, each reporting the same value —
   * harmless, and the kind of noise that hides a real report.
   */
  const reporterFor = useCallback(
    (section: SettingsSection) =>
      (dirty: boolean): void => {
        if (dirty) dirtyRef.current.add(section);
        else dirtyRef.current.delete(section);
        publishDirty();
      },
    // `publishDirty` closes over a setter and a ref, both stable for the life
    // of the component, so the reporters are made once.
    [],
  );
  const reporters = useMemo(
    () => ({
      teams: reporterFor('teams'),
      priorities: reporterFor('priorities'),
      steps: reporterFor('steps'),
      estimating: reporterFor('estimating'),
      optimization: reporterFor('optimization'),
    }),
    [reporterFor],
  );

  const show = useCallback(
    (section: SettingsSection): void => {
      setShown(section);
      rememberSettingsSection(projectId, section);
    },
    [projectId],
  );

  /**
   * Closes if nothing is held, or refuses and shows what is holding it.
   *
   * Every way out goes through here — Escape and the click away via Radix's
   * handlers below, the ✕ via `onOpenChange(false)`, and a panel's own `Done`,
   * `Save` or `Cancel` via {@link closeFrom}. Answers whether it closed, so a
   * Radix handler can `preventDefault()` the dismissal it would otherwise
   * perform on its own.
   *
   * Proof: the `if (first !== undefined)` refusal below deleted, so this always
   * closes, and both `an in-flight write holds the modal open and is shown` and
   * `the ✕ is refused the same way, and says which section is holding` failed
   * on `Unable to find an accessible element with the role "dialog" and name
   * "Project settings"` — the close went through over a ladder still
   * travelling and over a typed capacity. Watched 2026-08-30.
   */
  function requestClose(): boolean {
    const first = SECTIONS.map((s) => s.id).find((id) => dirtyRef.current.has(id));
    if (first !== undefined) {
      show(first);
      setRefused(true);
      return false;
    }
    setOpen(false);
    setRefused(false);
    return true;
  }

  /**
   * A panel saying it is clean and asking to close, in one call.
   *
   * The panel is believed rather than waited on: its own dirty report arrives
   * from an effect a render after the state that cleared it, and a `Done` that
   * had to be clicked twice — once to be refused by a report about the previous
   * render, once to land — would be a button that reads as broken.
   */
  function closeFrom(section: SettingsSection): void {
    dirtyRef.current.delete(section);
    publishDirty();
    requestClose();
  }

  function onOpenChange(next: boolean): void {
    if (next) {
      dirtyRef.current.clear();
      setDirtySections([]);
      setRefused(false);
      setShown(rememberedSettingsSection(projectId));
      setOpen(true);
      return;
    }
    requestClose();
  }

  /**
   * Arrow keys walk the tab list and select as they go — automatic activation,
   * which is what a screen reader expects of a section list inside a dialog.
   * Both axes, because the list is a column on a wide window and a row on a
   * narrow one, and a reader on either should not have to know which.
   */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, at: number): void {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : null;
    let next: number | null = null;
    if (step !== null) next = (at + step + SECTIONS.length) % SECTIONS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = SECTIONS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = SECTIONS.at(next);
    if (target === undefined) throw new Error(`no settings section at ${String(next)}`);
    show(target.id);
    document.getElementById(tabId(target.id))?.focus();
  }

  const holding = refused ? dirtySections[0] : undefined;
  const holdingLabel = SECTIONS.find((s) => s.id === holding)?.label;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalTrigger asChild>
        <Button
          variant="outline"
          size={trigger === 'glyph' ? 'square' : 'sm'}
          type="button"
          aria-label="Project settings"
          data-hint="Teams, priorities and steps of this project"
        >
          <SettingsIcon />
          {trigger === 'labelled' && <span>Project settings</span>}
        </Button>
      </ModalTrigger>
      <ModalContent
        className="sm:max-w-2xl"
        // Radix performs the dismissal itself unless the event is prevented, so
        // a refused close has to be said here and not only in `onOpenChange`.
        onEscapeKeyDown={(event) => {
          if (!requestClose()) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!requestClose()) event.preventDefault();
        }}
      >
        <ModalHeader>
          <ModalTitle>Project settings</ModalTitle>
          <ModalDescription>
            What this project configures about itself. Every setting here is this plan’s own.
          </ModalDescription>
        </ModalHeader>

        {holdingLabel !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {holdingLabel} has an unsaved edit. Finish it or cancel it before closing.
          </p>
        )}

        <div className="flex flex-col gap-4 sm:flex-row">
          <div
            role="tablist"
            aria-label="Project settings sections"
            className="flex gap-1 sm:w-36 sm:shrink-0 sm:flex-col"
          >
            {SECTIONS.map((section, at) => {
              const selected = shown === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  role="tab"
                  id={tabId(section.id)}
                  aria-selected={selected}
                  aria-controls={panelId(section.id)}
                  tabIndex={selected ? 0 : -1}
                  data-state={selected ? 'active' : 'inactive'}
                  className="data-[state=active]:bg-muted data-[state=inactive]:text-muted-foreground hover:bg-muted/60 rounded-md px-3 py-1.5 text-left text-sm"
                  onClick={() => {
                    show(section.id);
                  }}
                  onKeyDown={(event) => {
                    onTabKey(event, at);
                  }}
                >
                  {section.label}
                  {dirtySections.includes(section.id) && (
                    <span aria-hidden="true" data-fact="Has an unsaved edit">
                      {' '}
                      •
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex-1">
            <div
              role="tabpanel"
              id={panelId('teams')}
              aria-labelledby={tabId('teams')}
              hidden={shown !== 'teams'}
            >
              <TeamsPanel
                {...teams}
                onDirtyChange={reporters.teams}
                onDone={() => {
                  closeFrom('teams');
                }}
              />
            </div>
            <div
              role="tabpanel"
              id={panelId('priorities')}
              aria-labelledby={tabId('priorities')}
              hidden={shown !== 'priorities'}
            >
              <PrioritiesPanel
                {...priorities}
                onDirtyChange={reporters.priorities}
                onDone={() => {
                  closeFrom('priorities');
                }}
              />
            </div>
            <div
              role="tabpanel"
              id={panelId('steps')}
              aria-labelledby={tabId('steps')}
              hidden={shown !== 'steps'}
            >
              <StepsPanel {...steps} onDirtyChange={reporters.steps} />
            </div>
            <div
              role="tabpanel"
              id={panelId('estimating')}
              aria-labelledby={tabId('estimating')}
              hidden={shown !== 'estimating'}
            >
              <EstimatingPanel
                {...estimating}
                onDirtyChange={reporters.estimating}
                onDone={() => {
                  closeFrom('estimating');
                }}
              />
            </div>
            <div
              role="tabpanel"
              id={panelId('optimization')}
              aria-labelledby={tabId('optimization')}
              hidden={shown !== 'optimization'}
            >
              {optimization === undefined ? (
                <p className="text-muted-foreground text-sm">
                  Optimization settings are not available yet.
                </p>
              ) : (
                <OptimizationSettingsPanel
                  {...optimization}
                  onDirtyChange={reporters.optimization}
                />
              )}
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}

const tabId = (section: SettingsSection): string => `project-settings-tab-${section}`;
const panelId = (section: SettingsSection): string => `project-settings-panel-${section}`;
