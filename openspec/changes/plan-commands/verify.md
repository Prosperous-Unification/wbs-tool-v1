# Verification Report

> Produced by `openspec-verify-change` AFTER apply completes. Failed checks go
> back to the artifact that caused them; then re-run verify.

**Change**: `plan-commands`
**Verified at**: `2026-08-29 15:40`
**Verifier**: Claude (Fable 5), on Dany's Mac; CI on PR #177 is the gate of record

---

## 1. Structural Validation

- [x] `openspec validate --all --json` — all items `"valid": true` (78 items)

| Item | Type | Issues |
| ---- | ---- | ------ |
| —    | —    | —      |

---

## 2. Task Completion

- [x] Every `- [ ]` in tasks.md is now `- [x]` — 13 of 13

| Task | Reason incomplete | Blocks archive? |
| ---- | ----------------- | --------------- |
| —    | —                 | —               |

---

## 3. Delta Spec Sync

| Capability   | Sync status | Note                                                           |
| ------------ | ----------- | -------------------------------------------------------------- |
| `wbs-domain` | ✗ pending   | archive applies it: 5 ADDED, 1 MODIFIED (the journal contract) |

---

## 4. Failure Proofs

> Every row was watched failing on the production call path with the named fault
> injected, then restored and watched green. Messages are verbatim.

| Check (file)                                               | Fault injected                      | Test that observed the failure                                                                  | Result                                                               |
| ---------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `compensating.ts` `touchedBy` batch arm                    | `steps` left out                    | `compensating.test.ts` › touches what its steps touch, each once                                | `expected [] to equal [ 'w1', 'w2' ]`                                |
| `write-lock.ts` `run`                                      | reduced to `work()`                 | `write-lock.test.ts` › runs one holder at a time, in the order they asked                       | order `a:in, b:in, b:out, a:out`                                     |
| `plan-commands.ts` all-or-none                             | `rollback` → `commit`               | `plan-commands.test.ts` › leaves the first two unwritten when the third is refused              | `expected [ 'Sand', 'Strip' ] to equal []`                           |
| `work-item.service.ts` collector seam                      | `record` writes per step            | `plan-commands.test.ts` › is one journal entry, one plan event, and one undo…                   | `Expected length: 1, Received length: 6`                             |
| `plan-commands.ts` ref resolution                          | `…Ref` fields passed through raw    | `plan-commands.test.ts` › refuses a ref nobody minted…                                          | `reason: "not_found"` instead of `"unknown_ref"`                     |
| `plan-commands.ts` write lock                              | `lock.run` bypassed                 | `plan-commands.test.ts` › applies a rename queued behind a refused batch, after it              | rename rolled back with the refused batch                            |
| `plan-commands.ts` `walk` (atomic undo)                    | commit on a refusal                 | `plan-commands.test.ts` › takes back the steps an undo already applied when a later step cannot | `expected "X", received "Undone"`                                    |
| `work-item.service.ts` `apply` batch arm                   | per-step refusal ignored            | same                                                                                            | `expected false, received true`                                      |
| `plan-commands.ts` cap                                     | `too_many_commands` check removed   | `work-item.controller.test.ts` › refuses a batch that is not a list of known commands…          | `Expected: 400, Received: 200`                                       |
| `work-item.controller.ts` `parseCommand` per-kind dispatch | replaced by the bare `kind` check   | `work-item.controller.test.ts` › validates each command with the write’s own parser…            | `Expected: 400, Received: 404` (`parentId_must_be_id_or_null`)       |
| `openapi-tools.ts` retired-route exclusions (phase 1)      | `/api/work-items/*` dropped         | `openapi-tools.test.ts` › offers batches, not single writes                                     | `Expected length: 0, Received length: 16`                            |
| `wbs-client.ts` refusal body forwarded                     | `trimmed` dropped                   | `server.test.ts` › forwards a refused batch whole: the code, and the index and kind beside it   | `Expected to contain: '"at":1'`                                      |
| `wbs-api.ts` `projectOf` refusal                           | first-seen project guessed          | `wbs-api.test.ts` › refuses to write to a row no tree has shown it…                             | resolved instead of `unknown_work_item` (RED before the map existed) |
| `plan-commands.ts` lock released before the broadcast      | `announceTreeNow` inside `lock.run` | `plan-commands.test.ts` › lets go of the write lock before the broadcast leaves                 | test timed out at 5000ms — batch B never got the lock                |
| the deleted single routes                                  | `main` itself                       | `work-item.controller.test.ts` batch describe; `openapi-tools.test.ts` count 20                 | 51 tools / routes answering on `main`                                |
| batch inverse mid-failure via role removal (first attempt) | —                                   | rejected as a check that could not fail: staleness refused before any step (`“A” has changed`)  | rewritten on a hand-appended entry, then watched (rows above)        |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [x] Atomicity proven on real SQLite (`plan-commands.test.ts`), never on the in-memory fixtures
- [x] No row relies on an exit code

---

## 5. Gate Output

- [x] `bunx nx format:check --all` — exit 0
- [x] `bunx nx run-many -t lint typecheck build --parallel=2` — `Successfully ran targets lint, typecheck, build for 23 projects` (1 pre-existing warning: `wbs-table.tsx` exhaustive-deps)
- [x] `bunx nx run-many -t test --parallel=2` — all projects green except `tool-dagger:test` and `tool-devsync:test`, both macOS-only (`flock` missing; GNU `stat -c`), untouched by this change; CI on Linux is where they are proven.

```
be-01   bun test:      1162 pass / 0 fail (85 files)
mcp-01  bun test:       103 pass / 0 fail (7 files)
fe-01   vitest:        1803 pass / 2 fail — plan-mermaid weekend cases, timezone only (pass under TZ=UTC)
openapi.json regenerated; openapi-document.test.ts fresh (3 pass)
openspec validate --all: 78 items, 0 invalid
```

**Browser gate** (`CI=1 bunx playwright test -c apps/fe-01/playwright.scratch.config.ts`, shifted ports 3111/3211/4211, local Chromium, `locale: en-US`):

```
201 passed, 3 failed (5.2m)
✘ deps-cell.spec.ts:430  picks the add button up off the row it is hovered on   — animation poll never settles (fails on main too)
✘ keyboard.spec.ts:471   Escape leaves the stored day alone                     — typed day lands day/month swapped (fails on main too)
✘ keyboard.spec.ts:615   saves only the year that was typed                     — same (fails on main too)
```

The three failures are the ones recorded on 2026-08-28 as failing identically on `main`
with this configuration on this machine. Passing and load-bearing here: every gantt
spec (`setDate` waits for either date write), every keyboard chord spec (writes read by
command kind), mobile and reference-cells fixtures seeding through batches.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree (the untracked `apps/fe-01/playwright.scratch.config.ts` is local tooling, never committed)
- [x] Relevant commits pushed — `33a251e..HEAD` on `change/plan-commands`, PR #177

---

## Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — two tool suites red on macOS for host reasons and three browser tests that fail identically on `main`; none touched by this change. CI on #177 decides.
- [ ] ❌ FAIL

**Next step**:

Undraft #177; when CI's `gate` and `pixels` are green, squash-merge and archive the change.
