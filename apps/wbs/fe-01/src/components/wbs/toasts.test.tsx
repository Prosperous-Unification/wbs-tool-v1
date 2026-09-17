import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INFO_TOAST_MS, type Toast, ToastStack, type ToastStackApi, useToasts } from './toasts';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/**
 * The live api of the rendered stack, so a test can push a message without a
 * button per message.
 *
 * Written during render on purpose: `pushToast` is what the table calls from
 * an event handler, and reading it out of an effect would test a copy that is
 * one render stale.
 */
const held: { api: ToastStackApi | null } = { api: null };

function Harness() {
  const api = useToasts();
  held.api = api;
  return <ToastStack toasts={api.toasts} onDismiss={api.dismissToast} />;
}

/** Pushes through the rendered hook, inside `act` the way a click would be. */
const push = (toast: Toast): void => {
  const api = held.api;
  if (api === null) throw new Error('nothing is rendered to push a toast into');
  act(() => {
    api.pushToast(toast);
  });
};

/** What the stack is showing, newest first, without the ✕ glyphs. */
const shown = (): string[] =>
  [...document.querySelectorAll('[data-toast]')].map((node) => {
    const text = node.querySelector('[data-toast-text]')?.textContent;
    // Thrown rather than defaulted: a toast without its text node means the
    // markup changed, and an empty string here would quietly pass an ordering
    // assertion that is no longer looking at anything.
    if (text == null) throw new Error('a toast has no text');
    return text;
  });

/** The `+N more` line, or null when nothing is being collapsed. */
const moreLine = (): string | null =>
  document.querySelector('[data-toast-more]')?.textContent ?? null;

afterEach(() => {
  cleanup();
  held.api = null;
  vi.useRealTimers();
});

describe('the toast stack', () => {
  itDom('keeps an error until somebody takes it off', () => {
    // codex's requirement, and the reason this is not a fading banner: a
    // request that was refused is a thing the reader has to act on, and a
    // message that leaves on its own is one they can miss entirely.
    vi.useFakeTimers();
    render(<Harness />);

    push({ kind: 'error', text: 'rename failed: forbidden' });
    act(() => {
      vi.advanceTimersByTime(INFO_TOAST_MS * 20);
    });

    expect(shown()).toEqual(['rename failed: forbidden']);
    expect(screen.getByRole('alert').textContent).toContain('forbidden');
  });

  itDom('lets an info message take itself off', () => {
    vi.useFakeTimers();
    render(<Harness />);

    push({ kind: 'info', text: 'The table changed while you were dragging' });
    act(() => {
      vi.advanceTimersByTime(INFO_TOAST_MS - 1);
    });
    expect(shown()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toEqual([]);
  });

  itDom('does not shout an info message as an alert', () => {
    // The container is the polite live region; only a failure is an alert.
    render(<Harness />);

    push({ kind: 'info', text: 'nothing was lost' });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(shown()).toEqual(['nothing was lost']);
  });

  itDom('takes a toast off when its ✕ is pressed', () => {
    render(<Harness />);

    push({ kind: 'error', text: 'move failed: frozen' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: move failed: frozen' }));

    expect(shown()).toEqual([]);
  });

  itDom('stacks the newest on top and counts the ones past five', () => {
    render(<Harness />);

    for (const n of [1, 2, 3, 4, 5, 6, 7]) push({ kind: 'error', text: `failure ${String(n)}` });

    expect(shown()).toEqual(['failure 7', 'failure 6', 'failure 5', 'failure 4', 'failure 3']);
    expect(moreLine()).toBe('+2 more');
  });

  itDom('brings an older one back when a visible one is dismissed', () => {
    // The collapsed ones are held, not dropped: a refusal nobody has read yet
    // is not noise to throw away because five more arrived after it.
    render(<Harness />);

    for (const n of [1, 2, 3, 4, 5, 6]) push({ kind: 'error', text: `failure ${String(n)}` });
    expect(moreLine()).toBe('+1 more');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: failure 6' }));

    expect(shown()).toEqual(['failure 5', 'failure 4', 'failure 3', 'failure 2', 'failure 1']);
    expect(moreLine()).toBeNull();
  });

  itDom('collapses the same message repeated into one, at the top', () => {
    // A held Alt+arrow on a frozen row fires the same refusal per repeat.
    // Five identical lines say nothing the first one did not.
    render(<Harness />);

    push({ kind: 'error', text: 'frozen' });
    push({ kind: 'error', text: 'forbidden' });
    push({ kind: 'error', text: 'frozen' });

    expect(shown()).toEqual(['frozen', 'forbidden']);
  });

  itDom('restarts the fade when the same info message arrives again', () => {
    vi.useFakeTimers();
    render(<Harness />);

    push({ kind: 'info', text: 'try again' });
    act(() => {
      vi.advanceTimersByTime(INFO_TOAST_MS - 100);
    });
    push({ kind: 'info', text: 'try again' });

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(shown()).toEqual(['try again']);

    act(() => {
      vi.advanceTimersByTime(INFO_TOAST_MS);
    });
    expect(shown()).toEqual([]);
  });

  itDom('leaves no timer running when it unmounts', () => {
    // The leak this catches is a `setTimeout` whose callback outlives the
    // component and writes to state nobody is rendering. Counted rather than
    // reasoned about: `getTimerCount` is the only thing that can see a pending
    // timer that nothing will clear.
    vi.useFakeTimers();
    const view = render(<Harness />);
    const before = vi.getTimerCount();

    push({ kind: 'info', text: 'a fade is pending' });
    expect(vi.getTimerCount()).toBe(before + 1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(before);
    // And nothing fires late: advancing past the fade must reach no callback.
    act(() => {
      vi.advanceTimersByTime(INFO_TOAST_MS * 2);
    });
    expect(vi.getTimerCount()).toBe(before);
  });

  itDom('drops a dismissed info message’s timer with it', () => {
    vi.useFakeTimers();
    render(<Harness />);

    push({ kind: 'info', text: 'dismissed early' });
    const pending = vi.getTimerCount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: dismissed early' }));

    expect(vi.getTimerCount()).toBe(pending - 1);
  });

  itDom('is a live region before anything is in it', () => {
    // A live region announces changes to what it already contains. One that
    // arrives with its first message is one a screen reader may never read.
    render(<Harness />);

    const region = document.querySelector('[data-toasts]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });
});
