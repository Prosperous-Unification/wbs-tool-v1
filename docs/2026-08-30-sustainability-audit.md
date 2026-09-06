# Sustainability audit — 2026-08-30

Audit of `main` @ `5ec3b5f` against five asks: code reuse, LLM readability and
DDD, docs and minimal onboarding context, JSON-RPC and ArkType, and the
dev → test → fix loop. Four read-only sweeps plus timed runs on a Mac; every
figure below was measured this day, and every claim carries a path. Nothing
was changed by the audit itself.

Not to be confused with `2026-08-30-agent-loop-audit.md`, a different session's
audit of the same day's work; this one is about the codebase, that one about
the loop that produced it.

## Priorities

Ranked by what makes development most sustainable, not by LOC saved. Each
item depends on the ones above it; 3 and 4 can run in parallel, as can 5 and 6.

| #   | Change                                                                                                        | Why it ranks here                                                                                                           | Effort    | Tooling risk                                                |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| 1   | **Knowledge pipeline** — specs synced, archive as the ingest step, a doc lint, the ledger out of `AGENTS.md`  | Every later change compounds on whether the repo can state its own current behaviour. Today it cannot (§3).                 | ~1.5 days | none — in-house scripts                                     |
| 2   | **Test and lint tiers** — suffix convention, per-tier targets, two harnesses, ESLint cache, prettier direct   | Turns a 3-minute signal into a 3-second one; every later agent runs it hundreds of times.                                   | ~3 days   | none — mature flags                                         |
| 3   | **Command registry** (ArkType, one descriptor per kind; MCP tools derived from it)                            | Removes five hand-kept copies of the write vocabulary and finishes both of Dany's 4.1/4.2 asks without a transport rewrite. | ~5 days   | low — Elysia 1.4 Standard Schema, verify JSON-Schema export |
| 4   | **be-01 domain layer** — `planning/` vs `application/`, rows out of the barrel, pure `Revision`/preconditions | Makes the domain testable at T0 and liftable to `libs/domain`; `undo.test.ts` stops needing 12 repositories.                | ~4 days   | none                                                        |
| 5   | **fe-01 split** — `WbsTable` into concept modules, test file split to match, generated wire types             | The single biggest per-touch cost (11k + 15k LOC per edit) and the 182-second test.                                         | ~5 days   | none                                                        |
| 6   | **Mechanical reuse collapses** — satellite store, named dimension, auth macro, refusal tables, e2e fixtures   | Real but secondary; folded into 4 and 5 where they touch the same files.                                                    | in 4/5    | none                                                        |
| 7   | **Optional** — JSON-RPC envelope, oxlint/Biome/tsgo, fe-01 response validation                                | Only after 3; each gated on a maturity check (§7).                                                                          | —         | see §7                                                      |

### Same items, ranked for iteration speed

The order above optimises for sustainability. Ranked by effect on the
dev → test → fix loop per hour spent, three things move: the lint quick wins
lead on their own, the `wbs-table.test.tsx` split is pulled forward ahead of
the component split, and the knowledge pipeline splits into a cheap half that
matters for the loop and a heavy half that does not.

