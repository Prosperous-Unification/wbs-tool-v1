import { type ReactNode, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalTrigger } from '@/components/ui/modal';

/**
 * The control on the toolbar sheet a click was on, if that click closes it.
 *
 * Taking a control on the sheet is taking it on the plan behind the sheet, and
 * the plan is what wants looking at next — a phone screen is 390px and the
 * sheet is most of it. So a click on one of the sheet's own controls closes it.
 *
 * The control itself rather than a yes/no, because the caller has a second
 * question for it: {@link TAKES_THE_FOCUS} says whether that control moves the
 * focus itself, and the answer decides whether Radix's own restore is allowed
 * to happen.
 *
 * Two exemptions, and each is a fault this was written after meeting:
 *
 * - **A control that opens a surface of its own.** `ProjectSettingsModal`'s
 *   trigger is on this sheet, and closing the sheet unmounts the modal it was
 *   about to open. Radix marks such a trigger `aria-haspopup="dialog"`, which
 *   is the question asked here.
 * - **A click on another surface entirely.** React sends a portal's events up
 *   the **React** tree, so every click inside that steps dialog arrives here
 *   even though the modal is nowhere near this element in the DOM — and would
 *   close the sheet under it, mid-click, on the way to adding a step.
 * - **A click inside a disclosure the sheet is *hosting*.** The saved-plan
 *   shelf is on this sheet at a phone width, and its panel is a surface of its
 *   own that opens *in place*: reading a plan's history, picking a checkpoint
 *   and asking what changed since it are all clicks on `<button>`s inside this
 *   sheet, and every one of them would close the sheet the panel is drawn in.
 *   That is not the rule's case — taking one of these does not act on the plan
 *   behind the sheet, so there is nothing behind the sheet to go back to.
 *   Marked by the shelf's own `data-saved-plans`, for the reason
 *   {@link TAKES_THE_FOCUS} is a DOM attribute: the thing that knows lives with
 *   the thing it is about, and a list of labels here would go stale.
 *
 * @param target What was clicked — `event.target`, not the handler's element.
 * @param surface The sheet's own surface, which is `event.currentTarget`.
 */
function closingControlIn(target: EventTarget | null, surface: Element): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-modal-surface]') !== surface) return null;
  if (target.closest('[data-saved-plans]') !== null) return null;
  const control = target.closest('button');
  if (control?.getAttribute('aria-haspopup') !== null) return null;
  return control;
}

/**
 * The mark a toolbar control wears when taking it puts the focus somewhere of
 * its own choosing, so the sheet must not put it back on the trigger.
 *
 * Three controls wear it, and no others:
 *
 * - **`Add work item`**, which asks for the caret in the new row's name.
 * - **The readiness badge**, which walks to the cell estimating the next gap.
 * - **`Keyboard shortcuts`**, which opens the cheat sheet — a dialog that
 *   focuses its own panel on mount and restores on unmount. Radix's restore
 *   lands on a timer, so it arrives *after* that and takes the focus off a
 *   dialog that is still open; measured in jsdom, where the panel had the focus
 *   with the restore refused and the `Plan actions` trigger had it without.
 *
 * Every other control on the sheet — `Collapse all`, `Gantt`, `Undo`, the
 * exports — changes the plan without aiming the caret anywhere, and for those
 * Radix restoring the focus to the `Plan actions` trigger is the right answer
 * rather than a thing to suppress. Suppressing it left them on `<body>`.
 *
 * Not `data-lands-in-plan`, which is what the first two do and what the review
 * asked for: the cheat sheet lands in a dialog instead, and a name that
 * described two of the three would be a name the third is filed under wrongly.
 *
 * A DOM attribute rather than a list of labels here: the control that knows it
 * moves the focus is the control that says so, and a list would go stale the
 * next time one is added. See {@link closingControlIn} for who reads it.
 */
export const TAKES_THE_FOCUS = 'data-takes-the-focus';

/**
 * The phone's `Plan actions` sheet: the whole toolbar, folded behind one
 * button, with the open state **its own**.
 *
 * 1245px of controls above a 390px screen is a page of buttons with the plan
 * somewhere under them, so on a phone the toolbar folds rather than wraps.
 *
 * **Why this is a component at all**, since 2026-09-02: `open` was a `useState`
 * in `WbsTable`, so tapping `Plan actions` re-rendered the plan behind the
 * sheet — and a card's render runs the estimate trio per step plus its slack,
 * its mismatches, three label reads and a span read. Opening a sheet is not a
 * change to the plan and must not cost one. The controls arrive as
 * {@link PlanToolbarSheetProps.children}, so they are built by the table's own
 * render and this component's re-render reuses that element tree untouched.
 *
 * It also **replaces an effect**: `WbsTable` closed the sheet on every renderer
 * change, because a window dragged wide with the sheet open would otherwise
 * leave a modal over a table whose toolbar is already in a row of its own.
 * Only the cards renderer mounts this, so a widened window unmounts the sheet
 * and there is nothing left to close.
 */
