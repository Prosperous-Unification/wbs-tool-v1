# Task 7 report — OpenSpec 2.3 index reader and checker

## Outcome

Implemented the `check-indexes` production CLI over immutable committed, staged or diagnostic
working candidate selection. `readIndexes` reads selected Git blobs, strictly decodes one versioned
metadata envelope per indexed README and parses its Markdown links. `checkIndexes` resolves exact
nearest-index ownership in both directions, validates path case and anchors, confines symlink and
relative navigation to the selected candidate, retains frozen archive proposal entrypoints and
reports the forty-entry navigation threshold as debt rather than a mutation.

The fixture tree covers root, project and nested project indexes; grouped tests, fixtures and
vendor paths; and an archived OpenSpec proposal plus frozen spec. Task 2.4 policy and pilot README
creation were deliberately not started.

## TDD and failure proofs

Initial RED: zero pass, eleven fail and 88 assertions because `check-indexes` did not exist. First
GREEN: eleven pass, zero fail and 96 assertions. The final focused suite contains fifteen production
CLI tests and passed with 129 assertions.

Each required failure was then injected alone and restored: indexed deletion, unindexed addition,
wrong-case link, missing anchor, invalid metadata version, membership escape, ambiguous membership,
globbed link, incorrect review-debt threshold, unreadable blob, selected symlink escape, host-file
substitution, duplicate stable identity and absent metadata. The exact observations and adjacent
`Proof:` comments are recorded in the change `verify.md`.

## Verification

- Focused post-format index suite: 15 passed, 0 failed, 129 assertions.
- Direct ESLint over changed source and solution-style source/spec TypeScript build: exit 0.
- Uncached full `tool-wiki` aggregate: lint/typecheck/test exit 0; 103 tests passed, 0 failed,
  1,603 assertions; 277.29 seconds.
- Pinned OpenSpec 1.3.0 strict validation: the change is valid with exit 0; its optional PostHog
  flush reported DNS failure after validation.
- Nx reported its sandbox socket denial and explicitly used the in-process plugin fallback; no
  target was skipped.

Final changed-file formatting and diff checks are run after this report is part of the candidate
and recorded in the final handoff.

## Concerns and remaining scope

The metadata schema and checker establish the machinery but intentionally add no repository pilot
indexes or policy bindings; that is Task 2.4. The full repository and browser gates are left for the
parent integration pass because this slice changes only the isolated infrastructure project.
