# HTTP operation inventory

This is the final shared declaration inventory. Each row is one `EndpointShape` in
`libs/contracts/src/http/shapes.ts`; the shape owns its method, path, operation ID,
ordered policies, request schemas, response representations, refusal status/body
pairs, and OpenAPI summary.

There are 40 always-mounted operations and four conditional OIDC operations. Local
authentication therefore mounts and publishes 40 shapes; OIDC mounts and publishes
all 44. `apps/be-01/src/app.routes.test.ts` proves one binding per owned shape and
reaches every method/path through the production app. `/api/openapi.json` is the
generated document route and is intentionally outside this application-operation
inventory. The adapter retains the arrived method in request metadata, so a HEAD
request can reach the callback's explicit 405 prevalidation without changing its
declared GET method.

| Method | Path                                             | Operation ID                                      | Composition      |
| ------ | ------------------------------------------------ | ------------------------------------------------- | ---------------- |
| GET    | `/metrics`                                       | `getMetrics`                                      | always           |
| POST   | `/api/smoke/echo`                                | `postApiSmokeEcho`                                | always           |
| POST   | `/api/auth/register`                             | `postApiAuthRegister`                             | always           |
| POST   | `/api/auth/login`                                | `postApiAuthLogin`                                | always           |
| GET    | `/api/auth/me`                                   | `getApiAuthMe`                                    | always           |
| GET    | `/plans/by-solution/{slug}`                      | `getPlansBy-solutionBySlug`                       | always           |
| POST   | `/api/projects`                                  | `postApiProjects`                                 | always           |
| GET    | `/api/projects`                                  | `getApiProjects`                                  | always           |
| POST   | `/api/projects/{id}/opened`                      | `postApiProjectsByIdOpened`                       | always           |
| GET    | `/api/projects/{id}/export`                      | `getApiProjectsByIdExport`                        | always           |
| GET    | `/api/projects/{id}`                             | `getApiProjectsById`                              | always           |
| PATCH  | `/api/projects/{id}`                             | `patchApiProjectsById`                            | always           |
| POST   | `/api/projects/{id}/saved-plans`                 | `postApiProjectsByIdSaved-plans`                  | always           |
| GET    | `/api/projects/{id}/saved-plans`                 | `getApiProjectsByIdSaved-plans`                   | always           |
| GET    | `/api/projects/{id}/saved-plans/compare`         | `getApiProjectsByIdSaved-plansCompare`            | always           |
| GET    | `/api/saved-plans/{id}`                          | `getApiSaved-plansById`                           | always           |
| PATCH  | `/api/saved-plans/{id}`                          | `patchApiSaved-plansById`                         | always           |
| DELETE | `/api/saved-plans/{id}`                          | `deleteApiSaved-plansById`                        | always           |
| POST   | `/api/projects/{id}/steps`                       | `postApiProjectsByIdSteps`                        | always           |
| PATCH  | `/api/projects/{id}/steps/{stepId}`              | `patchApiProjectsByIdStepsByStepId`               | always           |
| DELETE | `/api/projects/{id}/steps/{stepId}`              | `deleteApiProjectsByIdStepsByStepId`              | always           |
| GET    | `/api/projects/{id}/work-items`                  | `getApiProjectsByIdWork-items`                    | always           |
| POST   | `/api/projects/{id}/commands`                    | `postApiProjectsByIdCommands`                     | always           |
| POST   | `/api/directory/commands`                        | `postApiDirectoryCommands`                        | always           |
| POST   | `/api/projects/{id}/undo`                        | `postApiProjectsByIdUndo`                         | always           |
| POST   | `/api/projects/{id}/redo`                        | `postApiProjectsByIdRedo`                         | always           |
| GET    | `/api/teams`                                     | `getApiTeams`                                     | always           |
| GET    | `/api/people`                                    | `getApiPeople`                                    | always           |
| GET    | `/api/tags`                                      | `getApiTags`                                      | always           |
| GET    | `/api/services`                                  | `getApiServices`                                  | always           |
| GET    | `/api/work-item-types`                           | `getApiWork-item-types`                           | always           |
| GET    | `/api/external-systems`                          | `getApiExternal-systems`                          | always           |
| GET    | `/api/projects/{id}/history`                     | `getApiProjectsByIdHistory`                       | always           |
| GET    | `/api/projects/{id}/calendar-markers`            | `getApiProjectsByIdCalendar-markers`              | always           |
| POST   | `/api/projects/{id}/calendar-markers`            | `postApiProjectsByIdCalendar-markers`             | always           |
| PATCH  | `/api/projects/{id}/calendar-markers/{markerId}` | `patchApiProjectsByIdCalendar-markersByMarkerId`  | always           |
| DELETE | `/api/projects/{id}/calendar-markers/{markerId}` | `deleteApiProjectsByIdCalendar-markersByMarkerId` | always           |
| POST   | `/internal/forward`                              | `postInternalForward`                             | always           |
| POST   | `/internal/resume`                               | `postInternalResume`                              | always           |
| GET    | `/health`                                        | `getHealth`                                       | always           |
| GET    | `/api/auth/login`                                | `getApiAuthLogin`                                 | conditional OIDC |
| GET    | `/api/auth/okta/callback`                        | `getApiAuthOktaCallback`                          | conditional OIDC |
| POST   | `/api/auth/refresh`                              | `postApiAuthRefresh`                              | conditional OIDC |
| POST   | `/api/auth/logout`                               | `postApiAuthLogout`                               | conditional OIDC |

## Generated consumers

- `mountedEndpoints` binds each owned shape to a typed handler; `mountEndpoints`
  enforces its policies and validates both sides of the boundary.
- `openApiPlugin` publishes only the shapes mounted by that app configuration.
  `emit-openapi-cli.ts` emits the full 44-shape registry during the backend build.
- `mcp-01` derives 32 tools from the full generated document after excluding auth,
  internal, smoke, health, and metrics paths.
- `clientFromShapes` derives typed methods from operation IDs. Browser fetch and
  in-process fake transports pass through the same request and response validation.

The declarations include success bodies and their representation: JSON 200/201,
empty 204/302, and text 200/500. GET work-items includes required
`lateBy: number | null` on every scheduled slice. Marker GET/POST/PATCH resolve a
stored null color to an automatic wire color; marker refusal detail stays scoped to
the collection or addressed operation. See `http-refusals.md` for the final failure
boundary.
