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

R5 exists because this failure keeps recurring — twenty-one times so far. Fixed: `assertPragmas` with no runtime
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
the solution config, whose references include the spec project, watched catching that exact
bug. The test projects are in the gate: measured 2026-09-07 at `3e17fb01`, all 23 spec projects
compile with **0** errors and a deliberate `const deliberatelyWrong: number = 'not a number'` in a
test file fails the target (`docs/refactoring/verify.md` § "Merged state").
The seventeenth is gw-01's copy of the same fault sat unnoticed until the 2026-08-09 review sweep: its
typecheck ran the solution config and compiled nothing, hiding a dead scaffold `index.ts`
re-exporting a module that does not exist. Its target now runs `tsc --build --force` on the
lib project too, watched failing on a deliberate `const deliberatelyWrong: number = 'not a
number'` and green with it removed; the dead file is deleted. Its spec project's two
errors (`forward-client.test.ts`) are gone with the rest: 0 on 2026-09-07.

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

Five more on 2026-08-30 in `estimate-triple-visible`, and **none shipped** — one family, and
the family is worth the name: **an assertion made outside the window the fault lives in.**
Four of them were the same mechanism. The folded estimate cell is an _uncontrolled_ box: it
holds what was typed from the keystroke onwards, and only the round trip replaces that with
what the row now says. So `await waitFor(() => expect(cell.value).toBe('2/3/10'))` is
satisfied by its **first** sample, before the answer it is about, and it was watched passing
with the whole change reverted. Wait on something only the answer can produce — the figure
beside the cell, the row's total days — and _then_ read the box. The third was subtler and
the same shape: typing a cell's own value back into itself proves nothing, because
`LiveField` diffs it against its baseline and sends nothing at all; the round trip has to be
made through a **second** row. The fourth assumed a draft where there is none — the folded
cell writes no draft on a keystroke (`onTyped` belongs to the `@` list), so "typed and not
left" is not the draft window and a live-preview fault was invisible in it; the window opens
on the blur that holds a refusal. And the fifth is `G gantt-calendar-axis` again in a browser:
the assertion that a 96px cell still shows its whole trio was proved by giving the figure
beside it `flex: 1` — which makes both children share the slack, so nothing clips and the
proof was watched **passing**. Replaced by the widest trio anybody has actually typed here,
`20/24/30`, it found the design genuinely broken: the box clipped by 8px at the row's own
type, `Expected: <= 0, Received: 8`. **Inject the fault the check is about, not the one that
is easy to inject.**

One more on 2026-08-30 in `plan-toolbar-controls`, and it **did not ship**: the plan asked for
the check and the plan's own shape was the vacuity. `tasks.md` 5.1 said to pin the folded
toolbar's width **before** the change and assert the bar got narrower, with the negative being
`Expand all` and `Collapse all` given their text labels back. But the pre-change bar carried
those labels _and_ `Freeze numbering` and `Unfreeze all` as two buttons where there is now one
`Freeze #` menu, so the faulted bar is **narrower** than the before-figure and `asked <=
before` passes with the fault in — a pin measured against a bar that no longer exists. The pin
is the shipped bar's own budget instead (1552.734375 measured, 1600 pinned), and the fault was
then watched failing on `Expected: <= 1600 · Received: 1658.828125`, 106px above it. **A
before-and-after pin is only a check when the fault rebuilds the whole "before".**

Two more on 2026-08-30 in `name-links-and-height`, and **neither shipped** — but they are
the rule's own failure mode rather than a check's, which is why they are worth the paragraph.
Both were `Proof:` comments **written before the failure was observed**: the
`[data-cell-rendered] a` rule's, which guessed "the click opened the editor instead of the
tab — expected 0 popups", and the notes' `a: LinkFollowable` mapping's, which guessed
`expected … attribute "target" … received <null>`. Injected, the first failed on
`page.waitForEvent: Test timeout of 60000ms exceeded` — no popup at all — and the second
failed **earlier than the line it named**, on `expect(locator).toHaveText … element(s) not
found`, because react-markdown's own `a` carries no `data-name-link` for the locator to find.
Both comments were corrected to what was observed. A guessed `Proof:` is indistinguishable
from an observed one to every future reader, and one of these two named an assertion the
fault never reaches — which is exactly how a check that cannot fail acquires a comment saying
it can. **Write the comment from the failure output, never from the expectation.**

