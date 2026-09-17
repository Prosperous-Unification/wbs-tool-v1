## Context

`trusted-wiki.yml` checks out `TOOL_WIKI_ACTIVATION_VERSION` for the launcher and `bun install`s the
validator runtime from that checkout, while the archive root it downloads already carries
`bootstrap-launcher.sh`, `launcher-path`, `active-v1` and `trusted-node-modules/`. Admission binds
one candidate identity, so an archive built here certifies one commit of this repository and refuses
every commit of any other. Nothing packs the roles that do not vary, and W5's preparer needs a base
activation to relocate, so a consumer has no first activation. Full evidence, role-by-role
variability and line citations:
`.superpowers/sdd/2026-09-15-agentic-scalability-plan/w7-design.md` (Summary, Q1-Q7); the decision a
reader will find surprising is in `docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md`.

## Goals / Non-Goals

**Goals:**

- One target packs only the roles that are identical for every repository and commit, plus a
  standalone preparer, and refuses anything it cannot pack honestly.
- A consumer's first activation is produced by the consumer, from the toolkit and its own commit,
  and proved by running the toolkit's launcher before any archive is written.
- The trusted workflow stops needing this repository's source, so its trust root is exactly the
  transport digest the three variables pin.
- `TOOL_WIKI_ACTIVATION_VERSION` becomes load-bearing again: it names the commit the extracted
  archive certifies, not merely a well-shaped string.

**Non-Goals:**

- Changing admission, `validateCompatibleActivation`, the `ManifestRecord` schema or any digest pin.
- A review harness, generated review records or generated audit strata.
- Moving the wiki to its own repository, or sharing policy between consumers.
- Creating a real `wiki-v*` tag or GitHub release in this change.

## Decisions

- **The tag is a descriptor, not configuration.** `TOOL_WIKI_ACTIVATION_VERSION` keeps
  `^[0-9a-f]{40}$`. The consumer-mode preparer writes a root `toolkit-release` file naming the tag
  and the toolkit archive digest; it is authenticated by the transport digest like every other root
  file and read by nothing on the admission path. A tag in the variable would resolve to a commit of
  _this_ repository, which certifies no consumer activation — the form would name nothing.
- **Provisioning joins the version to the archive.** After extraction both steps read
  `selected.json`, then that version directory's `manifest.json`, and exit 78 naming both revisions
  when `sourceRevision` differs from the variable. `jq` does the reading; an absent `jq` fails the
  step under `set -euo pipefail` rather than skipping the join.
- **The launcher owns the runtime default, the workflow does not.** `bin/tool-wiki-lint.sh` defaults
  `TOOL_WIKI_TRUSTED_NODE_MODULES` to `<activation root>/trusted-node-modules` — computed from the
  configured root before the selected version directory replaces it — and keeps both the
  absent-directory and inside-the-candidate refusals. `bin/tool-wiki-push-audit.sh` and
  `bin/h2puni-gate-lib.sh` already defaulted it; only the launcher did not, so consumers that run it
  directly needed the workflow to know the archive's layout.
- **The launcher role is the launcher's own bytes.** `bin/tool-wiki-lint.sh` is what a toolkit and
  an activation copy, so editing it means the next activation carries the new launcher and the
  relocation report prints `launcher: changed`. That is the designed path, not a break.
- **`wiki-cli:release` is a new `nx:run-commands` target, uncached.** The three `check.wiki-cli.*`
  facts pin the configuration of `test`, `lint:source` and `typecheck` only, so a new target moves no
  relationship fact. The tag-push workflow, not the target, runs the bootstrap checks.
- **The preparer shares W5's planner.** `RelocationSources.base` widens to
  `{ kind: 'base', … } | { kind: 'toolkit', validatorIdentity, strata, obligationStrata }`. Toolkit
  mode skips the relocation and lineage refusals (R4-R9, R11-R13, R18) because there is no base
  policy, mapping or rebuild to compare against, and keeps candidate, selector, membership, check,
  review, runtime and self-check refusals (R1-R3, R10, R14-R17, R19-R20). R21 reads the operator
  strata file instead of the base authority.
- **The review receipt stays out of the toolkit.** A receipt binds a candidate identity and a
  journal; the toolkit has no candidate. Shipping one would invite a consumer to embed a review of
  another repository's tree in its own authority.

## Risks / Trade-offs

- **Riskiest assumption:** that the planner certifies a first activation whose pilot revision is the
  candidate itself — zero content changes and judgments with empty bindings. It is unverified and it
  decides whether a consumer can bootstrap at all; the toolkit-mode preparer test settles it. If it
  is refused, a consumer must review a prior commit first and the README must say so.
- The trust root moves entirely to the transport digest. After this change no git checkout
  authenticates the launcher bytes; the pinned SHA-256 does, as the push audit already accepts.
- `prepare-activation.mjs` may not bundle standalone (arktype, `Bun.Transpiler`, spawned `git` and
  `bash`). The T6 refusal catches it at pack time; the fallback is a consumer clone of this
  repository at the tag for the offline preparation step only, which leaves the workflow unaffected.
- A consumer must be a git + Bun + Nx workspace with `project.json` targets and pinned `nx` and
  `typescript`. Policy authoring is by example, not generated.
- The three variables hold one commit, so a consumer's `trusted-wiki` is green for exactly the
  prepared commit. That is unchanged by this design and stated in the consumer README.
