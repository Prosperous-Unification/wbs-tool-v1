import {
  listExternalSystems,
  listPeople,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
} from './directory-shapes';
import { readHistory } from './history-shapes';
import { forwardInternal, resumeInternal } from './internal-http-shapes';
import {
  compareSavedPlans,
  deleteSavedPlan,
  listSavedPlans,
  readSavedPlan,
  renameSavedPlan,
  savePlan,
} from './saved-plan-shapes';
import { smokeEcho } from './smoke-shapes';
import { readSolution } from './solution-shapes';
import { addStep, removeStep, renameStep } from './step-shapes';

/** Migrated HTTP declarations; legacy families join this table as their handlers migrate. */
export const httpShapes = [
  smokeEcho,
  addStep,
  renameStep,
  removeStep,
  listTeams,
  listPeople,
  listTags,
  listServices,
  listWorkItemTypes,
  listExternalSystems,
  readHistory,
  readSolution,
  savePlan,
  listSavedPlans,
  compareSavedPlans,
  readSavedPlan,
  renameSavedPlan,
  deleteSavedPlan,
  forwardInternal,
  resumeInternal,
] as const;
