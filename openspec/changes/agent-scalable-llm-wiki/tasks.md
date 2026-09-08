These are execution packets, not completed work. Each checkbox is one bounded TDD slice
with one owner; groups are integration checkpoints. `design.md` fixes interfaces, paths,
trust boundaries and initial experiment defaults. Run each module's focused test first,
then its real CLI/Nx entrypoint. Record observed failures before writing `Proof:` comments.
No `verify.md` exists until implementation produces observations.

## 1. Baseline, contracts and finite inventory

- [ ] 1.1 Pin the untouched baseline revision, exact Git tuples, candidate inventory and
      fixed benchmark outcome/acceptance corpus under `docs/experiment-evidence/`; initialize
      the `tools/tool-wiki` project and schema fixtures under `src/contracts/`. Implement
      strict decoders for candidates, entries, policies, five independent granularity
      mappings, stable module identities, receipts and experiment manifests. Test:
      `contracts/contracts.test.ts` rejects missing required fields, unknown schema versions,
      invalid membership grammar and duplicate outcome/module identities. Negative: remove
      each decoder check and observe its production CLI boundary accept/reject oracle fail.
      Add source/spec typecheck targets, lint coverage and `cache:false` initial lint target;
      deliberate errors in both source and a test must fail
      `bunx nx typecheck tool-wiki --skip-nx-cache`.
      Do not clean root docs before baseline identities are retained.
- [ ] 1.2 Implement `inventory/read-candidate.ts` with immutable committed/staged selection
      and explicit diagnostic working mode, using `git ls-tree -r -z`/index-tree snapshots.
      Test `inventory/read-candidate.test.ts` through `cli.test.ts` in temporary Git repos:
      additions, deletion, rename sides, modes, symlink blobs, new untracked files and index
      change during read. Negative: drop one path, substitute another at equal count, omit a
      candidate addition, or read HEAD when staged differs; assert complete tuple/selection
      mismatch on the actual selected candidate. Required absence/unreadability/malformed
      state cases must fail distinctly; no zero-entry fallback.
- [ ] 1.3 Implement `inventory/classify-entries.ts` and evidence schema routing for ordinary
      content versus the two reserved evidence roots. Test `classification.test.ts` includes
      source/test/config/script/migration/fixture/generated/vendor/placeholder/document/
      OpenSpec/binary/symlink cases plus declared Gitlink boundaries. Negative: hide source,
      an executable mode, unknown schema or unenveloped prose under evidence and observe
      CLI classification failure; schema-wrapped opaque transcript is the positive control.
- [ ] 1.4 Implement `evidence/content-manifest.ts` canonical serialization and finite
      artifact validation. Test `content-manifest.test.ts` and `artifacts.test.ts`: evidence
      bytes change while content manifest stays fixed and validation terminates; source bytes
      change and content identity/currency changes. Negative: include evidence bytes in the
      content digest or require evidence self-review; assert wrong staleness or bounded
      validator termination failure, not a timeout unrelated to the intended invariant.

## 2. Relationships, indexes and the pilot

- [ ] 2.1 Implement `relationships/typescript.ts` and `relationships/nx.ts` against the
      installed compiler/configuration and actual project graph. Publish exact import,
      reverse-edge, target and resolved public-declaration selectors with extractor identity.
      Test `relationships.test.ts` on re-exported/transitive types and nested Nx projects;
      negative: alter a re-exported type behind an unchanged barrel and observe structural
      evidence become stale, then restore. An unchanged internal caller with the same edge
      must not stale provider topology; a new importer must stale it.
- [ ] 2.2 Implement `relationships/declarations.ts` and typed fact selectors for scripts,
      CI/hooks, Docker/generated artifacts, ports/env, tables/migrations, HTTP contracts,
      vendored locks and external consumers. Test `selectors.test.ts` through CLI extraction;
      negative: forge a selector/edge or change a current port/route/table/target and observe
      named mismatch. Explicitly historical selectors resolve against their historical base;
      unsupported relationships remain named unresolved, never silently certified.
