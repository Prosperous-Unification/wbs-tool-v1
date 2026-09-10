# Task 4 report — OpenSpec 1.4 finite content manifests

## Scope

Implemented only `agent-scalable-llm-wiki` task 1.4 on reviewed base
`6f5fa9844b047b08c1f26957a2241b16e6b8ff02`. The existing core extraction and tasks 1.1–1.3 remain
intact; relationship extraction from task 2.1 was not started.

## Implementation

- `evidence/content-manifest.ts` owns canonical JSON serialization, SHA-256 identities, content
  manifest construction/current-stale comparison, and exact finite artifact-graph validation.
- `content-manifest` selects and classifies a real committed/staged/working candidate. Its digest
  includes exact content path/mode/blob/classification tuples and explicit protocol, policy,
  relationship-input and extractor identities. It excludes evidence bytes and candidate commit/tree.
- `validate-artifacts` takes a strict external version-1 graph, requires exact candidate evidence
  membership and descriptors, validates byte identities and record schemas, then resolves every root
  and dependency within a node-plus-edge traversal bound. Missing/unreadable/malformed/extraneous,
  duplicate, unreachable, self-referential and cyclic state is refused without a default.
- The canonical serializer recursively byte-sorts object keys with a deterministic code-unit
  tie-breaker, rejects non-JSON/class/cyclic values, preserves semantic arrays, and emits one
  terminal newline. Artifact-graph identity separately sorts arrays whose order is not semantic.
  Slice 1.2 working snapshots now reuse this serializer.
- Strict contracts in `contracts/records.ts` version the manifest request and artifact graph, reject
  undeclared keys and duplicate stated identities, and bind manifest policy id/blob to the policy
  actually used for classification.
- `cli.ts` now reads required JSON bytes once with fatal UTF-8 and contextual read/parse failures.
  It exposes the two thin production commands without introducing task 2.1 selectors.

Only checkbox 1.4 was marked complete. `verify.md` records the observed failure-proof table.

## RED / GREEN

Initial focused command:

```text
bun test --preload ../test/scratch/preload.ts src/evidence/content-manifest.test.ts src/evidence/artifacts.test.ts
```

Initial RED was exit 1: 0 pass, 6 fail, 1 module-load error and 50 assertions. The content test could
not load absent `./content-manifest`; every artifact case reached the old CLI usage boundary. First
GREEN was 9 pass, 0 fail and 105 assertions. A follow-up RED proved reordered non-semantic graph
arrays initially changed validation identity; normalization made the same production case green.

The final test files drive the real CLI through temporary Git repositories. Evidence-only commits
retain content identity/current currency; a source commit changes the tuple blob, identity and
currency to stale. Artifact tests exercise exact finite membership, roots, edges, schemas, byte
identities, unreadable Git objects, graph input failures and explicit traversal termination.

## R5 fault evidence

One-at-a-time restored mutations observed the two required failures directly:

- Including evidence tuples changed content identity `797015...` to `fa835d...` on an evidence-only
  commit, so the current/stale oracle failed at the correct window.
- Requiring every evidence node to depend on itself made the production CLI exit 1 immediately on
  `evidence cannot require itself: ...second.v1.json`. Removing the cycle diagnosis separately exited
  1 at the explicit graph bound, not a test timeout, and failed the named-cycle oracle.

Additional production faults removed selected-evidence membership, reachability, missing-edge
context, descriptor and byte comparisons, strict second-read decoding, versioning, duplicate
guards, policy/input identities and malformed reviewed-identity refusal. Each oracle failed,
including four faults that otherwise exited 0. Required graph files were separately made absent,
mode-000, malformed and invalid UTF-8; a Git wrapper made the selected second evidence blob exit 23.
Fix Round 1 below corrects the distinct graph-to-candidate membership proof. Exact observations and
adjacent `Proof:` comments are in source and OpenSpec `verify.md`.

## Verification

After the implementation and tests were final, the focused command

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

exited 0: lint passed, both source and spec TypeScript projects compiled, and 58 tests passed with
zero failures and 666 assertions. Nx used its documented in-process fallback after the sandbox
denied its plugin socket; no target was skipped. Pinned strict OpenSpec validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0. Its optional PostHog flush could not resolve
`edge.openspec.dev` in the network-restricted environment, after validation had succeeded.

The exact changed-file format check and `git diff --check` are run after this report's final edit and
recorded in the handoff.

## Self-review and concerns

- Evidence record provenance here means strict schema fields and graph references. Trusted invocation
  journal authorship remains explicitly owned by task 3.1; this slice does not fabricate it.
- Full scoped review currency remains task 3.2. This slice exposes only whole content-manifest
  current/stale comparison required to prove evidence exclusion and source invalidation.
- The artifact graph and eventual commit binding are external inputs, avoiding a tracked artifact
  that must hash or review itself. Candidate policy/verifier source remains ordinary content.
- No `any`, production assertion, eslint disable, catch-and-continue or failure-to-default path was
  introduced. All temporary directories are removed by test cleanup.
- Full repository and browser gates are disproportionate to this isolated tool-wiki slice and were
  not run; the parent integration pass can run them on the combined candidate.

## Fix Round 1

Review found that the case labeled extraneous graph membership only emptied `roots`; it proved the
separate reachability refusal and never put a graph path outside the selected candidate. The revised
production-CLI fixture keeps the original `first -> second` root and edge valid, adds a third artifact
whose path is absent from candidate evidence, and makes that artifact a root so all three graph nodes
remain reachable. Replacing only the candidate-membership refusal with `continue` made the CLI exit 0
with `artifactCount: 3`, `visitedCount: 3` and `traversalBound: 4`. Restoring it produced the exact
`artifact graph path absent from candidate evidence: docs/review-evidence/extra.v1.json` refusal.

Canonical object ordering also tied distinct unpaired-surrogate keys because UTF-8 encoding replaces
both `\ud800` and `\ud801` with the same bytes. The focused RED was 13 passed, one failed and 171
assertions: opposite insertion orders produced opposite serialized key orders. A code-unit
tie-breaker after byte comparison retains the finite JSON values and makes serialization independent
of insertion order; the focused GREEN was 14 passed, zero failed and 172 assertions.

Record-embedded artifact-edge reconciliation remains explicitly deferred to task 3.1's provenance
work; this fix neither infers those edges nor begins relationship task 2.1. The focused Nx lint,
source/spec typecheck and test gate passed 59 tests with zero failures and 668 assertions before the
final documentation checks.

## Fix Round 2

Fix Round 1 correctly replaced the mislabeled extraneous fixture, but that replacement also removed
the production regression that had exercised finite-root reachability. A separate test now keeps the
two valid selected artifacts and their `first -> second` edge while supplying no roots. With the
guard present, the focused CLI case passed with 10 assertions. Removing only the unreachable-artifact
refusal made the CLI exit 0 with `artifactCount: 2`, `visitedCount: 0` and `traversalBound: 3`; the
exit-code oracle failed with zero tests passed, one failed and nine assertions. Restoring the guard
made all nine artifact tests pass with 126 assertions.

The Fix Round 1 extraneous-candidate case remains unchanged and separately proves exact graph-to-
candidate membership with every graph node reachable. No runtime source changed in this round. The
focused Nx lint, source/spec typecheck and test gate passed 60 tests with zero failures and 678
assertions before the final documentation checks.
