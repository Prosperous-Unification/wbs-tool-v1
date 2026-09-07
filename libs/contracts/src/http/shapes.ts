import {
  completeOidcLogin,
  logoutOidcSession,
  refreshOidcSession,
  startOidcLogin,
} from './auth-oidc-shapes';
import { loginPassword, readPasswordSession, registerPassword } from './auth-password-shapes';
import {
  createCalendarMarker,
  listCalendarMarkers,
  removeCalendarMarker,
  updateCalendarMarker,
} from './calendar-marker-shapes';
import {
  listExternalSystems,
  listPeople,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
} from './directory-shapes';
import { readHistory } from './history-shapes';
import { health, metrics } from './infrastructure-shapes';
import { forwardInternal, resumeInternal } from './internal-http-shapes';
import {
  createProject,
  exportProject,
  listProjects,
  patchProject,
  readProject,
  recordProjectOpen,
  retryProjectOptimization,
} from './project-shapes';
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
import {
  applyDirectoryCommands,
  applyProjectCommands,
  getWorkItems,
  redoProject,
  undoProject,
} from './work-item-shapes';

/** Migrated HTTP declarations; legacy families join this table as their handlers migrate. */
export const httpShapes = [
  health,
  metrics,
  registerPassword,
  loginPassword,
  readPasswordSession,
  startOidcLogin,
  completeOidcLogin,
  refreshOidcSession,
  logoutOidcSession,
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
  createProject,
  listProjects,
  recordProjectOpen,
  exportProject,
  readProject,
  patchProject,
  retryProjectOptimization,
  getWorkItems,
  applyProjectCommands,
  applyDirectoryCommands,
  undoProject,
  redoProject,
  listCalendarMarkers,
  createCalendarMarker,
  updateCalendarMarker,
  removeCalendarMarker,
  savePlan,
  listSavedPlans,
  compareSavedPlans,
  readSavedPlan,
  renameSavedPlan,
  deleteSavedPlan,
  forwardInternal,
  resumeInternal,
] as const;
