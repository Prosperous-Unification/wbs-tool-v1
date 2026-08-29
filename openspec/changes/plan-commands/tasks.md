<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks". A check with no negative test is not done.

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The composite compensating command (be-01)

- [x] 1.1 `CompensatingCommand` gains `{ do: 'batch', steps }`; `touchedBy` is the union, `subjectOf` the first step's; `readCommand` accepts it — test: `compensating.test.ts` `a batch touches what its steps touch`, `a batch's subject is its first step's`; negative: `steps` left out of `touchedBy`, watched failing.
- [x] 1.2 `apply` runs a batch's steps in order and refuses the whole batch on the first refusal — test: `work-item.service.test.ts` `undoing a batch puts every step back`, `a batch inverse that fails midway applies nothing`; negative: the per-step refusal ignored, watched failing on a half-applied inverse.

## 2. The batch runner (be-01)

- [x] 2.1 `withWriteLock` (async mutex) in `services.ts`, taken by every write handler and by the runner — test: `write-lock.test.ts` `a second write waits for the first`, `reads do not wait`; negative: the lock a no-op, watched failing on interleaving order.
- [x] 2.2 `WorkItemService.runBatch(projectId, actorId, commands)`: outer `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` on the connection, `BatchCollector` that captures recordings and suppresses per-step broadcasts, refs resolved per D4, one journal entry per D3, one broadcast after commit — tests (real SQLite, `boot.test.ts` style): `a refused third command leaves the first two unwritten`; negative: `ROLLBACK` replaced by `COMMIT`, watched failing on the rows present. `one batch is one journal entry and one Cmd+Z`; negative: collector bypassed (record writes per step), watched failing on `expected 1 journal row, got 5`. `a batch of one records the command itself`. `a batch that changed nothing records nothing`. `a child under a parent created in the same batch` and `a ref nobody minted refuses at its index`; negative: ref substitution removed, watched failing on `unknown parent`. `undo leaves the directory alone`.
- [x] 2.3 A single write arriving during a refused batch survives — test: `write-lock.test.ts` `a rename during a refused batch is applied after it`; negative: lock removed from the runner, watched failing on the rename rolled back.

## 3. The route and the document (be-01)

- [x] 3.1 `POST /api/projects/:id/commands` in `work-item.controller.ts`: hand-parsed body (the derived-field rule), a `oneOf` OpenAPI schema over every kind with descriptions, ≤ 200, `{ error, at, kind }` refusals through `statusFor`, `unknown_ref`/`duplicate_ref` as 400 — test: `work-item.controller.test.ts` `a batch answers ids per ref and the undo state`, `a 201-command batch is refused before any is applied`, `a refused command names its index and kind`; negative: the cap removed, watched failing.
- [x] 3.2 Regenerate `apps/be-01/openapi.json`; `openapi-document.test.ts` green; `DOCUMENT_DESCRIPTION` names the batch contract.

## 4. mcp-01

- [x] 4.1 `EXCLUDED_PATHS` grows every single-item plan and directory write; the exclusion list is asserted against the document (an entry excluding nothing fails) — test: `openapi-tools.test.ts` `the write surface is commands, undo, redo and the project routes` (count < 15, no `/api/work-items/*`), `every command kind is described in the commands tool`; negative: one write route left out of the exclusions, watched failing on the count.
- [x] 4.2 `server.test.ts` round trip: `tools/call postApiProjectsByIdCommands` forwards the body and returns be-01's `{ error, at, kind }` as tool content on refusal (D7) — negative: `at` dropped from the forwarded refusal, watched failing.

## 5. fe-01 on batches

- [x] 5.1 `wbs-api.ts` `commands(projectId, list)`; every `ProjectApi`/`DirectoryApi` write method posts a batch of one, signatures unchanged; the test fake gains `commands` routing each kind to its existing handler — test: `wbs-api.test.ts` `a rename is one commands request with one patchWorkItem`, `every write method posts exactly one command`; every existing fe-01 test green unchanged.
- [x] 5.2 Browser gate on shifted ports: `keyboard.spec.ts` network assertions (`writes` arrays) updated to the `commands` path; whole gate green.

## 6. Retire the single-item routes

- [x] 6.1 Delete the single-item write routes from be-01 controllers; regenerate `openapi.json`; mcp-01's exclusion assertion now proves the list matches nothing left over and the entries are removed — test: `work-item.controller.test.ts` `PATCH /api/work-items/{id} is 404`, `openapi-document.test.ts` fresh; every be-01 integration test that posted to a single route rewritten to a one-command batch.
- [x] 6.2 `docs`: `apps/mcp-01/README.md` tool count and the batch example; `LLM_README.md` doc index line for the MCP server; `HUMAN_README.md` if it names routes. Full gate + `openspec validate`.