- [ ] 2.3 Implement `indexes/read-indexes.ts` and `indexes/check-indexes.ts`, versioned
      metadata, exact bidirectional membership and Markdown path/case/anchor checks. Test
      `indexes.test.ts` in a fixture tree: nested projects, grouped test/vendor sets and frozen
      archive proposals. Negative: delete/add an indexed child, wrong-case link, missing
      anchor, invalid metadata, path escape or ambiguous membership declaration; each fails
      the CLI at its own assertion. Links contain no globs. More than forty direct entries
      reports review debt with no automatic file move.
- [ ] 2.4 Pin pilot boundaries and exclusions in reviewed `docs/wiki-policy/policy.json`
      and stable ids/path/predecessor mappings in `modules.json`. Use representative domain,
      application, adapter, infra, docs and archive boundaries that exist at the pinned base;
      freeze their exact paths in the manifest before work. Add corresponding READMEs and
      correct pilot knowledge in its proper owner. Test: membership, external-consumer
      declaration and applicable-check references pass `tool-wiki:lint` in observe mode;
      remove an index membership and watch it fail. Label pilot coverage explicitly.
- [ ] 2.5 Record the complete root source-to-destination map, then move current findings
      into `docs/findings/` and the R5 catalogue into `checks-that-cannot-fail.md`, preserving
      stable incident ids and observed proof text. Keep rules and gate obligations in AGENTS;
      keep orientation/gate/router in LLM_README. Test `root-migration.test.ts` asserts all
      source entries have live destinations and AGENTS/LLM_README caps; negative: delete one
      destination and inject 121 AGENTS lines, watching the CLI fail separately. Coordinate
      shared root ownership with namespace work; never rewrite applied SQL or frozen history.

## 3. Review provenance, currency and trusted lint

- [ ] 3.1 Implement `review/invoker.ts`, `review/protocol.ts` and invocation journal ports
      with the structured process-harness adapter. Test `protocol.test.ts` and
      `invocation-provenance.test.ts`: invocation registered before launch, actual model/
      provider/effort/tools/usage receipt retained, raw response identity/retention checked,
      cold judgments frozen before informed expansion. Negative: forge invocation id, alter
      a raw response reference, erase observed reads or replace cold uncertainty with informed
      yes; production receipt validation must fail. Missing required telemetry is unverified.
      Provision trusted harness/CI receipts separately; a local cooperative transcript alone
      cannot satisfy externally enforced provenance.
- [ ] 3.2 Implement `evidence/currency.ts` and `policy/obligations.ts` with independent
      content/structural/semantic/topology inputs. Test `currency.test.ts`: content-only child
      edit leaves ancestor navigation current; public or semantic selector edit stales its
      consumers; new reverse/index edge stales matching relationship judgment. Negative:
      change behavior with identical types and observe the required consumer/conformance
      check fail; delete impact classification and observe expanded-review refusal. A
      writer-declared implementation-only label cannot waive behavior checks.
- [ ] 3.3 Implement `review/audit.ts`, deterministic seed/risk sampling and separate
      file/directory/project/docs obligations, correction closure and fresh post-correction
      review. Test `audit.test.ts`: repeat seed gives exact same stratified sample, missing
      review stays named, disagreement triggers adjudication/fresh shard review. Negative:
      submit sampled evidence as exhaustive, close a finding without source/check evidence,
      or reuse pre-correction review; enforce must name the unmet obligation. Record
      model/context overlap and full review/read costs.
- [ ] 3.4 Implement `policy/trust.ts` and CLI observe/ratchet/enforce with externally
      selected policy/validator binding. Test `trusted-policy.test.ts` using independent
      candidate and trusted-policy fixtures: every mode performs whole-tree deterministic
      checks; ratchet prevents adopted regressions; enforce rejects missing obligations.
      Negative: candidate removes an adopted boundary, weakens its own validator, supplies
      observe for enforced work or edits an exemption; the unchanged trusted verifier must
      refuse. Separately reviewed compatible activations retain old/new identities and
      reselect affected checks. Never let candidate flags choose CI trust.
- [ ] 3.5 Wire `tool-wiki:lint` into `bin/h2puni-gate.sh`, CI and whole-tree lefthook with
      explicit working/staged/committed modes, complete inputs and caching disabled. Test
      `gate-entrypoints.test.ts` executes real command paths in fixture candidates, including
      deletion with an unchanged reverse link and working untracked content. Negative:
      stale an enforced blob and observe the host gate fail specifically at wiki lint.
      Keep a future cache fault fixture: if caching is ever enabled, omitted-input mutation
      after warming must rerun and fail. No new cache optimization is part of this rollout.

