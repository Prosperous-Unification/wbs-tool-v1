/** The saved-plan header exactly as a source returns it. */
export interface SavedPlanRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdById: string | null;
  readonly createdAt: number;
  readonly inputSchemaVersion: number;
  readonly inputBytes: number;
  readonly inputSha256: string;
  readonly scheduleSchemaVersion: number | null;
  readonly scheduleBytes: number | null;
  readonly scheduleSha256: string | null;
  readonly scheduleInputSha256: string | null;
  readonly schedulerAlgorithmId: string | null;
  readonly scheduleAbsentReason: string | null;
}

/** One stored body and the digest taken over its exact bytes. */
export interface SavedPlanBodyWrite {
  readonly schemaVersion: number;
  readonly bytes: string;
  readonly sha256: string;
}

/** The schedule side is either wholly present or absent with a reason. */
export type SavedPlanScheduleWrite =
  | {
      readonly present: true;
      readonly body: SavedPlanBodyWrite;
      readonly inputSha256: string;
      readonly algorithmId: string;
    }
  | { readonly present: false; readonly absentReason: string };

/** One immutable saved-plan write. */
export interface SavedPlanWrite {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdById: string | null;
  readonly createdAt: number;
  readonly input: SavedPlanBodyWrite;
  readonly schedule: SavedPlanScheduleWrite;
}

/** What the source did while trying to acquire and perform a saved-plan write. */
export type SavedPlanWriteOutcome<Refusal> =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'refused'; readonly refusal: Refusal }
  | { readonly outcome: 'snapshot_busy' };

/** A stored header and its independently stored bodies. */
export interface StoredSavedPlan {
  readonly header: SavedPlanRow;
  readonly bodies: {
    readonly input: string | null;
    readonly schedule: string | null;
  };
}

/** What a project holds at the instant a write checks its quota. */
export interface SavedPlanHoldingRow {
  readonly plans: number;
  readonly bytes: number;
}

export type SavedPlanTouchOutcome = 'touched' | 'no_such_plan' | 'snapshot_busy';

/** The identities used to authorize a rename or deletion. */
export interface SavedPlanPrincipals {
  readonly savedPlanId: string;
  readonly projectId: string;
  readonly projectOwnerId: string;
  readonly createdById: string | null;
}

/** The source-neutral saved-plan history boundary. */
export interface SavedPlanStore {
  // Proof: adding `holdingOf` here failed the adapter-free fixture on TS2741,
  // missing the transaction-only method (2026-09-09).
  // Proof: adding `bodyOf` did the same, naming `bodyOf` at TS2741.
  write<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
  ): Promise<SavedPlanWriteOutcome<Refusal>>;
  readOf(savedPlanId: string): Promise<StoredSavedPlan | null>;
  listOf(projectId: string): Promise<readonly SavedPlanRow[]>;
  principalsOf(savedPlanId: string): Promise<SavedPlanPrincipals | null>;
  renameTo(savedPlanId: string, name: string): Promise<SavedPlanTouchOutcome>;
  deleteOf(savedPlanId: string): Promise<SavedPlanTouchOutcome>;
}
