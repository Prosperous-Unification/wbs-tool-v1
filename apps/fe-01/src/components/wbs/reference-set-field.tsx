import { useRef, useState } from 'react';

import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';

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
  dataCell?: CreatablePickerProps['dataCell'];
  gridCell?: CreatablePickerProps['gridCell'];
  addLabel?: string;
  removeLabel?: (entry: ReferenceSetEntry) => string;
  placeholder?: string;
  title?: string;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

export const REFERENCE_SET_STRIP_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
} as const;

export const REFERENCE_SET_ADD_CLASS =
  'shrink-0 border-0 bg-transparent text-xs hover:bg-[color-mix(in_oklab,var(--foreground)_7%,var(--cell-bg))] hover:text-foreground';
export const REFERENCE_SET_CHIP_CLASS =
  'bg-muted inline-flex max-w-full items-center gap-0.5 rounded px-1 text-xs';
export const REFERENCE_SET_REMOVE_CLASS = 'shrink-0 border-0 bg-transparent p-0';

/** Shared compact editor for directory-backed work-item reference sets. */
export function ReferenceSetStrip({
  label,
  adapter,
  dataCell,
  gridCell,
  addLabel,
  removeLabel,
  placeholder,
  title,
}: ReferenceSetStripProps) {
  const root = useRef<HTMLSpanElement>(null);
  const ownIds = unique(adapter.ownIds);
  const own = ownIds.map(
    (id) => adapter.entries.find((entry) => entry.id === id) ?? { id, name: id },
  );
  const offered = adapter.entries.filter((entry) => !ownIds.includes(entry.id));
  const sourceIdsRef = useRef(ownIds);
  const projectedIdsRef = useRef(ownIds);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  if (sourceIdsRef.current.join('\0') !== ownIds.join('\0')) {
    sourceIdsRef.current = ownIds;
    projectedIdsRef.current = ownIds;
  }

  const mutate = async (
    project: (current: string[]) => string[],
    commit: (current: string[], next: string[]) => Promise<CommitOutcome>,
  ): Promise<CommitOutcome> => {
    if (pendingRef.current) return 'unsent';
    pendingRef.current = true;
    setPending(true);
    const current = projectedIdsRef.current;
    const next = unique(project(current));
    try {
      const outcome = await commit(current, next);
      // Creation cannot project the server-assigned id. Its unchanged `next`
      // must not overwrite props that refreshed while the create was awaited.
      if (outcome === 'landed' && current.join('\0') !== next.join('\0')) {
        projectedIdsRef.current = next;
      }
      return outcome;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await mutate(
      (current) => current.filter((ownId) => ownId !== id),
      (_current, next) => adapter.replace(next),
    );
  };

  return (
    <span
      ref={root}
      data-reference-set={adapter.kind}
      data-reference-strip=""
      style={REFERENCE_SET_STRIP_STYLE}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={addLabel ?? `Add a ${adapter.kind}`}
        data-reference-add=""
        className={REFERENCE_SET_ADD_CLASS}
        disabled={pending}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => root.current?.querySelector<HTMLInputElement>('input')?.focus()}
      >
        +
      </button>
      <span
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 3,
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        {own.map((entry) => (
          <span key={entry.id} data-reference-chip={entry.id} className={REFERENCE_SET_CHIP_CLASS}>
            <span className="truncate">{entry.name}</span>
            <button
              type="button"
              aria-label={removeLabel?.(entry) ?? `Remove ${entry.name} ${adapter.kind}`}
              disabled={pending}
              className={REFERENCE_SET_REMOVE_CLASS}
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
          restingValue={own.length === 1 ? own[0]?.name : undefined}
          onChoose={(id) =>
            mutate(
              (current) => [...current, id],
              (_current, next) => adapter.replace(next),
            )
          }
          onCreate={(name) =>
            mutate(
              (current) => current,
              (current) => adapter.create(name, current),
            )
          }
          closeWhen={(outcome) => outcome === 'landed'}
          disabled={pending}
          placeholder={placeholder ?? `Search ${label.toLowerCase()}`}
          title={title}
          dataCell={dataCell}
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
export function ReferenceSetSheet({
  label,
  adapter,
  open,
  onClose,
  ...stripProps
}: ReferenceSetSheetProps) {
  if (!open) return null;

  const ownIds = unique(adapter.ownIds);
  const closeAfterLanded = (outcome: CommitOutcome): CommitOutcome => {
    if (outcome === 'landed') onClose();
    return outcome;
  };
  const sheetAdapter: ReferenceSetAdapter = {
    ...adapter,
    replace: async (ids) => {
      const isAddition = unique(ids).some((id) => !ownIds.includes(id));
      const outcome = await adapter.replace(ids);
      return isAddition ? closeAfterLanded(outcome) : outcome;
    },
    create: async (name, current) => closeAfterLanded(await adapter.create(name, current)),
  };

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <ModalContent side="bottom" className="min-h-[60vh]" aria-label={`Edit ${label}`}>
        <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
          ×
        </button>
        <ModalHeader>
          <ModalTitle>Edit {label}</ModalTitle>
          <ModalDescription>Type to search the directory, or add a new name.</ModalDescription>
        </ModalHeader>
        <ReferenceSetStrip label={label} adapter={sheetAdapter} {...stripProps} />
      </ModalContent>
    </Modal>
  );
}
