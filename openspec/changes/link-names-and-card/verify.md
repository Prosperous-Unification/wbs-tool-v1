# verify — link-names-and-card

Every row of the failure-proof table names the injected fault and the output that was
**watched**, never the output expected. Two of the rows below record a proof that was
first written from an expectation and was **wrong**; both are corrected here and in
`AGENTS.md`.

Run on this Mac (darwin 25.5.0, bun 1.4.2). `bin/h2puni-gate.sh` is h2puni's and exits
127 here, so the gate is CI's own commands run one at a time.

## Commands

| Command                                                        | Result                         |
| -------------------------------------------------------------- | ------------------------------ |
| `nx format:check --all`                                        | clean                          |
| `nx run-many -t lint`                                          | 25 projects, 0 problems        |
| `nx run-many -t typecheck`                                     | 25 projects green              |
| `nx run-many -t build`                                         | 12 projects green              |
| `openspec validate --all --json`                               | 64 items, 64 passed            |
| `nx run-many -t test`                                          | 22/26 green; see below         |
| `CI=1 E2E_PORT_SHIFT=500 playwright test … external-refs`      | 12 passed (38.4s)              |
| `CI=1 E2E_PORT_SHIFT=500 playwright test` (whole browser gate) | 320 passed, 37 skipped, exit 0 |

`E2E_PORT_SHIFT=500` and `CI=1` throughout, which is `bun run e2e:beside-dev`: the
committed Playwright config sets `reuseExistingServer: !isCi`, so a bare `bun run e2e`
would measure whatever holds 3100/3200/4200 — the landmine in `LLM_README.md`, and there
was a `bun run dev` on those ports for this whole session.

## Failure proofs

| Check                                                                           | Injected fault                                                                     | Watched failure                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `plan-cells.test.tsx` — lifts the links cell over the pinned layer              | `raiseWhenOpen` narrowed back to `columnId === 'name'`                             | `expected 1 to be 2`                                                                                          |
| `e2e/external-refs.spec.ts` — the card is drawn on top of the rows below it     | the same narrowing                                                                 | **passed** — see the note below; this browser check does not distinguish the lift                             |
| `e2e/external-refs.spec.ts` — a card line … tints under the pointer             | the `[data-refs-card-line]:hover` rule deleted from `styles.css`                   | `the pointed line of the card does not tint · Expected: not "rgba(0, 0, 0, 0)"`                               |
| `e2e/external-refs.spec.ts` — opens the card from anywhere in the cell          | the surface sized to the cell's **content** box                                    | `the top left of the cell opened no card` — `x + 1` is inside the `<td>`'s 4px padding                        |
| `e2e/external-refs.spec.ts` — the same case                                     | the surface given `position: relative; height: 100%`                               | `the bottom right of the cell opened no card` — Chromium resolves no percentage height against a `table-cell` |
| `plan-cells.test.tsx` — a name of nothing but spaces reads as the URL's label   | `ref.name.trim() === ''` narrowed to `ref.name === ''`                             | `expected ' ' to be '#4178'`                                                                                  |
| `external-system.test.ts` — reads a Jira issue as its key                       | the `browse` arm removed                                                           | `Expected: "WCN-3887" · Received: "newsiteam.atlassian.net/WCN-3887"`                                         |
| `external-system.test.ts` — reads a pull request … as their number              | the GitHub arm removed                                                             | `Expected: "#4178" · Received: "github.com/4178"`                                                             |
| `external-system.test.ts` — reads a Confluence page as its title                | `readableSegment` reduced to the raw segment                                       | `Expected: "Cache warm-up plan" · Received: "Cache+warm-up+plan"`                                             |
| `external-system.test.ts` — reads an unclaimed URL as its host and last segment | the last segment dropped from the fallback                                         | `Expected: "example.test/thing" · Received: "example.test"`                                                   |
| `external-system.test.ts` — hands back a URL it cannot parse                    | the `catch` arm changed to rethrow                                                 | `TypeError: Invalid URL`                                                                                      |
| `external-system.test.ts` — names a scheme the renderer will not follow         | the empty-host arm removed                                                         | `Expected: "javascript:alert(1)" · Received: "/alert(1)"`                                                     |
| `external-ref.db.test.ts` — stores the name a link was given                    | `name` dropped from the insert's values, so the column takes its `DEFAULT ''`      | `- "SHED-9 Strip the walls" / + ""`                                                                           |
| `work-item.controller.test.ts` — takes a name … and bounds its length           | the length arm removed                                                             | `Expected: 400 · Received: 200`, the 301-character name stored                                                |
| `work-item.controller.test.ts` — the same case's type arm                       | the `typeof` arm removed                                                           | `- "error": "externalRefs_entry_name_is_not_text" / + "error": "invalid_body"`                                |
| `undo.db.test.ts` — puts a ref's name back, not just its address                | `revertTo`'s `name: each.name` deleted                                             | `- "name": "SHED-9 Strip the walls" / + "name": ""`                                                           |
| `plan-cells.test.tsx` — an unnamed link reads as the label its URL carries      | the `refLabelOf` fallback replaced by `ref.name` alone                             | `expected [ '', '' ] to deeply equal [ 'AB-1', '#4178' ]`                                                     |
| `plan-cells.test.tsx` — a non-http URL puts no link on the name either          | the name rendered as an `<a href={ref.url}>` regardless                            | `expected <a data-refs-card-name="ref1" …(4)></a> to be null`                                                 |
| `plan-cells.test.tsx` — the editor … offers the URL's own label for a new one   | `addingName` reduced to `typedName ?? ''`                                          | `expect(element).toHaveValue(#4178) · Received:` (nothing after it)                                           |
| `plan-cells.test.tsx` — a name … outlives the URL it was typed beside           | `typedName` initialised to `''` and read as `typedName === '' ? refLabelOf(…) : …` | `expect(element).toHaveValue() · Received: #4178` — **at the cleared-box assertion only**; see the note below |

