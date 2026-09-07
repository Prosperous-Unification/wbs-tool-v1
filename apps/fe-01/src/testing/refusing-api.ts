import type {
  ClientInput,
  ClientReply,
  EndpointShape,
  PreflightInput,
  RequestPreflight,
  TransportInput,
} from '@wbs/contracts';
import {
  addStep,
  applyDirectoryCommands,
  applyProjectCommands,
  clientFromShapes,
  createCalendarMarker,
  createProject,
  getWorkItems,
  listCalendarMarkers,
  listExternalSystems,
  listPeople,
  listProjects,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
  patchProject,
  preflightRequest,
  readProject,
  recordProjectOpen,
  redoProject,
  removeCalendarMarker,
  removeStep,
  renameStep,
  undoProject,
  updateCalendarMarker,
} from '@wbs/contracts';

import type {
  CalendarMarkerView,
  DeleteOptions,
  PlanRead,
  ProjectApi,
  WbsOperationId,
} from '@/lib/wbs-api';

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

function isFacadeSuccess<Answer extends { readonly ok: boolean }>(
  answer: Answer,
): answer is Extract<Answer, { readonly ok: true }> {
  const discriminator: unknown = answer.ok;
  // Proof: treating a truthy "yes" as success made the undo boundary test resolve
  // { ok: true, done: "rename", detail: null } instead of fake_invalid_response.
  return discriminator === true;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function requireValidRequest<Shape extends EndpointShape>(
  preflight: RequestPreflight<Shape>,
): PreflightInput<Shape> {
  if (preflight.kind === 'failure') boundaryFailure(preflight.failure);
  return preflight.input;
}

function preflightFakeRequest<Shape extends EndpointShape>(
  shape: Shape,
  input: Partial<TransportInput>,
): PreflightInput<Shape> | Promise<PreflightInput<Shape>> {
  const preflight = preflightRequest(shape, input);
  if (isPromiseLike(preflight))
    return Promise.resolve(preflight).then((completed) => requireValidRequest(completed));
  return requireValidRequest(preflight);
}

interface StartedMutation<Shape extends EndpointShape, Answer> {
  prepared: PreflightInput<Shape>;
  mutation: Promise<Answer>;
}

function startMutation<Shape extends EndpointShape, Answer>(
  shape: Shape,
  input: Partial<TransportInput>,
  mutate: (prepared: PreflightInput<Shape>) => Promise<Answer>,
): StartedMutation<Shape, Answer> | Promise<StartedMutation<Shape, Answer>> {
  const preflight = preflightFakeRequest(shape, input);
  const start = (prepared: PreflightInput<Shape>): StartedMutation<Shape, Answer> => ({
    prepared,
    // Proof: letting clientFromShapes start createCalendarMarker passed color: undefined;
    // the focused exact-call test received that key instead of the normalized marker.
    mutation: mutate(prepared),
  });
  return isPromiseLike(preflight) ? Promise.resolve(preflight).then(start) : start(preflight);
}

function requiredNormalized<Value>(value: Value | undefined): Value {
  // Proof: without this guard, normalized-away marker name/color values reached their
  // mutations; the focused negatives received fake_invalid_response or resolved successfully.
  if (value === undefined) throw new Error('fake_invalid_request');
  return value;
}

function emptyWhenUndefined<Value>(value: Value | undefined, empty: Value): Value {
  if (value === undefined) return empty;
  return value;
}

function markerWire(projectId: string, marker: CalendarMarkerView) {
  return { ...marker, projectId, createdAt: 0 };
}

function markerView(marker: CalendarMarkerView): CalendarMarkerView {
  return { id: marker.id, date: marker.date, name: marker.name, color: marker.color };
}

type ProjectPatch = ClientInput<typeof patchProject>['body'];
type ProjectCommand = ClientInput<typeof applyProjectCommands>['body']['commands'][number];
type DirectoryCommand = ClientInput<typeof applyDirectoryCommands>['body']['commands'][number];
type ProjectCommandResult = Extract<
  ClientReply<typeof applyProjectCommands>,
  { kind: 'success' }
>['body']['results'][number];
type DirectoryCommandResult = Extract<
  ClientReply<typeof applyDirectoryCommands>,
  { kind: 'success' }
>['body']['results'][number];

// Proof: deleting removeDependency made the spec typecheck fail with TS1360:
// "Property 'removeDependency' is missing" from this Record<keyof ProjectApi, ...>.
const PROJECT_API_OPERATIONS = {
  listProjects: 'getApiProjects',
  createProject: 'postApiProjects',
  openProject: 'postApiProjectsByIdOpened',
  renameProject: 'patchApiProjectsById',
  tree: 'getApiProjectsByIdWork-items',
  undo: 'postApiProjectsByIdUndo',
  redo: 'postApiProjectsByIdRedo',
  setEstimateMethod: 'patchApiProjectsById',
  setEstimateArithmetic: 'patchApiProjectsById',
  setDepReach: 'patchApiProjectsById',
  setOptimizationSettings: 'patchApiProjectsById',
  setStartDate: 'patchApiProjectsById',
  listCalendarMarkers: 'getApiProjectsByIdCalendar-markers',
  createCalendarMarker: 'postApiProjectsByIdCalendar-markers',
  renameCalendarMarker: 'patchApiProjectsByIdCalendar-markersByMarkerId',
  recolorCalendarMarker: 'patchApiProjectsByIdCalendar-markersByMarkerId',
  deleteCalendarMarker: 'deleteApiProjectsByIdCalendar-markersByMarkerId',
  setTeamCapacity: 'postApiProjectsByIdCommands',
  setPriorityBands: 'postApiProjectsByIdCommands',
  steps: 'getApiProjectsById',
  addStep: 'postApiProjectsByIdSteps',
  renameStep: 'patchApiProjectsByIdStepsByStepId',
  removeStep: 'deleteApiProjectsByIdStepsByStepId',
  createWorkItem: 'postApiProjectsByIdCommands',
  patchWorkItem: 'postApiProjectsByIdCommands',
  listTeams: 'getApiTeams',
  listTags: 'getApiTags',
  listServices: 'getApiServices',
  addService: 'postApiDirectoryCommands',
  listWorkItemTypes: 'getApiWork-item-types',
  addWorkItemType: 'postApiDirectoryCommands',
  listExternalSystems: 'getApiExternal-systems',
  addTag: 'postApiDirectoryCommands',
  renameTag: 'postApiDirectoryCommands',
  removeTag: 'postApiDirectoryCommands',
  addTeam: 'postApiDirectoryCommands',
  listPeople: 'getApiPeople',
  addPerson: 'postApiDirectoryCommands',
  assignPerson: 'postApiProjectsByIdCommands',
  moveWorkItem: 'postApiProjectsByIdCommands',
  duplicateWorkItem: 'postApiProjectsByIdCommands',
  removeWorkItem: 'postApiProjectsByIdCommands',
  setEstimate: 'postApiProjectsByIdCommands',
  clearEstimate: 'postApiProjectsByIdCommands',
  freezeProject: 'postApiProjectsByIdCommands',
  unfreezeProject: 'postApiProjectsByIdCommands',
  unfreezeWorkItem: 'postApiProjectsByIdCommands',
  addDependency: 'postApiProjectsByIdCommands',
  removeDependency: 'postApiProjectsByIdCommands',
} as const satisfies Record<keyof ProjectApi, WbsOperationId>;

function isProjectApiMethod(key: string): key is keyof ProjectApi {
  return Object.hasOwn(PROJECT_API_OPERATIONS, key);
}

function projectWire(projectId: string, patch: ProjectPatch = {}) {
  return {
    id: projectId,
    name: patch.name ?? 'Fake project',
    ownerId: 'fake-owner',
    restricted: patch.restricted ?? false,
    estimateMethod: patch.estimateMethod ?? 'pert',
    depReach: patch.depReach ?? 'whole-item',
    pertWeights: patch.pertWeights ?? { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: patch.estimateRounding ?? 'ceil',
    startDate: patch.startDate ?? null,
    solutionRef: patch.solutionRef ?? null,
    revision: 0,
    optimizationEnabled: patch.optimizationEnabled ?? false,
    scheduleEngine: patch.scheduleEngine ?? 'fast',
    scheduleObjective: patch.scheduleObjective ?? 'pri',
    createdAt: 0,
  } as const;
}

/**
 * Restores only the transport fields absent from {@link PlanRead} before the
 * shared response shape checks a stated tree. Required facade fields flow
 * through unchanged. The four optional label/reference lists and undefined
 * assignee entries are the documented old-server swap shape; they normalize
 * to the same empty/absent values as `toTree` before entering the current wire.
 */
function planWire(projectId: string, plan: PlanRead) {
  return {
    waitingForPerson: 0,
    waitingForCapacity: 0,
    ...plan,
    workItems: plan.workItems.map((row, position) => ({
      projectId,
      position,
      serviceId: null,
      actuals: {},
      progress: {},
      state: 'not_started' as const,
      measures: {},
      ...row,
      // Proof: nullish fallback turned tagIds: null into []; the focused tree test
      // resolved a complete plan instead of rejecting with fake_invalid_response.
      tagIds: emptyWhenUndefined(row.tagIds, []),
      serviceIds: emptyWhenUndefined(row.serviceIds, []),
      typeIds: emptyWhenUndefined(row.typeIds, []),
      externalRefs: emptyWhenUndefined(row.externalRefs, []),
      assignees: Object.fromEntries(
        Object.entries(row.assignees).filter((entry): entry is [string, string] => {
          const [, personId] = entry;
          return personId !== undefined;
        }),
      ),
    })),
    steps: plan.steps.map((step, position) => ({ projectId, position, ...step })),
  };
}

async function throughProjectPatch<Patch extends ProjectPatch>(
  projectId: string,
  patch: Patch,
  mutate: (normalizedProjectId: string, normalizedPatch: Patch) => Promise<void>,
): Promise<void> {
  // Proof: bypassing this client made the malformed setDepReach case receive
  // { outcome: "resolved", after: "fake_invalid_response" } after it corrupted depReach.
  // Proof: schema-only preflight let an empty project id mutate depReach; the state-window
  // test failed on expected "whole-item", received "anchor-slice" after the rejection.
  const preflight = preflightFakeRequest(patchProject, {
    params: { id: projectId },
    body: patch,
  });
  const prepared = isPromiseLike(preflight) ? await preflight : preflight;
  // The shared request boundary permits only undefined-key omission, without
  // transforms or defaults, so the accepted patch remains within Patch.
  const normalizedPatch = prepared.body as Patch;
  const mutation = mutate(prepared.params.id, normalizedPatch);
  const client = clientFromShapes([patchProject], async () => {
    await mutation;
    return {
      kind: 'json' as const,
      status: 200,
      body: { project: projectWire(prepared.params.id, normalizedPatch) },
    };
  });
  const reply = await client.patchApiProjectsById({
    params: prepared.params,
    body: normalizedPatch,
  });
  if (reply.kind === 'failure') boundaryFailure(reply.failure);
  if (reply.kind === 'refusal') throw new Error(reply.body.error);
}

class CapturedAnswer<T> {
  private state: { called: false } | { called: true; answer: T } = { called: false };

  set(answer: T): void {
    this.state = { called: true, answer };
  }

  get(boundary: string): T {
    if (!this.state.called)
      throw new Error(`validated fake ${boundary} did not invoke its mutation`);
    return this.state.answer;
  }
}

function throughProjectCommand<Command extends ProjectCommand, Answer>(
  projectId: string,
  command: Command,
  mutate: (normalizedProjectId: string, normalizedCommand: Command) => Promise<Answer>,
  resultOf: (answer: Answer) => ProjectCommandResult,
): Promise<void>;
function throughProjectCommand<Command extends ProjectCommand, Answer, Facade>(
  projectId: string,
  command: Command,
  mutate: (normalizedProjectId: string, normalizedCommand: Command) => Promise<Answer>,
  resultOf: (answer: Answer) => ProjectCommandResult,
  facadeOf: (validated: ProjectCommandResult) => Facade,
): Promise<Facade>;
async function throughProjectCommand<Command extends ProjectCommand, Answer, Facade>(
  projectId: string,
  command: Command,
  mutate: (normalizedProjectId: string, normalizedCommand: Command) => Promise<Answer>,
  resultOf: (answer: Answer) => ProjectCommandResult,
  facadeOf?: (validated: ProjectCommandResult) => Facade,
): Promise<Facade | undefined> {
  const input = { params: { id: projectId }, body: { commands: [command] } };
  // Proof: schema-only preflight let a dot-segment project id create a row; the state-window
  // test failed on expected length 0, received 1 after the rejection.
  const preflight = preflightFakeRequest(applyProjectCommands, input);
  const prepared = isPromiseLike(preflight) ? await preflight : preflight;
  const normalized = prepared.body.commands.at(0);
  if (normalized?.kind !== command.kind)
    throw new Error('validated fake project command changed identity');
  // The exact shared union validation and unchanged discriminant establish the
  // caller's command arm after JSON removes optional undefined fields.
  const normalizedCommand = normalized as Command;
  // Proof: deferring a valid fake mutation until clientFromShapes' async transport made three
  // plan-cards capacity cases fail because their deliberately unawaited assignment was absent.
  // Proof: mutating the original patchWorkItem command wrote name: undefined; its accepted
  // call then made the next shaped tree fail with "fake_invalid_response".
  const mutation = mutate(prepared.params.id, normalizedCommand);
  // Proof: bypassing this client made malformed setEstimate resolve undefined instead of reject;
  // a numeric createWorkItem id likewise resolved as { id: 7 } instead of fake_invalid_response.
  const client = clientFromShapes([applyProjectCommands], async () => {
    const answer = await mutation;
    return {
      kind: 'json' as const,
      status: 200,
      body: { results: [resultOf(answer)], undoable: false, redoable: false },
    };
  });
  const reply = await client.postApiProjectsByIdCommands({
    params: prepared.params,
    body: prepared.body,
  });
  if (reply.kind === 'failure') boundaryFailure(reply.failure);
  if (reply.kind === 'refusal') throw new Error(reply.body.error);
  const validated = reply.body.results.at(0);
  if (validated === undefined) throw new Error('fake_invalid_response');
  // Proof: returning the mutation answer leaked unchecked: true; the focused create
  // test received { id: "work-1", unchecked: true } instead of { id: "work-1" }.
  return facadeOf?.(validated);
}

async function throughDirectorySuccess<Command extends DirectoryCommand, Answer, Facade>(
  command: Command,
  mutate: (normalizedCommand: Command) => Promise<Answer>,
  resultOf: (answer: Answer) => DirectoryCommandResult,
  facadeOf: (validated: DirectoryCommandResult) => Facade,
): Promise<Facade> {
  const body = { commands: [command] };
  const preflight = preflightFakeRequest(applyDirectoryCommands, { body });
  const prepared = isPromiseLike(preflight) ? await preflight : preflight;
  const normalized = prepared.body.commands.at(0);
  if (normalized?.kind !== command.kind)
    throw new Error('validated fake directory command changed identity');
  // The exact shared union validation and unchanged discriminant establish the
  // caller's command arm after JSON removes optional undefined fields.
  const normalizedCommand = normalized as Command;
  const mutation = mutate(normalizedCommand);
  // Proof: bypassing this client made addPerson with numeric team ids resolve
  // { id: "person-1", name: "Ada", kind: "person", teamIds: [] } instead of reject.
  const client = clientFromShapes([applyDirectoryCommands], async () => {
    const answer = await mutation;
    return { kind: 'json' as const, status: 200, body: { results: [resultOf(answer)] } };
  });
  const reply = await client.postApiDirectoryCommands({ body: prepared.body });
  if (reply.kind === 'failure') boundaryFailure(reply.failure);
  if (reply.kind === 'refusal') throw new Error(reply.body.error);
  const validated = reply.body.results.at(0);
  if (validated === undefined) throw new Error('fake_invalid_response');
  // Proof: returning the mutation answer leaked unchecked: true; the focused directory
  // test received it beside the validated tag id and name.
  return facadeOf(validated);
}

const VOID_COMMAND_RESULT = { index: 0 };
const FAKE_PROJECT_ID = 'fake-project';

function checkedAnswers(answers: Partial<ProjectApi>): Partial<ProjectApi> {
  const checked: Partial<ProjectApi> = {};
  const listProjectsAnswer = answers.listProjects;
  if (listProjectsAnswer !== undefined) {
    checked.listProjects = async () => {
      // Proof: bypassing this client let listProjects resolve a project whose createdAt was
      // "yesterday" instead of rejecting it with fake_invalid_response. Supplying missing name
      // through projectWire's default also resolved as name: "Fake project" in the focused test.
      const client = clientFromShapes([listProjects], async () => {
        const projects = await listProjectsAnswer();
        return {
          kind: 'json' as const,
          status: 200,
          body: {
            projects: projects.map((project) => ({
              ...projectWire(project.id),
              ...project,
              id: project.id,
              name: project.name,
              restricted: project.restricted,
              startDate: project.startDate,
              createdAt: project.createdAt,
              ownerName: project.ownerName,
              lastOpenedAt: project.lastOpenedAt,
            })),
          },
        };
      });
      const reply = await client.getApiProjects({});
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.projects.map((project) => ({
        id: project.id,
        name: project.name,
        restricted: project.restricted,
        startDate: project.startDate,
        createdAt: project.createdAt,
        ownerName: project.ownerName,
        lastOpenedAt: project.lastOpenedAt,
      }));
    };
  }

  const createProjectAnswer = answers.createProject;
  if (createProjectAnswer !== undefined) {
    checked.createProject = async (name) => {
      const started = startMutation(createProject, { body: { name } }, (prepared) =>
        createProjectAnswer(prepared.body.name),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      // Proof: bypassing this client made createProject(7) resolve
      // { id: "project-1", name: "Plan", restricted: false } instead of reject. Defaulting a
      // missing restricted likewise resolved it as false instead of fake_invalid_response.
      const client = clientFromShapes([createProject], async () => {
        const made = await mutation;
        return {
          kind: 'json' as const,
          status: 200,
          body: {
            project: {
              ...projectWire(made.id),
              ...made,
              id: made.id,
              name: made.name,
              restricted: made.restricted,
            },
            steps: [],
          },
        };
      });
      const reply = await client.postApiProjects({ body: prepared.body });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return {
        id: reply.body.project.id,
        name: reply.body.project.name,
        restricted: reply.body.project.restricted,
      };
    };
  }

  const openProjectAnswer = answers.openProject;
  if (openProjectAnswer !== undefined) {
    checked.openProject = async (projectId) => {
      const started = startMutation(recordProjectOpen, { params: { id: projectId } }, (prepared) =>
        openProjectAnswer(prepared.params.id),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([recordProjectOpen], async () => {
        await mutation;
        return { kind: 'empty' as const, status: 204 };
      });
      const reply = await client.postApiProjectsByIdOpened({ params: prepared.params });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
    };
  }

  const treeAnswer = answers.tree;
  if (treeAnswer !== undefined) {
    checked.tree = async (projectId) => {
      const completed = new CapturedAnswer<PlanRead>();
      // Proof: the former global exemption made a direct tree with seq: "next" resolve the
      // malformed PlanRead; refusing-api.test.ts observed the complete object instead of rejection.
      const client = clientFromShapes([getWorkItems], async () => {
        const plan = await treeAnswer(projectId);
        completed.set(plan);
        return { kind: 'json' as const, status: 200, body: planWire(projectId, plan) };
      });
      const reply = await client['getApiProjectsByIdWork-items']({ params: { id: projectId } });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      const plan = completed.get('tree');
      return {
        ...reply.body,
        ...plan,
        workItems: reply.body.workItems.map((row, position) => {
          const facadeRow = plan.workItems.at(position);
          if (facadeRow === undefined) throw new Error('validated tree lost a work item');
          return {
            ...row,
            ...facadeRow,
            teamIds: [...row.teamIds],
            tagIds: [...row.tagIds],
            serviceIds: [...row.serviceIds],
            typeIds: [...row.typeIds],
            externalRefs: row.externalRefs.map((reference) => ({ ...reference })),
          };
        }),
      };
    };
  }

  const renameProjectAnswer = answers.renameProject;
  if (renameProjectAnswer !== undefined) {
    checked.renameProject = (projectId, name) =>
      throughProjectPatch(projectId, { name }, (normalizedProjectId, normalizedPatch) =>
        renameProjectAnswer(normalizedProjectId, normalizedPatch.name),
      );
  }

  const setEstimateMethodAnswer = answers.setEstimateMethod;
  if (setEstimateMethodAnswer !== undefined) {
    checked.setEstimateMethod = (projectId, method) =>
      throughProjectPatch(projectId, { estimateMethod: method }, (normalizedProjectId, patch) =>
        setEstimateMethodAnswer(normalizedProjectId, patch.estimateMethod),
      );
  }

  const setEstimateArithmeticAnswer = answers.setEstimateArithmetic;
  if (setEstimateArithmeticAnswer !== undefined) {
    checked.setEstimateArithmetic = (projectId, arithmetic) =>
      throughProjectPatch(projectId, arithmetic, (normalizedProjectId, normalizedArithmetic) =>
        setEstimateArithmeticAnswer(normalizedProjectId, normalizedArithmetic),
      );
  }

  const setDepReachAnswer = answers.setDepReach;
  if (setDepReachAnswer !== undefined) {
    checked.setDepReach = (projectId, reach) =>
      throughProjectPatch(projectId, { depReach: reach }, (normalizedProjectId, patch) =>
        setDepReachAnswer(normalizedProjectId, patch.depReach),
      );
  }

  const setOptimizationSettingsAnswer = answers.setOptimizationSettings;
  if (setOptimizationSettingsAnswer !== undefined) {
    checked.setOptimizationSettings = (projectId, patch) =>
      throughProjectPatch(projectId, patch, (normalizedProjectId, normalizedPatch) =>
        setOptimizationSettingsAnswer(normalizedProjectId, normalizedPatch),
      );
  }

  const setStartDateAnswer = answers.setStartDate;
  if (setStartDateAnswer !== undefined) {
    checked.setStartDate = (projectId, startDate) =>
      throughProjectPatch(projectId, { startDate }, (normalizedProjectId, patch) =>
        setStartDateAnswer(normalizedProjectId, patch.startDate),
      );
  }

  const stepsAnswer = answers.steps;
  if (stepsAnswer !== undefined) {
    checked.steps = async (projectId) => {
      const client = clientFromShapes([readProject], async () => ({
        kind: 'json' as const,
        status: 200,
        body: {
          project: projectWire(projectId),
          steps: (await stepsAnswer(projectId)).map((step, position) => ({
            ...step,
            projectId,
            position,
          })),
        },
      }));
      const reply = await client.getApiProjectsById({ params: { id: projectId } });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return reply.body.steps.map((step) => ({ id: step.id, name: step.name }));
    };
  }

  const undoAnswer = answers.undo;
  if (undoAnswer !== undefined) {
    checked.undo = async (projectId) => {
      const started = startMutation(undoProject, { params: { id: projectId } }, (prepared) =>
        undoAnswer(prepared.params.id),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      // Proof: bypassing this client let stale_undo detail 7 resolve instead of rejecting
      // the malformed modeled refusal with fake_invalid_response. Returning the raw checked
      // answer also leaked unchecked: true; the exact-equality case observed that extra key.
      const client = clientFromShapes([undoProject], async () => {
        const answer = await mutation;
        return isFacadeSuccess(answer)
          ? {
              kind: 'json' as const,
              status: 200,
              body: { ...answer, done: answer.done, detail: answer.detail },
            }
          : {
              kind: 'json' as const,
              status: 409,
              body: { ...answer, error: answer.reason, detail: answer.detail },
            };
      });
      const reply = await client.postApiProjectsByIdUndo({ params: prepared.params });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'success')
        return { ok: true, done: reply.body.done, detail: reply.body.detail };
      if (reply.body.error === 'nothing_to_undo' || reply.body.error === 'stale_undo')
        return { ok: false, reason: reply.body.error, detail: reply.body.detail };
      throw new Error(reply.body.error);
    };
  }

  const redoAnswer = answers.redo;
  if (redoAnswer !== undefined) {
    checked.redo = async (projectId) => {
      const started = startMutation(redoProject, { params: { id: projectId } }, (prepared) =>
        redoAnswer(prepared.params.id),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      // Proof: returning the raw checked redo answer leaked unchecked: true; the shared
      // exact-equality case observed that extra key beside ok, done, and detail.
      const client = clientFromShapes([redoProject], async () => {
        const answer = await mutation;
        return isFacadeSuccess(answer)
          ? {
              kind: 'json' as const,
              status: 200,
              body: { ...answer, done: answer.done, detail: answer.detail },
            }
          : {
              kind: 'json' as const,
              status: 409,
              body: { ...answer, error: answer.reason, detail: answer.detail },
            };
      });
      const reply = await client.postApiProjectsByIdRedo({ params: prepared.params });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'success')
        return { ok: true, done: reply.body.done, detail: reply.body.detail };
      if (reply.body.error === 'nothing_to_undo' || reply.body.error === 'stale_undo')
        return { ok: false, reason: reply.body.error, detail: reply.body.detail };
      throw new Error(reply.body.error);
    };
  }

  const addStepAnswer = answers.addStep;
  if (addStepAnswer !== undefined) {
    checked.addStep = async (projectId, name) => {
      const started = startMutation(
        addStep,
        { params: { id: projectId }, body: { name } },
        (prepared) => addStepAnswer(prepared.params.id, prepared.body.name),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([addStep], async () => {
        try {
          const step = await mutation;
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
        params: prepared.params,
        body: prepared.body,
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
      const started = startMutation(
        createCalendarMarker,
        { params: { id: projectId }, body: marker },
        (prepared) => createCalendarMarkerAnswer(prepared.params.id, prepared.body),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([createCalendarMarker], async () => ({
        kind: 'json',
        status: 201,
        body: {
          marker: markerWire(prepared.params.id, await mutation),
        },
      }));
      const reply = await client['postApiProjectsByIdCalendar-markers']({
        params: prepared.params,
        body: prepared.body,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const renameCalendarMarkerAnswer = answers.renameCalendarMarker;
  if (renameCalendarMarkerAnswer !== undefined) {
    checked.renameCalendarMarker = async (projectId, markerId, name) => {
      const started = startMutation(
        updateCalendarMarker,
        { params: { id: projectId, markerId }, body: { name } },
        (prepared) =>
          // The facade requires name and JSON normalization cannot omit a string value.
          renameCalendarMarkerAnswer(
            prepared.params.id,
            prepared.params.markerId,
            requiredNormalized(prepared.body.name),
          ),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([updateCalendarMarker], async () => ({
        kind: 'json',
        status: 200,
        body: {
          marker: markerWire(prepared.params.id, await mutation),
        },
      }));
      const reply = await client['patchApiProjectsByIdCalendar-markersByMarkerId']({
        params: prepared.params,
        body: prepared.body,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const recolorCalendarMarkerAnswer = answers.recolorCalendarMarker;
  if (recolorCalendarMarkerAnswer !== undefined) {
    checked.recolorCalendarMarker = async (projectId, markerId, color) => {
      const started = startMutation(
        updateCalendarMarker,
        { params: { id: projectId, markerId }, body: { color } },
        (prepared) =>
          // The facade supplies color and JSON normalization retains string and null values.
          recolorCalendarMarkerAnswer(
            prepared.params.id,
            prepared.params.markerId,
            requiredNormalized(prepared.body.color),
          ),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([updateCalendarMarker], async () => ({
        kind: 'json',
        status: 200,
        body: {
          marker: markerWire(prepared.params.id, await mutation),
        },
      }));
      const reply = await client['patchApiProjectsByIdCalendar-markersByMarkerId']({
        params: prepared.params,
        body: prepared.body,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return markerView(reply.body.marker);
    };
  }

  const deleteCalendarMarkerAnswer = answers.deleteCalendarMarker;
  if (deleteCalendarMarkerAnswer !== undefined) {
    checked.deleteCalendarMarker = async (projectId, markerId) => {
      const started = startMutation(
        removeCalendarMarker,
        { params: { id: projectId, markerId } },
        (prepared) => deleteCalendarMarkerAnswer(prepared.params.id, prepared.params.markerId),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([removeCalendarMarker], async () => {
        await mutation;
        return { kind: 'empty', status: 204 };
      });
      const reply = await client['deleteApiProjectsByIdCalendar-markersByMarkerId']({
        params: prepared.params,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
    };
  }

  const renameStepAnswer = answers.renameStep;
  if (renameStepAnswer !== undefined) {
    checked.renameStep = async (projectId, stepId, name) => {
      const started = startMutation(
        renameStep,
        { params: { id: projectId, stepId }, body: { name } },
        (prepared) =>
          renameStepAnswer(prepared.params.id, prepared.params.stepId, prepared.body.name),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([renameStep], async () => {
        try {
          const step = await mutation;
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
        params: prepared.params,
        body: prepared.body,
      });
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') throw new Error(reply.body.error);
      return { id: reply.body.step.id, name: reply.body.step.name };
    };
  }

  const removeStepAnswer = answers.removeStep;
  if (removeStepAnswer !== undefined) {
    checked.removeStep = async (projectId, stepId, cascade) => {
      const started = startMutation(
        removeStep,
        {
          params: { id: projectId, stepId },
          query: { cascade: cascade ? 'true' : undefined },
        },
        (prepared) =>
          removeStepAnswer(
            prepared.params.id,
            prepared.params.stepId,
            prepared.query?.cascade === 'true',
          ),
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([removeStep], async () => {
        const removal = await mutation;
        return isFacadeSuccess(removal)
          ? { kind: 'empty' as const, status: 204 }
          : {
              kind: 'json' as const,
              status: 409,
              body: { ...removal, error: removal.reason, inUse: removal.inUse },
            };
      });
      const reply = await client.deleteApiProjectsByIdStepsByStepId({
        params: prepared.params,
        query: prepared.query,
      });
      // Proof: hard-coding error: "in_use" made a facade answer with reason: "taken" resolve
      // as in_use; preserving its reason here made refusing-api.test.ts reject that response.
      // Omitting five usage counters also made this reject with fake_invalid_response instead
      // of exposing a partial union, observed in the same test file.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') {
        if (reply.body.error === 'in_use')
          return { ok: false, reason: 'in_use', inUse: reply.body.inUse };
        throw new Error(reply.body.error);
      }
      return { ok: true };
    };
  }

  const setTeamCapacityAnswer = answers.setTeamCapacity;
  if (setTeamCapacityAnswer !== undefined) {
    checked.setTeamCapacity = (projectId, teamId, size) =>
      throughProjectCommand(
        projectId,
        { kind: 'setCapacity', teamId, size },
        (normalizedProjectId, normalized) =>
          setTeamCapacityAnswer(normalizedProjectId, normalized.teamId, normalized.size),
        () => VOID_COMMAND_RESULT,
      );
  }

  const setPriorityBandsAnswer = answers.setPriorityBands;
  if (setPriorityBandsAnswer !== undefined) {
    checked.setPriorityBands = (projectId, bands) =>
      throughProjectCommand(
        projectId,
        { kind: 'setPriorityBands', bands: [...bands] },
        (normalizedProjectId, normalized) =>
          setPriorityBandsAnswer(normalizedProjectId, normalized.bands),
        () => VOID_COMMAND_RESULT,
      );
  }

  const createWorkItemAnswer = answers.createWorkItem;
  if (createWorkItemAnswer !== undefined) {
    checked.createWorkItem = (projectId, input) =>
      throughProjectCommand(
        projectId,
        { kind: 'createWorkItem', ...input },
        (normalizedProjectId, normalized) =>
          createWorkItemAnswer(normalizedProjectId, {
            parentId: normalized.parentId,
            ...(normalized.afterId === undefined ? {} : { afterId: normalized.afterId }),
            ...(normalized.name === undefined ? {} : { name: normalized.name }),
          }),
        (made) => ({ index: 0, id: made.id }),
        (validated) => {
          if (validated.id === undefined) throw new Error('fake_invalid_response');
          // Proof: passing the normalized wire command leaked kind: "createWorkItem" into
          // the facade spy; its exact-call test expected only { parentId: null }.
          return { id: validated.id };
        },
      );
  }

  const patchWorkItemAnswer = answers.patchWorkItem;
  if (patchWorkItemAnswer !== undefined) {
    checked.patchWorkItem = (workItemId, patch) => {
      const { teamIds, tagIds, serviceIds, typeIds, externalRefs, ...fields } = patch;
      return throughProjectCommand(
        FAKE_PROJECT_ID,
        {
          kind: 'patchWorkItem',
          workItemId,
          patch: {
            ...fields,
            ...(teamIds === undefined ? {} : { teamIds: [...teamIds] }),
            ...(tagIds === undefined ? {} : { tagIds: [...tagIds] }),
            ...(serviceIds === undefined ? {} : { serviceIds: [...serviceIds] }),
            ...(typeIds === undefined ? {} : { typeIds: [...typeIds] }),
            ...(externalRefs === undefined
              ? {}
              : { externalRefs: externalRefs.map((reference) => ({ ...reference })) }),
          },
        },
        (_normalizedProjectId, normalized) =>
          patchWorkItemAnswer(normalized.workItemId, normalized.patch),
        () => VOID_COMMAND_RESULT,
      );
    };
  }

  const assignPersonAnswer = answers.assignPerson;
  if (assignPersonAnswer !== undefined) {
    checked.assignPerson = (workItemId, stepId, personId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'setAssignee', workItemId, stepId, personId },
        (_normalizedProjectId, normalized) =>
          assignPersonAnswer(normalized.workItemId, normalized.stepId, normalized.personId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const moveWorkItemAnswer = answers.moveWorkItem;
  if (moveWorkItemAnswer !== undefined) {
    checked.moveWorkItem = (workItemId, parentId, afterId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'moveWorkItem', workItemId, parentId, afterId },
        (_normalizedProjectId, normalized) =>
          moveWorkItemAnswer(normalized.workItemId, normalized.parentId, normalized.afterId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const duplicateWorkItemAnswer = answers.duplicateWorkItem;
  if (duplicateWorkItemAnswer !== undefined) {
    checked.duplicateWorkItem = (workItemId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'duplicateWorkItem', workItemId },
        (_normalizedProjectId, normalized) => duplicateWorkItemAnswer(normalized.workItemId),
        (made) => ({ index: 0, id: made.id }),
        (validated) => {
          if (validated.id === undefined) throw new Error('fake_invalid_response');
          return { id: validated.id };
        },
      );
  }

  const removeWorkItemAnswer = answers.removeWorkItem;
  if (removeWorkItemAnswer !== undefined) {
    checked.removeWorkItem = (workItemId, options) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        {
          kind: 'deleteWorkItem',
          workItemId,
          ...(options?.strategy === undefined ? {} : { strategy: options.strategy }),
        },
        (_normalizedProjectId, normalized) => {
          // The facade distinguishes an omitted options argument from a supplied
          // object whose optional strategy leaves the JSON wire. Reconstruct only
          // that container/key presence; the value still comes from validated input.
          // Proof: reconstructing solely from normalized.strategy made the focused
          // boundary spy receive undefined instead of { strategy: undefined }.
          const normalizedOptions: DeleteOptions | undefined =
            options === undefined
              ? undefined
              : Object.hasOwn(options, 'strategy')
                ? { strategy: normalized.strategy }
                : {};
          return removeWorkItemAnswer(normalized.workItemId, normalizedOptions);
        },
        () => VOID_COMMAND_RESULT,
      );
  }

  const setEstimateAnswer = answers.setEstimate;
  if (setEstimateAnswer !== undefined) {
    checked.setEstimate = (workItemId, stepId, days) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'setEstimate', workItemId, stepId, days },
        (_normalizedProjectId, normalized) =>
          setEstimateAnswer(normalized.workItemId, normalized.stepId, normalized.days),
        () => VOID_COMMAND_RESULT,
      );
  }

  const clearEstimateAnswer = answers.clearEstimate;
  if (clearEstimateAnswer !== undefined) {
    checked.clearEstimate = (workItemId, stepId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'clearEstimate', workItemId, stepId },
        (_normalizedProjectId, normalized) =>
          clearEstimateAnswer(normalized.workItemId, normalized.stepId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const freezeProjectAnswer = answers.freezeProject;
  if (freezeProjectAnswer !== undefined) {
    checked.freezeProject = (projectId) =>
      throughProjectCommand(
        projectId,
        { kind: 'freezeProject' },
        (normalizedProjectId) => freezeProjectAnswer(normalizedProjectId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const unfreezeProjectAnswer = answers.unfreezeProject;
  if (unfreezeProjectAnswer !== undefined) {
    checked.unfreezeProject = (projectId) =>
      throughProjectCommand(
        projectId,
        { kind: 'unfreezeProject' },
        (normalizedProjectId) => unfreezeProjectAnswer(normalizedProjectId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const unfreezeWorkItemAnswer = answers.unfreezeWorkItem;
  if (unfreezeWorkItemAnswer !== undefined) {
    checked.unfreezeWorkItem = (workItemId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'unfreezeWorkItem', workItemId },
        (_normalizedProjectId, normalized) => unfreezeWorkItemAnswer(normalized.workItemId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const addDependencyAnswer = answers.addDependency;
  if (addDependencyAnswer !== undefined) {
    checked.addDependency = (workItemId, predecessorId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'addDependency', workItemId, predecessorId },
        (_normalizedProjectId, normalized) =>
          addDependencyAnswer(normalized.workItemId, normalized.predecessorId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const removeDependencyAnswer = answers.removeDependency;
  if (removeDependencyAnswer !== undefined) {
    checked.removeDependency = (workItemId, predecessorId) =>
      throughProjectCommand(
        FAKE_PROJECT_ID,
        { kind: 'removeDependency', workItemId, predecessorId },
        (_normalizedProjectId, normalized) =>
          removeDependencyAnswer(normalized.workItemId, normalized.predecessorId),
        () => VOID_COMMAND_RESULT,
      );
  }

  const addServiceAnswer = answers.addService;
  if (addServiceAnswer !== undefined) {
    checked.addService = (name) =>
      throughDirectorySuccess(
        { kind: 'createService', name },
        (normalized) => addServiceAnswer(normalized.name),
        (service) => ({ index: 0, entity: service }),
        (validated) => {
          if (validated.entity === undefined) throw new Error('fake_invalid_response');
          return { id: validated.entity.id, name: validated.entity.name };
        },
      );
  }

  const addWorkItemTypeAnswer = answers.addWorkItemType;
  if (addWorkItemTypeAnswer !== undefined) {
    checked.addWorkItemType = (name) =>
      throughDirectorySuccess(
        { kind: 'createWorkItemType', name },
        (normalized) => addWorkItemTypeAnswer(normalized.name),
        (workItemType) => ({ index: 0, entity: workItemType }),
        (validated) => {
          if (validated.entity === undefined) throw new Error('fake_invalid_response');
          return { id: validated.entity.id, name: validated.entity.name };
        },
      );
  }

  const addTagAnswer = answers.addTag;
  if (addTagAnswer !== undefined) {
    checked.addTag = (name) =>
      throughDirectorySuccess(
        { kind: 'createTag', name },
        (normalized) => addTagAnswer(normalized.name),
        (tag) => ({ index: 0, entity: tag }),
        (validated) => {
          if (validated.entity === undefined) throw new Error('fake_invalid_response');
          return { id: validated.entity.id, name: validated.entity.name };
        },
      );
  }

  const addTeamAnswer = answers.addTeam;
  if (addTeamAnswer !== undefined) {
    checked.addTeam = (name) =>
      throughDirectorySuccess(
        { kind: 'createTeam', name },
        (normalized) => addTeamAnswer(normalized.name),
        (team) => ({ index: 0, entity: team }),
        (validated) => {
          if (validated.entity?.serviceIds === undefined) throw new Error('fake_invalid_response');
          return {
            id: validated.entity.id,
            name: validated.entity.name,
            serviceIds: [...validated.entity.serviceIds],
          };
        },
      );
  }

  const addPersonAnswer = answers.addPerson;
  if (addPersonAnswer !== undefined) {
    checked.addPerson = (name, teamIds) =>
      throughDirectorySuccess(
        { kind: 'createPerson', name, teamIds: [...teamIds] },
        (normalized) => addPersonAnswer(normalized.name, normalized.teamIds),
        (person) => ({ index: 0, entity: person }),
        // A create answers the identity and not the memberships: `personEntity`
        // in `work-item.routes.ts` is `{ id, name, kind }`, and the batch entity
        // in `work-item-shapes.ts` declares `'teamIds?'`. Requiring `teamIds`
        // here made the fake refuse the one shape be-01 sends — the same defect
        // production carried until 732614df, which this stood in for.
        (validated) => {
          if (validated.entity?.kind === undefined) throw new Error('fake_invalid_response');
          return {
            id: validated.entity.id,
            name: validated.entity.name,
            kind: validated.entity.kind,
          };
        },
      );
  }

  const renameTagAnswer = answers.renameTag;
  if (renameTagAnswer !== undefined) {
    checked.renameTag = async (tagId, name) => {
      const command = { kind: 'patchTag' as const, tagId, name };
      const started = startMutation(
        applyDirectoryCommands,
        { body: { commands: [command] } },
        (prepared) => {
          const normalized = prepared.body.commands.at(0);
          if (normalized?.kind !== command.kind)
            throw new Error('validated fake directory command changed identity');
          // The facade requires tagId and JSON normalization cannot omit a string value.
          return renameTagAnswer(requiredNormalized(normalized.tagId), normalized.name);
        },
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([applyDirectoryCommands], async () => {
        const answer = await mutation;
        return isFacadeSuccess(answer)
          ? {
              kind: 'json' as const,
              status: 200,
              body: { results: [{ index: 0, entity: answer.entry }], ...answer },
            }
          : {
              kind: 'json' as const,
              status: 409,
              body: {
                ...answer,
                error: answer.reason,
                at: 0,
                kind: 'patchTag' as const,
                name: answer.survivingName,
              },
            };
      });
      const reply = await client.postApiDirectoryCommands({
        body: prepared.body,
      });
      // Proof: hard-coding error: "taken" let a facade reason: "in_use" resolve unchanged;
      // refusing-api.test.ts observed that object instead of fake_invalid_response.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') {
        if (reply.body.error === 'taken')
          return { ok: false, reason: 'taken', survivingName: reply.body.name };
        throw new Error(reply.body.error);
      }
      const entity = reply.body.results.at(0)?.entity;
      if (entity === undefined) throw new Error('fake_invalid_response');
      return { ok: true, entry: { id: entity.id, name: entity.name } };
    };
  }

  const removeTagAnswer = answers.removeTag;
  if (removeTagAnswer !== undefined) {
    checked.removeTag = async (tagId, cascade) => {
      const command = { kind: 'deleteTag' as const, tagId, cascade };
      const started = startMutation(
        applyDirectoryCommands,
        { body: { commands: [command] } },
        (prepared) => {
          const normalized = prepared.body.commands.at(0);
          if (normalized?.kind !== command.kind)
            throw new Error('validated fake directory command changed identity');
          // The facade requires tagId and JSON normalization cannot omit a string value.
          return removeTagAnswer(requiredNormalized(normalized.tagId), normalized.cascade ?? false);
        },
      );
      const { prepared, mutation } = isPromiseLike(started) ? await started : started;
      const client = clientFromShapes([applyDirectoryCommands], async () => {
        const answer = await mutation;
        return isFacadeSuccess(answer)
          ? {
              kind: 'json' as const,
              status: 200,
              body: { results: [{ index: 0 }], ...answer },
            }
          : {
              kind: 'json' as const,
              status: 409,
              body: {
                ...answer,
                error: answer.reason,
                at: 0,
                kind: 'deleteTag' as const,
                usage: answer.usage,
              },
            };
      });
      const reply = await client.postApiDirectoryCommands({
        body: prepared.body,
      });
      // Proof: hard-coding error: "in_use" let a facade reason: "taken" resolve unchanged;
      // refusing-api.test.ts observed that object instead of fake_invalid_response.
      if (reply.kind === 'failure') boundaryFailure(reply.failure);
      if (reply.kind === 'refusal') {
        if (reply.body.error === 'in_use')
          return { ok: false, reason: 'in_use', usage: reply.body.usage };
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
      if (stated !== undefined && typeof key === 'string' && isProjectApiMethod(key)) {
        // Proof: deleting removeDependency's wrapper made the exhaustive fake boundary test
        // fail with Received "Error: missing fake shape boundary: removeDependency".
        throw new Error(`missing fake shape boundary: ${key}`);
      }
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
