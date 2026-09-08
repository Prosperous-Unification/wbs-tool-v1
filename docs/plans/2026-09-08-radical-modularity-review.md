# Radical Modularity: design review

Review of the [original proposal](2026-09-08-agent-scalable-llm-wiki.md) at
`a095fff8fd4ceb7cfb76f5eb6a0c8a9d582d19f1`. Findings below refer to that revision's
section names; the linked proposal will incorporate their dispositions. This is
a review of the approach, not evidence that its tooling or scaling targets work.

## Mandate and assumptions

The user requested several rounds of refinement, then a written review, Claude
Fable cross-review, application of the findings, commit, push and merge without
further questions. The deliverable is the refined design and its review record;
the wiki, leases, sweep and benchmark remain future implementation changes.

- A1: **Radical Modularity** names the approach. LLM wiki, evidence ledger,
  work packet and module lease name its mechanisms.
- A2: The primary aim is to improve the attainable combination of quality,
  elapsed time and total cost across model configurations and granularities.
  Faster but more expensive work is a measured trade-off, not automatically a
  success or a failure. Acceptance criteria remain fixed between comparisons.
- A3: Initial execution authority is one host and one Git common directory.
  Multiple clones and hosts require another authority; local leases cannot
  coordinate them. Eight concurrent agents are a benchmark requirement to
  provision later, not a capability established by this session.
- A4: Code, executable configuration and accepted specifications are authority.
  Reviews are fallible observations of that authority. A complete inventory
  never means complete semantic knowledge.
- A5: No runtime or safety-policy change lands in this documentation delivery.
  Future implementation still follows repository rules R4 and R5. Existing required gates stay
  in force until a separately verified change revises them.

## Round 1: define what can vary and what counts

### R1 — Important: one module boundary couples five experiments

**Evidence:** Knowledge topology, directory-index criteria, per-file protocol,
module-owned ledger shards and temporary ownership attach different purposes to
one directory tree. The two-source-file and eight-content-line thresholds make
physical layout a policy authority before it has been tested.

**Failure scenario:** Splitting a module to reduce reading creates extra reviews,
leases and integration work. Throughput changes, but its cause is unknowable.

**Revision:** Separate knowledge, review, ownership, task and integration
granularity. Pin their mappings in a versioned policy. Stable module identifiers
survive path moves; explicit split/merge lineage and mapping versions let old
measurements remain interpretable. Directory defaults stay useful, while legal
groupings must respect dependency direction and cross-file invariants. A finer
task cannot waive the integration checks required by its affected boundary.

### R2 — Important: task-count throughput rewards changing the denominator

**Evidence:** Outcome defines Q(N) as completed task slices per hour, while the
user specifically wants to vary their granularity.

**Failure scenario:** Split one feature into ten tasks and Q rises without
delivering more behavior. Defer integration costs beyond the counting window
and Q rises again.

**Revision:** Fix a corpus of independently accepted outcomes before partitioning
work. An outcome counts once after integration and acceptance, irrespective of
how many assignments produced it. Capture full elapsed time, model usage and
cost, human effort, infrastructure cost, failures, review and maintenance. Record
token categories and a price-schedule identity so later repricing is possible.
Never compare counts across different corpora as though they were equivalent.

### R3 — Important: the benchmark confuses software delivery with a hypothesis

**Evidence:** Completion evidence requires 80% linear efficiency through eight
agents; agentic scalability verification holds neither model configuration nor
host/resource allocation explicit.

**Failure scenario:** A correct runner discovers a serial workload and can never
finish its own implementation. Increasing hardware or using a stronger model
looks like an improvement in modularity.

**Revision:** Keep Q(2)/Q(1) >= 1.6, Q(4)/Q(1) >= 3.2 and Q(8)/Q(1) >= 6.4 as
predeclared hypotheses on a named workload. Separate tooling acceptance from
evidence for those claims. Pin model/version/effort, runner, policy, task corpus,
repository base, retries, resource envelopes and observation windows. Vary one
axis at first; later test interactions. Report repeated trials, uncertainty,
failed/censored trials and warm/cold cache conditions. Keep disjoint task and
shared-contract task strata visible. Do not discard failures to meet targets.

### R4 — Important: measure before paying for the exhaustive sweep

**Evidence:** Delivery puts scalability measurement after the exhaustive sweep.
The recorded 2,379-file inventory implies at least 4,758 fresh file reviews for
two passes, excluding corrections, directory reviews and project reviews.

**Revision:** Establish baseline measurement and a representative pilot first.
Retain the exhaustive sweep as an explicit experiment with its full cost and
coverage visible. Whole-tree enumeration is unconditional; review depth and
freshness enforcement are separately versioned rollout policies. Compare the
exhaustive policy to risk-based policies rather than claiming a cheaper policy
has completed an exhaustive sweep. Declare the final adopted policy and its
remaining unreviewed or unresolved set.

