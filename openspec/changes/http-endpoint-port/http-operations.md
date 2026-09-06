# HTTP operation inventory

Updated after feature integration at 034d5eb2. The baseline names below come from
the committed document; four conditional OIDC routes were inspected in
`controller/auth.routes.ts` and receive explicit names during migration. This is
an inventory, not the final independent reachability proof. The 2610-test merged
backend/auth/domain/solver run and 228 Gantt cases are recorded in the parent
verification ledger. Full shape binding and real reachability checks remain task3.1.

There are 40 baseline operations and four conditional OIDC operations. The document
route `/api/openapi.json` is the generated artifact surface, separate from this
application endpoint inventory. HEAD dispatch to GET is preserved via raw request
metadata, including the callback's explicit405 refusal.

| Method | Path                                             | Operation ID                                      | Composition                        |
| ------ | ------------------------------------------------ | ------------------------------------------------- | ---------------------------------- |
| GET    | `/metrics`                                       | `getMetrics`                                      | baseline                           |
| POST   | `/api/smoke/echo`                                | `postApiSmokeEcho`                                | baseline                           |
| POST   | `/api/auth/register`                             | `postApiAuthRegister`                             | baseline                           |
| POST   | `/api/auth/login`                                | `postApiAuthLogin`                                | baseline                           |
| GET    | `/api/auth/me`                                   | `getApiAuthMe`                                    | baseline                           |
| GET    | `/plans/by-solution/{slug}`                      | `getPlansBy-solutionBySlug`                       | baseline                           |
| POST   | `/api/projects`                                  | `postApiProjects`                                 | baseline                           |
| GET    | `/api/projects`                                  | `getApiProjects`                                  | baseline                           |
| POST   | `/api/projects/{id}/opened`                      | `postApiProjectsByIdOpened`                       | baseline                           |
| GET    | `/api/projects/{id}/export`                      | `getApiProjectsByIdExport`                        | baseline                           |
| GET    | `/api/projects/{id}`                             | `getApiProjectsById`                              | baseline                           |
| PATCH  | `/api/projects/{id}`                             | `patchApiProjectsById`                            | baseline                           |
| POST   | `/api/projects/{id}/saved-plans`                 | `postApiProjectsByIdSaved-plans`                  | baseline                           |
| GET    | `/api/projects/{id}/saved-plans`                 | `getApiProjectsByIdSaved-plans`                   | baseline                           |
| GET    | `/api/projects/{id}/saved-plans/compare`         | `getApiProjectsByIdSaved-plansCompare`            | baseline                           |
| GET    | `/api/saved-plans/{id}`                          | `getApiSaved-plansById`                           | baseline                           |
| PATCH  | `/api/saved-plans/{id}`                          | `patchApiSaved-plansById`                         | baseline                           |
| DELETE | `/api/saved-plans/{id}`                          | `deleteApiSaved-plansById`                        | baseline                           |
| POST   | `/api/projects/{id}/steps`                       | `postApiProjectsByIdSteps`                        | baseline                           |
| PATCH  | `/api/projects/{id}/steps/{stepId}`              | `patchApiProjectsByIdStepsByStepId`               | baseline                           |
| DELETE | `/api/projects/{id}/steps/{stepId}`              | `deleteApiProjectsByIdStepsByStepId`              | baseline                           |
| GET    | `/api/projects/{id}/work-items`                  | `getApiProjectsByIdWork-items`                    | baseline                           |
| POST   | `/api/projects/{id}/commands`                    | `postApiProjectsByIdCommands`                     | baseline                           |
| POST   | `/api/directory/commands`                        | `postApiDirectoryCommands`                        | baseline                           |
| POST   | `/api/projects/{id}/undo`                        | `postApiProjectsByIdUndo`                         | baseline                           |
| POST   | `/api/projects/{id}/redo`                        | `postApiProjectsByIdRedo`                         | baseline                           |
| GET    | `/api/teams`                                     | `getApiTeams`                                     | baseline                           |
| GET    | `/api/people`                                    | `getApiPeople`                                    | baseline                           |
| GET    | `/api/tags`                                      | `getApiTags`                                      | baseline                           |
| GET    | `/api/services`                                  | `getApiServices`                                  | baseline                           |
| GET    | `/api/work-item-types`                           | `getApiWork-item-types`                           | baseline                           |
| GET    | `/api/external-systems`                          | `getApiExternal-systems`                          | baseline                           |
| GET    | `/api/projects/{id}/history`                     | `getApiProjectsByIdHistory`                       | baseline                           |
| GET    | `/api/projects/{id}/calendar-markers`            | `getApiProjectsByIdCalendar-markers`              | baseline                           |
| POST   | `/api/projects/{id}/calendar-markers`            | `postApiProjectsByIdCalendar-markers`             | baseline                           |
| PATCH  | `/api/projects/{id}/calendar-markers/{markerId}` | `patchApiProjectsByIdCalendar-markersByMarkerId`  | baseline                           |
| DELETE | `/api/projects/{id}/calendar-markers/{markerId}` | `deleteApiProjectsByIdCalendar-markersByMarkerId` | baseline                           |
| POST   | `/internal/forward`                              | `postInternalForward`                             | baseline                           |
| POST   | `/internal/resume`                               | `postInternalResume`                              | baseline                           |
| GET    | `/health`                                        | `getHealth`                                       | baseline                           |
| GET    | `/api/auth/login`                                | `getApiAuthLogin`                                 | OIDC only; explicit migration name |
| GET    | `/api/auth/okta/callback`                        | `getApiAuthOktaCallback`                          | OIDC only; explicit migration name |
| POST   | `/api/auth/refresh`                              | `postApiAuthRefresh`                              | OIDC only; explicit migration name |
| POST   | `/api/auth/logout`                               | `postApiAuthLogout`                               | OIDC only; explicit migration name |

Baseline document responses are largely absent; use `http-refusals.md` and each
parser/service's actual outcomes for status/body declarations. Do not derive an
empty response contract from missing documentation. Every family must gain actual
shape/direct-handler/wire coverage as it migrates.

Incoming deadline slices immediately add required `lateBy: number | null` to each
scheduled slice returned by GET work-items. The shared response must carry it even
though the current handwritten frontend SliceView omits it. This migration does
not add deadline editing or a new scheduling-refusal code.

Marker GET/POST/PATCH resolve stored null colors to an automatic string on the
wire. Collection not_found omits field; collection taken names markerId only when
it was supplied. Addressed PATCH/DELETE keep field:markerId. Preserve services.ts's
shared announcements composition and the incoming actual-composition DB test.
