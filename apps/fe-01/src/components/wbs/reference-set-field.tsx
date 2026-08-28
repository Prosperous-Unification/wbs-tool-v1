import { useRef, useState } from 'react';

import { CreatablePicker, type CreatablePickerProps } from './creatable-picker';
import type { CommitOutcome } from './live-editing';

export type ReferenceSetKind = 'team' | 'tag' | 'service';

export interface ReferenceSetEntry {
  id: string;
  name: string;
}

export interface ReferenceSetAdapter {
  kind: ReferenceSetKind;
  entries: readonly ReferenceSetEntry[];
  ownIds: readonly string[];
  inheritedLabel?: string;
  replace: (ids: string[]) => Promise<CommitOutcome>;
  create: (name: string, current: string[]) => Promise<CommitOutcome>;
}

export interface ReferenceSetStripProps {
  label: string;
  adapter: ReferenceSetAdapter;
  gridCell?: CreatablePickerProps['gridCell'];
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** Shared compact editor for directory-backed work-item reference sets. */
export function ReferenceSetStrip({ label, adapter, gridCell }: ReferenceSetStripProps) {
  const root = useRef<HTMLSpanElement>(null);
  const ownIds = unique(adapter.ownIds);
  const own = ownIds.map(
    (id) => adapter.entries.find((entry) => entry.id === id) ?? { id, name: id },
  );
  const offered = adapter.entries.filter((entry) => !ownIds.includes(entry.id));
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingAdd, setPendingAdd] = useState(false);
  const pendingAddRef = useRef(false);

  const add = async (action: () => Promise<CommitOutcome>): Promise<CommitOutcome> => {
    if (pendingAddRef.current) return 'unsent';
    pendingAddRef.current = true;
    setPendingAdd(true);
    try {
      return await action();
    } finally {
      pendingAddRef.current = false;
      setPendingAdd(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (pendingIds.has(id)) return;
    setPendingIds((current) => new Set(current).add(id));
    try {
      await adapter.replace(ownIds.filter((ownId) => ownId !== id));
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <span
      ref={root}
      data-reference-set={adapter.kind}
      style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Add a ${adapter.kind}`}
        data-reference-add=""
        disabled={pendingAdd}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => root.current?.querySelector<HTMLInputElement>('input')?.focus()}
      >
        +
      </button>
      <span style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
        {own.map((entry) => (
          <span
            key={entry.id}
            data-reference-chip={entry.id}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
          >
            <span>{entry.name}</span>
            <button
              type="button"
              aria-label={`Remove ${entry.name} ${adapter.kind}`}
              disabled={pendingIds.has(entry.id)}
              onClick={() => void remove(entry.id)}
            >
              ×
            </button>
          </span>
        ))}
      </span>
      <span style={{ flex: 1, minWidth: 72 }}>
        <CreatablePicker
          label={label}
          entries={offered}
          value={null}
          onChoose={(id) => add(() => adapter.replace([...ownIds, id]))}
          onCreate={(name) => add(() => adapter.create(name, ownIds))}
          closeWhen={(outcome) => outcome === 'landed'}
          placeholder={`Search ${label.toLowerCase()}`}
          gridCell={gridCell}
        />
      </span>
      {adapter.inheritedLabel !== undefined && (
        <span data-reference-inherited="">Inherited: {adapter.inheritedLabel}</span>
      )}
    </span>
  );
}

export interface ReferenceSetSheetProps extends ReferenceSetStripProps {
  open: boolean;
  onClose: () => void;
}

/** Phone presentation of the same directory-set editor. */
export function ReferenceSetSheet({ label, adapter, open, onClose }: ReferenceSetSheetProps) {
  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Edit ${label}`}>
      <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
        ×
      </button>
      <ReferenceSetStrip label={label} adapter={adapter} />
    </div>
  );
}