| Loop # | Slice                                                                               | From | Effort  | Effect on the loop                                                                      |
| ------ | ----------------------------------------------------------------------------------- | ---- | ------- | --------------------------------------------------------------------------------------- |
| L1     | ESLint `--cache`, prettier direct, `lint:fast` tier                                 | #2   | ~1.5 h  | lint 41–62s → 2–3s on every edit; largest gain per hour in this audit                   |
| L2     | Suffix convention, per-tier targets, be-01 harness, fe-01 fake API                  | #2   | ~3 days | `test:unit` < 3s; 24 files stop hand-wiring `WorkItemService`                           |
| L3     | Split `wbs-table.test.tsx` by its `describe` blocks, **before** touching `WbsTable` | #5   | ~½ day  | 552 serial tests become ~10 files across 4 workers: 182s → ~50s, zero production change |
| L4     | `config.yaml:31` fix + ten module READMEs                                           | #1   | ~½ day  | per-task read set 5–20× smaller (§3 table); the rest of #1 is sustainability, not speed |
| L5     | `WbsTable` split into concept modules                                               | #5   | ~4 days | the biggest per-edit cost left (11k LOC loaded to touch one concept)                    |
| L6     | Command registry                                                                    | #3   | ~5 days | a command change is one edit instead of five; MCP tools stop being path names           |
| L7     | be-01 domain layer                                                                  | #4   | ~4 days | `undo.test.ts` and the DB-tier service suites move to T0                                |
| L8     | Spec sync, archive-as-ingest, doc lint, ledger move                                 | #1   | ~1 day  | compounding, not per-iteration; schedule after L5                                       |
| —      | #6 and #7                                                                           |      |         | unchanged                                                                               |

## 0 · Numbers

| Measure                                     | Value                                                                           | Source                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `libs/domain` tests                         | 128 in **0.2s**                                                                 | `bun test`                                                      |
| `apps/be-01` tests                          | 1,203 in **26.6s**; 45 of 88 files open SQLite                                  | `bun test`                                                      |
| `apps/fe-01` vitest                         | 1,897 in **185s**                                                               | `TZ=UTC bunx vitest run`                                        |
| of which `wbs-table.test.tsx`               | 552 tests, 15,570 LOC, **182s** — one file, serial                              | same                                                            |
| `eslint` libs/domain · be-01 · fe-01 (cold) | 12s · 41s · 62s                                                                 | 5s fixed cost per project is the `projectService` program build |
| `eslint` be-01 with `--cache`, warm         | **2.5s** (2.8s with one file touched)                                           | measured with `--cache-location .nx/eslintcache`, then removed  |
| `nx format:check --all`                     | 44s; `prettier --check` on the same 1,447 files direct: **14s**                 | nx's file walk is the difference                                |
| `tsc --build --force` be-01 · fe-01         | 3.3s · 10s                                                                      | `--force` rebuilds every run                                    |
| tokens loaded before the task is known      | ~17.5k (`LLM_README` 1.3k words, `AGENTS.md` 3.5k, `CONTEXT.md` 6.4k)           | `wc -w`                                                         |
| `openspec/specs/`                           | **does not exist**; 92 unarchived changes hold 89k words of deltas, archive 41k | `ls`                                                            |
| Plan-command kinds                          | 36, written out by hand in **5** places                                         | §1 R1                                                           |
| LOC that collapse into shared seams         | ~5,500 of 183k                                                                  | §1                                                              |

## 1 · Reuse

Fifteen clusters; the top six carry ~80% of the collapsible LOC. The pattern:
the repo _knows_ two things must behave identically — the comments say
"line for line", "deliberately shaped as a copy of" — and achieves it by
copying, the one method that cannot enforce it. `libs/domain/effective-label.ts`
is the counter-example done right and the model for all of these.

- **R1 · Command vocabulary ×5.** `PlanCommand` union (`apps/be-01/src/service/plan-command.ts:16`),
  `PLAN_COMMAND_KINDS` (`:104`), `VARIANTS` OpenAPI schema (`controller/plan-command-schema.ts:53`, 247 LOC),
  `parseCommand` switch (`controller/work-item.controller.ts:543`, 236 LOC),
  `applyAll` switch (`service/plan-commands.ts:279`, 363 LOC). fe-01 sends
  `{ kind: string } & Record<string, unknown>` (`apps/fe-01/src/lib/wbs-api.ts:1637`) — the
  origin of every write is untyped. Only drift guard: a length check at `plan-command-schema.ts:300`.
- **R2 · Tag / Service / Work-item-type ×3 at six layers.** `repository/directory.ts:64–910`,
  `service/directory.service.ts:211–397`, `plan-commands.ts:549–635`,
  `wbs-api.ts:743–782`, `directory-page.tsx:573–1234`. `removeTag` and
  `removeWorkItemType` differ by one identifier. ~450 LOC.
