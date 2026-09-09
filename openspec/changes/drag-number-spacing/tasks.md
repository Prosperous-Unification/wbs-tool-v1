## 1. Compact leading controls

- [x] 1.1 Add a Chromium regression measuring the drag-to-number gap and glyph containment on root rows; run it against the old spacing and record the observed failure.
- [x] 1.2 Reduce the shared frame spacing by 8px, update affected geometry expectations and verify the regression plus number alignment, expand/collapse, pinning and drag behavior. Restore the old spacing as the negative control before recording its Proof comment.

## 2. Verify and merge

- [ ] 2.1 Inspect before/after screenshots; run the frontend and whole-workspace gates, the complete browser gate and OpenSpec validation. Record actual commands and outcomes in verify.md.
- [ ] 2.2 Review the isolated diff, push a PR, wait for successful CI, merge and verify the change exists on remote main.
