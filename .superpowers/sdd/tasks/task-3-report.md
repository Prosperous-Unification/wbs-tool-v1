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