- **R3 · 24 test files hand-build `WorkItemService`;** `buildServices()`
  (`apps/be-01/src/services.ts:84`) is used by none. 41 files repeat
  `mkdtemp + runMigrations + openDrizzle`; `register()` copied ×5, `send()` ×4. ~1,200 LOC.
- **R4 · Estimate / Actual / Measure / Progress ×4 at three layers.** Four
  identical repositories (560 LOC), eight `setX/clearX` service pairs with one
  ten-step body (`work-item.service.ts:2410–2786`), four `storedX` readers, four
  identical fixtures. ~600 LOC.
- **R5 · 401 guard retyped at 23 handlers;** `read`-scope check at one
  (`project.controller.ts:123`). `directory.controller.ts` is 44 guard lines of 69.
- **R6 · fe-01:** eight copies of the localStorage read/write/forget trio
  (`wbs-table.tsx:726–1274`, ninth in `gantt-panel.tsx:657`); four copy-pasted
  reference-set columns (`:7867–8075`) feeding 8 callbacks and 12 props; six
  independent `ProjectApi` fakes totalling 1,500 LOC with no `src/testing/`;
  303 LOC of hand-written wire types mirroring the then-committed OpenAPI document, which
  mcp-01 already derived from. HTTP task 3.2 now generates that document from
  `libs/contracts/src/http/document-from-shapes.ts` without a committed JSON input.
- Also: refusal-code → HTTP status in 5 places (`work-item.controller.ts:799`,
  `:493`, `role.controller.ts:14`, `project.controller.ts:123`, inline literals);
  refusal → sentence in 5 fe-01 places with two different 5xx sentences
  (`wbs-api.ts:1493`, `wbs-table.tsx:294`); markdown export once per tier with
  different escapers (`project.controller.ts:41`, `plan-export.ts:315`) — a user-visible
  inconsistency; e2e has 18 specs and one shared helper (`seedPlan` ×6, `chooseTheme` ×4).

## 2 · Readability and DDD

Inside functions the names are good; the R2 ban list holds (six bare `result`
locals repo-wide). The costs are structural and at the glossary edge.

- **D1 · `WbsTable` is one 8,820-line function** (`apps/fe-01/src/components/wbs/wbs-table.tsx:2445–11265`):
  51 `useState`, 78 `useCallback`, 25 `useMemo`, 23 `useRef`, 18 `useEffect`, no
  nested components. ≥14 separable concepts; eight are browser memory, not rendering.
- **D2 · be-01 has no domain layer.** `WorkItemService` (`service/work-item.service.ts:1076`)
  holds 14 stores + a broadcaster, 28 methods; `create()` (`:1487`) interleaves
  reads, inserts, four `moveAll`s and a broadcast. ~3,700 lines of _pure_ rules
  (`schedule.ts`, `roll-up.ts`, `derive-numbers.ts`, `compensating.ts`,
  `place-sibling.ts`, `assumed-assignee.ts`, `dependency.ts`, `directory-usage.ts`)
  sit under `service/` and import rows from `repository/index.ts` — a 1,903-line
  barrel of ~45 row types, ~15 store ports and constants. `libs/domain` holds ~30%
  of the domain. Measured cost: `undo.test.ts` is 1,891 lines and wires 12 real
  repositories to test one rule, because `revision + 1` lives inside a SQL statement.
- **D3 · ADR 0009 on `main` describes a rule `main` does not have.** Its table
  (`docs/adr/0009…:20`) says "Tag — Accumulate"; `libs/domain/src/effective-tag.ts:60`
  on `main` says "override rather than union"; and the `0008-tags-accumulate-down-the-tree.md`
  it cites six times exists only on the unpushed local branch `feat/tags-accumulate`,
  together with the `effective-tag.ts` change. Not a wrong ADR — an ADR merged ahead of
  its code, with the code's branch unmerged. Until that branch lands, an agent reading
  `main` implements union with documentation on its side.
