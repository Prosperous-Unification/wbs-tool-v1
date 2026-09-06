# HTTP operation inventory

PRE-INTEGRATION inventory: the 36 operations below predate calendar-marker commit 4051512c and OIDC fixes 39e53dda/a91f831b fetched during the ae1fc858 checkpoint. This is not the post-merge route inventory; regenerate only after integration.

Read-only committed-document inventory; mounted-route parity is not established by this list. Generated from apps/be-01/openapi.json at d6991a44.

| Method | Path                                     | Operation ID                           | Documented statuses |
| ------ | ---------------------------------------- | -------------------------------------- | ------------------- |
| GET    | `/metrics`                               | `getMetrics`                           |                     |
| POST   | `/api/smoke/echo`                        | `postApiSmokeEcho`                     |                     |
| POST   | `/api/auth/register`                     | `postApiAuthRegister`                  |                     |
| POST   | `/api/auth/login`                        | `postApiAuthLogin`                     |                     |
| GET    | `/api/auth/me`                           | `getApiAuthMe`                         |                     |
| GET    | `/plans/by-solution/{slug}`              | `getPlansBy-solutionBySlug`            |                     |
| POST   | `/api/projects`                          | `postApiProjects`                      |                     |
| GET    | `/api/projects`                          | `getApiProjects`                       |                     |
| POST   | `/api/projects/{id}/opened`              | `postApiProjectsByIdOpened`            |                     |
| GET    | `/api/projects/{id}/export`              | `getApiProjectsByIdExport`             |                     |
| GET    | `/api/projects/{id}`                     | `getApiProjectsById`                   |                     |
| PATCH  | `/api/projects/{id}`                     | `patchApiProjectsById`                 |                     |
| POST   | `/api/projects/{id}/saved-plans`         | `postApiProjectsByIdSaved-plans`       |                     |
| GET    | `/api/projects/{id}/saved-plans`         | `getApiProjectsByIdSaved-plans`        |                     |
| GET    | `/api/projects/{id}/saved-plans/compare` | `getApiProjectsByIdSaved-plansCompare` |                     |
| GET    | `/api/saved-plans/{id}`                  | `getApiSaved-plansById`                |                     |
| PATCH  | `/api/saved-plans/{id}`                  | `patchApiSaved-plansById`              |                     |
| DELETE | `/api/saved-plans/{id}`                  | `deleteApiSaved-plansById`             |                     |
| POST   | `/api/projects/{id}/steps`               | `postApiProjectsByIdSteps`             |                     |
| PATCH  | `/api/projects/{id}/steps/{stepId}`      | `patchApiProjectsByIdStepsByStepId`    |                     |
| DELETE | `/api/projects/{id}/steps/{stepId}`      | `deleteApiProjectsByIdStepsByStepId`   |                     |
| GET    | `/api/projects/{id}/work-items`          | `getApiProjectsByIdWork-items`         |                     |
| POST   | `/api/projects/{id}/commands`            | `postApiProjectsByIdCommands`          |                     |
| POST   | `/api/directory/commands`                | `postApiDirectoryCommands`             |                     |
| POST   | `/api/projects/{id}/undo`                | `postApiProjectsByIdUndo`              |                     |
| POST   | `/api/projects/{id}/redo`                | `postApiProjectsByIdRedo`              |                     |
| GET    | `/api/teams`                             | `getApiTeams`                          |                     |
| GET    | `/api/people`                            | `getApiPeople`                         |                     |
| GET    | `/api/tags`                              | `getApiTags`                           |                     |
| GET    | `/api/services`                          | `getApiServices`                       |                     |
| GET    | `/api/work-item-types`                   | `getApiWork-item-types`                |                     |
| GET    | `/api/external-systems`                  | `getApiExternal-systems`               |                     |
| GET    | `/api/projects/{id}/history`             | `getApiProjectsByIdHistory`            |                     |
| POST   | `/internal/forward`                      | `postInternalForward`                  |                     |
| POST   | `/internal/resume`                       | `postInternalResume`                   |                     |
| GET    | `/health`                                | `getHealth`                            |                     |