## Round 2: state what evidence can establish

### R5 — Important: cold-read success competes with the wiki's purpose

**Evidence:** Per-file protocol gives the reviewer only one path, then requires
all three final cold judgments to be yes even for cross-file impact.

**Failure scenario:** A file acquires copied dependency prose just to pass the
test that deliberately withheld its module's index. More duplication makes
freshness harder to maintain.

**Revision:** Keep cold reads as a diagnostic of local clarity. Assess impact
after following the intended navigation and tracing the boundary. Keep both
judgments and their read sets. Passing a navigation-assisted review must not be
reported as a passing cold read. An unresolved relationship remains explicit;
LLM agreement cannot establish absence of every unknown consumer.

### R6 — Critical: byte fingerprints cannot prove behavioral compatibility

**Evidence:** Evidence without invalidation explosion lets unchanged public
fingerprints preserve consumer attestations after implementation edits.

**Failure scenario:** A function keeps its type but reverses tie-breaking, error
semantics or rounding order. A consumer's relied-on behavior changes while its
signature fingerprint stays current. A barrel export can also hide transitive
type changes unless the public surface is actually resolved.

**Revision:** Separate structural currency from behavioral verification. Use a
resolved public declaration fingerprint for type structure, a contract evidence
fingerprint for selected specs/invariants/tests and explicit behavioral change
classification. Run applicable consumer/conformance checks for implementation
changes even when structure is stable. Changes with unclassified impact require
expanded review; manual declarations are evidence, not a compatibility proof.
Report invalidation fan-out instead of imposing a cap that suppresses necessary
work. No mechanism here promises "100% non-breaking".

### R7 — Critical: the ledger and directory tree can invalidate themselves

**Evidence:** Every tracked entry needs a blob attestation; ledgers are tracked;
directory entries are keyed by Git tree ID; completion refers to the final
merge commit. No exception separates evidence from the evidence's subject.

**Failure scenario:** Updating a ledger changes its own blob and its containing
tree, which requires another ledger update indefinitely. Requiring the final
commit SHA inside that commit has the same circularity.

**Revision:** Inventory every Git entry, then partition it into content and
reserved evidence paths using tool-owned classification. Verify evidence records
with deterministic schema/provenance checks rather than self-attestation. Key
content reviews by content blobs and normalized content-tree digests excluding
evidence bytes. Record the reviewed source base, not a claim to contain its own
final SHA. Bind the merged commit to the verified manifest using external CI
evidence. Classification must reject source hidden under reserved evidence paths.

### R8 — Important: declared relationships and extracted relationships differ

**Evidence:** Wiki lint promises stale facts and irreproducible relationships
are rejected across imports, prose, shells, ports, database tables and runtime
routes. No extraction coverage or declaration schema is defined.

**Failure scenario:** A regex misses a dynamic read and the ledger reports a
complete relationship graph. Prose containing a historical port is treated as
a current claim. README frontmatter becomes a second Nx configuration.

**Revision:** Keep derived facts generated from their executable authority and
store only non-derivable declarations. Every edge records provenance, extractor
version and evidence selector; unsupported/dynamic relationships are declared or
explicitly unresolved. Validate typed fact references, not arbitrary prose.
Separate current claims from frozen historical citations. Lint attests supported
checks and declared coverage, never semantic completeness.

### R9 — Important: freshness is neither independence nor reviewer reliability

**Evidence:** Protocol blob and model are recorded, but fresh-agent identity,
available context, sample selection and a five-percent disagreement test have
no operational definition.

**Revision:** Record invocation identity, actual model, prompt, provided context,
read set and verdict. A new context establishes context isolation, not
independent model errors. Select audit samples reproducibly after the inventory
is pinned, stratify by risk, and arbitrate disagreements against source/test
evidence. Missing telemetry makes the claim unverified. Never synthesize an
attestation from a prompt that was merely scheduled.

## Round 3: avoid making the governance system the bottleneck

### R10 — Critical: voluntary leases do not enforce write ownership

**Evidence:** The command acquires a lease and creates a worktree; then "the
agent refuses a write outside the packet" supplies the enforcement step.

**Failure scenario:** A shell command edits outside the packet; a crashed agent
resumes after its lease expires; nested directory owners both claim a file; two
clones hold independent lease stores. No lease check sees these collisions.

