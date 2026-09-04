/**
 * The browser's side of the saved-plan routes: list, save, rename, delete and
 * compare, plus the one question that has to be asked *before* any of them —
 * whether this node serves them at all.
 *
 * Split out of `wbs-api.ts` rather than added to it. That file is the plan
 * client: one token, one project, a read that is replaced rather than patched,
 * and 2200 lines of vocabulary the saved-plan surfaces never touch. These six
 * routes share only the header and the error convention, and both are eight
 * lines. A saved plan is also the one thing in this app that outlives the plan
 * it was taken from, so a module boundary here is the honest one.
 *
 * Wire types are declared, not imported, for `wbs-api.ts`'s reason: `libs/domain`
 * pulls arktype in for its runtime validation and none of that belongs in a
 * browser bundle. be-01 validates at its boundary; this is a description of what
 * comes back.
 */

/** The header the edge does not read; see `lib/api.ts` for why it is never `Authorization`. */
const auth = (token: string) => ({ 'content-type': 'application/json', 'x-wbs-token': token });

/**
 * Where be-01 serves its OpenAPI document. Mirrors `OPENAPI_SPEC_PATH` in
 * `apps/be-01/src/openapi/openapi-plugin.ts`.
 */
export const OPENAPI_SPEC_PATH = '/api/openapi.json';

/**
 * The three templated paths the six saved-plan routes live on, exactly as the
 * emitted document spells them.
 *
 * Three and not six because a document lists a path once and its methods under
 * it. Presence of the path is the question — a node that serves
 * `/api/saved-plans/{id}` serves all three of its methods, because they were
 * added in one migration and there is no build in which they diverge.
 */
export const SAVED_PLAN_SPEC_PATHS = [
  '/api/projects/{id}/saved-plans',
  '/api/projects/{id}/saved-plans/compare',
  '/api/saved-plans/{id}',
] as const;

/**
 * Whether this node has the saved-plan routes.
 *
 * **The discriminator is the served document, never a status code**, and that
 * is the whole design of this function. A node from before the migration has no
 * such route, and an unmatched route in this app answers a bare 404 with no body
 * this client can read — the same bare 404 a *mistyped project id* produces on a
 * node that does have the routes. Reading unavailability out of a 404 therefore
 * tells a user with a typo that their server is out of date, and tells a user on
 * an old server nothing they can act on.
 *
 * Asking the document first also means the question is asked once, before any
 * surface is drawn, rather than being re-derived from every failed request.
 *
 * A document that cannot be fetched or parsed is **not** an absent capability:
 * it throws, and the caller shows an error. "Not available on this node yet" is
 * a specific claim about a specific server, and it is only made when a document
 * was really read and really lacked the paths.
 */
export async function savedPlansAvailable(): Promise<boolean> {
  const res = await fetch(OPENAPI_SPEC_PATH);
  if (!res.ok) throw new Error(`http_${String(res.status)}`);
  const document = (await res.json()) as { paths?: Record<string, unknown> };
  const paths = document.paths;
  if (paths === undefined) throw new Error('unexpected_response');
  return SAVED_PLAN_SPEC_PATHS.every((path) => Object.hasOwn(paths, path));
}

/** One row of a project's shelf, as `SavedPlanListEntry` in be-01 serialises it. */
export interface SavedPlanListEntryView {
  readonly id: string;
  readonly name: string;
  /** The username recorded at save time, kept even if that account is later deleted. */
  readonly createdBy: string;
  /**
   * Epoch **milliseconds**, and be-01's clock rather than the browser's — but
   * be-01 does not send milliseconds. See {@link savedPlanEntry}.
   */
  readonly createdAt: number;
  readonly inputBytes: number;
  /** The schedule side's stored length, or `null` for a schedule-less save. */
  readonly scheduleBytes: number | null;
  /**
   * Why there is no schedule, or `null` when there is one.
   *
   * `string` and not a union, exactly as be-01's list types it: the column is
   * `text` and the read path passes an unrecognised reason through rather than
   * refusing a plan over a label that says nothing about its bytes. A client
   * that narrowed harder than the server would hide a plan the server is
   * willing to hand over.
   */
  readonly scheduleAbsentReason: string | null;
}

/** Which plan a comparison side names: a saved plan by id, or the live one. */
export type SavedPlanSideRef = { readonly saved: string } | 'current';

const sideParam = (side: SavedPlanSideRef): string => (side === 'current' ? 'current' : side.saved);

/** `PlanDiffCategory` in `libs/domain`, mirrored. */
export type PlanDiffCategoryView =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'reparented'
  | 'reordered'
  | 'estimates'
  | 'uncertainty'
  | 'actuals'
  | 'progress'
  | 'measures'
  | 'ownership'
  | 'dependencies'
  | 'settings'
  | 'freeze'
  | 'type'
  | 'tags'
  | 'external-references'
  | 'notes'
  | 'priority'
  | 'max-parallel'
  | 'service-assignment'
  | 'start-no-earlier-than'
  | 'priority-bands'
  | 'capacity'
  | 'registry'
  | 'dates'
  | 'other';

