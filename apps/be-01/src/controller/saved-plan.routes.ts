import {
  compareSavedPlans,
  deleteSavedPlan,
  listSavedPlans,
  readSavedPlan,
  renameSavedPlan,
  savePlan,
} from '@wbs/contracts';

import { bind, EMPTY, type HttpReply, type RequestFailure } from '../http/endpoint';
import type { Broadcaster } from '../service/broadcast';
import { canEdit, type ProjectService } from '../service/project.service';
import type {
  SavedPlanService,
  SavedPlanSideRef,
  SavedPlanTouchResult,
} from '../service/saved-plan.service';
import { UnknownSavedPlanBodyVersionError } from '../service/saved-plan-integrity';

/**
 * The reserved current sentinel names the live plan in the addressed project.
 * Proof: using live sent kind:saved/savedPlanId:current instead of kind:current
 * to compare in the mounted compare case (saved-plan.controller.db.test.ts).
 */
function sideRef(side: string): SavedPlanSideRef {
  return side === 'current' ? { kind: 'current' } : { kind: 'saved', savedPlanId: side };
}

/**
 * Unsupported stored versions require a newer build; unknown failures still throw.
 * Proof: changing501 to400 or dropping supported returned500 instead of501;
 * catching unknown errors as not_found returned404 instead of500, all in the
 * mounted known-version case (saved-plan.controller.db.test.ts).
 */
function versionRefusal(error: unknown) {
  if (!(error instanceof UnknownSavedPlanBodyVersionError)) throw error;
  const supported = [...error.supported];
  return {
    ok: false,
    status: 501,
    body: {
      error: 'unsupported_body_version',
      savedPlanId: error.savedPlanId,
      body: error.body,
      version: error.version,
      supported,
    },
  } as const;
}

/**
 * Classifies only the named service operation; project lookups and announcements
 * are outside this catch because their failures say nothing about stored plan versions.
 * Proof: broad handler catches returned501 instead of500 independently for project
 * and announcement errors in saved-plan.controller.db.test.ts's version-shaped cases.
 */
async function callSavedPlan<T>(operation: () => Promise<T>) {
  try {
    return { ok: true, value: await operation() } as const;
  } catch (error) {
    return versionRefusal(error);
  }
}

/**
 * Name bodies retain structural 422; malformed JSON and other request parts use 400.
 * Proof: mapping structural bodies to400 returned500 instead of422 in the
 * mounted name-admission case (saved-plan.controller.db.test.ts).
 */
function classifyNameFailure(failure: RequestFailure) {
  switch (failure.code) {
    case 'invalid_body':
      return { ok: false, status: 422, body: { error: 'invalid_body' } } as const;
    case 'invalid_json':
      return { ok: false, status: 400, body: { error: 'invalid_json' } } as const;
    case 'invalid_params':
      return { ok: false, status: 400, body: { error: 'invalid_params' } } as const;
    case 'invalid_query':
      return { ok: false, status: 400, body: { error: 'invalid_query' } } as const;
  }
}

/**
 * Lock contention is retryable 503; permission and missing-record refusals retain their own status.
 * Proof: changing503 to400 returned500 instead of503 in the mounted contention
 * case (saved-plan.controller.db.test.ts).
 */
function touchRefusal(outcome: Exclude<SavedPlanTouchResult['outcome'], 'touched'>) {
  switch (outcome) {
    case 'forbidden':
      return { ok: false, status: 403, body: { error: outcome } } as const;
    case 'not_found':
      return { ok: false, status: 404, body: { error: outcome } } as const;
    case 'snapshot_busy':
      return { ok: false, status: 503, body: { error: outcome } } as const;
  }
}

/**
 * Six saved-plan operations. Saves use project write access; rename/delete defer
 * to the service's creator-or-owner rule. Actor identity comes from policy admission.
 * Successful mutations announce only after the service commits and releases its
 * lock, through the shared per-caller DeferringBroadcaster. Refusals publish nothing.
 */