- **D4 · `CONTEXT.md` is ~10 concepts behind the schema:** no Tag, Service, Work
  item type, External system/ref, Solution ref, Progress, Saved view, Facet,
  Critical, Slack (used interchangeably with "float", `schedule.ts:123` vs `:1594`).
  _Service team_'s Avoid list forbids "service", now a table, route and entity.
  "Phase" is the UI word for Role in ~200 places including the MCP-facing
  description (`plan-command-schema.ts:19`); the glossary forbids it and nothing
  records it as the reader-facing word. `WorkItemService` names both the class
  and a join table (`schema.ts:1192`).
- **D5 · One operation, three names:** `deleteWorkItem` → `WorkItemService.remove`
  → `ProjectApi.remove`. MCP tool names are Elysia-generated `operationId`s
  (`getApiProjectsByIdWork-items`); 40 of 51 operations carry no prose
  (`apps/mcp-01/src/openapi-tools.ts:203`).
- **D6 · Stale REST-era artifacts:** `app.ts:180–192` describes registering
  `capacityController` and `priorityBandController`; neither is registered and
  neither file declares a route — both became command kinds.
- **D7 · Banned nouns in the outcome contract:** `WorkItemOutcome<T>.result`
  (`work-item.service.ts:601`), `BatchResult`, `ItemState` in `libs/domain`.
  `ProjectApi` methods are bare verbs (`create`, `patch`, `remove`, `tree`).

## 3 · Docs and onboarding cost

| Task                  | Source to open | Docs        | Why                                                                            |
| --------------------- | -------------- | ----------- | ------------------------------------------------------------------------------ |
| Add an MCP tool       | ~4,700 LOC     | 5.4k words  | mcp-01 has a real README naming files + the derivation rule                    |
| Add a work-item field | ~49,000 LOC    | 16k words   | schema → store → 3.8k service → controller → 2k client → 11k table, +24k tests |
| Fix a Gantt bug       | ~30,900 LOC    | 45.7k words | 8 unarchived `gantt-*` change dirs, no current-state spec                      |

- **C1 · No `openspec/specs/` tree.** 56 of 92 unarchived changes are fully
  ticked; 25 more have one "Dany looks at it" task open. Every delta says
  `## MODIFIED Requirements` against a base that never existed. The repo's own
  `openspec/DANY-REQUEST-AUDIT-2026-08-30.md` concedes the consequence: check
  `main` by grepping the symbol, not by reading `tasks.md`.
- **C2 · `openspec/config.yaml:31` injects "There is no CI. The gate is
  `bunx nx run-many -t test lint typecheck`"** into every artifact — a command
  `AGENTS.md:306` forbids, contradicting `ci.yml`, `LLM_README.md`, `AGENTS.md`.
- **C3 · `AGENTS.md` lines 124–300 (2,352 of 3,497 words) are the incident
  ledger,** auto-loaded every session, out of ordinal order; the one general
  rule in it duplicates lines 73–83.
- **C4 · 25 of 32 docs are orphans:** all nine ADRs, all ten `docs/plans/*`
  (superseded by change dirs), `docs/2026-08-29-wave-1-decisions.md`,
  `docs/auth-integration.md`. `LLM_README.md` does not link `CONTEXT.md`.
  `CONTEXT.md` has two headings for 125 terms and ends with 27 lines of deploy paths.
- **C5 · Stale claims:** `LLM_README.md:19` "ArkType" (HTTP routes are
  TypeBox/hand parsers); `:102` missing `apps/`; `swap.js` cited ×5 (source is
  `tools/tool-remote-scripts/src/swap.ts`); ADR 0005's `bin/sync.ts` is
  `bin/dev-deploy.sh`; ~35 bare basenames; `scaffold-tech-setup` flagged stale
  yet live, claiming TanStack DB and "no CI/CD".
