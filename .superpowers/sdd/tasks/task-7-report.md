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

## Fix Round 1

Closed Astra's Markdown-AST and member-confinement findings without starting Task 2.4. Used
reference definitions now feed the same exact path, case, anchor and glob checks as inline links;
images remain non-navigation and external autolinks remain external. Index metadata and explicit
HTML anchors now come only from rendered mdast HTML nodes, never fenced code. Every exact and grouped
member's effective selected symlink target is confined before its ownership claim is accepted,
whether or not a README links to it.

The initial production-CLI regressions reproduced the defects as exit 0 for an absent reference
target, a fenced anchor, a fenced metadata envelope, and unlinked exact and grouped escaping
symlinks. The image/autolink control remained green. After implementation, 27 focused index tests
passed with 224 assertions. One-at-a-time faults then observed exit 0 when reference resolution,
HTML-node discrimination or member confinement was bypassed. Absolute, absent-target and cyclic
member symlinks also have isolated production CLI oracles; removing each branch produced a wrong
diagnostic or erroneous exit 0. The unreadable-blob fallback was rechecked and correctly recorded
as moving the failure to `selected candidate contains no wbs indexes`. Removing the old link-only
lexical guard changed no behavior because member confinement now refuses the same linked escape
earlier; the dead guard and its stale proof were deleted.

Direct ESLint and solution-style source/spec TypeScript builds exited 0. The first uncached full
tool-wiki aggregate passed lint, typecheck and all 112 then-current tests with zero failures and
1,674 assertions in 284.04 seconds; the final aggregate after three more symlink oracles is recorded
as 115 tests, zero failures and 1,698 assertions in 286.01 seconds. Pinned OpenSpec 1.3.0 strict
validation returned the change valid with exit 0; the optional telemetry flush alone reported the
sandbox DNS failure. Final changed-file Prettier, diff and status checks follow this evidence
append. No checkbox changed and Task 2.4 remains untouched.

## Concerns and remaining scope

The metadata schema and checker establish the machinery but intentionally add no repository pilot
indexes or policy bindings; that is Task 2.4. The full repository and browser gates are left for the
parent integration pass because this slice changes only the isolated infrastructure project.

## Fix Round 2

Closed Astra's remaining HTML-anchor and directory-reference findings without changing Task 2.4 or
any checkbox. Explicit anchors now come from actual elements in one rendered HTML fragment assembled
from mdast HTML and text leaves: IDs on rendered elements and legacy anchor names remain valid, while
comments, raw-text contents and inert templates cannot create an anchor. Parsing one fragment keeps
HTML parent context across mdast's separate opening and closing nodes. Candidate-relative directory
references now canonicalize trailing separators and current-directory forms before exact lookup,
case diagnosis and absence reporting.

Initial production CLI runs reproduced comment/script false anchors as exit 0, rejected a real
non-`a` element ID, and reported trailing-slash and current-directory links as absent. The original
absent-directory substring assertion was tightened to exact output and then caught the retained
slash. The nearby audit additionally found that parsing mdast HTML leaves separately admitted inert
template content. One-at-a-time mutations restored raw regex matching, traversed parsed template
content, limited IDs to `<a>`, and removed path canonicalization; each failed its dedicated CLI
oracle with the exact observations recorded in `verify.md` and adjacent `Proof:` comments.

The final focused index suite passed 35 tests with zero failures and 285 assertions. Direct ESLint
and the solution-style source/spec TypeScript build exited 0. The uncached full tool-wiki aggregate
passed lint, typecheck and all 123 tests with zero failures and 1,759 assertions in 292.79 seconds.
Pinned OpenSpec 1.3.0 strict validation returned the change valid with exit 0 and telemetry disabled.
Final formatting/diff checks follow this evidence append. No pilot files were created, and no push
was performed.

## Fix Round 3

Closed Astra's final rendered-heading, slug-collision, symlink-byte and component-traversal findings
without starting Task 2.4 or changing a checkbox. Heading anchors now come from rendered-tree
context, excluding inert templates and raw-text contents while retaining visible inline-HTML text.
The documented collision algorithm allocates the lowest globally unused suffix, including
`a-1-1` for `A`, `A`, `A-1`, and the private heading marker cannot collide with user source.

Symlink target decoding now preserves an exact leading BOM independently of Markdown document
decoding. A shared selected-tree resolver walks path components before normalizing them away,
follows directory symlinks with bounded cycle detection, confines the candidate, and rejects a
regular file used as an intermediate component for both README navigation and member ownership.
The audit added adjacent real-directory, directory-symlink, trailing-file-separator, canonical
directory-anchor and member-path cases.

Initial production CLI tests failed for inert-template headings, rendered inline HTML, colliding
slugs, present and dangling BOM-prefixed symlink targets, regular-file parent traversal, and a
case-variant internal-marker forgery. A final adversarial RED also showed encoded angle brackets
and emphasis forging the marker through rendered text. One-at-a-time mutations then reproduced
those failures and also watched directory-symlink following, implicit directory membership,
canonical directory diagnostics, member confinement, cycles, absolute targets and absent targets
at their production boundaries. Exact outputs are recorded in `verify.md` and adjacent `Proof:`
comments.

The final focused index suite passed 47 tests with zero failures and 377 assertions. Direct
changed-file ESLint and the solution-style source/spec TypeScript build exited 0. The uncached full
tool-wiki aggregate passed lint, typecheck and all 135 tests with zero failures and 1,851 assertions
in 301.89 seconds (5m2s Nx duration); Nx used its explicit in-process fallback after the sandbox
denied the daemon socket, and no target was skipped. Pinned OpenSpec 1.3.0 strict validation returned
the change valid with exit 0 and telemetry disabled. Final formatting/diff checks follow this
evidence append. No pilot files were created, no checkbox changed, and no push was performed.
