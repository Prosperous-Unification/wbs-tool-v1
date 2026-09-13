import { Fragment, useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { usePageShortcutsSuspended } from '@/components/ui/page-shortcuts';

import {
  type AltStyle,
  altStyleOf,
  bindingsFor,
  type KeyBinding,
  showKeys,
  WHERE_ORDER,
} from './keyboard-bindings';
import type { PlanRenderer } from './plan-renderer';

export type { KeyPress } from './keyboard-bindings';
// The predicate moved to `keyboard-bindings.ts`, where `isPageShortcut` can
// reach it without a component importing a component. Re-exported because this
// is the module its callers ask, and a move is not a reason to change them.
export { opensCheatSheet } from './keyboard-bindings';

/**
 * What `navigator` says about the platform, or nothing.
 *
 * Read through `Reflect.get` rather than as a property: `navigator.platform`
 * is deprecated, absent in some runtimes and empty in others, so it is probed
 * and type-checked rather than assumed. Missing is a modeled answer here —
 * {@link altStyleOf} renders `⌥/Alt` for it — not an invariant to throw on.
 */
function navigatorSaid(field: 'platform' | 'userAgent'): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const said: unknown = Reflect.get(navigator, field);
  return typeof said === 'string' ? said : undefined;
}

export interface KeyboardCheatSheetProps {
  onClose: () => void;
  /**
   * Which renderer is drawing the plan behind this sheet.
   *
   * Required rather than defaulted, because a default is a wrong answer half
   * the time and the wrong half is the one nobody is looking at.
   */
  renderer: PlanRenderer;
  /**
   * Which keyboard the chords are labelled for. Detected from `navigator` when
   * absent; passed in by tests, which are not on the Mac they assert about.
   */
  altStyle?: AltStyle;
}

const TITLE_ID = 'keyboard-cheat-sheet-title';

/**
 * What a Tab can land on, as a selector.
 *
 * Deliberately not every element a browser might focus: the sheet's own markup
 * is a heading, a ✕ and a definition list, and the trap below only has to know
 * where the *ends* of that sequence are. `[tabindex="-1"]` is excluded because
 * the panel itself carries one — it is focusable on arrival and is not a stop
 * on the way round.
 */
const FOCUS_STOPS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The stops inside `panel`, in document order — possibly none. */
const focusStopsIn = (panel: HTMLElement): HTMLElement[] => [
  ...panel.querySelectorAll<HTMLElement>(FOCUS_STOPS),
];

/**
 * Every key binding this table has, on screen, in one modal dialog.
 *
 * Rendered only while it is open, so mounting is opening: the element that had
 * the focus is stored on mount and focused again on unmount, which is why
 * closing by Escape, by the ✕ and by clicking away all put the focus back
 * without any of them saying so.
 *
 * **The focus trap and the Escape listener are one effect, and they are one
 * fault.** "There is no focus trap; Tab leaves the dialog" was a named non-goal
 * until the UI audit of 2026-08-12 followed it one keystroke further: Escape
 * was a React handler on the backdrop, so it only ever saw a keystroke
 * aimed *inside* the sheet — and once Tab had put the focus in the table behind,
 * Escape stopped closing it. A dialog with `aria-modal="true"` that the
 * keyboard can walk out of and then cannot dismiss is not a gap in a
 * convenience, it is a reader stuck on a page they cannot get back to. The
 * listener is on `document`, in the capture step, so it answers wherever the
 * focus has got to; Tab is answered in the same place, which is what keeps the
 * focus from getting there in the first place.
 *
 * It is still not Radix. `ModalContent` would bring a trap, a dismissal
 * contract and `aria-hidden` on the page behind — and the routing matrix in
 * `openspec/changes/shadcn-foundation/design.md` decided this sheet is
 * hand-rolled, which `table-mechanics` had no reason to reverse. What it
 * changes is the behaviour, not the vendor.
 *
 * {@link usePageShortcutsSuspended} is still called below rather than only from
 * `ModalContent`: the sheet is a modal, so it holds the page's keyboard like
 * one — and until that call Ctrl+N tabbed into the table behind created a work
 * item nobody could see.
 *
 * Hand-rolled rather than Radix, and that is a decision rather than an
 * oversight — `openspec/changes/shadcn-foundation/design.md`, the routing
 * matrix. What this change gives it is the token palette and the shared rule;
 * its markup, its focus handling and every one of its tests are untouched.
 *
 * The list itself is {@link bindingsFor}'s answer and nothing else. A binding
 * written out here instead would be a second description of the keyboard, and
 * the second one is always the one that goes stale — which is also why the
 * cards renderer's sheet is a *narrower registry* rather than a filter written
 * here: {@link KeyBinding.renderers} is where "the cards answer no chords" is
 * said, once, next to the chords.
 */