- **C6 · Module READMEs:** mcp-01 has a real one; nine are three-line Nx stubs;
  fe-01 has none.
- **C7 · R3 is genuinely followed and excellent** — 303 JSDoc blocks in
  `wbs-table.tsx`, 122 in `work-item.service.ts`, invariants and `@throws` with
  `{@link}`. The code documents itself better than the docs do; the minimal
  read set should point _into_ files.

**Target read set:** `AGENTS.md` ≤140 lines (ledger → `docs/checks-that-cannot-fail.md`);
`LLM_README.md` with a modules table; one ≤40-line README per module in
mcp-01's shape (what, 4–6 files, test command, landmines); `CONTEXT.md`
grep-able (`###` per term, sub-domains, deploy tail to the runbook);
`openspec/specs/wbs-domain` created by `openspec-sync-specs`. Always-loaded
budget ≈1.8k tokens, from 17.5k.

## 4 · JSON-RPC and ArkType

**4.1 — finish the command bus; do not rewrite the transport.** 27 paths; two
(`POST /api/projects/:id/commands`, `POST /api/directory/commands`) carry 36
kinds and ~85% of mutations. What remains resource-shaped: role CRUD, project
create/patch/opened, undo/redo, 12 reads. The MCP mismatch is not the verb, it
is the lossy middle: path-generated `operationId`s, one flat schema for 36
kinds, no prose. A JSON-RPC envelope over that document yields the same tools.

- Command registry: one descriptor per kind `{ kind, schema, apply, describe }`
  in `libs/contracts`; parser, `PLAN_COMMAND_KINDS`, JSON Schema, dispatch and
  the fe-01 type all derived. mcp-01 derives one tool per kind from the registry
  (glossary verbs, real descriptions); the batch tool stays for multi-command writes.
- Fold the residue in as kinds (`createRole`, `renameRole`, `removeRole`,
  `patchProject`, undo/redo). Reads get a query registry with explicit names.
- A JSON-RPC 2.0 `POST /rpc` is then a ~150-line adapter; add it only if a
  client wants it (§7).

**4.2 — ArkType: yes, as a completion.** `@sinclair/typebox` is imported
directly by zero files; ArkType already declares 30 schemas in 12 files (all of
`libs/contracts`, `libs/config`, the three app configs). The hold-out is the HTTP
boundary: ~19 `t.` uses in five controllers plus eight hand-written body parsers
(`hand-parsed-body.ts:9–28`) that exist because Elysia strips unknown properties
before a guard can refuse them.

- Elysia 1.4.28 (installed) accepts Standard Schema V1; ArkType 2.2 implements
  it. Registry schemas use `'+': 'reject'` — the unknown-key refusal the hand
  parsers were for. `parseCommand`'s 236 lines go away.
- OpenAPI from `schema.toJsonSchema()` per kind, stitched by the existing emit
  CLI; `openapi-document.test.ts` keeps guarding drift. **Verify first** that
  every registry type is JSON-Schema-expressible (morphs and regex-narrowed
  strings are the usual exceptions).
- fe-01 imports the type from a runtime-free subpath (`wbs-api.ts:16`'s bundle
  reason stays honoured; the six pure `@wbs/domain/*` subpaths prove the pattern).
- Performance is not the argument — validation is off every measured critical
  path. Single-sourcing and readability are. Say so in the intent.
- R5: one negative per kind on the production path, watched failing with
  `'+': 'reject'` removed.

## 5 · The loop

No mechanical way exists today to answer "which suite covers this module, and
which is the fast one": no `bunfig.toml`, no suffix convention beyond six
`*.integration.test.ts` files unwired to any runner, `package.json` offers
`test` or nothing, lefthook runs zero tests, CI runs `run-many` on a "10k LOC
is cheap" rationale that is 18× stale and never runs the 19 Playwright specs.