### Two proofs that were wrong before they were watched

**A negative watched passing.** The last row's test first ended at "typed words survive a new
URL", and that case cannot see the fault: both readings keep non-empty words. Injected, it was
watched **green**. The case the `null` sentinel exists for is a box the reader **emptied on
purpose**, and the test now clears it before changing the URL. Recorded in `AGENTS.md`.

**A claim about which layer refuses a bad field, read off the code rather than measured.**
`plan-command-shapes.ts` declares `'name?': 'string'`, so the first draft of
`asOptionalExternalRefs` said the shape refuses a mistyped name before the parser runs,
demoted the `typeof` to narrowing and collapsed two refusals into one. Probed against
`buildApp`: the shape refuses an unknown **key** (`{"error":"invalid_body"}`) and lets a
mistyped **value** through, so `name: 7` was answered `..._is_too_long` — `(7).length` is
`undefined`, `undefined > 300` is false, the ref is written with a number in its name column
and the tree read then fails its own response schema. Two codes now, both watched, and the
probe's answers are assertions rather than a sentence. Recorded in `AGENTS.md`.

### A browser proof that turned out not to be one

`the card is drawn on top of the rows below it` carried a `Proof:` comment naming a failure
that had never been observed. Injected — `raiseWhenOpen` narrowed back to
`columnId === 'name'` — it **passed**, and the reason is the other half of this change: the
hover surface added for the whole-cell hover is `position: absolute`, and an absolutely
positioned wrapper keeps the card on top by itself. Two fixes, either sufficient, and a
browser can only see that the card is visible.

The negative for the lift is therefore the jsdom one — `lifts the links cell over the pinned
layer while its card is open`, watched on `expected 1 to be 2` — and the browser check is the
end-to-end guarantee rather than the proof. The lift stays because it is the general rule: the
Name column's own 2026-08-08 fault is the same one, and it has no absolutely positioned
wrapper to save it. The comment in the spec now says all of this instead of the prediction.

### A third finding, from the pointer's own geometry

`the card stayed open after the pointer left it` failed for 30 seconds with the pointer parked
200px below the cell — and the card was **right to stay open**: five refs make it about 185px
tall, and it is a child of the span that owns the `mouseleave`, so resting on the card is
resting on the cell. The test's away-point moved sideways instead. Nothing in the product
changed for this; it is written down because the next person to write a hover test here will
park the pointer in the same place.

### One check kept although it cannot fail

`e2e/external-refs.spec.ts`'s `the card as a reader sees it` asserts only that the card is
visible; its point is the attached screenshot. It is a picture, not a gate, and it says so.

## CI

All six checks green on PR #365 — `gate` (format, lint, typecheck, test, build, the secrets
scan, the migration lint and `openspec validate`, on Linux with `ortools` installed) and all
four `pixels` shards plus the aggregate.

## The four locally-failing test tasks, none from this change

- `solver-py` — `ModuleNotFoundError: No module named 'ortools'`; not installed in this
  Python. Green on CI.
- `tool-devsync` — the 6 `durable dev poller` cases that fail on macOS on clean `main`.
- `tool-bootstrap` — 59 pass / 2 fail, both `configure.sh Caddyfile merge, executed` timing out
  at 120s; nx flagged the task **flaky** itself.
- `be-01` — 2052 pass / **0 fail**; the task's non-zero exit is 2 async teardown errors in the
  optimization-queue SQLite pump (`SQLITE_IOERR_VNODE` from a timer firing after a temp
  database was removed), in code this change does not touch.

## What this change does not do

- Saved plans do not capture a ref's name. `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` stays at 1,
  and `saved-plan-input.ts` carries the reasoning at the line that drops the field: a name
  moves no date and no path restores a snapshot over live rows, so nothing can lose one.
- Nothing is fetched. A name is typed; `refLabelOf` reads a URL and no network.
