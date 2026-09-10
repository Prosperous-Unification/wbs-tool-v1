# verify — informative-cards-open-beside

## Commands

| Command                                                        | Result                 |
| -------------------------------------------------------------- | ---------------------- |
| `openspec validate --all --json`                               | 70 items, 70 passed    |
| `nx run fe-01:typecheck`                                       | green                  |
| `nx run fe-01:lint`                                            | exit 0                 |
| `nx format:check --all`                                        | exit 0                 |
| `vitest run --shard=1..3/3` + the zoned config                 | 2616 + 3 passed        |
| `playwright test` (whole gate, 4 shards, `E2E_PORT_SHIFT=500`) | 326 passed, 36 skipped |

Sharded for this machine's memory watchdog, which killed two unsharded runs of each. The
jsdom suite is `apps/fe-01`'s own `vitest run --no-file-parallelism --maxWorkers=1 --shard=n/3`,
which is what `fe-01:test` runs, plus its `vitest.zoned.config.ts` pass.

## Where each card lands now

Measured in Chromium with the four reference columns on screen, 1440px wide:

| Column          | cell      | card      | side  |
| --------------- | --------- | --------- | ----- |
| Start           | 1283–1381 | 1027–1287 | left  |
| Types           | 831–951   | 947–1207  | right |
| Tags            | 591–711   | 707–967   | right |
| folded Dev step | 987–1075  | 1075–1335 | right |

Start opens **left** because the frame ends at 1385: a card that always opened right ran to
1637, 252px past the edge of the plan. That figure is the negative below.

## Failure proofs

| Check                                            | Injected fault                            | Watched failure                                                                           |
| ------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `hover-card.test.tsx` — the side                 | `side` fixed at `'right'`                 | `expected { side: 'right', align: 'top' } to deeply equal { side: 'left', align: 'top' }` |
| `hover-card.test.tsx` — the alignment            | `align` fixed at `'top'`                  | `… to deeply equal { side: 'right', align: 'bottom' }`                                    |
| `card-lanes` — beside its cell                   | `opensSideways` off all three components  | `Start: the card stands over 020's own cell · Expected: not "the card"`                   |
| `card-lanes` — inside the frame                  | the side fixed at `left: '100%'`          | `Start: the card runs off the right of the frame · Expected: <= 1385 · Received: 1637`    |
| `hover-cards` — the folded card escapes its clip | `opensAPopover`'s `-final` branch removed | `the card is clipped at its cell edge · Expected: "the card" · Received: "DIV"`           |
| `hover-cards` — the Start card escapes its clip  | `'start'` removed from `POPOVER_COLUMNS`  | `the Start card is clipped at its cell edge · … Received: "INPUT"`                        |
| `hover-cards` — the preview over a pinned cell   | `raiseWhenOpen={false}`                   | `the pinned cell below hides the card · … Received: "TEXTAREA"`                           |

## Three tests whose subject this change moved

Two asserted a card escaping its `<td>`'s clip **downwards** — which is where these cards used
to go. They probe the side the card actually opens on now, and they ask
{@link cardIsOnTopAt} rather than comparing screenshots: hit testing respects a clip, so it
tells a clipped card from a painted one, and the pair of shots could not (R5 #26).

The third is `paints over the pinned cell of the row below it`, whose subject has now moved
twice — the dependency card yesterday, the folded step card today. Its subject is the **notes
preview**: the one card left that hangs below its cell, in a column that is pinned, which is the
trap `POPOVER_ROW_LAYER` exists for. No scrolling any more; there is no unpinned downward card
left to slide under the pinned block.