### Test tiers

| Tier       | Suffix           | Holds                                                                                                                                                                | Today              | Target                   | Runs                               |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------ | ---------------------------------- |
| T0 pure    | `*.test.ts`      | `libs/*`, be-01's 33 in-memory-fixture suites (`src/testing/*-fixture.ts` open no DB), fe-01 pure TS (`gantt-geometry`, `table-frame`, `plan-export`, `tree-search`) | not runnable alone | < 3s                     | every edit; lefthook               |
| T1 store   | `*.db.test.ts`   | be-01's 45 SQLite suites, migrations                                                                                                                                 | ~25s               | ~15s after harness       | before "done"                      |
| T2 http/ws | `*.http.test.ts` | Elysia app, gw-01 sockets, mcp-01 server                                                                                                                             | mixed into T1      | ~8s                      | before "done"                      |
| T3 dom     | `*.dom.test.tsx` | fe-01 jsdom                                                                                                                                                          | 185s               | ~45s (split + 4 workers) | per component dir; whole before PR |
| T4 browser | `e2e/*.spec.ts`  | Playwright, shifted ports                                                                                                                                            | local only         | CI job `pixels`          | CSS / default-action changes; PR   |

Mechanism: suffix rename (one commit, no logic); per-project `test:unit`,
`test:store`, `test:http`, `test:dom` targets (`bun test` filters by path
pattern; vitest gets `projects`); root `bun run test:unit`; lefthook runs it.
Two harnesses: `apps/be-01/src/testing/harness.ts` on `buildServices()` and
`apps/fe-01/src/testing/fake-api.ts`. Split `wbs-table.test.tsx` to match the
`WbsTable` split. `schedule-benchmark.test.ts`'s wall-clock assertion behind an
opt-in target.

### Lint tiers

Measured: the fixed cost is the `projectService` program build (5s on a 3k-LOC
lib); rule time is small except four typed rules (`no-deprecated` 3.8s,
`no-unsafe-assignment` 2.4s, `no-misused-promises` 2.1s, `no-floating-promises`
1.4s on fe-01).

1. `--cache --cache-location .nx/eslintcache` on every lint target: be-01
   41s → 2.5s warm. Caveat: a type change in A can stale B's `no-unsafe-*`
   verdict, so the cache is for the inner loop; CI and the gate stay uncached.
2. Prettier direct with explicit globs instead of `nx format:check --all`:
   44s → 14s, same 1,447 files; keeps the "checks nothing on main" landmine dead.