export function KeyboardCheatSheet({ onClose, renderer, altStyle }: KeyboardCheatSheetProps) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const style = altStyle ?? altStyleOf(navigatorSaid('platform'), navigatorSaid('userAgent'));
  const shown = bindingsFor(renderer);
  /** The groups this renderer has anything in — `Moving rows` is empty on cards. */
  const groups: readonly [string, readonly KeyBinding[]][] = WHERE_ORDER.map((where) => [
    where,
    shown.filter((binding) => binding.where === where),
  ]);

  // Mounting is opening, so the sheet is open for exactly as long as this
  // component exists.
  usePageShortcutsSuspended(true);

  useEffect(() => {
    const had = document.activeElement;
    returnFocusTo.current = had instanceof HTMLElement ? had : null;
    const panel = dialog.current;
    // React attaches refs before effects run; a null here is not a condition
    // to model around, it is this component being wrong about itself.
    if (panel === null) throw new Error('The cheat sheet was mounted without its dialog');
    panel.focus();
    return () => {
      const back = returnFocusTo.current;
      // Still on the page: the row it belonged to may have been deleted by
      // somebody else while the sheet was open, and focusing a detached node
      // silently sends the focus to the body instead of where it was.
      // Proof: this whole cleanup removed, `takes the focus on open and gives
      // it back on close` failed with the focus on the body. Watched,
      // 2026-08-07.
      if (back?.isConnected === true) back.focus();
    };
  }, []);

  useEffect(() => {
    const answer = (event: KeyboardEvent): void => {
      const panel = dialog.current;
      // React attaches refs before effects run and this listener only exists
      // for as long as the effect does; a null here is this component being
      // wrong about itself, not a condition to model.
      if (panel === null) throw new Error('The cheat sheet took a key without its dialog');
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const stops = focusStopsIn(panel);
      const first = stops.at(0);
      const last = stops.at(-1);
      // Nothing to walk — the panel itself holds the focus rather than handing
      // it to the table. Not a state this sheet is ever in today (it has a ✕),
      // and the branch is here because "today" is what a markup change edits.
      if (first === undefined || last === undefined) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const here = document.activeElement;
      // Outside the sheet altogether: a stray click, or a browser that put the
      // focus somewhere this component did not. The next Tab brings it back.
      if (!(here instanceof HTMLElement) || !panel.contains(here)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // The two ends, and only the two ends: every Tab in between is the
      // browser's own and moves between stops inside the panel.
      const leaving = event.shiftKey ? here === first || here === panel : here === last;
      if (!leaving) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    // Capture, so the answer does not depend on what the keystroke was aimed
    // at or on whether something between it and `document` stops it bubbling.
    document.addEventListener('keydown', answer, true);
    return () => {
      document.removeEventListener('keydown', answer, true);
    };
  }, [onClose]);

  return (
    // Presentation, because it is a backdrop: the dialog inside it is the
    // thing, and Escape and the ✕ are the ways out that assistive technology
    // is told about. The click is this element's; Escape is not, and that is
    // the audit's fix — a handler here only ever saw keystrokes aimed inside
    // the sheet, so a Tab into the table behind took Escape away with it. It
    // is on `document` now, in the effect above.
    <div
      role="presentation"
      data-cheat-sheet-backdrop
      onClick={(event) => {
        // The backdrop itself, never a click that started inside the panel and
        // bubbled out — that one is a person reading, not leaving.
        // Proof: narrowed to a bare `onClose()`, `stays open when the click
        // lands inside it` failed on a sheet that closed when its own heading
        // was clicked. Watched, 2026-08-07.
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/40"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        ref={dialog}
        // Focusable without being in the tab order: the focus is put here on
        // open so the next Escape lands in this dialog rather than in the
        // table behind it.
        tabIndex={-1}
        className="bg-background text-foreground max-h-[80vh] max-w-[46em] overflow-y-auto rounded-lg border p-5 shadow-lg"
      >
        <div className="mb-3 flex items-baseline gap-3">
          <h2 id={TITLE_ID} className="text-lg font-semibold tracking-tight">
            Keyboard shortcuts
          </h2>
          <Button
            variant="ghost"
            size="square"
            type="button"
            aria-label="Close the keyboard shortcuts"
            data-hint="Close (Escape)"
            onClick={onClose}
            className="ml-auto"
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </div>
        {groups.map(([where, bindings]) =>
          bindings.length === 0 ? null : (
            <section key={where} className="mb-4 last:mb-0">
              <h3 className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
                {where}
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                {bindings.map((binding) => (
                  <Fragment key={binding.keys}>
                    <dt className="whitespace-nowrap">
                      <kbd className="bg-muted text-foreground rounded-sm border px-1.5 py-0.5 text-xs">
                        {showKeys(binding.keys, style)}
                      </kbd>
                    </dt>
                    <dd>{binding.does}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ),
        )}
      </div>
    </div>
  );
}
