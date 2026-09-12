# Task 3 report — OpenSpec 1.3 entry classification

## Scope and files

Implemented only `agent-scalable-llm-wiki` task 1.3 on reviewed base
`8d726149da9d538e2442489ed3c85acc2e10fba9`.

- `tools/tool-wiki/src/inventory/classify-entries.ts`: exact tuple classification, reserved evidence
  routing, binary/symlink/Gitlink handling.
- `tools/tool-wiki/src/inventory/classification.test.ts`: real temporary-Git CLI coverage and
  required negative matrix.
- `tools/tool-wiki/src/cli.ts`, `inventory/index.ts`: thin `classify-candidate` entrypoint/export.
- `tools/tool-wiki/src/contracts/{records.ts,decode-record.ts,contracts.test.ts}`: strict selector,
  policy and opaque-transcript schemas.
- `tools/tool-wiki/src/contracts/fixtures/classification-policy.v1.json`: explicit full-tree v1
  selectors and evidence allowlists.
- `docs/experiment-evidence/baseline-inventory.v1.json`: synchronized classification-policy digest.
- OpenSpec `tasks.md` and `verify.md`: only checkbox 1.3 and its observed evidence.

No content-manifest code from task 1.4 was started.

## RED / GREEN

Initial RED:

```text
bun test src/inventory/classification.test.ts
0 pass, 2 fail, 24 assertions
Expected 0, Received 1: old CLI usage lacked classify-candidate
```

The wished-for test uses a committed Git tree containing source, test, config, executable script,
migration, fixture, generated, vendored, placeholder, document, OpenSpec, binary, symlink, Gitlink
and both evidence-root cases. Its oracle compares the full selection and every path/mode/blob/
classification tuple. After correcting the symlink-hash and synthetic-Gitlink fixture oracles, first
GREEN was 2 pass, 0 fail, 83 assertions. A further strict-policy RED showed a missing source class
and rule exited 0; GREEN refused it at policy decoding.

## Fault proofs

All mutations were made one at a time in production code, run through the real CLI test, observed,
then restored. Exact observations are recorded in the OpenSpec failure-proof table and adjacent
`Proof:` comments: hidden `.ts`, evidence mode 100755, unknown evidence schema, implicit prose
wrapping, undeclared Gitlink and an incomplete supported-class set each became an exit-0 acceptance
when its guard was broken.

## Verification

- Full committed-candidate classification at `8d726149`: exit 0 with explicit v1 selectors.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
  --output-style=static`: exit 0; lint, source/spec typecheck, 34 tests, 0 failures, 395 assertions.
- `bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`: exit 0, change valid.
- `bunx nx format:check --files=<all changed files>`: exit 0.
- `git diff --check`: exit 0.

Nx reported its sandbox socket denial and ran plugins in-process; no target was skipped. The full
repository/browser gates were intentionally not run for this isolated slice.

## Self-review and concerns

- Evidence matching is exact-one across the root allowlist, so a new overlapping schema must update
  the policy/contracts atomically.
- `opaque-transcript` proves only a structural provenance envelope here. Trusted journal/invocation
  provenance remains explicitly owned by task 3.1.
- Working-mode untracked paths remain the candidate reader's separate diagnostic set; they are not
  silently folded into selected tracked tuples or admission evidence.
- The fixture policy has no fallback selector. New path shapes fail classification and require an
  explicit reviewed policy update.

## Fix Round 1

The five Astra findings were reproduced through the production CLI at `caf85a89`. The initial
focused run was 6 pass, 6 fail and 160 assertions: reserved symlink/Gitlink modes bypassed evidence,
minimal WASM was treated as UTF-8 text, a leading symlink BOM was stripped, the shipped policy
classified a real `.test.tsx` as source, and undeclared WASM at `.ts` exited 0 as source.

Reserved-root lookup now precedes every special-mode branch. Binary detection applies Git's bounded
first-8,000-byte NUL sniff plus complete invalid-UTF-8 detection; this catches minimal WASM without
misclassifying the two late literal NULs in the real 243 KiB `gantt.spec.ts`. Symlink decoding
preserves BOM bytes. The shipped v1 policy covers `.test.tsx` and `.spec.tsx` in both test includes
and source exclusions. Independent CLI cases now cover zero/multiple selector matches, Gitlink
object mismatch, symlink escape and undeclared binary refusal.

One-at-a-time mutations were observed and restored for both reserved-mode precedence branches, NUL
detection and its bounded window, BOM preservation, shipped TSX selectors, both ordinary match
cardinalities, pinned Gitlink object, symlink escape and undeclared binary refusal. Exact outputs are
recorded in OpenSpec `verify.md` and adjacent `Proof:` comments.

Complete classification of committed `caf85a89` exited 0 for all 2,832 tuples. All 52 real
`.test.tsx`/`.spec.tsx` paths classified as test. The policy SHA-256 is
`5e19ae9d54e9f907a9e7cefaa8de69c0f64437b2b1c968661c6fff932a5495f8` and matches the baseline
inventory binding.

Final focused Nx verification passed lint, source/spec typecheck and 44 tests with zero failures and
488 assertions. Pinned strict OpenSpec validation passed. Full repository/browser gates remain
outside this isolated task 1.3 fix round. Exact changed-file formatting and diff checks passed.

## Final R5 cleanup

A production-CLI regression now places a non-NUL `0xff` byte after offset 8,000, beyond the bounded
NUL sniff. The correct detector refused it as undeclared binary content. With only fatal UTF-8
decoding removed, the CLI exited 0 and emitted `src/invalid-utf8.ts` as source; restoring the guard
returned the focused case to one pass with eight assertions. The full classifier passed 14 tests
and 196 assertions; focused Nx lint, source/spec typecheck and test passed 45 tests and 496
assertions. Pinned strict OpenSpec validation and exact formatting/diff checks also passed.
