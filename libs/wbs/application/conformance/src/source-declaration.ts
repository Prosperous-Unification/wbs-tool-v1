import type {
  HistoryStores,
  SavedPlanStore,
  StoredSavedPlan,
  Stores,
  TransactionalStores,
  WriteStamp,
} from '@wbs/core';

import type { CaseId, HistoryAdmission, PortName } from './case-manifest';

export interface Gap {
  readonly caseId: CaseId;
  readonly reason: string;
  readonly evidence: {
    readonly sourceRevision: string;
    readonly assertion: string;
    readonly observedFailure: string;
  };
}

export type Capability<P> =
  | {
      readonly kind: 'offered';
      open(caseId: CaseId): Promise<CaseFixture<P>>;
      readonly gaps: readonly Gap[];
    }
  | { readonly kind: 'absent'; readonly reason: string };

export type Capabilities = {
  readonly [P in PortName]: Capability<Stores[P]>;
};

export interface SourceDeclaration {
  readonly name: string;
  readonly revision: string;
  readonly capabilities: Capabilities;
  readonly historyAdmission: HistoryAdmission;
}

export interface CaseFixture<P> {
  readonly fixtureId: string;
  readonly port: P;
  readonly journalAppender: Pick<Stores['journal'], 'append'>;
  readonly seed: SeededPlan;
  readonly readers: SourceReaders;
  readonly scenario: ScenarioControl;
  close(): Promise<void>;
}

export interface SeededPlan {
  readonly projectIds: readonly [string, string];
  readonly ownerIds: readonly [string, string];
  readonly stepIds: readonly [readonly [string, string], readonly [string, string]];
  readonly workItemIds: readonly [readonly [string, string], readonly [string, string]];
  readonly teamIds: readonly [string, string];
  readonly tagIds: readonly [string];
  readonly serviceIds: readonly [string];
  readonly typeIds: readonly [string];
  readonly externalSystemIds: readonly [string];
  readonly personIds: readonly [string, string];
  readonly stamps: readonly [WriteStamp, WriteStamp];
}

/** Stable cross-source identities used by every independently opened case. */
export const DETERMINISTIC_SEED: SeededPlan = {
  projectIds: ['project-a', 'project-b'],
  ownerIds: ['owner-a', 'owner-b'],
  stepIds: [
    ['step-a-dev', 'step-a-qa'],
    ['step-b-dev', 'step-b-qa'],
  ],
  workItemIds: [
    ['work-a-one', 'work-a-two'],
    ['work-b-one', 'work-b-two'],
  ],
  teamIds: ['team-a', 'team-b'],
  tagIds: ['tag-a'],
  serviceIds: ['service-a'],
  typeIds: ['type-a'],
  externalSystemIds: ['sys-jira-issue'],
  personIds: ['person-a', 'person-b'],
  stamps: [
    { at: 100, by: 'owner-a' },
    { at: 200, by: 'owner-b' },
  ],
};

/** Mixed-case owners that distinguish SQLite BINARY order from locale collation. */
export const TARGETED_ORDER_WORK_ITEM_IDS = ['work-A', 'work-a'] as const;

export interface PhaseBarrier {
  readonly entered: Promise<void>;
  release(): void;
}

export interface LateWriteEvidence {
  readonly savedPlan?: StoredSavedPlan;
}

export interface CaptureDirectoryChange {
  readonly tag: Awaited<ReturnType<TransactionalStores['directory']['renameTag']>>;
  readonly person: Awaited<ReturnType<TransactionalStores['directory']['patchPerson']>>;
}

export type ScenarioControl =
  | { readonly kind: 'ordinary' }
  | {
      readonly kind: 'late-write';
      readonly point:
        'subtree-final-satellite' | 'journal-history-insert' | 'saved-plan-schedule-body';
      arm(): void;
      reached(): boolean;
      evidence(): LateWriteEvidence;
    }
  | {
      readonly kind: 'capture-interleave';
      readonly firstRead: PhaseBarrier;
      changeDirectory(): Promise<CaptureDirectoryChange>;
    }
  | {
      readonly kind: 'competing-history-write';
      readonly rivalWriter: SavedPlanStore;
      readonly expectedRival: 'quota-refused' | 'snapshot_busy';
    }
  | {
      readonly kind: 'batch-settlement';
      begin(): Promise<void>;
      readonly entered: Promise<void>;
      settle(decision: 'commit' | 'rollback'): Promise<void>;
    };

export interface SourceReaders {
  readonly projects: Pick<Stores['projects'], 'findById' | 'stepsOf' | 'listFor'>;
  readonly workItems: Pick<Stores['workItems'], 'listByProject'>;
  readonly steps: Pick<Stores['steps'], 'listByProject'>;
  readonly estimates: Pick<Stores['estimates'], 'listByProject'>;
  readonly actuals: Pick<Stores['actuals'], 'listByProject'>;
  readonly measures: Pick<Stores['measures'], 'listByProject'>;
  readonly progress: Pick<Stores['progress'], 'listByProject'>;
  readonly dependencies: Pick<Stores['dependencies'], 'listByProject'>;
  readonly directory: Pick<
    Stores['directory'],
    | 'listTags'
    | 'listTeams'
    | 'listPeople'
    | 'assignmentsFor'
    | 'assignmentsOf'
    | 'assignmentsInProject'
  >;
  readonly journal: Pick<Stores['journal'], 'entriesFor' | 'stateOf'>;
  readonly planEvents: Pick<Stores['planEvents'], 'listFor'>;
  readonly savedPlans: Pick<Stores['savedPlans'], 'readOf' | 'listOf' | 'principalsOf'>;
}

export type TransactionalPortName = keyof TransactionalStores;
export type HistoryPortName = keyof HistoryStores;
