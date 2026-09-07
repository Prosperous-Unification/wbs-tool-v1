import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EstimateRoundingView, PertWeightsView } from '@/lib/wbs-api';

import { EstimatingPanel, weightsOfDraft } from './estimating-panel';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const DEFAULT_WEIGHTS: PertWeightsView = { optimistic: 1, realistic: 4, pessimistic: 1 };

/**
 * Everything the panel is given, with each call recorded.
 *
 * Rendered bare, without the modal around it — `priorities-panel.test.tsx`'s
 * arrangement, and for its reason: the shell's own rules are the modal's tests,
 * and what is asserted here is the two contracts this panel keeps with it.
 */
/** What the panel reports through `setArithmetic`, named so the spy can be typed. */
interface Arithmetic {
  pertWeights?: PertWeightsView;
  estimateRounding?: EstimateRoundingView;
}

/**
 * The `setArithmetic` prop as a spy.
 *
 * Named because the option and the default have to be the **same** type: typed
 * `ReturnType<typeof vi.fn>` the option was `Mock<any[], unknown>`, whose union
 * with the default is assignable to neither the prop nor `.mock.calls`.
 */
type SetArithmetic = Mock<(arithmetic: Arithmetic) => Promise<void>>;

function stubbed(
  over: {
    method?: 'pert' | 'optimistic' | 'realistic' | 'pessimistic';
    pertWeights?: PertWeightsView;
    estimateRounding?: EstimateRoundingView;
    setArithmetic?: SetArithmetic;
  } = {},
) {
  const setArithmetic =
    over.setArithmetic ??
    vi.fn<(arithmetic: Arithmetic) => Promise<void>>(async () => {
      await Promise.resolve();
    });
  const onChanged = vi.fn(async () => {
    await Promise.resolve();
  });
  // Typed, and not decoration: an untyped `vi.fn` records its calls as `[]`, so
  // `mock.calls.at(-1)?.at(0)` reads as `any` and the assertions below become a
  // lint error rather than a check on what was reported.
  const onDirtyChange = vi.fn((dirty: boolean) => dirty);
  const onDone = vi.fn(() => true);
  render(
    <EstimatingPanel
      method={over.method ?? 'pert'}
      pertWeights={over.pertWeights ?? DEFAULT_WEIGHTS}
      estimateRounding={over.estimateRounding ?? 'ceil'}
      setArithmetic={setArithmetic}
      onChanged={onChanged}
      onDirtyChange={onDirtyChange}
      onDone={onDone}
    />,
  );
  return { setArithmetic, onChanged, onDirtyChange, onDone };
}

