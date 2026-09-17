## Context

The base-owned `trusted-wiki` check extracts one activation archive pinned by three repository
variables to a `main` SHA. Its policy still selects `libs/domain/src/saved-plan`; PR #457 moved that
directory, so every candidate is refused at `validateSelectedInputs` (`trust.ts:1246-1265`). The
policy already models a move (`selector` new, `sourceSelector` old, baselines at the old paths,
`trust.ts:388-426`), and the mapping is pinned by digest to the candidate's own
`modules.bootstrap.json` (`trust.ts:1144-1170`). No committed code or runbook step produces the
six per-candidate roles (`authority.json`, both bindings, `evidence.json`, `review-receipt.json`,
`validator.mjs`) or the archive root; both live releases were assembled by hand. Full evidence and
line citations: `.superpowers/sdd/2026-09-15-agentic-scalability-plan/w5-design.md` (Q1–Q6) and
`w5-activation-research.md` (facts 1–10, table C1–C15).

## Goals / Non-Goals

**Goals:**

- One command prepares an admissible activation from a candidate SHA and the current base
  activation, refusing (by name) an unknown or dirty SHA, a moved boundary without `sourceSelector`,
  an unresolved `predecessorModuleIds` chain, a selector that selects nothing, and any change to
  the trusted policy beyond selectors and the relationship request.
- The command records only what it measured (the three bootstrap checks it ran), derived by hash
  (identities, bindings, evidence, receipt bytes), or was handed by the operator (the review
  record), and proves the result by running the produced launcher to `certified: true` before
  tarring.
- The runbook `## Relocation` section is the target of the selector-miss refusal and states the
  two-step landing and the one-SHA-at-a-time limit.

**Non-Goals:**

- Selectors or commands resolved through candidate files other than the digest-pinned policy,
  mapping and the declarations file the pinned policy names.
- Any change to admission, to `validateCompatibleActivation`, or to a digest pin.
- Running or replacing the review harness; automating the release or the variables.
- Making `trusted-wiki` green for commits other than the one the activation was prepared from.

## Decisions

- **Review record is an input, never generated.** Admission checks the review only for shape and
  joins (`trust.ts:1380-1449`, `audit.ts:399-598`); a consistent fabrication would certify. The
  tool takes `--review-record` (an `AuditReview`) and refuses it unless `candidateIdentity`,
  `sourceBase`, `subject.contentIdentity`, generation and both completed phases bind the SHA
  (R17). `review-receipt.json` is `serializeCanonical(record.evidence.receipt)`; the live archives
  confirm the role equals the embedded copy.
- **Checks are run, not copied.** Commands come from the `nx-target` facts named by the pinned
  policy's `relationshipRequest.declarationPaths` at the SHA (`bunx nx run <project>:<target>
