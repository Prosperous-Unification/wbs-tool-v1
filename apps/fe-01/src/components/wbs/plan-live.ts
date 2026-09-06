import type * as React from 'react';

import type {
  ExternalSystemView,
  PersonView,
  PriorityBandView,
  ServiceView,
  TagView,
  TeamView,
  WorkItemTypeView,
} from '@/lib/wbs-api';
import { type ProjectApi } from '@/lib/wbs-api';

import { type PickerOption } from './creatable-picker';
import { type DepLights } from './dep-light-store';
import type { PickerEntry } from './dep-picker';
import { type DropZone } from './drag-drop';
import { type CellElement } from './editable-grid';
import type { TrioProblem } from './estimate-draft';
import { type ExternalRefDraft } from './external-refs-modal';
import { type ServiceLabel, type ServiceTeamLabel, type TagLabel } from './gantt-geometry';
import type { FocusIntent } from './live-editing';
import { type CommitOutcome } from './live-editing';
import { type CardAssignee } from './plan-cards';
import type { PrintedDay } from './short-date';
import { type TreeRow } from './wbs-rows';

/**
 * Current cell readers and writers. WbsTable replaces current on every render.
 * Column factories may close over only this ref and the three structural inputs:
 * steps, unfoldedSteps and hiddenColumnIds. Adding mutable values to that memo
 * remounts cells and discards focus and half-typed text.
 *
 * Proof: removing busy from WbsTable.liveNow made the source TypeScript check
 * report TS2741: busy is missing but required in PlanLiveValues (2026-09-06).
 */
export interface PlanLiveValues {
  focusIntent: React.MutableRefObject<FocusIntent>;
  gridElement: React.MutableRefObject<HTMLElement | null>;
  startFloor: React.MutableRefObject<ReadonlyMap<string, string>>;
  api: ProjectApi;
  projectId: string;
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  busy: boolean;
  duplicateRow: (id: string) => Promise<CommitOutcome>;
  deleteRow: (row: TreeRow) => Promise<CommitOutcome>;
  commitNameCell: (rowId: string, typed: string, baseline: string) => Promise<CommitOutcome>;
  onKeyDown: (event: React.KeyboardEvent, row: TreeRow) => void;
  onTabKey: (event: React.KeyboardEvent, rowId: string, columnId: string) => void;
  onArrowKey: (event: React.KeyboardEvent<CellElement>, rowId: string, columnId: string) => void;
  onAltMove: (event: React.KeyboardEvent, row: TreeRow, columnId: string) => void;
  onCommandKey: (event: React.KeyboardEvent, row: TreeRow, columnId: string) => void;
  armedDelete: { rowId: string; number: string } | null;
  setDragging: React.Dispatch<React.SetStateAction<string | null>>;
  setDropHint: React.Dispatch<React.SetStateAction<{ rowId: string; zone: DropZone } | null>>;
  dependenciesOf: (ids: readonly string[]) => { id: string; number: string; name: string }[];
  dependOn: (successorId: string, typed: string) => void;
  hasSchedule: () => boolean;
  showSchedule: (days: number) => string;
  depPicker: { rowId: string; typed: string; highlightId: string | null } | null;
  setDepPicker: React.Dispatch<
    React.SetStateAction<{ rowId: string; typed: string; highlightId: string | null } | null>
  >;
  depLights: DepLights;
  openMenuRowId: string | null;
  setOpenMenuRowId: React.Dispatch<React.SetStateAction<string | null>>;
  depEntriesFor: (
    forRow: { id: string; dependsOn: readonly string[] },
    typed: string,
  ) => PickerEntry[];
  pickDependency: (successorId: string, predecessorId: string) => Promise<CommitOutcome>;
  moveDepHighlight: (rowId: string, delta: 1 | -1, entryIds: readonly string[]) => void;
  estimateValue: (
    row: TreeRow,
    stepId: string,
    point: 'optimistic' | 'realistic' | 'pessimistic',
  ) => string;
  trioProblemFor: (row: TreeRow, stepId: string) => TrioProblem | null;
  commitEstimate: (
    row: TreeRow,
    stepId: string,
    point: 'optimistic' | 'realistic' | 'pessimistic',
    typed: string,
  ) => Promise<CommitOutcome>;
  combinedValue: (row: TreeRow, stepId: string) => string;
  combinedProblem: (row: TreeRow, stepId: string) => string | null;
  commitCombinedEstimate: (
    row: TreeRow,
    stepId: string,
    typed: string,
    baseline: string,
  ) => Promise<CommitOutcome>;
  mention: { rowId: string; stepId: string; typed: string } | null;
  enterFoldedCell: (box: CellElement) => void;
  readFoldedCell: (rowId: string, stepId: string, box: CellElement) => void;
  closeMention: () => void;
  leaveFoldedCell: () => void;
  mentionOptions: (row: TreeRow, stepId: string) => PickerOption[];
  openCard: string | null;
  setHoveredCell: React.Dispatch<React.SetStateAction<string | null>>;
  setFocusedCell: React.Dispatch<React.SetStateAction<string | null>>;
  setNotBefore: (id: string, day: string | null, reason?: string | null) => void;
  setNotBeforeReason: (id: string, typed: string) => void;
  setDeadline: (id: string, day: string | null) => void;
  setPriority: (id: string, typed: string) => Promise<CommitOutcome>;
  priorityBands: PriorityBandView[];
  setParallelism: (id: string, typed: string) => Promise<CommitOutcome>;
  effectiveTeamLabelOf: (row: TreeRow) => ServiceTeamLabel;
  effectiveTagLabelOf: (row: TreeRow) => TagLabel;
  effectiveServiceLabelOf: (row: TreeRow) => ServiceLabel;
  editingNotBefore: string | null;
  openNotBefore: (rowId: string) => void;
  closeNotBefore: (rowId: string) => void;
  editingDeadline: string | null;
  openDeadline: (rowId: string) => void;
  closeDeadline: (rowId: string) => void;
  startDate: string | null;
  teams: TeamView[];
  tags: TagView[];
  services: ServiceView[];
  workItemTypes: WorkItemTypeView[];
  externalSystems: ExternalSystemView[];
  setRefsEditing: React.Dispatch<React.SetStateAction<string | null>>;
  people: PersonView[];
  setTeamOf: (id: string, teamIds: readonly string[]) => Promise<CommitOutcome>;
  setTagsOf: (id: string, tagIds: readonly string[]) => Promise<CommitOutcome>;
  setServicesOf: (id: string, serviceIds: readonly string[]) => Promise<CommitOutcome>;
  setTypesOf: (id: string, typeIds: readonly string[]) => Promise<CommitOutcome>;
  setExternalRefsOf: (id: string, refs: readonly ExternalRefDraft[]) => Promise<CommitOutcome>;
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
  spanOf: (row: TreeRow) => { start: PrintedDay; finish: PrintedDay };
  assigneeOn: (row: TreeRow, stepId: string) => CardAssignee | null;
  anyAssigneeOn: (stepId: string) => boolean;
  nonOwnerNoteOf: (row: TreeRow) => string | null;
  waitsFor: (row: TreeRow) => { id: string; number: string; name: string }[];
  matchIds: ReadonlySet<string>;
  filtering: boolean;
}
export type PlanLive = React.MutableRefObject<PlanLiveValues>;
