Ordered slices. Slices 1 and 2 stand alone and land first: they make the existing archive's
descriptors load-bearing. Slice 3 adds the release target, slice 4 the consumer preparer that
consumes it, slice 5 the template, README and runbook. Slice 6 is operator work Dany runs.

## 1. The activation version names the archive it provisions

- [x] 1.1 Both provisioning steps — `.github/workflows/trusted-wiki.yml` "Provision immutable
      external activation" and `.github/workflows/ci.yml` "Provision immutable external activation
      for push audit" — read the extracted root's `selected.json`, then that version directory's
      `manifest.json`, and exit 78 naming the manifest revision and the configured version when they
      differ. `TOOL_WIKI_ACTIVATION_VERSION` keeps `^[0-9a-f]{40}$`. Test:
      `apps/wiki/cli/src/policy/gate-entrypoints.test.ts` runs each production step's bash against a
      `file://` archive built in the test from `prepareActivation` + `selectActivation`, with the
      version equal to the manifest's — exit 0 and `TOOL_WIKI_ACTIVATION_ROOT` written to the
      captured `GITHUB_ENV`; negative: the same archive with a different 40-hex version observes
      exit 78 and both revisions in stderr, watched failing with the join deleted — the step then
      exports a root for an archive certifying another commit.
- [x] 1.2 The selection directory the step reads is refused when it is absent, empty, absolute or
      escapes the root, before any manifest is read. Test: `gate-entrypoints.test.ts` rewrites
      `selected.json` with `../escape` and observes exit 78 naming the selection; negative: with the
      containment check removed the same case reads a manifest outside the extracted root.
- [x] 1.3 The `main` refusal stays: a non-40-hex version exits 78 before the archive is fetched.
      Test: the existing `activation workflows refuse a mutable activation version` case, unchanged.

## 2. The consumer never checks out the wiki's source

- [x] 2.1 `bin/tool-wiki-lint.sh` defaults `TOOL_WIKI_TRUSTED_NODE_MODULES` to
      `<activation root>/trusted-node-modules`, computed from the configured root before the
      selected version directory replaces it, keeping the absent-directory and
      inside-the-candidate refusals. Test: `gate-entrypoints.test.ts` production-entrypoint case
      with the root carrying `trusted-node-modules/typescript/package.json` and the variable unset
      runs the route; negative: neither an override nor that directory observes a non-zero exit
      naming `trusted-node-modules`, watched failing with the default left unguarded — the launcher
      then runs its route with no TypeScript closure.
- [x] 2.2 `.github/workflows/trusted-wiki.yml` drops "Check out trusted launcher", "Preserve trusted
      launcher", "Install trusted validator runtime modules" and the modules override, and installs
      `$activation_root/<launcher-path>` to `$RUNNER_TEMP/tool-wiki-lint.sh` at mode 0555 after
      extraction, refusing an absolute or `..`-bearing descriptor. Bun stays, pinned to
      `.bun-version`. Test: `gate-entrypoints.test.ts` workflow pins — `launcher-path` present, one
      `persist-credentials: false`, `bun install` and the version checkout ref absent, the
      configuration guard still before provisioning, `bun-version` equal to `.bun-version`; negative:
      the five rewritten pins watched failing against the pre-edit workflow text, the step-order pin
      against a workflow with the guard moved after provisioning, and the runtime pin against a
      drifted `.bun-version`; the launcher-install step's descriptor refusal watched installing a
      decoy launcher from beside the extraction directory with the shape check removed.
- [x] 2.3 `docs/runbook-tool-wiki-activation.md` "Transport and admission" states that the archive
      carries launcher and runtime and that no workflow checks out the activation version, and
      "Relocation" states that editing `bin/tool-wiki-lint.sh` makes the next activation carry the
      new launcher and print `launcher: changed`. No executable test — prose the operator follows.

## 3. `wiki-cli:release` packs a toolkit

- [x] 3.1 `apps/wiki/cli/src/policy/release.ts` plans a toolkit — canonical `toolkit.json`
      bytes, role list, digests — and refuses T1 malformed tag, T2 unknown tag, T3 tag not at HEAD,
      T4 dirty checkout, T5 operator Bun other than `.bun-version`, T6 non-standalone bundle, T7
      destination inside the checkout being released, T8 occupied destination or existing archive
      path, T9 installed `typescript` that is not the pinned version (an absent or symlinked
      trusted module stays `R19`, raised by `trusted-modules.ts`). Test:
      `release.test.ts` on a one-commit fixture repository tagged `wiki-v0.0.1` covers
      T1 (`wiki-v1`), T3 (tag on the parent), T4 (touched file) and T5 (edited `.bun-version`);
      negative: each refusal removed in turn lets its case pack an archive instead.
