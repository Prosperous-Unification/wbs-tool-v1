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
- One design interview, three skills together: `superpowers:brainstorming` for
  approach exploration, `grilling` to stress-test it, `domain-modeling` for the
  vocabulary. Resolved terms go into `CONTEXT.md` as they resolve, not batched at
  the end. Not `grill-with-docs` — it is a router marked
  `disable-model-invocation`, so only a human typing `/grill-with-docs` reaches it.
- `CONTEXT.md` and ADR format come from `.agents/skills/domain-modeling/`
  (`CONTEXT-FORMAT.md`, `ADR-FORMAT.md`). That is the format of record; neither
  file is stubbed in advance, so the first real term creates it in that shape.
- Delta specs carry testable behavior. `design.md` only when the technical shape is
  non-trivial.
- `tasks.md` holds ordered TDD slices. There is no separate plan artifact.
- `verify.md` records commands, results, and the failure-proof table from R5.

## Migrations

- **Every migration ships a `down.sql` beside its `migration.sql`.** The
  migration lint fails without one, and `readMigrationFolders` refuses to run a
  rollback it cannot complete.
- Forward migrations stay additive (add columns, never drop): blue and green
  share one SQLite file mid-swap, so the outgoing release keeps reading the
  schema while green migrates. The lint enforces this on `migration.sql` and
  deliberately does not on `down.sql` — reversing an additive change is
  destructive by definition, which is why it lives in a separate file that runs
  only when one colour is being taken away.
- The swap reads the applied set before migrating and, on abort, reverses back
  to it (`migrate-status-cli.ts`, then `migrate-down-cli.ts --to=<name>`). A
  rollback that fails says so loudly and prints the command to finish by hand:
  the alternative is an old release serving against a schema it never asked for
  while the deploy claims it rolled back.
- Editing a migration after it has been applied is refused at rollback time —
  its `down.sql` no longer describes what is in the database.

## Checks that cannot fail

R5 exists because this failure keeps recurring — eighteen times so far. Fixed: `assertPragmas` with no runtime
caller, the migration lint's unreachable `ALTER TABLE ... RENAME COLUMN` branch, `readRemoteState`
reading an unreadable file as never-deployed, `shellcheck … || echo`, the secrets scanner's
`.catch(() => '')` (an unreadable file scanned as clean — in a CI gate), and `dev:setup` skipping a
missing `.env.example`.

Three more on 2026-08-05: `swap.js`'s `readRecordedColor` reading an unreadable state file as
never-deployed; `configure.sh` replacing an unreadable `.env` with one line, dropping every
other secret; and the install target shipping whatever was left in `dist/` while reporting
"checksums verified against the local build" — true, about the stale file it had just
installed. The last one was caught by checking the installed artifact, not by reading code.

Two more on 2026-08-06, both in tests that guarded a real behaviour and could not see it break:
`does not take the focus or the half-typed value` delivered a peer edit that left the field's
value alone, so it passed with the `key` that caused the bug still in place; and the smoke's
`internal-forward` check posts to be-01 itself, so it reports ok against a gw-01 whose secret
be-01 rejects — watched passing, live, next to the new check failing.

One more on 2026-08-06, and the first one found in the gate itself: `nx typecheck` ran
`tsc --noEmit -p apps/<app>/tsconfig.json` against a solution-style config — `"files": []`,
`"include": []`, two `references` — so it compiled **nothing**. A deliberate
`const x: number = 'not a number'` passed it. A missing required field on `buildApp` reached
dev and 500'd every `/api/teams` request. Both targets now run `tsc --build --force` against
the source project, watched catching that exact bug. The test projects are not in the gate
yet: 10 pre-existing errors, named in `teams-and-assignees/verify.md`, are their own change.
The seventeenth is gw-01's copy of the same fault sat unnoticed until the 2026-08-09 review sweep: its
typecheck ran the solution config and compiled nothing, hiding a dead scaffold `index.ts`
re-exporting a module that does not exist. Its target now runs `tsc --build --force` on the
lib project too, watched failing on a deliberate `const deliberatelyWrong: number = 'not a
number'` and green with it removed; the dead file is deleted. Its spec project holds two
pre-existing errors (`forward-client.test.ts`), out of the gate like the others'.

