import type { SavedPlanRow } from '@wbs/core';

import type { SavedPlanRow as AdapterSavedPlanRow } from './schema';

export function portRowFrom(row: AdapterSavedPlanRow): SavedPlanRow {
  return row;
}

export function adapterRowFrom(row: SavedPlanRow): AdapterSavedPlanRow {
  // Proof: dropping nullable scheduleAbsentReason from SavedPlanRow failed
  // be-01:typecheck here on TS2741 (2026-09-09).
  return row;
}
