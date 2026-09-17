## Why

Another repository can run the wiki's trusted check only by pointing `TOOL_WIKI_ACTIVATION_VERSION`
at a commit here, which `trusted-wiki.yml` checks out for launcher and runtime. An activation
certifies one commit, so nothing published here certifies a consumer's commits. A consumer can
reuse only the toolkit: launcher, snapshotter, validator, TypeScript closure. Nothing releases it,
and nothing prepares a first activation.

## What Changes

**A wiki release is a toolkit**

- From: nothing packs the reusable roles
- To: `wiki-cli:release` packs them and a standalone preparer from a clean checkout at a
  `wiki-vMAJOR.MINOR.PATCH` tag; a tag-push workflow publishes it
- Impact: non-breaking

**A consumer prepares its own activation**

- From: the preparer needs a base activation, so a consumer has none
- To: a toolkit mode derives the per-commit roles from the consumer's commit, policy, mapping,
  review and strata, proven by the toolkit's launcher before anything is written
- Impact: new operator command; admission unchanged

**`trusted-wiki.yml` never checks out the wiki's source**

- From: a checkout of the version supplies the launcher and a `bun install` its runtime
- To: both come from the archive; the launcher defaults to its `trusted-node-modules`
- Impact: non-breaking

**The activation version names the archive's commit**

- From: the variable is only shape-checked, so any value takes any archive
- To: provisioning refuses a manifest `sourceRevision` that differs from it
- Impact: misconfiguration fails visibly

## Non-Goals

Moving the wiki to its own repository. Changing the activation format. A tag as
`TOOL_WIKI_ACTIVATION_VERSION`. Shared policy. Generated policy, mapping or reviews. Green
`trusted-wiki` beyond the prepared commit. Any real tag or release.

## Constraints

Bun and Nx only; the consumer workflow is byte-identical and pins the toolkit's Bun.
The plan wanted a `wiki-v*` tag as the version, but a tag names the toolkit's commit, which
certifies no consumer activation: it stays 40-hex and gains the manifest join. No interview was
held; this intent assumes:

- assumed: the preparer bundles standalone, else the consumer clones the tag.
- assumed: publishing a consumer archive and setting its variables is admin work.
- assumed: audit strata are operator-supplied.

## Capabilities

### New Capabilities

- `wiki-release`: a tagged toolkit consumed with a copied workflow and three variables; each
  consumer prepares its own activation.

### Modified Capabilities

None.

## Domain Terms

`Toolkit release`, `Toolkit activation` (CONTEXT.md).

## Decisions Recorded

`docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md`.

## Impact

`apps/wiki/cli/src/policy`, `bin/tool-wiki-lint.sh`, three workflows, `apps/wiki/consumer/`, the
activation runbook, the `TOOL_WIKI_ACTIVATION_*` variables.
