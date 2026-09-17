import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What a toast is for: a failure somebody has to act on, or a fact they only
 * have to know.
 *
 * The distinction is the whole of the lifecycle rule below — an `error` waits
 * to be dismissed, an `info` leaves by itself — so it is one field rather than
 * two booleans that can disagree.
 */
export type ToastKind = 'error' | 'info';

/** One message on its way to the corner of the screen. */
export interface Toast {
  kind: ToastKind;
  text: string;
}

/**
 * How long an info toast stays before it takes itself off.
 *
 * Long enough to read a sentence, short enough that a burst does not pile up
 * behind it. Errors do not use this at all; see {@link useToasts}.
 */
export const INFO_TOAST_MS = 5000;

/**
 * How many toasts are on screen at once. The rest are counted, not shown.
 *
 * Five, not "as many as arrive": both UX reviewers killed a per-change toast
 * for being noise, and a corner filling with twenty stacked boxes is the same
 * failure arriving by a different door — it hides the table it is reporting
 * on. The ones past five are held, not dropped: dismissing a visible toast
 * brings the next one up.
 */
export const VISIBLE_TOASTS = 5;

/**
 * A toast's identity, which is what it says and how it says it.
 *
 * Two toasts with the same kind and text are the same message arriving twice
 * — a held Alt+arrow on a frozen row fires its refusal once per key repeat —
 * so identity by content is what collapses that into one line. It is also the
 * React key and the handle a dismissal names, which is why there is no
 * separate id: an id would let the same sentence exist twice.
 */
export const toastKey = (toast: Toast): string => `${toast.kind}:${toast.text}`;

/** What a component holding a toast stack has: what to render, and the two ways it changes. */
export interface ToastStackApi {
  /** Newest first. */
  toasts: readonly Toast[];
  pushToast: (toast: Toast) => void;
  /** Takes off the toast whose {@link toastKey} this is. */
  dismissToast: (key: string) => void;
}

/**
 * Holds the toasts one component has raised, and owns their lifecycle.
 *
 * Two rules, and they are the reason this is a hook rather than a `setError`:
 *
 * - **An error persists until it is dismissed.** A refused request is
 *   something the reader has to do something about, and a message that
 *   removes itself is one they can miss entirely.
 * - **An info message fades after {@link INFO_TOAST_MS}.** It is context, not
 *   a task; leaving it on screen would make the reader clear it by hand for
 *   nothing.
 *
 * Every pending fade is held in a ref keyed by {@link toastKey} and cleared
 * three ways: when the toast fades, when it is dismissed, and when the
 * component unmounts. A timer that outlives the component writes to state
 * nobody is rendering — see the unmount test, which counts pending timers
 * rather than reasoning about them.
 */
export function useToasts(): ToastStackApi {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  /** Every fade still to fire, by the key of the toast it will take off. */
  const fades = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** Forgets `key`'s pending fade, if it has one. Safe to call when it has none. */
  const cancelFade = useCallback((key: string) => {
    const pending = fades.current.get(key);
    if (pending === undefined) return;
    clearTimeout(pending);
    fades.current.delete(key);
  }, []);

  const dismissToast = useCallback(
    (key: string) => {
      cancelFade(key);
      setToasts((current) => current.filter((toast) => toastKey(toast) !== key));
    },
    [cancelFade],
  );

  const pushToast = useCallback(
    (toast: Toast) => {
      const key = toastKey(toast);
      // Newest first, and the same message arriving again is moved back to the
      // top rather than added beside itself.
      setToasts((current) => [toast, ...current.filter((held) => toastKey(held) !== key)]);
      if (toast.kind !== 'info') return;
      // Restarted, not left running: the message has just been said again, so
      // its five seconds start again.
      cancelFade(key);
      fades.current.set(
        key,
        setTimeout(() => {
          fades.current.delete(key);
          setToasts((current) => current.filter((held) => toastKey(held) !== key));
        }, INFO_TOAST_MS),
      );
    },
    [cancelFade],
  );

  useEffect(() => {
    // Read once here rather than in the cleanup: `useRef` hands back the same
    // object for the life of the component, so this is the same Map either
    // way, and the lint rule about a ref read in a cleanup is about refs that
    // are reassigned.
    const pending = fades.current;
    return () => {
      // Proof: dropped, `leaves no timer running when it unmounts` failed with
      // one timer still pending after the component was gone. Watched,
      // 2026-08-06.
      for (const fade of pending.values()) clearTimeout(fade);
      pending.clear();
    };
  }, []);

  return { toasts, pushToast, dismissToast };
}

export interface ToastStackProps {
  /** Newest first — this renders them in that order, top to bottom. */
  toasts: readonly Toast[];
  onDismiss: (key: string) => void;
}

/**
 * The corner of the screen where events say what happened.
 *
 * Bottom right, fixed, above the table: the alternative it replaces was one
 * line above the table that scrolled out of sight, was overwritten by the next
 * failure, and disappeared on the next successful action.
 *
 * Rendered even when it is empty, deliberately. A live region announces
 * changes to what it already contains; one that arrives together with its
 * first message is one a screen reader may never read out.
 *
 * `aria-live="polite"` on the container carries the info messages. An error is
 * its own `role="alert"`, which is an assertive live region on that element —
 * a refused request interrupts, a note does not.
 */
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  const shown = toasts.slice(0, VISIBLE_TOASTS);
  const collapsed = toasts.length - shown.length;
  return (
    <div
      data-toasts
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex max-w-[30em] flex-col gap-2"
    >
      {shown.map((toast) => (
        <div
          key={toastKey(toast)}
          data-toast={toast.kind}
          // Only a failure is an alert. Spread rather than `role={undefined}`
          // so an info toast carries no role attribute at all.
          {...(toast.kind === 'error' ? { role: 'alert' } : {})}
          // The kind still decides the colours, and it still decides them in
          // one place — the tokens replace `#c00` on `#fde8e8`, so a dark set
          // would re-point them rather than needing a second pair of literals.
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md',
            toast.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-foreground'
              : 'bg-popover text-popover-foreground',
          )}
        >
          <span data-toast-text>{toast.text}</span>
          {/*
            A real button, not a glyph with a click handler: this is the only
            way an error leaves the screen, so it has to be reachable by
            keyboard. The message is in the label because five stacked ✕
            buttons are otherwise indistinguishable to anyone reading them one
            at a time.
          */}
          <Button
            variant="ghost"
            size="square"
            type="button"
            aria-label={`Dismiss: ${toast.text}`}
            onClick={() => {
              onDismiss(toastKey(toast));
            }}
            className="ml-auto h-5 w-5 shrink-0"
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </div>
      ))}
      {collapsed > 0 && (
        <div data-toast-more className="text-muted-foreground text-xs">
          +{collapsed} more
        </div>
      )}
    </div>
  );
}
