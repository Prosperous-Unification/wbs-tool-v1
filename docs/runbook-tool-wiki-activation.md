# Tool Wiki trusted activation

The bootstrap policy is `policy.tool-wiki-bootstrap.v1` in
`docs/wiki-policy/bootstrap-policy.json`. It enforces only
`boundary.infra.tool-wiki`; the six modules in the historical pilot remain named, non-selected
review debt. Tasks 6 and 7 remain open.

## Prepare

An operator, outside the candidate checkout, invokes the trusted review harness for the exact
frozen Tool Wiki module plus the launcher, host gate, trusted workflow, candidate CI workflow,
hook, and Nx callers declared by `tools/tool-wiki/README.md`. Retain the real review receipt and
journal entry. Missing usage, reads, raw response, or journal provenance is not a review.

Run the three exact scoped checks selected by the bootstrap obligation:

```sh
bunx nx run tool-wiki:test --skip-nx-cache
bunx nx run tool-wiki:lint:source --skip-nx-cache
bunx nx run tool-wiki:typecheck --skip-nx-cache
```

Build a closure containing the launcher, snapshotter, a reviewed standalone validator bundle,
policy, mapping, separate local/CI bindings, authority evidence, and review receipt. Pass those nine
explicit roles to `prepareActivation`; it copies them into a new versioned directory, joins the
policy/mapping/validator/review identities to their actual bytes, and records every artifact digest.
`selectActivation` requires the independently expected package identity and atomically replaces the
small operator-controlled `selected.json`. Never edit an activated file or reuse a per-candidate
authority snapshot.

## Transport and admission

Copy the same digest-pinned archive to a versioned directory on h2puni. The base-owned
`trusted-wiki` workflow downloads its operator-configured HTTPS archive into runner temporary
storage, verifies the configured SHA-256 before extraction, and refuses missing URL, digest, or
version configuration. The archive root contains `selected.json` beside its selected version
directory; paths in both the selector and the package role descriptors are relative so the same
archive can be extracted under a host version directory or runner temporary storage. The preserved
launcher verifies the selected manifest identity, checksum-list identity, and every role artifact
before reading a descriptor. The separately administered required-workflow/ruleset remains an
external prerequisite; candidate YAML cannot activate it.

Required admission must refuse an inactive, observe-only, absent, unreadable, malformed, or
wrong-scope activation. Diagnostic local rollout may still report inactive without certification.

## Final binding and recovery

After the exact commit is published and its immutable publication marker exists, emit the canonical
final binding to an operator-controlled store with `emitIntegrationBinding`. The artifact retains
the commit/tree/sole-parent tuple, full composition identity, distinct normative content-only
identity, finite evidence-validation identity, activation identities, exact generations, receipts,
and journal verifications. Bootstrap alone may use
`{kind:"not-applicable",reason:"pre-authority bootstrap commit"}`; later integrated bindings must
name their actual integration and attempt identities.

Emission is compare-and-create and writes outside the candidate, so a crash after Git publication
can recover from the immutable marker, checked candidate, retained receipts, and selected activation
without consulting mutable `HEAD` or inventing new checks. `verifyIntegrationBinding` rechecks Git,
the independent activation/content/evidence inputs, candidate composition, and every receipt.

Copy identical binding bytes to the authenticated workflow artifact channel and the host retention
store. If either store, the h2puni package, GitHub archive, journal verifier, or required rule is not
provisioned, admission remains pending rather than certified.
