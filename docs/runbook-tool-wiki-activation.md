# Tool Wiki trusted activation

The bootstrap policy is `policy.tool-wiki-bootstrap.v1` in
`docs/wiki-policy/bootstrap-policy.json`. It enforces only
`boundary.infra.tool-wiki`; the six modules in the historical pilot remain named, non-selected
review debt. Tasks 6 and 7 remain open.

## Release

A **release is a toolkit**, not a certification: it carries the roles that are identical for every
repository and every commit — `launcher.sh`, `snapshotter.ts`, `validator.mjs`, the standalone
`prepare-activation.mjs` and `trusted-node-modules/` — with `toolkit.json` and `SHA256SUMS`. It
certifies no commit, because an activation binds one candidate identity and a consumer's candidates
are its own commits. The decision is
[ADR 0026](adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md).

Tag the reviewed commit `wiki-vMAJOR.MINOR.PATCH` and push it; `.github/workflows/wiki-release.yml`
runs the three uncached bootstrap checks, then the target, then uploads the assets. It is the only
workflow in this repository with `contents: write`. Before the first tag, a `wiki-v*` tag ruleset
restricting who may push one is an administrative prerequisite — that workflow publishes, and no
repository file can restrict who triggers it.

To pack one by hand, from a clean checkout whose HEAD the tag names, after a fresh install so the
runtime closure the toolkit ships is the one the tag's lockfile pins:

```sh
bun install --frozen-lockfile
bunx nx run wiki-cli:release -- --tag wiki-vX.Y.Z --destination <dir outside the checkout>
```

It refuses a malformed tag (`T1`), a tag no commit resolves (`T2`), a tag that is not at HEAD
(`T3`), a dirty checkout (`T4`), an operator Bun other than `.bun-version` (`T5`), a bundle that is
not standalone (`T6`), a destination inside the checkout being released (`T7`), a destination that
already holds a toolkit or an archive path that already exists (`T8`), and an installed `typescript`
that is not the version `package.json` pins (`T9`) — `node_modules/` is git-ignored, so `T4` cannot
see it. An absent or symlinked trusted node module is the same `R19` the relocation command raises.
It writes no archive on refusal, and prints the tag, the commit and the archive's SHA-256.

A consumer then produces its **own** per-commit activation from that toolkit with
`prepare-activation.mjs`, supplying its policy, mapping, review record and audit strata. The whole
consumer procedure is `apps/wiki/consumer/README.md`, beside the workflow template it copies.

### This repository's own activation

Run the three exact scoped checks selected by the bootstrap obligation:

```sh
bunx nx run wiki-cli:test --skip-nx-cache
bunx nx run wiki-cli:lint:source --skip-nx-cache
bunx nx run wiki-cli:typecheck --skip-nx-cache
```

An operator, outside the candidate checkout, invokes the trusted review harness for the exact
frozen Tool Wiki module plus the launcher, host gate, trusted workflow, candidate CI workflow,
hook, and Nx callers declared by `apps/wiki/cli/README.md`. Retain the real review receipt and
journal entry. Missing usage, reads, raw response, or journal provenance is not a review.

