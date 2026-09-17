Ordered slices for one relocation candidate. Slice 1 lands alone; slice 2 consumes the
`design.md` written in 2.1; slices 3 and 4 land after the command exists, and 4.2 is
operator work on the real repository.

## 1. The refusal names the procedure

- [x] 1.1 `validateSelectedInputs` in `tools/tool-wiki/src/policy/trust.ts` refuses a selector
      that selects no candidate input by naming the boundary id, the selector kind and value,
      and `docs/runbook-tool-wiki-activation.md#relocation`. Test: the existing production-CLI
      case in `src/policy/trusted-policy.test.ts` asserts the whole new text, watched failing
      on the old message before the edit; negative: a new `src/policy/pilot-policy.test.ts`
      case whose trusted policy still selects the pre-move `libs/domain/src/saved-plan` while
      the candidate holds those files at `libs/wbs/domain/domain/src/saved-plan` observes the
      refusal naming `boundary.domain.saved-plan`, watched failing with the fixture pointed at
      the moved path so the selector resolves and lint accepts.

## 2. Prepare an activation from the candidate SHA

- [x] 2.1 Write this change's `design.md`: how each of the ten activation roles is produced —
      all ten from the candidate SHA (policy and mapping byte-for-byte, launcher and
      snapshotter from the candidate's own files, `validator.mjs` rebuilt from the candidate
      entry, authority, evidence, review receipt and both bindings derived), with only the
      audit stratum table copied from the base activation — how the archive root is
      assembled, and how the candidate identity is computed. No executable test — it is the
      artifact 2.2 consumes, reviewed against `w5-activation-research.md`'s role disposition.
- [x] 2.2 `tools/tool-wiki/src/policy/relocation-activation.ts` prepares an activation from a
      candidate SHA and a base activation root, and
      `tools/tool-wiki/src/policy/prepare-relocation-activation-cli.ts` exposes it, printing
      the version directory and digest. It reads the candidate's `docs/wiki-policy` policy and
      module mapping at that committed SHA, asserts every boundary with a `sourceSelector`
      has a non-empty baseline in the base activation and a non-empty selected member set in
      the candidate, and asserts every `predecessorModuleIds` chain resolves. Test:
      `tools/tool-wiki/src/policy/relocation-activation.test.ts` over two fixture commits
      spanning a directory rename — a rename with a matching `sourceSelector` prepares, and
      production admission for that candidate against the prepared activation accepts.
- [x] 2.3 Each refusal of 2.2 is exercised on the production path — a moved boundary without
      `sourceSelector`, an unknown SHA, a dirty working tree, an unresolved
      `predecessorModuleIds` chain, and a candidate selector that still selects nothing.
      Test: the fixture cases in `relocation-activation.test.ts`; negative: each check removed
      in turn makes its case observe a prepared activation instead of the named refusal, with
      the injected fault recorded in an adjacent `Proof:` comment.

## 3. Document the landing

- [x] 3.1 `docs/runbook-tool-wiki-activation.md` gains `## Relocation`: the candidate ships
      `selector` new, `sourceSelector` old and predecessor ids for renamed modules; the
      operator runs 2.2's command against the candidate head; publishes the archive and sets
      the three activation repository variables to the candidate SHA; `trusted-wiki` reruns
      green; after the merge the version is an ancestor of `main` and nothing else changes.
      It states the hard limit: the variables hold one SHA, so two concurrent move candidates
      serialize. `openspec/changes/repo-namespacing/verify.md` gains a dated line recording
      that PR #457 merged with the trusted check red for this reason and that the relocation
      activation is owed here. Test: the production selector-miss case in
      `src/policy/pilot-policy.test.ts` takes the runbook path and anchor out of the refusal it
      just observed and resolves that anchor with `markdownAnchors`, the reader the index check
      uses; negative: renaming the `## Relocation` heading leaves the anchor unresolved.

## 4. Clear the debt on the real repository

- [x] 4.1 `docs/wiki-policy/bootstrap-policy.json`, `modules.bootstrap.json` and
      `relationships.bootstrap.json` select the moved pilot boundaries: `selector` new and
      `sourceSelector` old for the three moved boundaries, `relationshipRequest.typescript`
      namespaced, the three modules' memberships, index paths and `externalConsumers` at the new
      prefixes with a bumped `mappingVersion`, and the four stale `nx-target` facts re-pointed at
      the renamed projects. `pilot.sourceRevision` and the mapping `sourceRevision` stay at
      364cc0f8. Test: the `pilot-policy.test.ts` case over the on-disk bootstrap files asserting
      that every boundary selector names a path present at HEAD, that baselines stay under
      `sourceSelector`, and that each module's memberships lie under its boundary's new selector;
      negative: the same case observed all three boundary ids, then all three module id/stray
      pairs, before the edits landed.
- [ ] 4.2 Run 2.2's command for the current `main` head, publish the archive release, set
      `TOOL_WIKI_ACTIVATION_VERSION`, `TOOL_WIKI_ACTIVATION_ARCHIVE_URL` and
      `TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256` together, and observe `trusted-wiki` green on the
      next candidate. Operator work: it needs repository admin. Test: the observed
      `trusted-wiki` run, recorded with its run id.
- [x] 4.3 This change's `verify.md` records every command, its result, the canonical h2puni gate
      output for the branch head, and the failure-proof table for slices 1 to 4 — for each new or
      changed check, the fault injected, the test that observed it failing, and the result. It
      stays PASS WITH WARNINGS while 4.2 is open.