## 4. Claim authority and fenced submission

- [ ] 4.1 Implement `admission/authority-store.ts` and `admission/claims.ts` using the
      canonical common-Git SQLite authority, strict state schema, transactions and bounded
      contention. Test `claims.test.ts` in memory and `claims.db.test.ts` across two spawned
      Bun processes/worktrees: all claims acquired or none, parent/child overlap, conflict
      groups and disjoint success. Negative: split acquisition into separate transactions
      and observe partial ownership/interleaving; remove overlap detection and observe both
      writers acquire the same boundary. Absence on initial creation is modeled; unreadable,
      corrupt or incompatible existing state throws.
- [ ] 4.2 Implement `admission/generations.ts` and state transitions. Test
      `generations.test.ts`: heartbeat expiry fences/investigates; submitted state retains
      claims; exact-generation release is idempotent; rejection/abandonment allows a new
      generation. Negative: resume old writer after successor acquisition, wrong-generation
      release, or second publication after submit; observe refusal preserving successor and
      immutable submission identities. Do not claim expired heartbeat stopped a process.
- [ ] 4.3 Implement `admission/packet.ts` and `admission/submit.ts`: pin base/policy/mapping,
      objective/outcome, owned/read sets, contracts/invariants/checks; normalize paths without
      symlink escape; freeze patch and candidate identities. Test `submit.test.ts` in real
      fixture worktrees. Negative: out-of-packet rename destination, unowned addition/deletion,
      traversal or changed read dependency; refuse before admission. Read expansion leaves
      write permission unchanged. CLI report distinguishes detected publication violations
      from editing-time prevention.

## 5. Combined integration and recovery

- [ ] 5.1 Implement `admission/integrate.ts` in a coordinator worktree with immutable
      submission application, candidate-specific read/contract revalidation and affected
      check selection. Test `integration.test.ts`: two compatible submissions integrate as
      one checked candidate; contract-only incompatible transition fails until consumers
      join the same batch. Negative: reuse scoped evidence after a gate/relationship change
      and observe reselection/refusal; final candidate manifest must match every receipt.
- [ ] 5.2 Add final generation/base recheck with compare-and-swap Git ref update, bounded
      retry and exact-submission recovery. Test `integration-races.test.ts`: advance target
      branch while checks are held, then release; old candidate cannot publish. Negative:
      omit ref/base check or use mutable writer patch and observe the wrong-candidate oracle
      fail. Rejected submissions and other sessions' files remain recoverable and untouched.
      Test queue limits (four submissions/five minutes initially), starvation/terminal failure
      reporting and resource-lane/port prerequisites separately from file claims.
- [ ] 5.3 Bootstrap the separately reviewed trusted policy/validator activation and final
      external integration binding. Test `attestation.test.ts`: binding includes actual
      commit/tree/content manifest/evidence/policy/generations/check receipts, without writing
      the containing commit id inside its own content. Negative: forge candidate/policy id
      or omit required check and observe trusted verification refuse. Run the complete host
      gate and applicable browser/OpenSpec checks on the actual frozen tooling candidate;
      record observed failures/restorations and exact skipped obligations in `verify.md`.

## 6. Exhaustive sweep and candidate catch-up

- [ ] 6.1 Freeze exhaustive policy, inventory, protocol, model/context settings and five
      independent granularity mappings. Generate one complete obligation set for every content
      path plus file/directory/project/docs boundaries; validate evidence paths through their
      schemas. Test `exhaustive-coverage.test.ts`: no orphan paths, stable shard identities
      independent of assignment grouping. Negative: replace a path at equal count or merge
      groups to omit a review and observe coverage fail. Final mapping/index adoption waits
      for `repo-namespacing`; historical packets resolve their pinned pre-move mapping.
- [ ] 6.2 Execute cold/informed reviews through the provisioned harness, collect all raw
      responses/usage, resolve owned documentation corrections, and route behavior/architecture
      findings to separate changes. Perform fresh post-correction file/directory/project/docs
      reviews and reproducible audit/adjudication. Test: report validator verifies exact
      required coverage, unresolved/unreviewed sets and receipt cost reconciliation. Any
      unavailable required invocation or unresolved required finding keeps this task open.
