import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GanttFaultBoundary } from '@/components/wbs/gantt-fault';

import { AppFaultBoundary } from './app-fault';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** A component that throws the moment it renders, the way a bad union does. */
function Throwing({ words }: { words: string }): never {
  throw new Error(words);
}

/** What the app-level fallback put on screen, or null while it did not. */
const appFaultWords = (): string | null =>
  document.querySelector('[data-app-fault]')?.textContent ?? null;

/** What the chart's own fallback put on screen, or null while it did not. */
const chartFaultWords = (): string | null =>
  document.querySelector('[data-gantt-fault]')?.textContent ?? null;

/**
 * React writes the caught error to `console.error` whatever a boundary does,
 * and so does {@link AppFaultBoundary.componentDidCatch} deliberately. Left
 * alone, five expected faults print five stack traces over a passing suite.
 */
const muteConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

let logged: ReturnType<typeof muteConsoleError>;

beforeEach(() => {
  logged = muteConsoleError();
});

afterEach(() => {
  cleanup();
  logged.mockRestore();
});

describe('the app’s last boundary', () => {
  itDom('renders its children while nothing throws', () => {
    render(
      <AppFaultBoundary>
        <p>the editor</p>
      </AppFaultBoundary>,
    );

    expect(screen.getByText('the editor')).toBeDefined();
    expect(appFaultWords()).toBeNull();
  });

  itDom('says what was thrown, offers a reload, and leaves a document behind', () => {
    // F7, observed live 2026-08-09: a throw in the editor unmounted the tree
    // and left `document.body.innerHTML` empty, with React's "Consider adding
    // an error boundary" the only trace of it anywhere.
    //
    // Proof: `<AppFaultBoundary>` struck from this render and `<Throwing>`
    // rendered bare. This test failed with the render itself throwing —
    // `Error: the plan is in a state it cannot be in`, out of `render` rather
    // than as a failed expectation — which is the white screen, in a test.
    // Watched 2026-08-09.
    render(
      <AppFaultBoundary>
        <Throwing words="the plan is in a state it cannot be in" />
      </AppFaultBoundary>,
    );

    // 1. The error's own words, not "something went wrong": they are the only
    //    description anybody will have of a state that is over by the time it
    //    is read about.
    expect(appFaultWords()).toContain('The app stopped');
    expect(appFaultWords()).toContain('the plan is in a state it cannot be in');
    // 2. Spoken, so a screen reader is told the page has gone rather than
    //    finding it silently replaced.
    expect(screen.getByRole('alert')).toBeDefined();
    // 3. And a way out, which is the only one there is at the root.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
    // 4. The failure this is here to stop, stated as itself.
    expect(document.body.innerHTML).not.toBe('');
  });

  itDom('reloads the document when the reader asks', () => {
    const reload = vi.fn();
    const original = window.location;
    // The boundary that makes this safe: jsdom refuses to navigate and prints
    // "Not implemented: navigation", so `window.location` is a stub with the
    // one member the fallback touches for the length of this test, and the real
    // one is put back below. The production call is the one line in the handler.
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    try {
      render(
        <AppFaultBoundary>
          <Throwing words="gone" />
        </AppFaultBoundary>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  itDom('says so when what was thrown was not an error at all', () => {
    // `throw 'nope'` is legal JavaScript and a dependency can do it. The
    // sentence names the absence rather than printing `undefined`.
    function ThrowingAString(): never {
      // The fault being modelled is precisely a dependency that throws a
      // non-Error, so the rule is off for this one line.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'nope';
    }
    render(
      <AppFaultBoundary>
        <ThrowingAString />
      </AppFaultBoundary>,
    );

    expect(appFaultWords()).toContain('the reason it gave was not an error message');
    expect(appFaultWords()).not.toContain('undefined');
  });
});

describe('the nearest boundary is the one that catches', () => {
  itDom('costs a chart rather than a page when the chart is what threw', () => {
    // The split this change deliberately does not widen: the chart is the
    // optional feature that may degrade (AGENTS.md, R5), the editor beside it
    // is not. `GanttFaultBoundary` is the real one from `gantt-fault.tsx` —
    // unchanged by this change — so what is asserted here is React's own
    // nearest-wins rule over the two boundaries the app actually ships.
    //
    // Proof: `<GanttFaultBoundary>` struck from this render, leaving the throw
    // to the app boundary. This test failed on
    // `expect(chartFaultWords()).toContain('The chart cannot be drawn')` —
    // `AssertionError: the given combination of arguments (null and string) is
    // invalid for this assertion`, chai's words for a chart fallback that was
    // never rendered because the whole page's had replaced it. Watched
    // 2026-08-09.
    render(
      <AppFaultBoundary>
        <p>the editor</p>
        <GanttFaultBoundary generation={1}>
          <Throwing words="slice sanding names a predecessor this payload has not got" />
        </GanttFaultBoundary>
      </AppFaultBoundary>,
    );

    expect(chartFaultWords()).toContain('The chart cannot be drawn');
    expect(chartFaultWords()).toContain('slice sanding names a predecessor');
    // The app boundary did not fire, and the page around the chart is still on
    // screen — which is the whole point of the inner one.
    expect(appFaultWords()).toBeNull();
    expect(screen.getByText('the editor')).toBeDefined();
  });

  itDom('catches what the chart’s boundary is not under', () => {
    // The other half of the same rule: a throw beside the chart rather than
    // inside it has nothing nearer than the root, and reaches it.
    render(
      <AppFaultBoundary>
        <GanttFaultBoundary generation={1}>
          <p>a chart</p>
        </GanttFaultBoundary>
        <Throwing words="the table cannot render this row" />
      </AppFaultBoundary>,
    );

    expect(appFaultWords()).toContain('the table cannot render this row');
    expect(chartFaultWords()).toBeNull();
  });
});