3. `lint:fast` (no `projectService`, everything but the four typed rules) on
   every edit and in lefthook; `lint:typed` (today's config) before "done" and in CI.
4. Drop `--force` from local `tsc --build`; keep it in CI (it exists because the
   solution-config bug hid a no-op build; incremental builds do not have that fault).

### Modularity

Cross-project boundaries are good: `@nx/enforce-module-boundaries` with scope +
runtime tags (`eslint.config.js:16–37`), zero relative cross-project imports,
no fe-01 → be-01 import (both `@wbs/be-01` and `@wbs/gw-01` aliases are dead).
The coupling is _inside_ projects: `components/wbs/` is a flat 47-file bag;
`service/` mixes pure planning with orchestration. Per-module READMEs plus the
be-01 and fe-01 splits give each module a "read these 4 files, run
`nx run <p>:test:unit`" entry; `nx affected` becomes safe in CI after that.

## 6 · Knowledge pipeline (the LLM-wiki fit)

The repo is already two-thirds of an LLM-wiki and lacks exactly its three
operations. Raw sources: `openspec/changes/**`, decision files, git log —
strong. Wiki: `CONTEXT.md`, ADRs, runbooks, JSDoc — present, unsynced. Index:
`LLM_README.md` — R1 already. Log: none; the `AGENTS.md` ledger is a log
embedded in the schema. Lint: none; every finding in §3 is one it would have caught.

- One ingest point: `opsx:archive` = sync delta → `openspec/specs`, touch
  `CONTEXT.md`/README/ADR, append `docs/log.md`. Archive is the step currently
  skipped (56 ticked, unarchived).
- The design interview (brainstorming + grilling + domain-modeling) is the
  _query_ step; terms already go to `CONTEXT.md` as they resolve.
- R3 stays primary: wiki pages hold cross-file knowledge only and `{@link}` into
  code — never a sixth copy of what JSDoc says.
- `wiki-lint` under R5: backticked paths exist, ADR refs resolve, every
  `schema.ts` table has a glossary term, `config.yaml` agrees with `ci.yml`,
  caps hold — each with a negative test; lefthook + CI.
- Port the schema rules into `AGENTS.md`; do not adopt a third-party wiki layout —
  this repo's constraints are stricter than the pattern's.

## 7 · Tool maturity

Standard: mature, or new but on a steady path to reliability, with a check
named before adoption. Knowledge cutoff for the model writing this is early
2026; items marked _verify_ need a current look before the decision.

| Tool / feature                             | Verdict               | Basis                                                                                                                                                                                              | Check before adopting                                                                      |
| ------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ESLint `--cache`                           | **Adopt**             | Core feature for years                                                                                                                                                                             | none                                                                                       |
| Prettier direct invocation                 | **Adopt**             | Mature                                                                                                                                                                                             | keep explicit globs so the base-ref trap stays dead                                        |
| Vitest `projects`, `bun test` path filters | **Adopt**             | Stable APIs                                                                                                                                                                                        | none                                                                                       |
| `nx affected`                              | **Adopt after tiers** | Mature; the per-project inputs are already right                                                                                                                                                   | none                                                                                       |
| ArkType 2.x                                | **Adopt**             | Stable since 2025; already carries 30 schemas here                                                                                                                                                 | `toJsonSchema()` coverage for the registry's types                                         |
| Elysia Standard Schema (1.4)               | **Adopt, verify**     | Shipped in the installed 1.4.28; younger than the TypeBox path                                                                                                                                     | that `openapi.json` still emits for Standard-Schema routes, or emit via ArkType and stitch |
| Command registry, doc lint, harnesses      | **Adopt**             | In-house code, no dependency                                                                                                                                                                       | R5 negatives                                                                               |
| Biome (formatter)                          | **Later, verify**     | 2.x is mature and near-Prettier output; migration churn on 1,447 files                                                                                                                             | diff a full reformat; if it is not near-zero, stay on Prettier                             |
| Biome / oxlint (lint, fast tier)           | **Not yet**           | Syntactic rules mature (oxlint 1.0 mid-2025); neither runs the plugins this repo depends on (`jsdoc`, `@nx/enforce-module-boundaries`, tanstack, react-hooks); type-aware linting is preview-grade | revisit when plugin parity or type-aware rules leave preview                               |
| tsgo (TypeScript native)                   | **Watch**             | Preview at cutoff; large speedups reported; not the stable compiler                                                                                                                                | adopt when it is the default `tsc` of a stable TS release                                  |
| JSON-RPC 2.0 envelope                      | **Optional**          | Trivial after the registry; no client asks for it today                                                                                                                                            | a client that needs it                                                                     |
| LLM-wiki pattern                           | **Adopt as pattern**  | Pattern, not a dependency                                                                                                                                                                          | none                                                                                       |

## Method

Four Explore sweeps (duplication; naming/DDD; docs; tests/modularity/API/
validation), each read-only, plus timed runs listed in §0. Spot-checked by hand
before publishing: ADR 0009 vs `effective-tag.ts`; `app.ts` controller
registration; `config.yaml:31`; `plan-command-schema.ts:300`; the 24 hand-built
`WorkItemService` test files; the arktype/typebox import counts. Playwright was
not timed. The transient `.nx/eslintcache` created for the measurement was removed.