/** Lets the two awaits a write makes — the call, then the reread — settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

const boxFor = (point: string): HTMLInputElement => {
  const box = screen.getByLabelText(point, { exact: false });
  // Narrowed rather than cast: a label pointing at something that is not an
  // input is a broken surface, and reading `.value` off it would be `undefined`
  // compared against `undefined` — a check that cannot fail.
  if (!(box instanceof HTMLInputElement)) throw new Error(`${point} is not an input`);
  return box;
};

describe('weightsOfDraft', () => {
  it('reads three numbers, fractions and zeroes included', () => {
    expect(weightsOfDraft({ optimistic: '1', realistic: '4', pessimistic: '1' })).toEqual({
      optimistic: 1,
      realistic: 4,
      pessimistic: 1,
    });
    // A zero drops its point out of the average rather than costing nothing,
    // and half a weight is as meaningful as half a day.
    expect(weightsOfDraft({ optimistic: '0', realistic: '2.5', pessimistic: '0' })).toEqual({
      optimistic: 0,
      realistic: 2.5,
      pessimistic: 0,
    });
  });

  it('refuses an empty box rather than sending a deliberate zero', () => {
    expect(weightsOfDraft({ optimistic: '', realistic: '4', pessimistic: '1' })).toBeNull();
  });

  it('refuses a weight of 1e999, which is an Infinity in a number’s clothing', () => {
    expect(weightsOfDraft({ optimistic: '1e999', realistic: '4', pessimistic: '1' })).toBeNull();
  });

  it('refuses a negative weight and three zeroes, which cannot average anything', () => {
    expect(weightsOfDraft({ optimistic: '-1', realistic: '4', pessimistic: '1' })).toBeNull();
    expect(weightsOfDraft({ optimistic: '0', realistic: '0', pessimistic: '0' })).toBeNull();
  });
});

describe('the estimating panel', () => {
  itDom('sends the three weights as one triple', async () => {
    const { setArithmetic, onChanged, onDone } = stubbed();

    fireEvent.change(boxFor('Realistic'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weights' }));
    await settle();

    expect(setArithmetic).toHaveBeenCalledTimes(1);
    expect(setArithmetic.mock.calls.at(0)?.at(0)).toEqual({
      pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
    });
    // Nothing is optimistic: the plan is re-read, and only then does the
    // surface ask to close.
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  /**
   * Proof: the `Number.isFinite` arm of `weightsOfDraft` replaced by a bare
   * `Number(typed) >= 0`, and this failed on `expected "spy" to not be called at
   * all, but actually been called 1 times` — a triple on its way to be-01 with
   * `Infinity` in it, which divides every step of the plan to zero days.
   * Watched 2026-08-30.
   */
  itDom('refuses a weight of 1e999 rather than sending an Infinity', async () => {
    const { setArithmetic } = stubbed();

    fireEvent.change(boxFor('Optimistic'), { target: { value: '1e999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weights' }));
    await settle();

    expect(setArithmetic).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('at or above zero');
  });

  itDom('picks a rounding the moment it is chosen, and re-reads the plan', async () => {
    const { setArithmetic, onChanged, onDone } = stubbed({ estimateRounding: 'ceil' });

    fireEvent.click(screen.getByLabelText('Round down', { exact: false }));
    await settle();

    expect(setArithmetic.mock.calls.at(0)?.at(0)).toEqual({ estimateRounding: 'floor' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    // A rounding is one choice and lands on its own; it does not close the
    // surface out from under somebody who came to change two things.
    expect(onDone).not.toHaveBeenCalled();
  });

  itDom('ticks be-01’s rounding rather than one of its own', () => {
    stubbed({ estimateRounding: 'exact' });

    expect(boxFor('Keep the fraction').checked).toBe(true);
    expect(boxFor('Round up').checked).toBe(false);
  });

  itDom('says the weights are not in force when the plan takes one point', () => {
    stubbed({ method: 'pessimistic' });

    expect(screen.getByText(/not in force/)).toBeTruthy();
  });

  itDom('reports itself dirty while a weight is typed and clean once it lands', async () => {
    const { onDirtyChange } = stubbed();

    expect(onDirtyChange.mock.calls.at(-1)?.at(0)).toBe(false);
    fireEvent.change(boxFor('Realistic'), { target: { value: '2' } });
    expect(onDirtyChange.mock.calls.at(-1)?.at(0)).toBe(true);

    fireEvent.change(boxFor('Realistic'), { target: { value: '4' } });
    await settle();

    expect(onDirtyChange.mock.calls.at(-1)?.at(0)).toBe(false);
  });

  itDom('keeps what was typed when be-01 refuses the triple, and says why', async () => {
    const refusing = vi.fn<(arithmetic: Arithmetic) => Promise<void>>(async () => {
      await Promise.resolve();
      throw new Error('bad_pert_weights');
    });
    const { onDone } = stubbed({ setArithmetic: refusing });

    fireEvent.change(boxFor('Realistic'), { target: { value: '0' } });
    fireEvent.change(boxFor('Optimistic'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weights' }));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('cannot average');
    expect(boxFor('Realistic').value).toBe('0');
    expect(onDone).not.toHaveBeenCalled();
  });
});