Build a closure containing the launcher, snapshotter, a reviewed single-file validator bundle,
policy, mapping, separate local/CI bindings, lint evidence, trusted authority, and review receipt.
Pass those ten explicit roles to `prepareActivation`; it copies them into a new versioned directory,
joins both bindings' policy, authority, validator, and optional mapping references to those exact
role paths and digests, joins the policy/mapping/validator/review identities to their actual bytes,
and records every artifact digest.
`selectActivation` requires the independently expected package identity and atomically replaces the
small operator-controlled `selected.json`. Never edit an activated file or reuse a per-candidate
authority snapshot. In practice `prepare-relocation-activation-cli.ts` does all of this — see
[Relocation](#relocation).

## Transport and admission

The transport archive root contains `selected.json`, its selected version directory, a bootstrap
copy of the reviewed launcher with root-level `active-v1` and `launcher-path` descriptors, and the
minimal `trusted-node-modules` TypeScript package closure copied from the exact lockfile-pinned
reviewed checkout (`typescript` and its declared dependency directories). The bootstrap launcher
resolves the selected package and verifies its manifest,
checksum-list identity, and artifact checksums before reading any selected role. Root descriptors
are relative to the archive root so the same bytes relocate between GitHub runner temporary storage
and h2puni; every consumer resolves a relative descriptor from that root, never from its current
working directory.

The protected-default push audit downloads, verifies, and extracts that same pinned archive before
running its launcher and archive-carried TypeScript runtime closure with required certification.
It never relocates candidate-installed modules into the trust path. With no archive variables it
reports inactive; partial configuration or a configured activation root that loses its marker
fails rather than silently auditing nothing.

Set `TOOL_WIKI_ACTIVATION_VERSION` to the exact reviewed source commit, not a display label. No
workflow checks that revision out. Provisioning refuses an archive whose selected manifest
`sourceRevision` differs from the variable, naming both, then installs the launcher the archive
root's `launcher-path` names and runs it against the archive's own `trusted-node-modules`. The
launcher, the push audit and the h2puni host gate all default `TOOL_WIKI_TRUSTED_NODE_MODULES` to
that directory and refuse when it is absent; the validator refuses runtime modules inside the
candidate. A consumer repository therefore needs the three variables and this workflow, never a
checkout of the wiki's source. Nx relationships are read statically from
`nx.json` and `project.json`; candidate plugins and inferred plugin targets are never executed or
admitted by this bootstrap boundary.

The h2puni host gate resolves `TOOL_WIKI_TRUSTED_NODE_MODULES` the same way. It refuses a missing
TypeScript package and any explicit override that resolves inside the candidate checkout. The
archive transport SHA-256 authenticates these runtime bytes alongside the root descriptors; do not
construct or install the host archive without that directory.

The toolkit tar is published as a release asset of **this** repository, under its `wiki-v*` tag.
An activation tar is published as a release asset of the repository whose commit it certifies — for
a consumer, its own. The two never mix: a consumer's three variables always point at the consumer's
own archive, and a root `toolkit-release` descriptor records which toolkit produced it as
provenance that nothing on the admission path reads.

Copy the same digest-pinned archive to a versioned directory on h2puni. The base-owned
`trusted-wiki` workflow downloads its operator-configured HTTPS archive into runner temporary
storage, verifies the configured SHA-256 before extraction, and refuses missing URL, digest, or
version configuration. The job always runs: with none or only some of the three repository
variables set, its required configuration guards fail and admission stays red. The archive root contains
`selected.json` beside its selected version directory; paths in both the selector and the package
role descriptors are relative so the same archive can be extracted under a host version directory
or runner temporary storage. The launcher installed from the
archive's own `launcher-path` verifies the selected manifest identity, checksum-list identity, and
every role artifact before reading a descriptor. The separately administered required-workflow/ruleset remains an
external prerequisite; candidate YAML cannot activate it.

Required admission must refuse an inactive, observe-only, absent, unreadable, malformed, or
wrong-scope activation. Diagnostic local rollout may still report inactive without certification.

## Relocation

A candidate that moves files under a trusted boundary is refused with `trusted boundary selector
selects no candidate input`, because the activation's policy still selects the old path. The policy
models a move: `selector` names the new path and `sourceSelector` the old one, and the baselines stay
at the old paths. Landing a move takes two steps: activate from the candidate head, then merge.

1. The candidate ships, at its head SHA: `selector` new and `sourceSelector` old for every moved
   boundary in `docs/wiki-policy/bootstrap-policy.json` (nothing else in the policy changes except
   `relationshipRequest`); `docs/wiki-policy/modules.bootstrap.json` with the new prefixes, index
   paths and `externalConsumers`, `predecessorModuleIds` for any renamed module id, and a bumped
   `mappingVersion`; `docs/wiki-policy/relationships.bootstrap.json` facts pointing at the renamed
   Nx projects. Keep `pilot.sourceRevision` and the mapping `sourceRevision` unchanged: the
   baselines are reviewed tuples at that revision, and the command refuses a revision that lacks
   them. The mapping file's own path is the one thing a relocation cannot move — the command reads
   it from the base activation's CI binding (`pilotModuleMapping.candidatePath`), so moving
   `modules.bootstrap.json` itself needs a hand-assembled activation instead.
2. Run the trusted review harness for that exact SHA and keep its `AuditReview` record. The harness
   is operator-run and lives outside this repository; the command never writes a review record and
   refuses one that does not bind the candidate (`candidateIdentity`, `sourceBase`, the reviewed
   subject, generation and both completed phases). Any commit after the review invalidates it.
   Then, from a clean checkout at that SHA with its lockfile-pinned modules installed:

   ```sh
   bun apps/wiki/cli/src/policy/prepare-relocation-activation-cli.ts \
     --candidate-repository <clean checkout whose HEAD is the SHA> \
     --candidate-sha <40-hex candidate SHA> \
     --base-activation <extracted current release>/activation-<base sha> \
     --review-record <AuditReview record for that SHA>.json \
     --destination <new archive root, outside the candidate> \
     --work <retention directory, outside the candidate> \
     --resource-lane <lane the checks ran in> \
     --cwd-identity <identity of that working directory>
   ```

   Every flag above is required. `--resource-lane` and `--cwd-identity` have no default on purpose:
   they are the operator attestation the check receipts carry, and a tool that invented them would
   attest on the operator's behalf. `--candidate-policy`, `--candidate-launcher` and
   `--validator-entry` default to this repository's layout. The command runs the three bootstrap
   checks, regenerates policy, mapping, launcher, snapshotter, validator, evidence, authority,
   receipt and both bindings, assembles the archive root, proves the archive certifies its own
   candidate by running the produced launcher to `certified: true`, and prints the release and
   variable commands.

3. Publish the tar as release `tool-wiki-activation-<sha8>` and set `TOOL_WIKI_ACTIVATION_VERSION`,
   `TOOL_WIKI_ACTIVATION_ARCHIVE_URL` and `TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256` together.
4. Re-run `trusted-wiki` on the candidate. It is green for that head and for no other commit: one
   authority certifies one commit, so the push audit of the merge commit and every later candidate
   stay red until each gets its own activation.
5. Merge with a merge commit, never a squash. The activation version is then an ancestor of `main`
   and nothing else changes; a squash leaves it reachable only through `refs/pull/N/head`.

The three variables hold one SHA, so two concurrent move candidates serialize: the second is
prepared only after the first has merged, from a head that contains it.

`bin/tool-wiki-lint.sh` is the launcher role: an activation copies its bytes, and every consumer of
the archive runs that copy rather than the file in any checkout. A candidate that edits the launcher
therefore ships a new launcher in the next activation prepared from it, and the command's report
prints `launcher: changed` beside the validator identity. That is the designed path — review the
launcher diff as trusted code, because the archive's bytes become the admission entrypoint.

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
