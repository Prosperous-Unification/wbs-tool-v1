import { useEffect } from 'react';

import { isPageShortcut, isWindowShortcut } from '@/components/wbs/keyboard-bindings';

/**
 * What counts as being on a surface that owns the keyboard.
 *
 * `data-modal-surface` is what `ModalContent` writes; `role="dialog"` catches
 * the hand-rolled cheat sheet, which is a modal by every other measure and does
 * not go through that component. `role="menu"` is a row's ⋯ menu, which is not
 * a modal and is on this list for exactly the reason the other two are —
 * `CONTEXT.md`: it *"owns the keyboard while it is open"*, and the rule below
 * is the only place that sentence is enforced. Matched with `closest`, so a
 * control nested anywhere inside any of them answers yes.
 */
const KEYBOARD_OWNING_SURFACE = '[data-modal-surface], [role="dialog"], [role="menu"]';

/**
 * Whether this keystroke was aimed at something on an open surface.
 *
 * @param target What the keystroke was aimed at — `event.target`, not the focus.
 * @returns True when the target is a surface or sits inside one.
 */
function isOnSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEYBOARD_OWNING_SURFACE) !== null;
}

/**
 * Holds the page's own keyboard back for as long as a surface that owns the
 * keyboard is open — a modal, the cheat sheet, or a row's ⋯ menu.
 *
 * **The fault it exists for.** `?`, Cmd+Z and Cmd+Shift+Z are listened for on
 * `window` in `wbs-table.tsx` — deliberately, because the change being undone
 * could have been made from any cell, any picker or the toolbar, and there is
 * no one element to hang them on. The command chords (`Ctrl + N / D / H J K L`,
 * `Ctrl/⌘ + Enter`) are handled on the cells themselves. None of those
 * listeners knows anything about a dialog, so an open dialog left every one of
 * them live over a table nobody could see: Cmd+Z undid a change behind the
 * sheet, `?` opened the cheat sheet on top of it, and — because this app's
 * cheat sheet deliberately does not trap the focus — Tab out of the sheet and
 * Ctrl+N created a work item in the plan underneath.
 *
 * **The rule, and it is one rule.** While `isOpen`, a `keydown` listener on
 * `window` in the **capture** step ends any keystroke {@link isPageShortcut}
 * claims. Capture on `window` is the first thing to run in the whole
 * propagation, before the document, before React's root container and before
 * the bubble-step listeners the table registers on `window` — so
 * `stopImmediatePropagation` there is what makes "the page's shortcuts are off"
 * true rather than a claim about listener registration order.
 *
 * **The rule asks a different question on each side of the surface**, and this
 * is the correction both reviews asked for. A command chord is not on the
 * window: `Ctrl + N / D / H J K L` and `Ctrl/⌘ + Enter` are React handlers on
 * the **cells**, so they can only fire for a keystroke whose target is a cell —
 * and no cell is an ancestor of a portal.
 *
 * - **Target outside the surface**: {@link isPageShortcut}, the whole family.
 *   That is the table's cells, its toolbar, and the page behind the dialog.
 * - **Target on the surface**: {@link isWindowShortcut} only. The chords are
 *   let through, because nothing of the page's could have acted on them and the
 *   modal's own field is entitled to them — `P phases-ui`'s dialog wants
 *   Cmd+Enter for its submit, and the first version of this hook made that
 *   impossible. Probed live: `Ctrl+H` and `Ctrl+Enter` on an input inside an
 *   open modal were both swallowed.
 *
 * **A row's ⋯ menu is one of these surfaces too**, since 2026-08-09. Cmd+Z
 * fired while a menu was open — observed live, twice, with `[role="menu"]`
 * asserted in the DOM at the moment of the keypress — and undid a rename behind
 * a menu the reader was reading, while the same chord over an open dialog was
 * correctly inert. `ActionsMenu` calls this hook with its own `open`, so the
 * menu falls under the rule already written here rather than under a second
 * one: the window shortcuts are held back and the chords are let through to the
 * items, which is what `every chord is inert while a row’s ⋯ menu is open`
 * already proves the menu itself does with them.
 *
 * **What the chord half of that is *not* proof against, stated because it was
 * the reason for choosing it and turned out not to be.** The guess was that
 * swallowing the chord would take `ActionsMenu`'s own `preventDefault` away and
 * hand Chrome back R5's fourteenth fault — a `<button>` clicking itself from a
 * modified Enter. Probed on 2026-08-09 with this rule deliberately widened to
 * `isPageShortcut` on both sides: `a modified Enter or Space on a menu item
 * takes nothing` (`e2e/keyboard.spec.ts`, real Chromium) **still passed**,
 * because the only modified Enter this predicate claims is Ctrl/⌘+Enter and
 * Chrome synthesizes no click for that one — Shift+Enter, which does, is not a
 * command chord and was never swallowed. So the on-surface half is the modal's
 * rule applied consistently, not a guard with a failure anybody has watched.
 *
 * **Not "let everything on the surface through", which was the obvious form and
 * is wrong.** `?` and Cmd+Z are on the window, so they fire for a keystroke
 * aimed at the dialog's own ✕ as readily as at a cell — and a dialog whose
 * Cancel button undoes a change in the plan behind it is the fault this hook
 * exists for, wearing a hat. `opensCheatSheet` and `undoChord` already refuse a
 * target somebody is typing into, so a text box on the surface keeps both.
 *
 * **What it deliberately does not do.**
 *
 * - No `preventDefault`. The browser's own Cmd+Z inside a text box is better
 *   than anything this app could offer for a half-typed word, and it is never
 *   claimed here in the first place.
 * - Nothing about Escape, Tab or the arrows. Those belong to whichever modal is
 *   open — Radix dismisses and traps on them — and a rule that swallowed them
 *   would take the ways out of the dialog with it.
 * - No count of open modals. Two of them register two listeners and each stops
 *   the same keystroke; stopping an already-stopped event is not a thing that
 *   can go wrong.
 *
 * Proof: the `window.addEventListener` line commented out, all four holding
 * tests in `page-shortcuts.test.tsx` failed — the cheat sheet opening over an
 * open modal, `api.undo` called once, `api.create` called once, and the cheat
 * sheet failing to hold Cmd+Z back. And with `isWindowShortcut` above widened
 * back to `isPageShortcut`, `lets a command chord reach a field on the surface`
 * failed on `expected [] to deeply equal [ 'Enter', 'h' ]`. Watched 2026-08-09,
 * quoted in `openspec/changes/shadcn-foundation/verify.md`.
 *
 * @param isOpen Whether the surface asking is on screen right now.
 */
export function usePageShortcutsSuspended(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return undefined;
    const swallow = (event: KeyboardEvent) => {
      const claimed = isOnSurface(event.target)
        ? isWindowShortcut(event, event.target)
        : isPageShortcut(event, event.target);
      if (!claimed) return;
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
    };
  }, [isOpen]);
}