**Revision:** State the single-authority scope. Acquire all canonical path and
conflict-group claims atomically; reject overlaps, traversal, symlink escapes and
invalid patterns. Pin the resolved policy to the lease. Use a generation/fencing
token checked at admission and integration; stale writers cannot publish. A
heartbeat expiry permits fencing and investigation, not an assertion that the
old process stopped. Exact session/token release is idempotent. A diff boundary
gate is mandatory; preventive filesystem enforcement requires a separately
proven executor. Do not describe a prompt instruction as a sandbox.

### R11 — Important: integration and contract sequencing can deadlock progress

**Evidence:** Leases end on integration; contracts are frozen before consumers
start; compatible work is batched. Shared-root writes and incompatible consumer
changes have no explicit waiting or transition rule.

**Revision:** Separate working and submitted states. Freeze an immutable patch
for admission, fence its writer, and keep admission claims until integration or
explicit rejection. Bound batches by size and waiting time. Perform validation
against the actual integration candidate, including read dependencies and gate
configuration. Additive/versioned contract transitions can publish a usable
intermediate commit; breaking changes need one coordinated atomic batch. A
green contract commit alone need not be a releasable application. Order claims
and avoid partial acquisition to prevent deadlock. Bound retries and report
starvation and integration rework.

### R12 — Important: the first strict lint would block its own rollout

**Evidence:** Change A wires whole-tree ledger lint before Change C creates the
full inventory's reviews. No bootstrap phase is specified.

**Revision:** Enumerate the whole tree in every mode. Introduce observe, ratchet
and enforce modes with explicit versioned adoption sets and visible debt.
Observe must not advertise certification. Ratchet refuses regressions and new
unclassified paths without pretending old debt is reviewed. Enforce requires all
obligations of the selected policy. Changes to classifications, exemptions or
policy need separate reviewed evidence; a failing run cannot quietly weaken its
own policy. Keep link/metadata/schema checks deterministic from the start.

### R13 — Important: root evidence and review maintenance can erase gains

**Evidence:** Root navigation and aggregate reviews are final passes, while
directory currency uses recursive tree hashes. Every descendant edit therefore
can require new ancestor reviews; review shards use the changing ownership unit.

**Revision:** Separate topology/relationship judgments from implementation
judgments; only their actual inputs invalidate them. Use stable shard identities
independent of task grouping, and measure changes to root documents as shared
work. Cache parser output by verified content identity; recheck full inventory
coverage. Report ledger churn, review amplification and integration queue time
as costs. A missing input is a failure, never a cache hit.

### R14 — Important: limits on abstraction and reversibility need owners

**Evidence:** The plan provides numeric size limits but no procedure for a task
discovering its assigned boundary is wrong, or for retiring a bad split.

**Revision:** The agent can request expansion with named evidence; the authority
grants the entire new claim set atomically or keeps the task paused. Track
boundary escapes as useful observations. Give every policy an identity, record
split/merge lineage, and rerun the fixed workload after changes. Keep raw
measurement exports usable without the wiki tooling. Stable identifiers,
evidence trust boundaries and admission authority deserve ADRs at implementation;
threshold defaults and initial grouping do not need permanent commitments.

## Disposition and cross-review

Initial recommendation: revise the proposal across all fourteen findings before
adopting it as an implementation blueprint. The exhaustive sweep and eight-agent
experiment remain explicit future work, with their costs and claims separated
from the correctness of the tooling that measures them.

### Claude Fable cross-review, round 1

The [preserved response](2026-09-08-radical-modularity-cross-review.md) is from
`claude-fable-5` at high effort, session
`3e5d27d2-5700-4690-97b9-59110e35915a`. It reviewed the two documents with tools
disabled; it did not inspect repository code or run checks. The CLI reports
success, 138,463 ms, one turn and USD 0.838581 including auxiliary model usage.
The raw CLI response's SHA-256 is
`1808782c1f6c5648b100fe78ac1d4323948b320dc5b5a3dee79996983cdf4061`.
The response approves application with amendments, not the original proposal
unchanged or an operational implementation.

| Cross-review point                         | Disposition in the refined proposal                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6: retain the <=3 invalidation diagnostic | Accepted: measurement retains it as a predeclared design-review trigger; it never suppresses required work                                        |
| R10: specify the minimal enforced core     | Accepted: ownership starts with atomic claims, generation token, diff admission and token validation; one-host/common-directory limit is explicit |
| Contradictory completion criteria          | Accepted: separate tooling, adopted policy and experiment evidence; negative scaling results complete experiments without proving scaling         |
| Stale assumptions                          | Accepted: rewrite inventory partition, cold/informed scope and non-breaking claim in place                                                        |
| Router as mutable findings board           | Accepted in the foundation design: findings move to an indexed tree, invariants to their boundary, with a complete destination map                |
| Magic-number self-scope negative           | Accepted: exact path/mode/blob equality and equal-count substitution fault replace the 2,000-path constant                                        |
| Secondary/audit threshold status           | Accepted: pinned diagnostics/defaults, no post-hoc threshold changes reported as the same experiment                                              |
| Fixed-corpus overfitting                   | Accepted: every result names its corpus; refresh breaks comparability; held-out outcomes and an explicit external-validity limit                  |

