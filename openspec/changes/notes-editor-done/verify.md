# verify — notes-editor-done

## Commands

| Command                                                   | Result  |
| --------------------------------------------------------- | ------- |
| `openspec validate --all --json`                          | PENDING |
| `nx run fe-01:typecheck`                                  | PENDING |
| `nx run fe-01:lint`                                       | PENDING |
| `nx run fe-01:test:unit`                                  | PENDING |
| `nx run fe-01:test`                                       | PENDING |
| `playwright test` hover-cards (`CI=1 E2E_PORT_SHIFT=500`) | PENDING |

## Failure proofs

| Check                                                                      | Injected fault                                             | Watched failure                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Escape saves what was typed and closes the notes editor` (jsdom)          | the Escape branch removed from the Name cell's `onKeyDown` | `expected '## Risks' to be '## Risks\n\nand a mitigation'`                                        |
| `Escape saves the note and closes the editor` (Chromium)                   | the same                                                   | `Escape left the notes panel up · Expected: 0 · Received: 1`                                      |
| `the Done button beside the notes saves and closes the editor too` (jsdom) | the button's `blur()` removed                              | `expected '## Risks' to be '## Risks\n\n- one more'`                                              |
| `Done is the thing under the pointer, and closes the editor` (Chromium)    | the button's `pointerEvents` left to the panel's `none`    | `Done is not what the pointer lands on · Expected: "Done writing notes for 010" · Received: "TD"` |

The Chromium pointer-events check is the one jsdom cannot make: a button drawn over a
`pointer-events: none` panel with the same declaration renders and reads as a button, and only a
hit test in a browser sees the click fall through to the row behind.
