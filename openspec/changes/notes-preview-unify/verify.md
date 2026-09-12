# verify — notes-preview-unify

## Commands

| Command                                                   | Result                              |
| --------------------------------------------------------- | ----------------------------------- |
| `openspec validate --all --json`                          | 77 items, 77 passed                 |
| `nx run fe-01:typecheck`                                  | green                               |
| `nx run fe-01:lint`                                       | exit 0                              |
| `nx run fe-01:test:unit`                                  | 31 files, 528 passed                |
| `nx run fe-01:test`                                       | 103 files, 2647 passed, + 2/3 zoned |
| `playwright test` hover-cards (`CI=1 E2E_PORT_SHIFT=500`) | 37 passed, exit 0                   |

## Failure proofs

| Check                                                                                       | Injected fault                                 | Watched failure                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `the editing preview is the same card as the hover preview, and stays on screen` (Chromium) | the bespoke `min(1000px, 55vw)` panel restored | `the two previews differ in width · Expected: <= 2 · Received: 510` |
| `while editing, hovering the notes marker opens no second preview` (jsdom)                  | the marker's `editingRef` guard removed        | `expected [ …(2) ] to have a length of 1 but got 2`                 |
| `while editing, the notes marker opens no second preview` (Chromium)                        | the same                                       | `two previews open while editing · Expected: 1 · Received: 2`       |