--skip-nx-cache`, the live commands); the receipt records exit code, timestamps, stdout/stderr
  digests and `candidateManifest`; a check that exits non-zero or reports a skip refuses (R16),
  since a receipt carrying skips could never discharge its obligation. Labels (`resourceLane`,
  `cwdIdentity`, `toolIdentity`) are attestation and are printed as such.
- **`reviewed` is the tree at `pilot.sourceRevision`.** Every baseline tuple lives there
  (verified at 364cc0f8, not at d3342da5) and `reviewedBinds` looks them up by old path
  (`trust.ts:1396-1402`). Bumping `pilot.sourceRevision` past a move is refused (R8); Task 6.3's
  bump instruction is struck.
- **Behavior rules and classifications are derived conservatively.** One rule and one
  `behavior-changing` classification per content change between `reviewed` and `current`, one
  judgment per review id binding changed and removed ids — the live d3342da5 shape (38 rules =
  38 changed blobs) generalised; the most demanding class, never a waiver.
- **Every role that names candidate bytes is taken at the candidate SHA**: policy, mapping,
  launcher (`trusted-wiki.yml:33-43` installs the launcher from the activation-version checkout),
  snapshotter, and `validator.mjs` rebuilt with `Bun.build` from `--validator-entry`
  (`gate-entrypoints.test.ts:652-655` precedent). Only the audit stratum table is copied from the
  base authority.
- **`validateCompatibleActivation` stays unchanged and bindings omit `predecessor`/`activation`.**
  Relaxing selector monotonicity (`trust.ts:909-917`) would still leave `:826-832` refusing every
  cross-candidate authority (audit obligation `subject.contentIdentity` is per candidate). The
  planner enforces a stricter relocation invariant: canonical equality of the policy after
  stripping `selector`, `sourceSelector` and `relationshipRequest` (R4), `sourceSelector` equal
  to the base selector (R6), mapping lineage (R11–R14).
- **Placement.** `tools/tool-wiki/src/policy/relocation-activation.ts` (pure planner:
  `planRelocationChecks`, `planRelocationActivation`), `prepare-relocation-activation-cli.ts`
  (git, spawn, fs, tar, the launcher self-check), `relocation-activation.test.ts`. Not a `cli.ts`
  subcommand: `cli.ts` + `trust.ts` are the validator closure (`cli.ts:348-353`).
- **The candidate is measured, never written to.** `R3` refuses a dirty checkout and equally a
  `--work` or `--destination` inside the candidate repository: this command's own writes would
  otherwise make every receipt describe a tree that is no longer the committed one. The whole
  code table lives on `RelocationRefusalCode` in `relocation-activation.ts`.
- **Archive root** is assembled by the shell: `prepareActivation` + `selectActivation`, then
  `bootstrap-launcher.sh` (0555), `launcher-path`, `active-v1`, `trusted-node-modules/` copied
  from the candidate's lockfile-pinned `node_modules` (`typescript` and its dependencies,
  transitively; real directories only), reproducible `tar`, sha256, and the printed `gh release
create` / `gh variable set` lines.

## Risks / Trade-offs

- One authority certifies one commit (`trust.ts:1388-1394, 1479-1485`). `trusted-wiki` turns green
  only for the prepared SHA; other PRs stay red until their own activation (~20 min of checks
  plus an LLM review). This change does not alter that; the plan's expectation that W5 makes the
  check green in general is wrong and must be re-decided.
- The review is operator attestation; `trust.scope external-verifier` names a verifier this
  repository cannot reach. Mitigation: keep the harness output beside the archive.
- Rebuilding `validator.mjs` ties its digest to the operator's Bun; the tool refuses a `Bun.version`
  other than `.bun-version`.
- The authority grows to a few MB when `reviewed` is far behind `current` (thousands of changes).
- A squash merge leaves the activation version reachable only via `refs/pull/N/head`.

## Migration Plan

1. Task 5.1 refusal text (in progress) names `docs/runbook-tool-wiki-activation.md#relocation`.
2. Task 5.2 lands the planner, shell and tests; Task 5.3 the runbook section and the
   `repo-namespacing/verify.md` line.
3. On the W5 branch, before the activation: `bootstrap-policy.json` (three boundaries'
   `selector`/`sourceSelector` from `policy.json`, `relationshipRequest.typescript` namespaced),
   `modules.bootstrap.json` (three modules from `modules.json`, `mappingVersion` bumped,
   `sourceRevision` unchanged), `relationships.bootstrap.json` (four facts from
   `relationships.json`). Verified by observe lint on a scratch clone of main.
4. Task 5.4: review harness for the branch head → command on h2puni → release
   `tool-wiki-activation-<sha8>` → three variables → `trusted-wiki` green on that head → merge
   commit → record in `verify.md`.
5. Task 6.7 repeats step 3–4 for the W6 head with `apps/wiki/cli` selectors, `wiki-cli` facts and
   `--validator-entry apps/wiki/cli/src/cli.ts`.
6. Rollback: reset the three variables to the previous release's values; archives are immutable.

## Open Questions

- Should the required `trusted-wiki` check stay required while certification is per commit, or
  does a later change model an authority that survives unrelated commits?
- Should a `run-bootstrap-review` command wrap `ProcessReviewInvoker` + `FileInvocationJournal`
  so the receipt's provenance can be re-derived (`validateReviewProvenance`) instead of attested?
- Where the `external-verifier` journals for d3342da5 and 34f79d8e are retained, if anywhere.
