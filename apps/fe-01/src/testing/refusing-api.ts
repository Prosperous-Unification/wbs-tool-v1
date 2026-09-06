import {
  addStep,
  clientFromShapes,
  createCalendarMarker,
  listCalendarMarkers,
  listExternalSystems,
  listPeople,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
  patchProject,
  removeCalendarMarker,
  removeStep,
  renameStep,
  updateCalendarMarker,
} from '@wbs/contracts';

import type { CalendarMarkerView, ProjectApi } from '@/lib/wbs-api';

/**
 * A {@link ProjectApi} whose every method refuses, except the ones a test
 * states.
 *
 * Four suites had each written this stand-in out by hand — `app-router`,
 * `page-shortcuts`, `project-page`, `plan-cards` — and every copy had drifted
 * the same way: seven methods the interface has grown since
 * (`setPriorityBands`, `setTeamCapacity`, `setDepReach`,
 * `setEstimateArithmetic`, `renameTag`, `removeTag`, `addWorkItemType`) were
 * missing from all four, and three carried stubs under names it had renamed
 * away (`create`, `patch`, `assign`, `move`, `remove`, `duplicate`, `freeze`,
 * `unfreeze`). No `typecheck` target compiled a test file here until
 * 2026-09-02, so nothing said so.
 *
 * One of those dead names made a **shipped proof vacuous**:
 * `page-shortcuts.test.tsx` asserts that a command chord behind a modal never
 * reaches the write, and it was watching a spy named `create` — a method
 * `ProjectApi` stopped having. The recorded proof says that assertion was once
 * seen failing on "`api.create` called once", and it could not have failed
 * again after the rename.
 *
 * A `Proxy` rather than 43 written-out refusals, so it cannot drift again:
 * anything the interface grows is refused here the day it is added, and a test
 * that reaches a method it did not state says so out loud instead of passing
 * against a silent default.
 *
 * Stated methods whose client view maps directly onto an endpoint run through
 * {@link clientFromShapes} with the answer as their in-process transport. The
 * same request, response, and refusal shapes therefore guard both this focused
 * fake and {@link fakeProjectApi}; a fixture cannot teach a screen a payload
 * the HTTP client would refuse.
 */
/** What makes an object thenable, and so must read as absent here. */
const PROMISE_PROTOCOL = new Set(['then', 'catch', 'finally']);

function boundaryFailure(failure: { code: string; cause?: unknown }): never {
  if (failure.code === 'transport') throw failure.cause;
  throw new Error(`fake_${failure.code}`);
}

function markerWire(projectId: string, marker: CalendarMarkerView) {
  return { ...marker, projectId, createdAt: 0 };
}

function markerView(marker: CalendarMarkerView): CalendarMarkerView {
  return { id: marker.id, date: marker.date, name: marker.name, color: marker.color };
}

