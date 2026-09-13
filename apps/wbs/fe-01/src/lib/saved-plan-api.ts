import {
  type ClientFailure,
  type ClientReply,
  compareSavedPlans,
  deleteSavedPlan,
  listSavedPlans,
  renameSavedPlan,
  savePlan,
} from '@wbs/contracts';

import { browserClient } from './http';
import { unreachable } from './http';

export const OPENAPI_SPEC_PATH = '/api/openapi.json';

export const SAVED_PLAN_SPEC_PATHS = [
  '/api/projects/{id}/saved-plans',
  '/api/projects/{id}/saved-plans/compare',
  '/api/saved-plans/{id}',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Capability absence is established only by a successfully read served document. */
export async function savedPlansAvailable(): Promise<boolean> {
  const response = await fetch(OPENAPI_SPEC_PATH);
  if (!response.ok) throw new Error(`http_${String(response.status)}`);
  const document: unknown = await response.json();
  if (!isRecord(document) || !isRecord(document['paths'])) throw new Error('unexpected_response');
  const paths = document['paths'];
  return SAVED_PLAN_SPEC_PATHS.every((path) => Object.hasOwn(paths, path));
}

type ListReply = ClientReply<typeof listSavedPlans>;
type ListWire = Extract<ListReply, { kind: 'success' }>['body']['savedPlans'][number];
type SaveReply = ClientReply<typeof savePlan>;
type StoredWire = Extract<SaveReply, { kind: 'success' }>['body']['savedPlan'];

export interface SavedPlanListEntryView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  /** Epoch milliseconds for the browser date APIs. */
  readonly createdAt: number;
  readonly inputBytes: number;
  readonly scheduleBytes: number | null;
  readonly scheduleAbsentReason: string | null;
}

export type SavedPlanSideRef = { readonly saved: string } | 'current';
export type PlanDiffView = Extract<
  ClientReply<typeof compareSavedPlans>,
  { kind: 'success' }
>['body']['diff'];
export type PlanDifferenceView = PlanDiffView['input'][number];
export type PlanDiffCategoryView = PlanDifferenceView['category'];

type WithBody<Reply, Body> =
  | Exclude<Reply, { kind: 'success' }>
  | (Omit<Extract<Reply, { kind: 'success' }>, 'body'> & { readonly body: Body });

export type SavedPlanListReply = WithBody<ListReply, { savedPlans: SavedPlanListEntryView[] }>;
export type SavedPlanSaveReply = WithBody<SaveReply, { savedPlan: SavedPlanListEntryView }>;
export type SavedPlanCompareReply = ClientReply<typeof compareSavedPlans>;
export type SavedPlanRenameReply = ClientReply<typeof renameSavedPlan>;
export type SavedPlanRemoveReply = ClientReply<typeof deleteSavedPlan>;

export interface SavedPlanApi {
  list(projectId: string): Promise<SavedPlanListReply>;
  save(projectId: string, name?: string): Promise<SavedPlanSaveReply>;
  rename(savedPlanId: string, name: string): Promise<SavedPlanRenameReply>;
  remove(savedPlanId: string): Promise<SavedPlanRemoveReply>;
  compare(
    projectId: string,
    left: SavedPlanSideRef,
    right: SavedPlanSideRef,
  ): Promise<SavedPlanCompareReply>;
}

/** Converts a typed client-boundary failure into the existing status-line code. */
export function savedPlanFailureCode(failure: ClientFailure): string {
  switch (failure.code) {
    case 'cancelled':
    case 'transport':
    case 'invalid_request':
      return failure.code;
    case 'unexpected_status':
      return `http_${String(failure.status)}`;
    case 'invalid_response':
      return 'unexpected_response';
    default:
      return unreachable(failure);
  }
}

function listEntry(wire: ListWire): SavedPlanListEntryView {
  return { ...wire, createdAt: wire.createdAt * 1000 };
}

function byteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

/** Save returns stored bodies; the confirmation needs the corresponding shelf header. */
function storedEntry(wire: StoredWire): SavedPlanListEntryView {
  return {
    id: wire.id,
    name: wire.name,
    createdBy: wire.createdBy,
    createdAt: wire.createdAt * 1000,
    inputBytes: byteLength(wire.input.bytes),
    scheduleBytes: wire.schedule.present ? byteLength(wire.schedule.body.bytes) : null,
    scheduleAbsentReason: wire.schedule.present ? null : wire.schedule.absentReason,
  };
}

const sideParam = (side: SavedPlanSideRef): string => (side === 'current' ? side : side.saved);

const client = browserClient([
  listSavedPlans,
  savePlan,
  compareSavedPlans,
  renameSavedPlan,
  deleteSavedPlan,
]);

// Proof: the former cast-based client threw `unsupported_body_version` for a
// complete 501 and admitted malformed known shelf fields; saved-plan-api.test.ts
// failed 10 cases before this shape-derived production path replaced it.

/** Every call is validated by its shared endpoint shape before this adapter maps view-only units. */
export function httpSavedPlanApi(): SavedPlanApi {
  return {
    async list(projectId) {
      const reply = await client['getApiProjectsByIdSaved-plans']({ params: { id: projectId } });
      if (reply.kind !== 'success') return reply;
      return {
        ...reply,
        body: { savedPlans: reply.body.savedPlans.map(listEntry) },
      };
    },
    async save(projectId, name) {
      const reply = await client['postApiProjectsByIdSaved-plans']({
        params: { id: projectId },
        body: { name },
      });
      if (reply.kind !== 'success') return reply;
      return { ...reply, body: { savedPlan: storedEntry(reply.body.savedPlan) } };
    },
    rename(savedPlanId, name) {
      return client['patchApiSaved-plansById']({
        params: { id: savedPlanId },
        body: { name },
      });
    },
    remove(savedPlanId) {
      return client['deleteApiSaved-plansById']({ params: { id: savedPlanId } });
    },
    compare(projectId, left, right) {
      return client['getApiProjectsByIdSaved-plansCompare']({
        params: { id: projectId },
        query: { left: sideParam(left), right: sideParam(right) },
      });
    },
  };
}
