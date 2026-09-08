import type * as React from 'react';

import { type ProjectApi } from '@/lib/wbs-api';

import { type CellCards } from './cell-card-store';
import { type DepLights } from './dep-light-store';
import type { PickerEntry } from './dep-picker';
import { type DropZone } from './drag-drop';
import { type CellElement } from './editable-grid';
import type { FocusIntent } from './live-editing';
import { type CommitOutcome } from './live-editing';
import { type TreeRow } from './wbs-rows';

/**
 * Current event capabilities and external stores. WbsTable replaces current on
 * every render so stable column components invoke the latest action without
 * closing over it. Display values belong to `PlanRowReadings`; adding one here
 * would bypass the cell memo's explicit input contract.
 */
export interface PlanLiveValues {
  focusIntent: React.RefObject<FocusIntent>;
  gridElement: React.RefObject<HTMLElement | null>;
  api: ProjectApi;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  duplicateRow: (id: string) => Promise<CommitOutcome>;
  deleteRow: (row: TreeRow) => Promise<CommitOutcome>;
  commitNameCell: (rowId: string, typed: string, baseline: string) => Promise<CommitOutcome>;
  onKeyDown: (event: React.KeyboardEvent, row: TreeRow) => void;
  onTabKey: (event: React.KeyboardEvent, rowId: string, columnId: string) => void;
  onArrowKey: (event: React.KeyboardEvent<CellElement>, rowId: string, columnId: string) => void;
  onAltMove: (event: React.KeyboardEvent, row: TreeRow, columnId: string) => void;
  onCommandKey: (event: React.KeyboardEvent, row: TreeRow, columnId: string) => void;
  setDragging: React.Dispatch<React.SetStateAction<string | null>>;
  setDropHint: React.Dispatch<React.SetStateAction<{ rowId: string; zone: DropZone } | null>>;
  dependOn: (successorId: string, typed: string) => void;
  setDepPicker: React.Dispatch<
    React.SetStateAction<{ rowId: string; typed: string; highlightId: string | null } | null>
  >;
  depLights: DepLights;
  setOpenMenuRowId: React.Dispatch<React.SetStateAction<string | null>>;
  depEntriesFor: (
    forRow: { id: string; dependsOn: readonly string[] },
    typed: string,
  ) => PickerEntry[];
  pickDependency: (successorId: string, predecessorId: string) => Promise<CommitOutcome>;
  moveDepHighlight: (rowId: string, delta: 1 | -1, entryIds: readonly string[]) => void;
  commitEstimate: (
    row: TreeRow,
    stepId: string,
    point: 'optimistic' | 'realistic' | 'pessimistic',
    typed: string,
  ) => Promise<CommitOutcome>;
  commitCombinedEstimate: (
    row: TreeRow,
    stepId: string,
    typed: string,
    baseline: string,
  ) => Promise<CommitOutcome>;
  enterFoldedCell: (box: CellElement) => void;
  readFoldedCell: (rowId: string, stepId: string, box: CellElement) => void;
  closeMention: () => void;
  leaveFoldedCell: () => void;
  /**
   * Which cell's hover card is on screen, and the two writers that decide.
   *
   * A store rather than three values on this contract since R10: a card is a
   * pointer reading, and a pointer reading held in {@link WbsTable}'s state
   * re-rendered every cell in the table on every boundary the pointer crossed.
   * A cell that draws a card subscribes with {@link useCardOpenOn}; nothing
   * reads the open key off this object during a render.
   */
  cellCards: CellCards;
  setNotBefore: (id: string, day: string | null, reason?: string | null) => void;
  setNotBeforeReason: (id: string, typed: string) => void;
  setDeadline: (id: string, day: string | null) => void;
  setPriority: (id: string, typed: string) => Promise<CommitOutcome>;
  setParallelism: (id: string, typed: string) => Promise<CommitOutcome>;
  openNotBefore: (rowId: string) => void;
  closeNotBefore: (rowId: string) => void;
  openDeadline: (rowId: string) => void;
  closeDeadline: (rowId: string) => void;
  setRefsEditing: React.Dispatch<React.SetStateAction<string | null>>;
  setTeamOf: (id: string, teamIds: readonly string[]) => Promise<CommitOutcome>;
  setTagsOf: (id: string, tagIds: readonly string[]) => Promise<CommitOutcome>;
  setServicesOf: (id: string, serviceIds: readonly string[]) => Promise<CommitOutcome>;
  setTypesOf: (id: string, typeIds: readonly string[]) => Promise<CommitOutcome>;
  createTeamFor: (id: string, name: string, current: readonly string[]) => Promise<CommitOutcome>;
  createServiceFor: (
    id: string,
    name: string,
    current: readonly string[],
  ) => Promise<CommitOutcome>;
  createTagFor: (id: string, name: string, current: readonly string[]) => Promise<CommitOutcome>;
  createTypeFor: (id: string, name: string, current: readonly string[]) => Promise<CommitOutcome>;
  assignTo: (id: string, stepId: string, personId: string | null) => void;
  createPersonFor: (row: TreeRow, stepId: string, name: string) => void;
  toggleStep: (stepId: string) => void;
}
export type PlanLive = React.RefObject<PlanLiveValues>;