export interface PlanToolbarSheetProps {
  /** The toolbar's controls, exactly as the wide face lays them out. */
  children: ReactNode;
}

export function PlanToolbarSheet({ children }: PlanToolbarSheetProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * Whether the control that closed the sheet aims the caret itself — the
   * {@link TAKES_THE_FOCUS} mark, read off the control that was clicked.
   *
   * False for every other way out, and that includes the rest of the toolbar:
   * Escape, the ✕, a tap outside, and `Collapse all`, `Gantt`, `Undo` and the
   * exports, none of which ask for the focus anywhere. Only the three that do
   * may refuse Radix's restore, because refusing it for the others drops the
   * focus on `<body>` — nothing to type into and nothing to Tab from.
   *
   * A ref because nothing renders it, and because it is read from Radix's own
   * close handler one turn of the event loop after the click that set it.
   */
  const controlTakesTheFocus = useRef(false);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      {/*
        The trigger belongs to the modal rather than sitting beside it, for
        `ProjectSettingsModal`'s reason: Radix restores the focus to its trigger
        on close, and to nothing at all without one.
      */}
      <ModalTrigger asChild>
        <Button variant="outline" type="button" className="min-h-11">
          Plan actions
        </Button>
      </ModalTrigger>
      <ModalContent
        side="bottom"
        // Taking a control on this sheet is taking it on the plan behind it,
        // and the plan is what wants looking at next.
        //
        // **The bubble step, and that is load-bearing.** As `onClickCapture`
        // this closed the sheet *before* the control's own handler ran, and in
        // a real browser that means the handler never ran at all: React
        // registers one capture listener and one bubble listener per container,
        // a discrete update flushes between them, and the button is unmounted
        // by the time the bubble dispatch walks the fiber tree looking for
        // handlers. So every toolbar control on the sheet did nothing — no
        // request, no work item. jsdom passed all sixteen card tests through
        // it, because `Add work item`'s own `onClick` had already been
        // collected there.
        //
        // Found by a browser at 390×844, 2026-08-09: `POST
        // /api/projects/…/work-items` simply absent from the network log after
        // a click that closed the sheet.
        onClick={(event) => {
          const control = closingControlIn(event.target, event.currentTarget);
          if (control === null) return;
          // Assigned, never set: the flag outlives the click that wrote it, so
          // a `Collapse all` after an `Add work item` would read the create's
          // `true` and suppress a restore nothing had asked for. Every close
          // writes its own answer.
          controlTakesTheFocus.current = control.hasAttribute(TAKES_THE_FOCUS);
          setOpen(false);
        }}
        // Radix restores the focus to the trigger when a modal closes, and it
        // does it on a timer — so it lands *after* the refetch a control on
        // this sheet started, and takes the caret back off the work item that
        // control created. Refused for the three controls that aim the caret
        // themselves, and for nothing else: a sheet closed by Escape, by the ✕,
        // by a tap outside or by any of the other dozen controls has aimed the
        // caret nowhere, and the trigger is exactly where the focus belongs.
        //
        // Proof: this handler removed, `lands the focus in the card of a work
        // item it just created` failed on `expected <button …> to be <textarea
        // …>` — Radix's restore arriving last. Watched, 2026-08-09.
        //
        // Proof of the other half — the flag pinned back to an unconditional
        // `true`, which is what shipped: `gives the focus back to the trigger
        // when the control aimed the caret nowhere` failed on `expected <body>
        // to be <button …>`. Watched in jsdom and in Chromium at 390×844
        // (`e2e/mobile.spec.ts`), 2026-08-09.
        onCloseAutoFocus={(event) => {
          if (!controlTakesTheFocus.current) return;
          controlTakesTheFocus.current = false;
          event.preventDefault();
        }}
      >
        <ModalHeader>
          <ModalTitle>Plan actions</ModalTitle>
        </ModalHeader>
        {children}
      </ModalContent>
    </Modal>
  );
}
