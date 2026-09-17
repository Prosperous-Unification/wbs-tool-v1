import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { RefusalWords } from '@/lib/refusal';

import { SectionProblem, useSettingsSection } from './use-settings-section';

const WORDS: RefusalWords = {
  sentences: { taken: 'that name is taken', name_required: 'a name is needed' },
  otherwise: (code) => `refused (${code})`,
};

/** A section with one button, standing in for the four real panels. */
function Section(props: {
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onChanged?: () => Promise<void>;
  write?: () => Promise<void>;
}): React.ReactNode {
  const section = useSettingsSection({
    words: WORDS,
    dirty: props.dirty,
    onDirtyChange: props.onDirtyChange,
    onChanged: props.onChanged ?? (() => Promise.resolve()),
  });
  return (
    <div>
      <SectionProblem problem={section.problem} />
      <button
        type="button"
        disabled={section.busy}
        onClick={() => {
          void section.attempt(props.write ?? (() => Promise.resolve()));
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          section.refuse('name_required');
        }}
      >
        Refuse locally
      </button>
    </div>
  );
}

/**
 * The rule four panels each kept a copy of, and the two halves a new panel
 * forgets.
 *
 * Every one of steps, teams, priorities and estimating had its own watched
 * negative for reporting `dirty` (2026-08-30, in
 * `project-settings-modal.test.tsx`). Those still stand and are about the
 * modal; these are about the rule itself, now that there is one of it.
 *
 * Proof: the unmount effect deleted, watched failing on `expected [ true ] to deeply equal
 * [ true, false ]` — a section that never takes its claim back leaves the
 * modal refusing to close over a form that is gone. And `dirty || busy`
 * narrowed to `dirty`, watched failing on `expected [ false ] to include true`:
 * a write in the air stops being a thing the modal must not close over, which
 * is the case no panel would have to remember any more. Observed 2026-09-02.
 */
describe('a settings section', () => {
  afterEach(cleanup);

  it('withdraws its claim on unmount', async () => {
    const reported: boolean[] = [];
    const view = render(
      <Section
        dirty
        onDirtyChange={(dirty) => {
          reported.push(dirty);
        }}
      />,
    );
    await waitFor(() => {
      expect(reported).toEqual([true]);
    });

    view.unmount();

    expect(reported).toEqual([true, false]);
  });

  it('counts a write in the air as unfinished, whatever the section says', async () => {
    // The half no panel has to remember: its own `dirty` is `false` throughout.
    const reported: boolean[] = [];
    let land = (): void => undefined;
    render(
      <Section
        dirty={false}
        write={() =>
          new Promise<void>((resolve) => {
            land = resolve;
          })
        }
        onDirtyChange={(dirty) => {
          reported.push(dirty);
        }}
      />,
    );
    screen.getByRole('button', { name: 'Save' }).click();

    await waitFor(() => {
      expect(reported).toContain(true);
    });
    land();
    await waitFor(() => {
      expect(reported.at(-1)).toBe(false);
    });
  });

  it('words a refusal from the section’s own table, and keeps the surface', async () => {
    render(
      <Section
        dirty={false}
        write={() => Promise.reject(new Error('taken'))}
        onDirtyChange={() => undefined}
      />,
    );

    screen.getByRole('button', { name: 'Save' }).click();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('that name is taken');
    });
    // The button is enabled again, so the reader can try the same thing twice.
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('words a refusal it made itself, from that same table', async () => {
    // A blank name never reaches be-01, and must not read differently for it.
    render(<Section dirty={false} onDirtyChange={() => undefined} />);

    screen.getByRole('button', { name: 'Refuse locally' }).click();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('a name is needed');
    });
  });
});
