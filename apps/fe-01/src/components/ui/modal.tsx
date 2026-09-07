import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import { usePageShortcutsSuspended } from './page-shortcuts';

/**
 * Where a modal surface is anchored, which is the whole difference between what
 * the shadcn registry ships as two components.
 *
 * `centre` is its dialog and the three edges are its sheet. They are one
 * component here because they are one Radix primitive with one dismissal
 * contract, one focus trap and — the reason this change exists — one rule about
 * the page's keyboard. Vendored as two files, that rule would have been written
 * twice, and the second copy is the one that goes stale.
 */
export type ModalSide = 'centre' | 'right' | 'left' | 'bottom';

const SIDE_CLS: Record<ModalSide, string> = {
  centre:
    'left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-lg',
  right: 'inset-y-0 right-0 h-full w-3/4 max-w-sm border-l shadow-lg sm:max-w-md',
  left: 'inset-y-0 left-0 h-full w-3/4 max-w-sm border-r shadow-lg sm:max-w-md',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t shadow-lg',
};

/** The modal itself: open state, dismissal, and the portal its surface lands in. */
export const Modal = DialogPrimitive.Root;
/** A control that opens the modal it is inside, without the caller holding state. */
export const ModalTrigger = DialogPrimitive.Trigger;
/** A control that closes the modal it is inside — the ✕, and any Cancel button. */
export const ModalClose = DialogPrimitive.Close;

/**
 * The dimmed page behind the surface.
 *
 * Exported because `ModalContent` is not the only shape a modal will ever need
 * — `M mobile-cards` puts a toolbar in a bottom sheet with its own padding —
 * and because a caller assembling its own portal still has to get the overlay
 * right.
 */
export const ModalOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function ModalOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-black/40', className)}
      {...props}
    />
  );
});

export interface ModalContentProps extends ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  side?: ModalSide;
  /**
   * Whether the surface draws its own ✕ in the top right.
   *
   * On by default: Radix gives a modal Escape and a click away, and neither is
   * discoverable by someone reading the screen rather than remembering it.
   * Off for a surface that puts its own dismissal somewhere else — a confirm
   * with Cancel and Delete has two ✕s otherwise, and they mean different things.
   */
  closeButton?: boolean;
  children: ReactNode;
}

/**
 * Holds the page's keyboard back for as long as **this** is mounted, which is
 * for as long as the surface around it is on screen.
 *
 * It exists because "mounted" and "open" turned out not to be the same fact.
 * {@link ModalContent} is an ordinary child of {@link Modal}, so React runs its
 * body on every render of whatever holds it, open or shut — Radix's `Presence`
 * decides what the *portal* renders, not whether this component function was
 * called. So a hook called in `ModalContent`'s own body registered its capture
 * listener the moment the dialog was declared and never took it off, and every
 * page shortcut on the page went dead while the dialog was closed.
 *
 * Rendering it as a child of `DialogPrimitive.Content` puts it inside what the
 * portal mounts and unmounts, which is the thing that really tracks "open".
 *
 * Proof: found by the first production caller rather than by reasoning. With
 * `usePageShortcutsSuspended(true)` in `ModalContent`'s body and a closed
 * `StepsDialog` mounted in `WbsTable` — that surface is `ProjectSettingsModal`'s
 * steps section since `project-config-modal` — **49 tests** in `wbs-table.test.tsx`
 * failed — `outdents with shift-tab` on `expected [ '010' ] to deeply equal
 * [ '010', '020' ]`, because Ctrl+N was being swallowed by a dialog nobody had
 * opened. Watched 2026-08-09, and pinned since by `holds nothing back while the
 * modal is closed` in `page-shortcuts.test.tsx`.
 */
function PageShortcutsHeld(): null {
  usePageShortcutsSuspended(true);
  return null;
}

/**
 * A modal surface, and the one place the page's keyboard is held back.
 *
 * Radix owns everything that is about this dialog: the focus trap, the return
 * of the focus on close, `role="dialog"` with `aria-modal`, Escape, the click
 * away, and `aria-hidden` on the page behind. What Radix cannot know about is
 * this app's **page-level** keyboard — `?` and Cmd+Z are listened for on
 * `window`, and the command chords on the cells — so an open dialog left every
 * one of them live over a table nobody could see. {@link usePageShortcutsSuspended}
 * is that rule, and it is hung on {@link PageShortcutsHeld} **inside** the
 * portal rather than called from this body. That is not tidiness: this body runs
 * whenever its caller renders, open or shut, and only what the portal mounts
 * tracks "open". There is still no flag to keep in step — the mount is the flag,
 * it is just a different mount than the first version of this file assumed.
 *
 * The dialog needs a {@link ModalTitle} — Radix warns without one, and a modal
 * with no accessible name is one a screen reader announces as "dialog".
 */
export const ModalContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(function ModalContent(
  { className, side = 'centre', closeButton = true, children, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <ModalOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-modal-surface={side}
        className={cn(
          'bg-background text-foreground fixed z-50 flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-6',
          SIDE_CLS[side],
          className,
        )}
        {...props}
      >
        <PageShortcutsHeld />
        {children}
        {closeButton && (
          <DialogPrimitive.Close
            className="ring-offset-background focus-visible:ring-ring absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            // The word rather than a glyph: `✕` is announced as "multiplication
            // sign" or as nothing at all, depending on the reader.
            aria-label="Close"
          >
            <span aria-hidden="true">✕</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

/** The surface's own heading block — title, and the sentence under it. */
export function ModalHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

/** Where a surface's actions sit: right-aligned on a wide screen, stacked on a narrow one. */
export function ModalFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

/** The modal's accessible name, wired to `aria-labelledby` by Radix. */
export const ModalTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function ModalTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-lg leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  );
});

/** The modal's `aria-describedby` sentence — what this surface is for. */
export const ModalDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function ModalDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
});