export function savedPlanRoutes(
  plans: SavedPlanService,
  projects: ProjectService,
  announcements: Broadcaster,
) {
  return [
    bind(
      savePlan,
      async ({ params, body, principal }): Promise<HttpReply<typeof savePlan>> => {
        const found = await projects.read(params.id);
        if (found === null) return { ok: false, status: 404, body: { error: 'not_found' } };
        if (!canEdit(found.project, principal.id))
          return { ok: false, status: 403, body: { error: 'forbidden' } };
        const called = await callSavedPlan(() =>
          plans.save({
            projectId: params.id,
            name: body.name,
            createdBy: principal.username,
            createdById: principal.id,
          }),
        );
        if (!called.ok) return called;
        const outcome = called.value;
        switch (outcome.outcome) {
          case 'saved':
            // Proof: removing publication left [] instead of the saved_plans_changed
            // event in the existing announces-a-save controller case.
            await announcements.publish(params.id, { type: 'saved_plans_changed' });
            return { ok: true, status: 201, body: { savedPlan: outcome.record } };
          case 'no_project':
            return { ok: false, status: 404, body: { error: 'not_found' } };
          case 'snapshot_busy':
            return { ok: false, status: 503, body: { error: 'snapshot_busy' } };
          case 'refused':
            // Proof: dropping quota detail returned500 instead of409 in the
            // mounted quota case (saved-plan.controller.db.test.ts).
            return { ok: false, status: 409, body: { error: 'quota', refusal: outcome.refusal } };
        }
      },
      {
        classifyRequestFailure: classifyNameFailure,
      },
    ),
    bind(listSavedPlans, async ({ params }): Promise<HttpReply<typeof listSavedPlans>> => {
      if ((await projects.read(params.id)) === null)
        return { ok: false, status: 404, body: { error: 'not_found' } };
      const called = await callSavedPlan(() => plans.list(params.id));
      if (!called.ok) return called;
      return { ok: true, status: 200, body: { savedPlans: [...called.value] } };
    }),
    bind(
      compareSavedPlans,
      async ({ params, query }): Promise<HttpReply<typeof compareSavedPlans>> => {
        if ((await projects.read(params.id)) === null)
          return { ok: false, status: 404, body: { error: 'not_found' } };
        const called = await callSavedPlan(() =>
          plans.compare(params.id, sideRef(query.left), sideRef(query.right)),
        );
        if (!called.ok) return called;
        const outcome = called.value;
        switch (outcome.outcome) {
          case 'compared':
            return {
              ok: true,
              status: 200,
              body: {
                diff: {
                  input: [...outcome.diff.input],
                  schedule: [...outcome.diff.schedule],
                },
              },
            };
          case 'corrupt':
            // Proof: dropping the corrupt side id returned500 instead of422
            // in the mounted compare case (saved-plan.controller.db.test.ts).
            return {
              ok: false,
              status: 422,
              body: {
                error: 'corrupt',
                savedPlanId: outcome.savedPlanId,
                refusal: outcome.refusal,
              },
            };
          case 'no_project':
            return { ok: false, status: 404, body: { error: 'not_found' } };
          case 'not_found':
            return {
              ok: false,
              status: 404,
              body: { error: 'not_found', savedPlanId: outcome.savedPlanId },
            };
        }
      },
      {
        classifyRequestFailure: (failure) =>
          failure.code === 'invalid_query'
            ? { ok: false, status: 422, body: { error: 'invalid_query' } }
            : failure.part === 'params'
              ? { ok: false, status: 400, body: { error: 'invalid_params' } }
              : { ok: false, status: 400, body: { error: 'invalid_body' } },
      },
    ),
    bind(readSavedPlan, async ({ params }): Promise<HttpReply<typeof readSavedPlan>> => {
      const called = await callSavedPlan(() => plans.read(params.id));
      if (!called.ok) return called;
      const outcome = called.value;
      switch (outcome.outcome) {
        case 'read':
          return { ok: true, status: 200, body: { savedPlan: outcome.plan } };
        case 'not_found':
          return { ok: false, status: 404, body: { error: 'not_found' } };
        case 'corrupt':
          return { ok: false, status: 422, body: { error: 'corrupt', refusal: outcome.refusal } };
      }
    }),
    bind(
      renameSavedPlan,
      async ({ params, body, principal }): Promise<HttpReply<typeof renameSavedPlan>> => {
        const called = await callSavedPlan(() => plans.rename(params.id, principal.id, body.name));
        if (!called.ok) return called;
        const outcome = called.value;
        if (outcome.outcome !== 'touched') return touchRefusal(outcome.outcome);
        await announcements.publish(outcome.projectId, { type: 'saved_plans_changed' });
        return { ok: true, status: 200, body: { savedPlanId: params.id, name: body.name } };
      },
      {
        classifyRequestFailure: classifyNameFailure,
      },
    ),
    bind(
      deleteSavedPlan,
      async ({ params, principal }): Promise<HttpReply<typeof deleteSavedPlan>> => {
        const called = await callSavedPlan(() => plans.delete(params.id, principal.id));
        if (!called.ok) return called;
        const outcome = called.value;
        if (outcome.outcome !== 'touched') return touchRefusal(outcome.outcome);
        await announcements.publish(outcome.projectId, { type: 'saved_plans_changed' });
        return { ok: true, status: 204, body: EMPTY };
      },
    ),
  ] as const;
}
