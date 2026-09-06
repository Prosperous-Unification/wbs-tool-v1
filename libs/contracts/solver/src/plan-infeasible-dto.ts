import { indexTree } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

export const PLAN_INFEASIBLE_DTO_VERSION = 1;

export interface PlanInfeasibleItem {
  readonly ownerWorkItemId: string;
  readonly boundWorkItemId: string;
  readonly effectiveDeadlineOffset: number;
}

export interface PlanInfeasibleResult {
  readonly items: readonly PlanInfeasibleItem[];
}

export interface StoredPlanInfeasibleResult {
  readonly dtoVersion: number;
  readonly items: readonly PlanInfeasibleItem[];
}

const byBytes = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function defect(message: string): Error {
  return new Error(`stored plan-infeasible result: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  what: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (unexpected.length > 0)
    throw defect(`${what} carries unknown key ${unexpected.sort().join(', ')}`);
  const missing = expected.filter((key) => !(key in value));
  if (missing.length > 0) throw defect(`${what} is missing ${missing.join(', ')}`);
}

function readId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw defect(`${what} is not a non-empty string`);
  return value;
}

function readItem(value: unknown, index: number): PlanInfeasibleItem {
  const item = asRecord(value, `items[${String(index)}]`);
  exactKeys(
    item,
    ['ownerWorkItemId', 'boundWorkItemId', 'effectiveDeadlineOffset'],
    `items[${String(index)}]`,
  );
  const offset = item['effectiveDeadlineOffset'];
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset)) {
    throw defect(`items[${String(index)}].effectiveDeadlineOffset is not a safe integer`);
  }
  return {
    ownerWorkItemId: readId(item['ownerWorkItemId'], `items[${String(index)}].ownerWorkItemId`),
    boundWorkItemId: readId(item['boundWorkItemId'], `items[${String(index)}].boundWorkItemId`),
    effectiveDeadlineOffset: offset,
  };
}

export function encodePlanInfeasible(result: PlanInfeasibleResult): StoredPlanInfeasibleResult {
  return {
    dtoVersion: PLAN_INFEASIBLE_DTO_VERSION,
    items: [...result.items]
      .sort(
        (left, right) =>
          byBytes(left.boundWorkItemId, right.boundWorkItemId) ||
          byBytes(left.ownerWorkItemId, right.ownerWorkItemId),
      )
      .map((item) => ({ ...item })),
  };
}

export function decodePlanInfeasible(raw: unknown): PlanInfeasibleResult {
  const dto = asRecord(raw, 'the payload');
  exactKeys(dto, ['dtoVersion', 'items'], 'the payload');
  if (dto['dtoVersion'] !== PLAN_INFEASIBLE_DTO_VERSION) {
    throw defect(`unknown dtoVersion ${String(dto['dtoVersion'])}`);
  }
  if (!Array.isArray(dto['items'])) throw defect('items is not an array');

  const seen = new Set<string>();
  const items = dto['items'].map(readItem);
  for (const item of items) {
    if (seen.has(item.boundWorkItemId)) {
      throw defect(`duplicate boundWorkItemId ${item.boundWorkItemId}`);
    }
    seen.add(item.boundWorkItemId);
  }
  return { items };
}

/** Build the deterministic certificate the response wire intentionally omits. */
export function planInfeasibleResultOf(input: ScheduleInput): PlanInfeasibleResult {
  const { leavesUnder } = indexTree(input.rows);
  const bound = new Map<string, PlanInfeasibleItem>();

  for (const [ownerWorkItemId, effectiveDeadlineOffset] of input.deadlines) {
    for (const boundWorkItemId of leavesUnder.get(ownerWorkItemId) ?? []) {
      const candidate = { ownerWorkItemId, boundWorkItemId, effectiveDeadlineOffset };
      const held = bound.get(boundWorkItemId);
      if (
        held === undefined ||
        effectiveDeadlineOffset < held.effectiveDeadlineOffset ||
        (effectiveDeadlineOffset === held.effectiveDeadlineOffset &&
          byBytes(ownerWorkItemId, held.ownerWorkItemId) < 0)
      ) {
        bound.set(boundWorkItemId, candidate);
      }
    }
  }

  return {
    items: [...bound.values()].sort((left, right) =>
      byBytes(left.boundWorkItemId, right.boundWorkItemId),
    ),
  };
}
