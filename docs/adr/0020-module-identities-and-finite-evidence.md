---
status: accepted
---

# Module identities and finite evidence

Radical Modularity compares different arrangements of knowledge, review, ownership, tasks
and integration over the same repository. Give each module a stable identity and a versioned
path mapping, and compute content manifests from exact Git path/mode/blob tuples and the
policy and relationship inputs that explain them. A directory rename changes its mapping,
not its logical identity; splits and merges record predecessors rather than silently
reusing an identity for different responsibilities.

Review evidence is a finite, schema-validated set outside the content it attests to.
Attestations identify the source base and content selectors; final CI binds them to the
actual integration commit in an external artifact. Policy and verifier implementations are
ordinary reviewable content. This avoids the infinite sequence in which a review changes
its containing commit and must review itself again. Hash equality establishes currency,
not authorship or semantic correctness: trusted invocation receipts and the selected
review/check obligations remain required.

We rejected path-as-identity because moving a directory would erase review continuity, and
an undifferentiated hash of source plus evidence because every new review would invalidate
the reviews it contains. A broad ignored evidence directory is also rejected: unknown
schemas, executable entries and disguised source fail classification. Exact contracts and
negative tests live in [the change](../../openspec/changes/agent-scalable-llm-wiki/design.md).
Accepted as an implementation decision under the user's 2026-09-08 instruction; no
experimental benefit or review completeness is asserted by this ADR.