- [ ] 6.3 Catch up to the integration candidate using content versus evidence distinctions;
      run structural/behavioral affected checks and invalidated reviews, then finalize root
      navigation. Test: `tool-wiki:lint --mode=enforce` under the exhaustive experiment policy
      accepts only complete current coverage. Negative: mutate source after review or add a
      reverse edge during held catch-up and observe required stale evidence before integration.
      Report full initial sweep/correction/adjudication/catch-up cost separately from upkeep.

## 7. Controlled experiments and policy adoption

- [ ] 7.1 Implement `experiments/accounting.ts`, strict trial/outcome/receipt schemas and
      portable JSONL/CSV export in `experiments/export.ts`. Test `accounting.test.ts` and
      `export.test.ts`: one accepted outcome counts once after split/retry/commits; reconcile
      all sessions including failure/censoring with elapsed, raw usage, human and infra cost.
      Negative: split outcome to inflate count, omit failed attempt, lose usage/price identity,
      or exclude waiting/gate time; report validation refuses. Independently recompute from
      exports without importing tool-wiki code.
- [ ] 7.2 Implement `experiments/runner.ts` over the structured `ExecutionAdapter`, with
      pinned manifests, seeds, actual model receipts, resource/cache conditions, bounded retries
      and active-session intervals. Test `runner.test.ts`: injected deterministic executor
      proves randomization/repeat order, warm/cold labeling and full accounting. Negative:
      substitute two four-session groups for eight, silently switch model or alter corpus/
      threshold after observation; comparability/concurrency validation refuses. Provision
      real eight-way capacity and trusted usage capture before the corresponding live cohort.
- [ ] 7.3 Execute at least three randomized repeats of real one/two/four/eight-session
      cohorts on the pinned corpus, initially varying concurrency alone. Keep independent
      module/shared-contract strata, fixed-total/fixed-per-session allocation and held-out
      tuning outcomes explicit. Collect the 24-hour defect window, all three-attempt limits,
      failures/censoring and full costs. Test: the independent exported-evidence reader
      reproduces corpus completion, Q(N), elapsed/cost distributions and overlap count.
      Unavailable required cohorts remain pending; negative target results remain reported.
- [ ] 7.4 Execute controlled follow-up conditions varying granularity or model configuration
      one factor at a time using the same outcome corpus/quality floor; report interaction
      limitations and observed review amplification/lease wait/rework/conflict/discovery.
      Test: compare-report validator rejects incompatible corpus/price/resource/prompt changes
      presented as one-factor comparisons. Preserve the original scaling and secondary
      hypotheses; diagnose misses without removing checks or excluding failed attempts.
- [ ] 7.5 Select and separately activate a named adoption policy from the recorded coverage,
      cost and latency evidence; alternatives disclose their different review obligations.
      Enable its enforce mode, batch compatible changes and run full repository/OpenSpec gates
      through normal PR integration at the tested candidate. Test: adoption report distinguishes
      tooling acceptance, selected-policy coverage, exhaustive/all-cohort experiment completion
      and any supported scaling claim. A working pilot cannot satisfy the later obligations.

## 8. Completion record

- [ ] 8.1 Independent review of all selected capabilities and production failure-proof table;
      every required fault family in the normative plan maps to observed output in `verify.md`.
      Confirm all injected faults restored, all required checks/capacity/trials have explicit
      status, portable evidence survives without tool-wiki, and root/namespace ownership is
      reconciled. Archive only when the selected tooling, policy and experiment obligations
      above are complete; do not collapse separate completion states into a scaling claim.

Normative coverage routing: knowledge/indexes -> 2.3–2.5; finite inventory/evidence -> 1.1–1.4;
relationships/currency -> 2.1–2.2 and 3.2; review protocol/audit -> 3.1/3.3/6; trust/rollout ->
3.4–3.5/5.3; ownership/submission/integration -> 4–5; full-cost fixed-outcome measurement and
all cohorts -> 7. Each of the original delivery sequence's five phases has an explicit
implementation and completion obligation here.