export interface PlanDifferenceView {
  readonly category: PlanDiffCategoryView;
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
}

/** The two halves stay separate here because they are bounded separately upstream. */
export interface PlanDiffView {
  readonly input: readonly PlanDifferenceView[];
  readonly schedule: readonly PlanDifferenceView[];
}

/**
 * What a save answered.
 *
 * The two refusals are modeled rather than thrown because 8.5 needs them said in
 * different words: `snapshot_busy` is "somebody else is writing, try again" and
 * a quota refusal has to name the limit reached. A thrown code loses the
 * `refusal` beside it, which is the sentence the quota case is made of.
 */
export type SavedPlanSaveResult =
  | { readonly outcome: 'saved'; readonly savedPlan: SavedPlanListEntryView }
  | { readonly outcome: 'snapshot_busy' }
  | { readonly outcome: 'quota'; readonly refusal: string };

/**
 * What a rename or delete answered.
 *
 * `forbidden` and `not_found` are separate answers and not one "it did not
 * work": a plan somebody else saved is still on the shelf and still readable,
 * and telling its reader it does not exist would be a lie about a row they can
 * see.
 */
export type SavedPlanTouchResultView =
  | { readonly outcome: 'touched' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'snapshot_busy' };

/**
 * What a comparison answered.
 *
 * `corrupt` carries the id **because there are two sides**: a refusal naming no
 * plan leaves the user unable to tell which picker holds the damaged one. That
 * is be-01's reason for putting `savedPlanId` on its 422, and it is only worth
 * anything if the client keeps it.
 *
 * `not_found` carries an optional id for the same reason and with the same
 * limit: a missing *project* names nothing, a missing *side* names itself.
 */
export type SavedPlanCompareResult =
  | { readonly outcome: 'compared'; readonly diff: PlanDiffView }
  | { readonly outcome: 'not_found'; readonly savedPlanId: string | null }
  | { readonly outcome: 'corrupt'; readonly savedPlanId: string; readonly refusal: string };

export interface SavedPlanApi {
  /** The project's shelf, newest first as be-01 orders it. Throws `not_found` for an unknown project. */
  list(projectId: string): Promise<SavedPlanListEntryView[]>;
  /**
   * Writes a checkpoint immediately.
   *
   * **`name` is optional, and omitting it is the normal path** — assumption
   * A-1. An earlier revision of this comment said the default was "defaulted by
   * the *caller*, not here", and then said in its own next clause why no caller
   * on this side of the wire can do it: the default is the server's timestamp
   * for the record it is about to create, and no clock in a browser is that
   * clock. be-01 now supplies it (`defaultSavedPlanName`, off the same
   * `created_at` it writes), so the two ends agree instead of each correctly
   * refusing.
   *
   * Absent means **the key is not sent at all**, not sent as `null` or `''`:
   * `minLength: 1` still guards a name that is sent, so `''` is a 422 and never
   * a silent default, and that distinction only survives if this layer omits
   * rather than empties.
   */
  save(projectId: string, name?: string): Promise<SavedPlanSaveResult>;
  rename(savedPlanId: string, name: string): Promise<SavedPlanTouchResultView>;
  remove(savedPlanId: string): Promise<SavedPlanTouchResultView>;
  compare(
    projectId: string,
    left: SavedPlanSideRef,
    right: SavedPlanSideRef,
  ): Promise<SavedPlanCompareResult>;
}

/**
 * Reads be-01's `{ error }` out of a body, falling back to the status.
 *
 * Duplicated from `wbs-api.ts` rather than exported from it: importing would
 * make this module depend on 2200 lines it otherwise does not touch, to reuse
 * six. The convention is be-01's, not either module's.
 */
async function refusalCode(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? `http_${String(res.status)}`;
  } catch {
    // A proxy error page rather than our JSON — the status is all there is.
    return `http_${String(res.status)}`;
  }
}

/** The subset of `SavedPlanTouchResultView` a status line can answer, or `null` for anything else. */
function touchRefusal(code: string): SavedPlanTouchResultView | null {
  return code === 'not_found' || code === 'forbidden' || code === 'snapshot_busy'
    ? { outcome: code }
    : null;
}

/**
 * What be-01 puts on the wire for one shelf row: the view's shape, with
 * `createdAt` in the unit the column really holds.
 *
 * Epoch **seconds**. `boot.ts` builds `SavedPlanService` with
 * `now: () => Math.floor(Date.now() / 1000)` "matching the column", and the
 * service's contract says the same.
 */
type SavedPlanListEntryWire = Omit<SavedPlanListEntryView, 'createdAt'> & {
  readonly createdAt: number;
};

