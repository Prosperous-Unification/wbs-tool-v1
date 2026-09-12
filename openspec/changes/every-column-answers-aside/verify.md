# verify — every-column-answers-aside

## Commands

| Command                                                        | Result                 |
| -------------------------------------------------------------- | ---------------------- |
| `openspec validate --all --json`                               | 72 items, 72 passed    |
| `nx run fe-01:typecheck`                                       | green                  |
| `nx run fe-01:lint`                                            | exit 0                 |
| `nx format:check --all`                                        | exit 0                 |
| jsdom (`vitest --shard=1..3/3`)                                | 888 + 709 + 1023       |
| `playwright test` (whole gate, 4 shards, `E2E_PORT_SHIFT=500`) | 326 passed, 36 skipped |

## What moved, measured in Chromium

| Pop-up                                       | Before                        | After                               |
| -------------------------------------------- | ----------------------------- | ----------------------------------- |
| a cell's hint or fact (nine columns' pop-up) | under the mark, over the rows | beside it; the mark's span is clear |
| a toolbar control's hint                     | under the control             | unchanged, and asserted so          |
| the notes preview                            | `[502, 172, 260, 265]`        | `[502, 175, 882, 136]`              |

The preview's row ends at 175 and the next row's marker stands at x 486: it now starts at the
row's own bottom edge and 16px past that marker, and it is **882px** wide where it was 260.
Width needs `width: max-content` — shrink-to-fit measures the room between `left: 100%` and the
containing block's right edge, and that block is the cell, 4px away.

## Failure proofs

| Check                                              | Injected fault                | Watched failure                                                            |
| -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `hover-card.test.tsx` — the aside side             | the side fixed at right       | `expected { left: 740, top: 200 } to deeply equal { left: 654, top: 200 }` |
| `hints` — a cell's fact                            | `aside` fixed to `false`      | `the card is not beside its mark · Expected: >= 0 · Received: -18.078125`  |
| `hover-cards` — the preview's own row              | `leavesItsRowClear` taken off | `the preview covers its own row · Expected: >= 174.1875`                   |
| `hover-card.test.tsx` — the preview's declarations | the same prop dropped         | `expected '0px' to be '100%'`                                              |

## A precondition that failed first, and was rewritten

The preview's browser case first asserted `card.width > 400` before its claims — and under the
injected fault the card is 361px, so the negative failed **at the precondition** rather than at
the claim it is written for. A negative that fails on a precondition says nothing about the
behaviour (`tool-hints-wait`, R5). The width assertion is gone; what is left — that the card
reaches the rows below — is true of a card placed either way, so the claims are about the
placement alone.

## One test deleted, and why

`paints over the pinned cell of the row below it` has had its subject moved three times in
three days: the dependency card, the folded step card, and now the preview, each of which
stopped standing over a pinned cell as it moved out of its column. Nothing hangs below a cell
in a pinned column any more, so the case has no subject. What it was guarding is covered:
`external-refs.spec.ts` asserts a pinned column's card is visible over the rows below, and the
lift's own negative is the jsdom one (`lifts the links cell over the pinned layer while its card
is open`), which that file's comment already names as the only oracle that can see it.