- [x] 3.2 `release-cli.ts` runs git, `Bun.build` and tar and prints `toolkit: <tag> <sha>`
      and `archive: <path> sha256: <digest>`; `project.json` gains an uncached `release` target.
      `trusted-modules.ts` holds the module names and package directory both CLIs use. Test: the
      happy-path case asserts the tar lists exactly the seven members, the printed digest equals the
      file's SHA-256, and each `toolkit.json` role digest equals its member; negative: a member
      added to the tar without a `toolkit.json` entry is observed failing the member assertion.
- [x] 3.3 The `check.wiki-cli.*` facts in both relationships files still pin only `test`,
      `lint:source` and `typecheck`. Test: the existing relationships conformance test, re-run.

## 4. A consumer prepares its own activation

- [x] 4.1 `relocation-activation.ts` widens `RelocationSources.base` to a
      `{ kind: 'base' } | { kind: 'toolkit' }` union; toolkit mode skips R4-R9, R11-R13 and R18,
      keeps R1-R3, R10, R14-R17 and R19-R20, and R21 reads the operator strata file. R14 is split
      into `assertMappingOwnership`, which compares the candidate's mapping with its own policy and
      tree and so runs in both modes. Test: `release.test.ts` case (g) a review record binding
      another identity observes R17, case (h) a strata file naming no stratum for a policy review
      observes the R21 text, and a consumer mapping covering no boundary observes R14 in toolkit
      mode; negative: each refusal removed lets its case reach the authority or prepare.
- [x] 4.2 `prepare-activation-cli.ts` prepares from a toolkit, a consumer SHA, its policy and
      mapping, a review record and a strata file, digest-checks every toolkit role against
      `toolkit.json`, writes the `toolkit-release` root descriptor, and proves the root by running
      the toolkit's launcher to `certified: true` before tarring. Test: case (f) on the relocation
      fixtures prepares, `verifyActivation` accepts, and the toolkit's launcher run with
      `TOOL_WIKI_ACTIVATION_ROOT` and no modules override exits 0 with `certified: true`. The
      command's self-check scrubs `TOOL_WIKI_TRUSTED_NODE_MODULES` rather than setting it, so that
      run is the production proof of 2.1's default: with the default removed from the launcher the
      whole command fails. The test re-runs the produced launcher with only `PATH` to say so; negatives: a toolkit member altered after packing,
      a file altered inside the extracted runtime closure, and a `toolkit.json` naming another Bun
      each observe their named refusal, watched failing with the corresponding check removed.

## 5. Consumer template, README and runbook

- [x] 5.1 `apps/wiki/consumer/trusted-wiki.yml` is a byte copy of the post-slice-2 workflow and
      `apps/wiki/consumer/README.md` states the three variables, the authored policy, mapping and
      relationship files, the first-activation recipe, one `module-index` example, the runbook link
      and the operator-attestation rule. Test: `gate-entrypoints.test.ts` compares the two workflow
      files byte-for-byte and asserts the template's `bun-version` equals `.bun-version`; negative:
      the identity assertion watched failing against an unedited copy.
- [x] 5.2 `.github/workflows/wiki-release.yml` runs the three uncached `wiki-cli` checks, then
      `wiki-cli:release`, then uploads the tar and `SHA256SUMS`; it is the only workflow with
      `contents: write` and pins every action by 40-hex SHA. Test: the existing action-ref pin
      extended to this file, plus a permissions assertion that `ci.yml` and `trusted-wiki.yml` stay
      `contents: read`; negative: a tag-form action ref watched failing the 40-hex pin.
- [x] 5.3 The runbook's "Prepare" becomes "Release" (the target and the consumer preparer) and
      "Transport" states that the toolkit is a release asset of this repository and an activation a
      release asset of the consumer's. No executable test.

## 6. Operator procedure, not run here

- [ ] 6.1 Dany tags, watches the release workflow, and in the consumer repository copies the
      template and README, authors policy, mapping, relationships and one `module-index`, runs the
      preparer, publishes the activation, sets the three variables, opens a PR at that SHA and
      observes `trusted-wiki` green. Recorded in `verify.md`; this change creates no tag or release.
