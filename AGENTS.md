# Agent rules

`CLAUDE.md` and `GEMINI.md` are symlinks to this file. Edit this one. They are
listed in `.nxignore` because `nx format:check` passes files to prettier as
explicit patterns, and prettier exits 2 on an explicitly-named symlink.

Five rules govern this repo. Everything below is those five, made operational.

- **R1** `LLM_README.md` is an index.
- **R2** Names carry the domain, not the documentation.
- **R3** Knowledge lives with what it describes.
- **R4** Intent first, four artifacts.
- **R5** Unknown is not OK, and every check must be provably breakable.

## Orientation (R1)

- Read `LLM_README.md` first, then only the linked doc your task needs.
- `LLM_README.md` is capped at 150 lines and holds only what you need _before_ you
  know your task: orientation, the gate command, landmines, open findings, doc index.
- Detail goes in a linked spec, ADR, runbook, or JSDoc. Never duplicate a linked doc.
- Bun and Nx only. Never npm, pnpm, yarn, or a second task runner.

## Evidence

- Never claim a command, behavior, or dependency works without fresh output.
- State every skipped, unavailable, or unverified check explicitly.
- Read callers and tests before changing behavior. Preserve unrelated changes.

## Names (R2)

- Shortest name that is unambiguous in its scope. Functions are verb-object.
  Booleans read as predicates.
- Never `data`, `result`, `obj`, `tmp`, `item`, `handle`.
- If a name needs a qualifier to disambiguate, that qualifier is usually a missing type.
- Rename unclear code rather than explaining it in prose.

## Knowledge placement (R3)

- Knowledge about a symbol lives in JSDoc **on that symbol**: what it does, what it
  throws, what invariant it holds, why it is strange.
- Knowledge that spans files — decisions, glossary, runbooks — lives in `docs/` and
  is linked from the JSDoc. A decision spanning five files has no correct file to
  live in; put it in one and the other four never learn about it.
- `CONTEXT.md` is the domain glossary. Terms only, no implementation detail.
- `docs/adr/` holds decisions that are hard to reverse, surprising, and had real
  alternatives. Nothing else earns an ADR.
- Cross-link with `{@link Symbol}`. Update JSDoc in the same change as the behavior.
- No file headers. No narrating syntax (`// increment the counter`).
- No `any`, unchecked cast, `!`, or eslint-disable outside tests without an adjacent
  comment naming the boundary that makes it safe.

`apps/be-01/src/repository/db.ts` is the reference for this rule done right.

## Failure policy (R5)

- Validate external data once at its boundary. Internal types stay precise after that.
- Unknown is not OK: missing file, unreadable state, absent tool, malformed trusted
  data, unexpected nullish — **throw**. Never convert them to a default.
- Catch only to recover from a modeled condition, or to add context and rethrow.
- Never `|| true`, `|| echo`, empty catch, or log-and-continue for a required operation.

These are **not** invariant failures. Model them, do not throw:

- Elysia: malformed request, auth failure, 404, conflict → typed 4xx, never a 500.
- React: loading, empty, query failure, absent optional prop → rendered states.
  Impossible union states throw into an Error Boundary; no assertions in `render`.
- Retries: bounded polling for health convergence and socket drain, then throw.
- Cancellation: aborted request, closed socket, SIGTERM are controlled exits.

Degrading is allowed only for an explicitly optional feature, with degraded status
visible in the return type and a test covering it. Log-and-continue is not degradation.

## Non-vacuous checks (R5)

Checks that cannot fail have shipped here six times. This is the rule that stops it.

- Every new or changed safety check needs a negative test on its production call path.
- Watch that test fail with the check removed or the dependency deliberately broken.
- Add an adjacent `Proof:` comment naming the injected fault and the test that
  observed the failure.
- Test both absence and unreadability when code distinguishes filesystem state.
- An exit code is evidence only if the tool's contract guarantees the effect.
  `caddy reload` exits 0 having done nothing.

## Change workflow (R4)

- An OpenSpec change is required for observable behavior, contracts, migrations,
  deploy safety, or architecture. Skipped for docs, mechanical refactors, and fixes
  that restore an already-precise spec.
- Intent first: problem, desired outcome, non-goals, constraints. Max 400 words.
  Alternatives belong in an ADR, not in the intent.
- One design interview, both skills together: `superpowers:brainstorming` for
  approach exploration and `grill-with-docs` for domain language. Resolved terms go
  into `CONTEXT.md` as they resolve, not batched at the end.
- Delta specs carry testable behavior. `design.md` only when the technical shape is
  non-trivial.
- `tasks.md` holds ordered TDD slices. There is no separate plan artifact.
- `verify.md` records commands, results, and the failure-proof table from R5.

## Gate

- Before claiming done, run locally what CI will run anyway:
  `bunx nx format:check` and `bunx nx run-many -t test lint typecheck build`.
- OpenSpec changes also run `openspec validate --all --json`.
- `.github/workflows/ci.yml` runs all of the above plus the secrets scan and
  migration lint on every push and PR. It is not bypassable; lefthook is.
- Never `--no-verify`. It skips lefthook, and CI will catch it later and louder.
- A missing required tool blocks the task. Install it or report the task blocked.
