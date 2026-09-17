import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CompletionPrompt,
  type CompletionPromptProps,
  dayNote,
  defaultFactEnd,
  defaultFactStart,
} from './completion-prompt';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const FORECAST = { startsOn: '2026-09-01', endsOn: '2026-09-10' };

function prompt(overrides: Partial<CompletionPromptProps> = {}) {
  const onConfirm = vi.fn<(started: string, finished: string) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <CompletionPrompt
      number="010"
      heldFactStart={null}
      heldFactEnd={null}
      forecast={null}
      today="2026-09-13"
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      onClosed={() => undefined}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange };
}

const started = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Started on');
const finished = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Finished on');
const noteOf = (which: 'started' | 'finished'): string | null =>
  document.querySelector(`[data-day-note="${which}"]`)?.textContent ?? null;
const markDone = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Set to Done' });
/** The form the fields submit — Enter's path, which the disabled button cannot block. */
function form(): HTMLFormElement {
  const found = started().closest('form');
  if (found === null) throw new Error('the day fields are outside their form');
  return found;
}

describe('what the two fields open with', () => {
  it('starts on the forecast start, or today with no forecast, or the held day', () => {
    expect(defaultFactStart(null, FORECAST, '2026-09-13')).toBe('2026-09-01');
    expect(defaultFactStart(null, null, '2026-09-13')).toBe('2026-09-13');
    expect(defaultFactStart('2026-09-03', FORECAST, '2026-09-13')).toBe('2026-09-03');
  });

  it('finishes today while the forecast end is ahead, on the forecast end once it is behind', () => {
    // Proof: the `today > forecast.endsOn` arm dropped, and this fails on
    // `expected '2026-09-13' to be '2026-09-10'`; watched 2026-09-13.
    expect(defaultFactEnd(null, FORECAST, '2026-09-13')).toBe('2026-09-10');
    expect(defaultFactEnd(null, FORECAST, '2026-09-05')).toBe('2026-09-05');
    expect(defaultFactEnd(null, null, '2026-09-13')).toBe('2026-09-13');
    expect(defaultFactEnd('2026-09-08', FORECAST, '2026-09-13')).toBe('2026-09-08');
  });

  it('says what each day is, off the value and not the default', () => {
    expect(dayNote('2026-09-01', null, '2026-09-01', '2026-09-13', 'start')).toBe(
      'Same as the forecast start.',
    );
    expect(dayNote('2026-09-13', null, '2026-09-01', '2026-09-13', 'start')).toBe('Today.');
    expect(dayNote('2026-09-03', '2026-09-03', '2026-09-01', '2026-09-13', 'start')).toBe(
      'The day already recorded on this row.',
    );
    expect(dayNote('2026-09-07', null, '2026-09-01', '2026-09-13', 'end')).toBe('A day you typed.');
    expect(dayNote('', null, null, '2026-09-13', 'end')).toBe('Not a calendar day yet.');
  });
});

describe('the completion prompt', () => {
  itDom(
    'offers the forecast start and today, says so, and puts the focus in the start field',
    () => {
      prompt({ forecast: { startsOn: '2026-09-01', endsOn: '2026-09-20' } });

      expect(screen.getByRole('dialog', { name: 'Set 010 to Done' })).toBeInTheDocument();
      expect(started().value).toBe('2026-09-01');
      expect(finished().value).toBe('2026-09-13');
      expect(noteOf('started')).toBe('Same as the forecast start.');
      expect(noteOf('finished')).toBe('Today.');
      expect(document.activeElement).toBe(started());
    },
  );

  itDom('offers the forecast end once today is past it, and says so', () => {
    prompt({ forecast: FORECAST });

    expect(finished().value).toBe('2026-09-10');
    expect(noteOf('finished')).toBe('Same as the forecast end.');
  });

  itDom('offers the held days and says they are recorded', () => {
    prompt({ heldFactStart: '2026-09-02', heldFactEnd: '2026-09-09', forecast: FORECAST });

    expect(started().value).toBe('2026-09-02');
    expect(finished().value).toBe('2026-09-09');
    expect(noteOf('started')).toBe('The day already recorded on this row.');
    expect(noteOf('finished')).toBe('The day already recorded on this row.');
  });

  itDom(
    'confirms both days once, on the button and on Enter, with the notes following a change',
    () => {
      const { onConfirm } = prompt({ forecast: FORECAST });

      fireEvent.change(finished(), { target: { value: '2026-09-11' } });
      expect(noteOf('finished')).toBe('A day you typed.');
      fireEvent.click(markDone());

      expect(onConfirm.mock.calls).toEqual([['2026-09-01', '2026-09-11']]);

      fireEvent.change(started(), { target: { value: '2026-09-02' } });
      fireEvent.submit(form());
      expect(onConfirm.mock.calls).toEqual([
        ['2026-09-01', '2026-09-11'],
        ['2026-09-02', '2026-09-11'],
      ]);
    },
  );

  itDom('holds Mark done back while a day is not a date', () => {
    const { onConfirm } = prompt();

    fireEvent.change(started(), { target: { value: '' } });

    expect(markDone().disabled).toBe(true);
    expect(noteOf('started')).toBe('Not a calendar day yet.');
    // A submit forced past the disabled button — Enter in a field — is
    // refused by the same rule, so neither day can be `''`.
    fireEvent.submit(form());
    expect(onConfirm.mock.calls).toEqual([]);
  });

  itDom('Cancel and Escape dismiss it and confirm nothing', () => {
    const { onConfirm, onOpenChange } = prompt();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(started(), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
