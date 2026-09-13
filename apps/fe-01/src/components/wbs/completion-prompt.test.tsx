import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompletionPrompt, type CompletionPromptProps } from './completion-prompt';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

function prompt(overrides: Partial<CompletionPromptProps> = {}) {
  const onConfirm = vi.fn<(day: string) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <CompletionPrompt
      number="010"
      heldFactEnd={null}
      today="2026-09-13"
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      onClosed={() => undefined}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange };
}

const field = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Finished on');
/** The form the field submits — Enter's path, which the disabled button cannot block. */
function form(): HTMLFormElement {
  const found = field().closest('form');
  if (found === null) throw new Error('the day field is outside its form');
  return found;
}
const markDone = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Mark done' });

describe('the completion prompt', () => {
  itDom('offers today when the row holds no fact end, with the focus in the field', () => {
    prompt();

    expect(screen.getByRole('dialog', { name: 'Mark 010 done' })).toBeInTheDocument();
    expect(field().value).toBe('2026-09-13');
    expect(document.activeElement).toBe(field());
  });

  itDom('offers the held fact end, and says so', () => {
    prompt({ heldFactEnd: '2026-09-10' });

    expect(field().value).toBe('2026-09-10');
    expect(screen.getByRole('dialog').textContent).toContain('It already holds 10 Sep');
  });

  itDom('confirms the day in the field once, on the button and on Enter', () => {
    const { onConfirm } = prompt();

    fireEvent.change(field(), { target: { value: '2026-09-11' } });
    fireEvent.click(markDone());

    expect(onConfirm.mock.calls).toEqual([['2026-09-11']]);

    fireEvent.change(field(), { target: { value: '2026-09-12' } });
    fireEvent.submit(form());
    expect(onConfirm.mock.calls).toEqual([['2026-09-11'], ['2026-09-12']]);
  });

  itDom('holds Mark done back while the day is not a date', () => {
    const { onConfirm } = prompt();

    fireEvent.change(field(), { target: { value: '' } });

    expect(markDone().disabled).toBe(true);
    // A submit forced past the disabled button — Enter in the field — is
    // refused by the same rule, so `on` can never be `''`.
    fireEvent.submit(form());
    expect(onConfirm.mock.calls).toEqual([]);
  });

  itDom('Cancel and Escape dismiss it and confirm nothing', () => {
    const { onConfirm, onOpenChange } = prompt();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
