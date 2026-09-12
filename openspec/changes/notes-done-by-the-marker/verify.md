# verify — notes-done-by-the-marker

## Commands

| Command                                                   | Result                                   |
| --------------------------------------------------------- | ---------------------------------------- |
| `openspec validate --all --json`                          | 78 items, 78 passed                      |
| `nx run fe-01:typecheck`                                  | green                                    |
| `nx run fe-01:lint`                                       | exit 0                                   |
| `nx run fe-01:test:unit`                                  | 31 files, 528 passed                     |
| `nx run fe-01:test`                                       | 103 files, 2647 passed, + 2/3 zoned      |
| `playwright test` hover-cards (`CI=1 E2E_PORT_SHIFT=500`) | 4 relevant passed; whole file left to CI |

## Failure proofs

| Check                                                                            | Injected fault                                    | Watched failure                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Done stands by the notes marker, and closes the editor when pressed` (Chromium) | `right: 24` on the button changed to `right: 400` | `Done is not beside the notes marker · Expected: <= 12 · Received: 384.40625` |
| `the Done button beside the notes saves and closes the editor too` (jsdom)       | the button's `box.current?.blur()` removed        | `expected '## Risks' to be '## Risks\n\n- one more'`                          |