The fourteenth, on 2026-08-09, found by driving real Chrome by hand and in the shape of the one
above. `actions-menu.tsx`'s item guard refused a modified Enter by returning — **without**
`preventDefault` — so the browser fired the button's own click and took the item anyway; a
chord aimed at the plan duplicated a branch because a menu happened to be open. The proof
that guarded it, `every chord is inert while a row's ⋯ menu is open`, dispatches synthetic
keys into jsdom, which performs no default action at all: it could see the guard deleted and
could never see the guard left half-done. The negative test for that fault has to be a
browser, and it is now in `e2e/keyboard.spec.ts`, watched failing on Shift+Enter with a third
row on screen.

The fifteenth, on 2026-08-09 in `M mobile-cards`, and the same shape as the fourteenth: the
oracle was jsdom and the fault was a browser's. The toolbar sheet closed itself from an
`onClickCapture`, so React flushed the discrete update **between** its capture and bubble
dispatches, the control was unmounted before the bubble pass walked the fiber tree for
handlers, and every toolbar control on the sheet did nothing at all — no request, no work
item. All sixteen of `plan-cards.test.tsx`'s tests passed through it, `closes when a control
on it acts on the plan` included, because jsdom had already collected `Add work item`'s own
`onClick` when the close ran. Found in Chrome at 390×844 by the `POST …/work-items` simply
missing from the network log. The close is on the bubble phase now, and the browser is the
only thing that can say so.

The sixteenth, on 2026-08-09 in `G gantt-view`, and the first caught **inside a browser test
as it was being written**. The e2e assertion that a not-before caret stays clear of its bar
took the successor bar as `bars.at(1)` — which in a fresh project is the same row's second
_role_: an unestimated QA slice of zero width standing at the same workday. The overlap check
compared the caret against a bar that has no area, so it could not fail, and injecting the
fault it was written for — the caret drawn on the bar — left it green. The bar is now found
through the caret's own row, its width and height asserted non-zero first, and the injected
fault was watched failing before the test was believed.

Two more the same day, in `P phases-ui`, and **neither shipped** — which is why neither is in
the count above. `page-shortcuts.test.tsx` had six checks about an open modal and none about a
closed one, so nothing could see `ModalContent` suspending the page's keyboard the moment a
dialog was _declared_; `P` is `Modal`'s first production caller and 49 unrelated tests went
red the hour it mounted one. And `P`'s own `unfoldedRoles` sanitizer, which the plan asked
for, was written, its negative watched **passing** with the line deleted, and the line removed:
`columns` maps over `roles`, so a dead id in the accordion selects nothing. Write the negative
before you believe the line.

Two more on 2026-08-09 in `T2 compact-columns`, and **neither shipped**. The earliest-start cell
opened its editor from `onMouseDown`, so React flushed the discrete update inside that dispatch
and the at-rest input was gone before Chromium performed the event's **default action** — focusing
the node it had hit-tested. Focusing a detached node moves the focus to `<body>`, that blurred the
editor, a blur is an exit, and the editor closed: a click on the cell did nothing at all. All 314
cases in `wbs-table.test.tsx` stayed green through it, because every one of them opens the editor
with Enter and jsdom performs no default action. Found in Chromium by counting
`input[type=date]` after a click and getting none; the open is on `click` now, and
`e2e/keyboard.spec.ts` watched the fault. R5 #14/#15's fault class, third time.

And the fix written for the _other_ half of that contract was a check that could not fail. Escape
had to stop the blur it causes from committing the abandoned day, so `DateField` grew a flag the
next commit attempt would spend. Removing that flag was watched — and the browser test passed
anyway: the row's editor is unmounted on the way out, so there is no blur to suppress, and on the
one field that does stay on screen (the toolbar's project start date) the flag sat behind the
`node.value = agreed.current` beside it and was never reached. The flag is deleted; the value
reset is the guarantee, and it was watched failing on `expected "2026-09-09" to be "2026-06-01"`
with a real blur, in a browser.

Two more on 2026-08-09 in `G gantt-calendar-axis`, and **neither shipped**. The calendar
axis's cell count was asserted against the canvas it stands over — a real relation, and a
vacuous check as written, because the canvas was **sized from the axis's own length**. The
named fault (the axis built from the workday horizon while the canvas kept the calendar one)
moved both and was watched **passing**; the canvas is now sized from the placed horizon, the
two are computed apart, and the same fault was then watched failing on `expected …(6) to have
a length of 8 but got 6`. And `bun run e2e` **reused another checkout's dev server**: the
committed Playwright config sets `reuseExistingServer: !isCi`, a `bun run dev` from
`~/wd/puni/wbs-tool-v1` held 3100/3200/4200, and 66 browser tests passed against code this
worktree had never built — the two new gantt assertions failed only because they described a
chart that checkout did not draw. A browser gate that silently measures a different checkout
is the same fault wearing a third hat; see `LLM_README.md`'s landmine.

One more the same day, in `N name-title-body`, and it **did not ship** either. The hover
preview must show a work item's name as text rather than as markdown source, and the negative
written for it used the name `# not a heading <script>`. With the fault injected — the name
concatenated into the source — it **passed**: `# # x` is an ATX heading whose content is the
literal `# x`, so the parser handed back the exact string the test was asserting had never
been parsed. The name carries `*not*` now, and the heading is asserted to contain no element
the parser made; both failures were then watched. The test that catches a parser has to use
punctuation a parser eats.

