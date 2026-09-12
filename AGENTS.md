# Agent rules

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit this one; both are
listed in `.nxignore` because explicit symlink arguments make Prettier exit 2.

Five rules govern this repo:

- **R1** `LLM_README.md` is an index.
- **R2** Names carry the domain, not documentation.
- **R3** Knowledge lives with what it describes.
- **R4** Intent first, four artifacts.
- **R5** Unknown is not OK, and every check must be provably breakable.

## Orientation and evidence (R1)

- Read `LLM_README.md` first, then only its link for your task. It stays within
  150 lines and contains pre-task orientation, the gate and routing—not mutable findings.
- Detail belongs in its linked spec, ADR, runbook or JSDoc; never duplicate it.
- Bun and Nx only. Never npm, pnpm, yarn or a second task runner.
- Never claim a command, behavior or dependency works without fresh output.
- State every skipped, unavailable or unverified check. Read callers and tests before
  behavior changes, and preserve unrelated changes.

## Names (R2)

- Use the shortest unambiguous scoped name. Functions are verb-object; booleans are predicates.
- Never `data`, `result`, `obj`, `tmp`, `item` or `handle`.
- A needed qualifier usually signals a missing type. Rename unclear code instead of explaining it.

## Knowledge placement (R3)

- Symbol knowledge is JSDoc on that symbol: behavior, throws, invariants and strangeness.
- Cross-file decisions, glossary and runbooks live in `docs/`; link them with
  `{@link Symbol}` and update JSDoc with behavior. `CONTEXT.md` is terms only.
- Only hard-to-reverse, surprising decisions with real alternatives earn `docs/adr/`.
- No file headers or syntax narration. `apps/be-01/src/repository/db.ts` is the reference.
- No `any`, unchecked cast, `!` or eslint-disable outside tests without an adjacent
  comment naming the boundary that makes it safe.

## Failure policy and proofs (R5)

- Validate external input once at its boundary; keep internal types precise.
- Missing/unreadable/malformed trusted state, absent tools and unexpected nullish values throw.
  Never default them. Catch only modeled recovery or to add context and rethrow.
- Never `|| true`, `|| echo`, empty catch or log-and-continue for required work.
- Model expected outcomes: Elysia request/auth/404/conflict as typed 4xx; React loading,
  empty/query failure/optional props as rendered states; cancellation as controlled exit;
  retries as bounded convergence then throw. Impossible React unions reach an Error Boundary.
- Degrade only an explicitly optional feature, visibly in its return type and with a test.
- Every new or changed safety check needs a production-path negative. Watch it fail with
  the check removed or its dependency broken, then add an adjacent `Proof:` comment naming
  the injected fault and observed test. Test absence and unreadability when distinguished.
- An exit code proves only what the tool contract guarantees. The incident catalogue and
  its observed proof details live at [checks that cannot fail](docs/findings/checks-that-cannot-fail.md).

## Change workflow (R4)

- OpenSpec is required for observable behavior, contracts, migrations, deploy safety or
  architecture; skip it for docs, mechanical refactors and fixes restoring a precise spec.
- Intent (problem, outcome, non-goals, constraints) is at most 400 words. Alternatives go in ADRs.
- One design interview combines `superpowers:brainstorming`, `grilling` and
  `domain-modeling`; resolve terms into `CONTEXT.md` immediately. `grill-with-docs` is a
  human-only router. Use `.agents/skills/domain-modeling/{CONTEXT,ADR}-FORMAT.md`.
- Delta specs state testable behavior; add `design.md` only for non-trivial technical shape.
  `tasks.md` is ordered TDD slices; `verify.md` records commands, results and R5 proofs.

## Migrations

- Every `migration.sql` ships beside `down.sql`; migration lint and rollback require it.
- Forward migrations are additive because blue and green share SQLite mid-swap. Lint applies
  this to `migration.sql`, not destructive rollback-only `down.sql`.
- Swap records applied migrations before moving forward and reverses to that set on abort via
  `migrate-status-cli.ts` and `migrate-down-cli.ts --to=<name>`. Failed rollback must report
  loudly with the manual completion command.
- Rollback refuses a migration edited after application.

## Gate

- Before claiming done on h2puni, run `bin/h2puni-gate.sh <sha>`. It takes the canonical
  host-wide heavy lock, checks out that SHA under the lock, then runs CI format, test, lint,
  typecheck and build. Do not run raw full Nx gates there or check out the SHA first.
- Trust the printed `h2puni gate: running on <sha>`, not intent. Exit 65 means the shared
  gate tree is dirty; move or commit named files and rerun—never unattended `git clean`.
- A held lock queues for 30 minutes; `HEAVY_LOCK_WAIT_SECONDS=0` opts into refusal.
  Format needs `--all`; the base-ref default is empty on main.
- Gate also runs `openspec validate --all --json`. CI adds secrets and migration lint;
  lefthook is bypassable, CI is not. Never `--no-verify`.
- A missing required tool blocks the task: install it or report the block.