/**
 * The one place seconds become milliseconds, and the reason there is exactly
 * one.
 *
 * be-01 stores and serves epoch **seconds**; every browser API that turns a
 * number into a date — `new Date(n)`, `toISOString`, `toLocaleString` — takes
 * milliseconds. The raw value went straight into `new Date(...)` in both the
 * shelf list and the save confirmation, so a checkpoint saved in September 2026
 * was shown as **21 January 1970**. Sol's I1 on PR 202, and the client type
 * claimed milliseconds while the server contract said seconds, so both sides
 * were internally consistent and wrong about each other.
 *
 * **Converted here rather than at the server**, and that is a decision and not
 * an accident: `created_at` is an `integer` column of epoch seconds with rows
 * already in it, so changing the wire unit is a data migration plus a
 * compatibility window for older clients, to fix a defect that lives entirely in
 * one browser boundary. The unit crosses the network as be-01 defines it and is
 * normalised on arrival, which is what {@link SavedPlanListEntryView.createdAt}
 * now documents.
 *
 * Both callers go through this: `list` and the `save` confirmation, which is the
 * other place the raw number reached a `new Date`.
 */
function savedPlanEntry(wire: SavedPlanListEntryWire): SavedPlanListEntryView {
  return { ...wire, createdAt: wire.createdAt * 1000 };
}

export function httpSavedPlanApi(token: string): SavedPlanApi {
  const headers = auth(token);
  return {
    async list(projectId) {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/saved-plans`, {
        headers,
      });
      if (!res.ok) throw new Error(await refusalCode(res));
      return ((await res.json()) as { savedPlans: SavedPlanListEntryWire[] }).savedPlans.map(
        savedPlanEntry,
      );
    },

    async save(projectId, name) {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/saved-plans`, {
        method: 'POST',
        headers,
        // `{}` and not `{ name: undefined }` — those serialise to the same
        // bytes today, but the second one is a shape somebody later "tidies"
        // into `{ name: name ?? '' }`, which is a 422 the user cannot read. The
        // conditional spread says the intent the wire cannot: no name was
        // chosen, so the server chooses.
        body: JSON.stringify(name === undefined ? {} : { name }),
      });
      if (res.ok) {
        return {
          outcome: 'saved',
          savedPlan: savedPlanEntry(
            ((await res.json()) as { savedPlan: SavedPlanListEntryWire }).savedPlan,
          ),
        };
      }
      const text = await res.text();
      let body: { error?: string; refusal?: string } = {};
      try {
        body = JSON.parse(text) as { error?: string; refusal?: string };
      } catch {
        // Fall through to the throw: a non-JSON failure is not a modeled refusal.
      }
      if (body.error === 'snapshot_busy') return { outcome: 'snapshot_busy' };
      // Both halves are asked for. A `quota` with no sentence in it is a be-01
      // that has changed shape, and "you have reached the limit of" with nothing
      // after it is worse than the raw code.
      if (body.error === 'quota' && body.refusal !== undefined) {
        return { outcome: 'quota', refusal: body.refusal };
      }
      throw new Error(body.error ?? `http_${String(res.status)}`);
    },

    async rename(savedPlanId, name) {
      const res = await fetch(`/api/saved-plans/${encodeURIComponent(savedPlanId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name }),
      });
      if (res.ok) return { outcome: 'touched' };
      const refusal = touchRefusal(await refusalCode(res));
      if (refusal !== null) return refusal;
      throw new Error(`http_${String(res.status)}`);
    },

    async remove(savedPlanId) {
      const res = await fetch(`/api/saved-plans/${encodeURIComponent(savedPlanId)}`, {
        method: 'DELETE',
        headers,
      });
      if (res.ok) return { outcome: 'touched' };
      const refusal = touchRefusal(await refusalCode(res));
      if (refusal !== null) return refusal;
      throw new Error(`http_${String(res.status)}`);
    },

    async compare(projectId, left, right) {
      const query = new URLSearchParams({ left: sideParam(left), right: sideParam(right) });
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/saved-plans/compare?${query.toString()}`,
        { headers },
      );
      if (res.ok)
        return { outcome: 'compared', diff: ((await res.json()) as { diff: PlanDiffView }).diff };
      const text = await res.text();
      let body: { error?: string; savedPlanId?: string; refusal?: string } = {};
      try {
        body = JSON.parse(text) as { error?: string; savedPlanId?: string; refusal?: string };
      } catch {
        // Fall through: a non-JSON failure names no side and is not a refusal.
      }
      if (body.error === 'corrupt' && body.savedPlanId !== undefined) {
        return { outcome: 'corrupt', savedPlanId: body.savedPlanId, refusal: body.refusal ?? '' };
      }
      if (body.error === 'not_found') {
        return { outcome: 'not_found', savedPlanId: body.savedPlanId ?? null };
      }
      throw new Error(body.error ?? `http_${String(res.status)}`);
    },
  };
}