Two more on 2026-08-09 in `D directory-page`, and **neither shipped**. The directory page must
show a membership only once be-01 has answered, and the negative written for that — refuse the
patch, then assert the refused team is not chipped — was watched **passing** with the optimistic
`setPeople` put back in front of the request. It had to: the page re-reads after every write, so
an optimistic page and a patient one land on the same screen and the only difference is the
window between the request and the answer. The fake holds the patch in flight now and the
assertion is made **there**, where the fault was then watched failing on `expected <button …> to
be null`. And `page-nav.tsx` carried an `activeOptions={{ exact: true }}` written on the
reasoning that `/` is a prefix of `/directory`: removing it changed nothing at all, because the
two are siblings under the root route and `Link` decides "active" by route match rather than by
string. It is deleted, and why is written where it was going to be. **Assert in the window the
fault lives in, and delete the guard whose removal you cannot see.**

One more on 2026-08-09 in `T1 column-widths-drag`, and it **did not ship**. The remembered
column widths are read as a claim, and the plan asked for three per-entry rules with three
negatives. The middle one — `if (!Number.isFinite(width)) continue;` — was written and its
negative watched with the line deleted: it **passed**. `1e999` is the only non-finite width
JSON can express, it parses to `Infinity`, and `Infinity` is above every ceiling exactly as
`-Infinity` is below every floor; JSON has no `NaN` for the case the line would have been
about. The range check beside it already refused both. The line is deleted and both storage
cases watch the range check instead, watched failing on `expected '' to be '56px'`. Write the
negative before you believe the line — `P phases-ui`, one change later.

One more on 2026-08-14 in `linked-row-hover`, and it **did not ship**. The pointed row's tint had
to outrank the alternating band's hover, so `data-row-lit` joined that rule's `:not()` chain — and
the negative written for it, pointing a row from a **Gantt bar**, was watched **passing** with the
attribute taken back out. `nth-child(even):hover` needs the pointer on the `<tr>`: point from the
chart and `:hover` never matches at all, so the banded rule cannot compete and there is nothing
for the `:not()` to hold up. The collision needs both conditions on **one** row, which after the
fix below is only a bar holding the focus while the pointer rests on that same row in the table —
`depFocus`'s own arrangement. Rewritten that way it failed on `Expected "oklab(0.96448 …)"
Received "oklab(0.917255 …)"`. **A negative about `:hover` has to hover the thing.**

And the fault that made the rewrite necessary is the shape worth remembering: the first cut wrote
`data-row-lit` on **every** hovered row, which made the banded rule unmatchable and stopped the
stripe moving under the pointer at all. All **1319** jsdom tests passed through it; four
assertions in `e2e/hover-cards.spec.ts` failed, in both palettes. It was found by running the
**whole** browser gate rather than the new tests in it — a change that edits a shared CSS rule has
no business believing a filtered run.

Prove your check fails when the thing is broken, and say so in the comment. A check whose
failure mode has never been observed is a claim, not a gate.

## Gate

- Before claiming done on h2puni, run `bin/h2puni-gate.sh`. It acquires the
  canonical host-wide heavy-work lock before running CI's format, test, lint,
  typecheck, and build commands. Do not run the raw full Nx gate on h2puni.
  `--all` is not decoration: without it the scope is `git diff main HEAD`, which is
  EMPTY on main — a format check that checks nothing and passes.
- OpenSpec changes also run `openspec validate --all --json`.
- `.github/workflows/ci.yml` runs all of the above plus the secrets scan and
  migration lint on every push and PR. It is not bypassable; lefthook is.
- Never `--no-verify`. It skips lefthook, and CI will catch it later and louder.
- A missing required tool blocks the task. Install it or report the task blocked.