One more on 2026-08-30 in `estimate-weights-and-rounding`, and it **did not ship**. The
change's headline is an order — a step's three points are combined, that figure is rounded,
and only then are steps summed — and the negative written for it injected the fault the
change is _about_: the parent roll-up taken back to "roll the triples up, charge once". It
was watched **passing**. It had to be: a leaf's steps were already charged one at a time
before the change (`finalsOf` summed `finalDays` per step), so rolling triples up per step
changes nothing on a leaf, and the order only becomes visible across **children**. The fault
that test is actually about is the other order — charge the sum rather than the step — and
injected that way it failed on `Expected: 1, Received: 0.5`. The parent half now carries the
roll-up fault as its own proof, on a parent. **Inject the fault at the level the order lives
at**, which is `estimate-triple-visible`'s "assert in the window the fault lives in" wearing
a second hat.

Three on 2026-08-31 in `reference-cell-escape-and-hover`, and **none shipped** — but the one
worth the paragraph is the check that was already on `main` and could not fail.
`types-cell.spec.ts`'s headline, `a row of three types is the same height as a row of none`,
carried a recorded note saying its own negative had been watched leaving all five cases
green, and blamed the `<td>` clip for hiding a wrapped strip. Both halves were wrong: the
column is exempt from that clip now and the case **still** passed with `flex-wrap: wrap`
injected on the strip and both chip groups. The reason is that the row was measured **with
the cell still being edited**, and an edited reference strip is an absolutely positioned
panel — not in the row's flow at all, free to wrap to any height without moving anything. One
`blur()` before the measurement, and the same injection failed on `Expected: 26.1875 /
Received: 87.1875`. **A layout check has to be taken in the layout the reader lives in**, which
is `estimate-triple-visible`'s "assert in the window the fault lives in" wearing a third hat —
and a recorded explanation for a vacuity is itself a claim, worth re-checking before it is
inherited. The other two were written this round and deleted rather than shipped: a focus
handoff on a chip's `✕` whose negative cannot be reached because the button can never hold
the focus (Shift+Tab in the box is the grid's move, measured), and an `elementFromPoint` probe
four pixels past a cell's right edge, which passes with the clip removed because the next
`<td>` paints its own background over the overflow.

One more on 2026-08-31 in `external-refs`, and it **did not ship**: the plan asked for a
check the design could not break. `tasks.md` 6.1 said to measure "a row with four systems and
a row with none ... to the same height", with the negative being "the marks moved into normal
flow". Injected — `markStyle`'s `position: 'absolute'` changed to `'static'` — the height
assertion was watched **passing**: 26.1875px either way. It had to. The ref cell's box is
12px inside a row the Name cell already stands 26.19px tall, so the row is never this cell's
to move and the equality is a true statement about a column that has nothing to do with it.
What the fault really does is collapse the marks — a `<span>` in normal flow is inline, width
and height do not apply, and four 6px discs become zero-width text boxes outside the box they
were meant to sit in (`[164,150,0,15]`, measured). The check is now that each mark is a 6×6
disc inside its box, and the same fault was then watched failing on `jira is not a 6×6 disc ·
Expected {"height": 6, "width": 6} · Received {"height": 15, "width": 0}`. **A geometry claim
about a small box inside a bigger one is a claim about the bigger one**, which is
`estimate-triple-visible`'s "assert in the window the fault lives in" wearing a third hat.

One more on 2026-08-31 in `svg-export-and-gutter`, and it is the **gate** rather than a test:
`fe-01:lint` names its inputs one by one in `project.json`, and `vitest.setup.ts` and
`playwright-config.test.ts` — two of the seven `.ts` files at `apps/fe-01/` — were not among
them. A real `@typescript-eslint/no-unnecessary-condition` error written into `vitest.setup.ts`
was reported **clean** by `bunx nx lint fe-01`, and would have been by CI's `run-many -t lint`;
**lefthook** caught it, which is the hook this file calls bypassable while CI is not. Both files
are named now, watched failing on `vitest.setup.ts 153:18 error Unnecessary conditional` with
the fault back in and green with it gone. Add a new root-level file to that command the day you
add the file — a lint target scoped to a place the fault is not is the `main`-green landmine
above wearing a second hat.

One more on 2026-08-31 in `steps-schema-rename`, and it **did not ship** — but it is the first one
where the _migration_ and its check were wrong together. `ALTER TABLE role RENAME TO step` rewrites
other tables' `REFERENCES` clauses **only when `foreign_keys` is on as the statement is prepared**,
and `runMigrations` decided that pragma **once for the whole run**: if any pending migration carried
`-- foreign-keys-off-rebuild`, every pending migration ran unenforced. On dev, where the one marker
migration (`20260824010000_add_oidc_identity`) was applied a week earlier, nothing pending asked for
it and the rename was correct. On a **fresh** database every migration is pending, so the whole
bootstrap ran with foreign keys off and the rename left five tables pointing at a table that no
longer existed — `no such table: main.role` on the first insert into any of them. One file, two
schemas, decided by which database it landed on.

The check written to verify the rename — **"no table, column or index name carries the word
`role`"**, which is the spec's own scenario — **passed against the broken database**, because the
word survived only inside FK clauses and constraint names, neither of which is a table, column or
index. What found it was running the 1249 tests that already existed: 161 of them failed. The window
is now narrowed to the migrations that ask for it (`pendingNeedingForeignKeysOff`), and the check is
the reference clause plus a live write through it, watched failing on `Expected to contain:
"REFERENCES \"step\""` with the whole-run decision put back. **A check written from the spec's own
words can still be blind to the fault the spec is about — run everything, not the new test.**

One more on 2026-09-01 in `audit-columns`, and it is the first where the thing that could not fail
was a **type**. The 76 new audit columns were added to `schema.ts` by spreading a shared
`auditColumns()` into 26 tables — drizzle's own idiom for shared columns — and one of those tables
is `users`, which is the table the helper's `created_by` points **at**. So `users` needed the
helper's return type and the helper's return type needed `users`; TypeScript resolved the cycle by
inferring the spread as contributing **nothing**, in silence. Every row type in the schema lost all
three columns: `db.select().from(tag)` came back typed `{ id, name }`. Nothing caught it — the
migration created the columns, drizzle wrote and read them correctly at runtime, `nx typecheck`
passed, and the new behaviour tests passed while asserting `row.createdBy` on a property TypeScript
believed did not exist. What found it was the **LSP**, on the test file, because the test project is
out of the typecheck gate. Fixed by writing `users`' own two columns inline with the annotated
self-reference drizzle asks for, which breaks the cycle; proved by a throwaway probe asserting
`typeof tag.$inferSelect` accepts all three. **A silently-widened type is a check that cannot fail,
and the gate that would have caught this one does not read the files that noticed.**

Four on 2026-09-01 in `tool-hints-wait`, and **none shipped** — but two of them are new
shapes and the browser one is the most reusable thing in this list.

**Playwright's `toHaveCount(0)` is a _retrying_ assertion, so it is not a way to say
"nothing here right now".** The new hint layer must draw no wait ring inside its first
400ms, and `await expect(ring).toHaveCount(0)` two hundred milliseconds in was watched
**passing** with `RING_QUIET_MS` set to 0: the assertion polls for thirty seconds and is
satisfied the moment the count reaches zero, which for a ring is the moment the card
replaces it, three seconds later. The fault was then caught two assertions further down by
a card that had also gone wrong, which reads in the report as a completely different bug.
Every silence in `e2e/hints.spec.ts` is now `expect(await locator.count()).toBe(0)` — read
once, at the instant it is about — and the same fault failed on `Expected: 0 · Received: 1`
at the line it belongs to. **An auto-waiting matcher cannot assert an absence that is only
temporary.**

**A locator that says "the first mark of this kind" is not about any particular mark.** The
case that a project fact opens within 400ms found its subject with `page.locator('td
[data-fact]').first()`, and passed with the fault it exists for — the row number turned back
into a `data-hint` — because a row carries several facts and the locator simply moved on to
the next one. Pinned to `td span[data-fact="010"]`, the same fault failed at the locator
itself: `element(s) not found`.

The other two are old shapes wearing this change's clothes. An advance computed from the
constant it asserts against (`waitOut(RING_QUIET_MS - 250)`) went **negative** under the
injected fault and failed the run on `Negative ticks are not supported` rather than on the
assertion — a failure that says nothing about the behaviour; the advances are literals now.
And a ring read at the **end** of the wait rather than during it could not fail either way,
because the opening clears the ring on its way past — `estimate-triple-visible`'s "assert in
the window the fault lives in", again. Two `Proof:` comments in this change were also written
from what the fault looked like it should do and were **wrong** in both cases; both were
rewritten from the output.

And one on 2026-09-01 that is not a vacuous check but the reason this list keeps growing: **the
whole gate was green over a feature that did not work.** With the wait shipped, adding a work item
killed every toolbar hint for the rest of the visit — the write hands the keyboard to the new row's
Name box a few milliseconds later, that `focusin` names a `<textarea>` with no hint of its own, and
the layer's focus path answered by cancelling everything, the pointer's three-second wait included.
The pointer has not moved, so nothing ever restarts it. 2020 jsdom tests and 276 browser tests
passed through it, twenty of them written that hour and every one of them about a page **at rest**;
the fault lives only in the second after a write. It was found by taking a screenshot and looking at
it. And the first theory for it — a scroll from the settling table — was **wrong**: the document's
own event log had no scroll in it at all. Instrument before you believe a mechanism, and look at the
thing you built.

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