function checkedAnswers(answers: Partial<ProjectApi>): Partial<ProjectApi> {
  const checked: Partial<ProjectApi> = {};
  const setOptimizationSettingsAnswer = answers.setOptimizationSettings;
  if (setOptimizationSettingsAnswer !== undefined) {
    checked.setOptimizationSettings = async (projectId, patch) => {
      const client = clientFromShapes([patchProject], async () => {
        await setOptimizationSettingsAnswer(projectId, patch);
        return {
          kind: 'json',
          status: 200,
          body: {
            project: {
              id: projectId,
              name: 'Fake project',
              ownerId: 'fake-owner',
              restricted: false,
              estimateMethod: 'pert',
              depReach: 'whole-item',
              pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
              estimateRounding: 'ceil',
              startDate: null,
              solutionRef: null,
              revision: 0,
              createdAt: 0,
              optimizationEnabled: patch.optimizationEnabled ?? false,
              scheduleEngine: patch.scheduleEngine ?? 'fast',
              scheduleObjective: patch.scheduleObjective ?? 'pri',
            },
          },
        };
      });
      const reply = await client.patchApiProjectsById({
        params: { id: projectId },
        body: patch,
      });
      // Proof: bypassing this generated call made malformed optimizer settings resolve
      // `undefined` instead of rejecting and invoked the mutation spy in refusing-api.test.ts.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
    };
  }

  const addStepAnswer = answers.addStep;
  if (addStepAnswer !== undefined) {
    checked.addStep = async (projectId, name) => {
      const client = clientFromShapes([addStep], async () => {
        try {
          const step = await addStepAnswer(projectId, name);
          return {
            kind: 'json',
            status: 200,
            body: { step: { ...step, projectId, position: 0 } },
          };
        } catch (cause) {
          if (!(cause instanceof Error)) throw cause;
          if (cause.message === 'taken')
            return { kind: 'json', status: 409, body: { error: 'taken' } };
          if (cause.message === 'name_required')
            return { kind: 'json', status: 422, body: { error: 'name_required' } };
          throw cause;
        }
      });
      const reply = await client.postApiProjectsByIdSteps({
        params: { id: projectId },
        body: { name },
      });
      // Proof: bypassing this generated call invoked the stated answer with a numeric
      // name; refusing-api.test.ts observed the mutation spy called and no rejection.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return { id: reply.body.step.id, name: reply.body.step.name };
    };
  }

  const listTeamsAnswer = answers.listTeams;
  if (listTeamsAnswer !== undefined) {
    checked.listTeams = async () => {
      const client = clientFromShapes([listTeams], async () => ({
        kind: 'json',
        status: 200,
        body: { teams: await listTeamsAnswer() },
      }));
      const reply = await client.getApiTeams({});
      // Proof: returning a team without serviceIds made this call reject with
      // fake_invalid_response in refusing-api.test.ts instead of reaching a screen.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.teams;
    };
  }

  const listPeopleAnswer = answers.listPeople;
  if (listPeopleAnswer !== undefined) {
    checked.listPeople = async () => {
      const client = clientFromShapes([listPeople], async () => ({
        kind: 'json',
        status: 200,
        body: { people: await listPeopleAnswer() },
      }));
      const reply = await client.getApiPeople({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.people;
    };
  }

  const listTagsAnswer = answers.listTags;
  if (listTagsAnswer !== undefined) {
    checked.listTags = async () => {
      const client = clientFromShapes([listTags], async () => ({
        kind: 'json',
        status: 200,
        body: { tags: await listTagsAnswer() },
      }));
      const reply = await client.getApiTags({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.tags;
    };
  }

  const listServicesAnswer = answers.listServices;
  if (listServicesAnswer !== undefined) {
    checked.listServices = async () => {
      const client = clientFromShapes([listServices], async () => ({
        kind: 'json',
        status: 200,
        body: { services: await listServicesAnswer() },
      }));
      const reply = await client.getApiServices({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.services;
    };
  }

  const listWorkItemTypesAnswer = answers.listWorkItemTypes;
  if (listWorkItemTypesAnswer !== undefined) {
    checked.listWorkItemTypes = async () => {
      const client = clientFromShapes([listWorkItemTypes], async () => ({
        kind: 'json',
        status: 200,
        body: { workItemTypes: await listWorkItemTypesAnswer() },
      }));
      const reply = await client['getApiWork-item-types']({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.workItemTypes;
    };
  }

  const listExternalSystemsAnswer = answers.listExternalSystems;
  if (listExternalSystemsAnswer !== undefined) {
    checked.listExternalSystems = async () => {
      const client = clientFromShapes([listExternalSystems], async () => ({
        kind: 'json',
        status: 200,
        body: { externalSystems: await listExternalSystemsAnswer() },
      }));
      const reply = await client['getApiExternal-systems']({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.externalSystems;
    };
  }

  const listCalendarMarkersAnswer = answers.listCalendarMarkers;
  if (listCalendarMarkersAnswer !== undefined) {
    checked.listCalendarMarkers = async (projectId) => {
      const client = clientFromShapes([listCalendarMarkers], async () => ({
        kind: 'json',
        status: 200,
        body: {
          markers: (await listCalendarMarkersAnswer(projectId)).map((marker) =>
            markerWire(projectId, marker),
          ),
        },
      }));
      const reply = await client['getApiProjectsByIdCalendar-markers']({
        params: { id: projectId },
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.markers.map(markerView);
    };
  }

  const createCalendarMarkerAnswer = answers.createCalendarMarker;
  if (createCalendarMarkerAnswer !== undefined) {
    checked.createCalendarMarker = async (projectId, marker) => {
      const client = clientFromShapes([createCalendarMarker], async () => ({
        kind: 'json',
        status: 201,
        body: {
          marker: markerWire(projectId, await createCalendarMarkerAnswer(projectId, marker)),
        },
      }));
      const reply = await client['postApiProjectsByIdCalendar-markers']({
        params: { id: projectId },
        body: marker,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const renameCalendarMarkerAnswer = answers.renameCalendarMarker;
  if (renameCalendarMarkerAnswer !== undefined) {
    checked.renameCalendarMarker = async (projectId, markerId, name) => {
      const client = clientFromShapes([updateCalendarMarker], async () => ({
        kind: 'json',
        status: 200,
        body: {
          marker: markerWire(
            projectId,
            await renameCalendarMarkerAnswer(projectId, markerId, name),
          ),
        },
      }));
      const reply = await client['patchApiProjectsByIdCalendar-markersByMarkerId']({
        params: { id: projectId, markerId },
        body: { name },
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const recolorCalendarMarkerAnswer = answers.recolorCalendarMarker;
  if (recolorCalendarMarkerAnswer !== undefined) {
    checked.recolorCalendarMarker = async (projectId, markerId, color) => {
      const client = clientFromShapes([updateCalendarMarker], async () => ({
        kind: 'json',
        status: 200,
        body: {
          marker: markerWire(
            projectId,
            await recolorCalendarMarkerAnswer(projectId, markerId, color),
          ),
        },
      }));
      const reply = await client['patchApiProjectsByIdCalendar-markersByMarkerId']({
        params: { id: projectId, markerId },
        body: { color },
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const deleteCalendarMarkerAnswer = answers.deleteCalendarMarker;
  if (deleteCalendarMarkerAnswer !== undefined) {
    checked.deleteCalendarMarker = async (projectId, markerId) => {
      const client = clientFromShapes([removeCalendarMarker], async () => {
        await deleteCalendarMarkerAnswer(projectId, markerId);
        return { kind: 'empty', status: 204 };
      });
      const reply = await client['deleteApiProjectsByIdCalendar-markersByMarkerId']({
        params: { id: projectId, markerId },
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
    };
  }

  const renameStepAnswer = answers.renameStep;
  if (renameStepAnswer !== undefined) {
    checked.renameStep = async (projectId, stepId, name) => {
      const client = clientFromShapes([renameStep], async () => {
        try {
          const step = await renameStepAnswer(projectId, stepId, name);
          return {
            kind: 'json',
            status: 200,
            body: { step: { ...step, projectId, position: 0 } },
          };
        } catch (cause) {
          if (!(cause instanceof Error)) throw cause;
          if (cause.message === 'taken')
            return { kind: 'json', status: 409, body: { error: 'taken' } };
          if (cause.message === 'name_required')
            return { kind: 'json', status: 422, body: { error: 'name_required' } };
          if (cause.message === 'not_found')
            return { kind: 'json', status: 404, body: { error: 'not_found' } };
          throw cause;
        }
      });
      const reply = await client.patchApiProjectsByIdStepsByStepId({
        params: { id: projectId, stepId },
        body: { name },
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return { id: reply.body.step.id, name: reply.body.step.name };
    };
  }

  const removeStepAnswer = answers.removeStep;
  if (removeStepAnswer !== undefined) {
    checked.removeStep = async (projectId, stepId, cascade) => {
      const client = clientFromShapes([removeStep], async () => {
        const removal = await removeStepAnswer(projectId, stepId, cascade);
        return removal.ok
          ? { kind: 'empty' as const, status: 204 }
          : {
              kind: 'json' as const,
              status: 409,
              body: { error: 'in_use' as const, inUse: removal.inUse },
            };
      });
      const reply = await client.deleteApiProjectsByIdStepsByStepId({
        params: { id: projectId, stepId },
        query: { cascade: cascade ? 'true' : undefined },
      });
      // Proof: omitting five usage counters from the fake refusal made this call reject
      // with fake_invalid_response in refusing-api.test.ts instead of exposing a partial union.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') {
        if (reply.body.error === 'in_use')
          return { ok: false, reason: 'in_use', inUse: reply.body.inUse };
        throw new Error(reply.body.error);
      }
      return { ok: true };
    };
  }
  return checked;
}

export function refusingApi<Answers extends Partial<ProjectApi>>(
  answers: Answers,
): ProjectApi & Answers {
  return new Proxy(answers as ProjectApi, {
    get(target, key) {
      // Proof: replacing this lookup with `undefined` made all three boundary cases in
      // refusing-api.test.ts resolve instead of reject: malformed request, response, and refusal.
      const shaped: unknown = Reflect.get(checkedAnswers(target), key);
      if (shaped !== undefined) return shaped;
      const stated: unknown = Reflect.get(target, key);
      if (stated !== undefined) return stated;
      // Absent, not refused, for anything that is not a method name this api
      // could have. `then` is the one that matters: a proxy handing back a
      // function for it **is** a thenable, so awaiting anything that holds this
      // object calls it — 34 of `plan-cards.test.tsx`'s 118 cases failed on
      // `api.then is not one this test answers`, watched 2026-09-02, before
      // this line existed.
      if (typeof key !== 'string' || PROMISE_PROTOCOL.has(key)) return undefined;
      return () => Promise.reject(new Error(`api.${key} is not one this test answers`));
    },
  }) as ProjectApi & Answers;
}