R1–R14 are applied in place throughout the proposal; the original claims are
available in Git at the pinned revision rather than retained as contradictory
normative text. CONTEXT.md defines Radical Modularity, granularity policy,
benchmark outcome and review attestation. The root router links to the design
within its existing cap. This docs delivery deliberately leaves the foundation's
root-content relocation, operational gates and exhaustive experiments as future
tasks, explicitly named in the proposal.

### Claude Fable cross-review, round 2

Fresh Fable session `49e1e117-b067-4335-9243-82a034d031e5` reviewed the rewritten
proposal, this review and the preserved first response with tools disabled.
It reports success, 122,872 ms and USD 0.915785 including auxiliary usage.
The raw response SHA-256 is
`f8aa3f1f2cdadbbdf7117fdb72c5c8a2b0db460268bb6f8324292b530a7b2f78`.
Its [response](2026-09-08-radical-modularity-cross-review.md#round-2-response)
confirms all fourteen findings and eight amendments landed, with conditional
approval and four further findings:

- F1 accepted: raw responses need an explicit opaque-payload evidence schema
  or external artifact retention, so they do not contradict the prose exclusion.
- F2 clarified with a different correction: unavailable required cohorts keep
  experiment reporting incomplete while tooling acceptance is separate. The
  suggested "all provisioned" qualifier is rejected because it would let the
  eight-agent requirement disappear when only four slots are available. Pending
  means outstanding, not accepted; that was the intended original distinction.
- F3 accepted: qualify repository rules R1–R5 to distinguish them from this
  review's R1–R14 finding identifiers.
- F4 accepted: cache conditions name Nx/build/model caches; wiki-lint cache
  negatives apply when that future optimization is introduced.

The measurement contract also makes ledger churn, one-time versus steady-state
cost and fixed-total versus per-session resources explicit. These clarify the
existing cost/control obligations rather than introducing another subsystem.

### Claude Fable cross-review, round 3

Fresh session `f4c5e62e-f849-45ec-aa49-54f25e311d90` returned **APPROVE** with
no remaining blockers or important contradictions. It explicitly verified that
the alternative F2 correction preserves every required cohort. Its sole nit,
qualifying repository rule R4 in the verification paragraph, is corrected below.
The [preserved response](2026-09-08-radical-modularity-cross-review.md#round-3-response)
covers the revised design and dispositions, with tools disabled.

The CLI reports success, 38,077 ms and USD 0.504530 including auxiliary usage;
raw response SHA-256:
`ade48fa6f692a1c020d4ae9538f34796e3ab69eb25496b13ddc5f70239a15d47`.
All three responses report substantive `claude-fable-5` usage. The CLI also
reports small additional Haiku usage, included in the costs; its purpose was
not independently verified. Fresh contexts do not claim independent model errors.

### Verification scope

This is a documentation change under repository rule R4's exemption. No new executable safety
check is added, so no new test or `Proof:` is claimed. Formatting, link/anchor
checks, glossary uniqueness for the added terms, scope checks and the repository's
existing CI apply. The operational fault table names required future tests.
Local verification on `pop-os`:

- `bun install --frozen-lockfile`: exit 0, checked 1,565 installs across 1,407
  packages without changes. The earlier main-merge hook reported a missing
  lefthook before setup. Explicit `bunx lefthook run pre-commit` then passed
  doc-caps, plaintext-secrets and format; code lint and migration lint skipped
  because the staged files contain no matching source or SQL.
- `bunx nx format:check --all`: exit 0 after the design corrections.
- `bun run tools/tool-git-hooks/src/hooks/doc-caps.ts`: exit 0;
  `LLM_README.md` is 150 lines.
- `git diff --check`: exit 0. Local relative targets/anchors and the router's
  design link resolve; the four added glossary definitions occur exactly once.
- Source/configuration files are unchanged relative to integrated `main`.
  Application tests and the h2puni host gate were not run locally for this docs
  change. No OpenSpec artifacts were changed; full validation remains in CI.

Delivery uses [PR #344](https://github.com/Prosperous-Unification/wbs-tool-v1/pull/344).
Merge must wait for its gate, four browser shards and aggregate pixels job on
the pushed revision. That PR's checks and merge record are the authoritative
external evidence; earlier checks on `a095fff8` cannot verify this revision.
