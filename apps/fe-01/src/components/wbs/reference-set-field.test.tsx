import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  type ReferenceSetAdapter,
  ReferenceSetSheet,
  ReferenceSetStrip,
} from './reference-set-field';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const entries = [
  { id: 'team-1', name: 'Platform' },
  { id: 'team-2', name: 'QA' },
  { id: 'team-3', name: 'Release' },
];

function adapter(overrides: Partial<ReferenceSetAdapter> = {}): ReferenceSetAdapter {
  return {
    kind: 'team',
    entries,
    ownIds: ['team-1'],
    inheritedLabel: 'Core',
    replace: vi.fn().mockResolvedValue('landed'),
    create: vi.fn().mockResolvedValue('landed'),
    ...overrides,
  };
}

describe('ReferenceSetStrip', () => {
  itDom('renders one leading add path, own chips, and inherited context', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);

    expect(screen.getAllByRole('button', { name: 'Add a team' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add a team' }).tabIndex).toBe(-1);
    expect(document.querySelectorAll('[data-creatable-add]')).toHaveLength(0);
    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('Inherited: Core')).toBeInTheDocument();
  });

  itDom('omits selected entries and adds the chosen id to the whole own set', async () => {
    const model = adapter();
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    fireEvent.focus(box);
    expect(screen.queryByRole('option', { name: 'Platform' })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(model.replace).toHaveBeenCalledWith(['team-1', 'team-2']);
    });
  });

  itDom('creates against the current whole set and preserves refused members', async () => {
    const model = adapter({ create: vi.fn().mockResolvedValue('refused') });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'New team' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(model.create).toHaveBeenCalledWith('New team', ['team-1']);
    });
    expect(screen.getByText('Platform')).toBeInTheDocument();
  });

  itDom('removes one member and disables only that chip while the write is pending', async () => {
    let answer!: (value: 'landed' | 'refused' | 'unsent') => void;
    const pending = new Promise<'landed' | 'refused' | 'unsent'>((resolve) => {
      answer = resolve;
    });
    const model = adapter({ replace: vi.fn().mockReturnValue(pending) });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const remove = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Remove Platform team',
    });
    fireEvent.click(remove);
    expect(remove).toBeDisabled();
    expect(model.replace).toHaveBeenCalledWith([]);

    await act(async () => {
      answer('refused');
      await pending;
    });
    expect(remove).not.toBeDisabled();
    expect(screen.getByText('Platform')).toBeInTheDocument();
  });

  itDom('the leading plus focuses the adjacent keyboard path', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a team' }));
    expect(screen.getByRole('combobox', { name: 'Teams' })).toHaveFocus();
  });
});

describe('ReferenceSetSheet', () => {
  itDom('uses the same set editor inside a labelled phone dialog', () => {
    const close = vi.fn();
    render(<ReferenceSetSheet label="Teams" adapter={adapter()} open onClose={close} />);

    expect(screen.getByRole('dialog', { name: 'Edit Teams' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Teams' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Teams' }));
    expect(close).toHaveBeenCalledOnce();
  });
});
