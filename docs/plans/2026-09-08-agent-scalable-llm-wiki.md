# Radical Modularity

Status: refined design for future implementation. This delivery applies the
design-review corrections; it does not implement or certify the wiki, leases,
sweep or scalability runner. The historical filename and branch remain stable
navigation targets. [Design review and dispositions](2026-09-08-radical-modularity-review.md)
explain the revisions to the original proposal at `a095fff8`.

## Intent

The repository needs to increase useful model-assisted work without requiring
each session to reconstruct the entire system. Radical Modularity makes
responsibility, context, relationships and verification explicit, and makes
their granularity adjustable enough to measure and improve.

The desired outcome is a maintained LLM wiki, verifiable review evidence,
temporary write ownership and reproducible experiments. A session can locate
the relevant boundary, inspect its contract, obtain a work packet and deliver
an independently accepted outcome. Measurements include the cost of keeping
this machinery current.

The approach introduces no embedding service, third-party search dependency,
page-per-file knowledge copy or permanent assignment of modules to models.
It does not promise complete semantic knowledge or universal linear scaling.
Future behavior, contract, architecture and safety changes require their own
OpenSpec artifacts and observed negative proofs under repository rules R4/R5.

## Assumptions

1. The user's latest request is refinement, cross-review and delivery of the
   approach. Operational implementation follows the sequence below.
2. Acceptance quality is held constant; elapsed time and total cost are measured
   separately. Twice as fast at four times the cost is a trade-off to report.
3. Initial ownership authority covers one host and one Git common directory.
   Coordination across independent clones or hosts is outside this version.
4. Every tracked entry at a pinned Git revision is inventoried, partitioned into
   content and reserved evidence paths by tool-owned classification. Complete
   inventory is distinct from complete review under a named policy.
5. Reviews are fallible observations. A cold diagnostic and a navigation-assisted
   judgment have different scopes and recorded read sets. Fresh context does
   not establish independent model errors. No judgment promises "100% non-breaking".
6. Model configuration, context policy, task grouping and concurrency may vary
   independently. Changing several together estimates their combined effect
   unless the experiment separates those effects.
7. Eight-way execution must be provisioned and verified before its benchmark.
   Two successive four-session cohorts cannot represent eight simultaneous
   sessions. Unavailable capacity leaves that experiment pending.

The [review](2026-09-08-radical-modularity-review.md#mandate-and-assumptions)
records the interpretation of the user's request without another interview.

## Knowledge stays with its authority

The source inspiration is
[ry's LLM-wiki revision](https://gist.github.com/ry/c56dfa7b1b90eeff2d8d0127e45ae3bb/revisions?short_path=4c66555#diff-4c66555dd402cc5d67a52a326ac73c0e13d09c5e3e6e2e32967808d23a576025):
relative Markdown links, recursive README indexes, coherent clusters and Git
history as the chronological record. The mechanisms below are this repository's
proposal, not claims about that source.

Code, tests, configuration and accepted specifications are raw authority.
`CONTEXT.md`, ADRs, runbooks, JSDoc and module READMEs explain that authority.
`AGENTS.md` supplies the rules. No second `wiki/` tree or `docs/log.md` is added.

```text
AGENTS.md -> LLM_README.md -> tree/project README -> module README -> authority
```

Indexes provide the default entry route; cross-links expose relationships that
do not form a tree. A model may follow evidence outside its initial reading
packet. Read expansion is recorded separately from permission to write there.
Symbol knowledge stays in names/JSDoc, cross-file invariants in their owning
index or linked document, cross-project decisions in ADRs, terms in `CONTEXT.md`.

The future foundation makes `LLM_README.md` a stable router: link to findings
and boundary invariants rather than enumerating mutable findings and landmines
there. Place extracted root findings under an indexed `docs/findings/` tree
until ledger queries can replace that entry point. Keep the canonical gate and
essential orientation in the router. Moving the existing content requires a
complete source-to-destination inventory so no warning disappears.

`AGENTS.md` retains repository rules R1–R5 and links within 120 lines;
`LLM_README.md` stays within 150. The R5 incident material moves to a catalogue grouped by fault shape with
stable identifiers and observed proof details preserved. These are foundation
tasks; this design revision changes no existing safety rule or gate obligation.

## Five independent granularities

| Dimension   | Unit selected by policy                          | Evidence of a useful boundary                          |
| ----------- | ------------------------------------------------ | ------------------------------------------------------ |
| Knowledge   | Initial index, summary and source read set       | Discovery time, additional reads, missed relationships |
| Review      | Files or behaviors assessed together             | Defects found, missed faults, disagreement and cost    |
| Ownership   | Paths and conflict groups claimed by one session | Contention, expansion and conflicting changes          |
| Task        | Work assigned toward a fixed benchmark outcome   | Completion time, retries and coordination cost         |
| Integration | Submitted changes verified together              | Queue time, rework, acceptance and gate cost           |

A versioned granularity policy records these mappings and constraints. Nx
projects and directories supply defaults, not proof of independent changeability.
Different policies can group the same files without moving source. Smaller
assignments cannot relax checks required by the actual affected boundary.

Modules have stable identifiers and versioned path mappings. Splits and merges
record predecessor identities. Historical packets resolve their pinned mapping,
never the current one. Ledger shard identity stays independent of task and
ownership grouping. Overlapping knowledge/review views are legal; overlapping
write claims require the same exclusive authority.

Physical refactoring follows measured coupling. A policy can group a coupled
cluster for one writer while offering smaller views for discovery. Scope
expansion names a missing relationship; the authority grants all additional
claims atomically or keeps the task paused. Expansion is useful evidence, not
an incentive to hide cross-boundary work.

Stable identities, evidence trust boundaries and admission authority earn ADRs
when implemented and alternatives are decided. Allocate numbers from the live
tree then. Thresholds and initial groupings are reversible policy defaults.

## Recursive index conventions

Nx project roots, major non-project trees and declared cross-file boundaries
receive indexes. Initially suggest indexes for directories with two non-test
sources or two indexed children; the adopted policy records boundaries and
exclusions. File counts and minimum prose length do not certify a module or
force empty templates into the repository.

Test-only, fixture-only and vendored directories may be described as sets by
their nearest index. Archived OpenSpec changes keep frozen artifacts, with
their proposal as entry point. Every exclusion stays classified and visible in
full-tree coverage. More than forty direct entries prompts navigation review
or grouping, without automatically moving source.

An index has a purpose, relative linked contents and applicable relationships,
cross-file invariants, exact boundary checks and known external consumers.
Metadata records why a section is inapplicable. Contents cover the selected
entries in both directions; grouped sets have checkable membership declarations.
Missing/case-mismatched paths, unresolved anchors and ambiguous links fail lint.
Markdown links contain no globs. Declaration patterns have a validated grammar
and resolve to concrete paths in a packet, including the allowed new-path rule.

Project names, tags, graph edges, targets and commands are derived from Nx and
executable configuration. Handwritten declarations hold only non-derivable
facts: extra runtime relationships, semantic contracts, module identity and
conflict groups. Reference authoritative targets instead of maintaining a
second command list. Deployables declare known external consumers or an
explicit "none known" and its knowledge limits; silence is unclassified.

## Inventory and finite evidence

At revision B enumerate exactly `git ls-tree -r B`: path, mode, blob and
classification. Symlinks are inventoried without following them and their
targets are checked deliberately. Content classes include source, test, config,
script, migration, fixture, generated, vendored, placeholder, document and
OpenSpec. Review binary format/consumer/regeneration authority as such. Applied
migrations and frozen history are reviewed, not rewritten by a docs sweep.

Compare complete path/mode/blob tuples, not a minimum count. The earlier 2,379
entries at `619b714b` is a historical observation; every run derives its own set.
Partition every entry into content or reserved evidence. Validate evidence
artifacts through schema, provenance and referential integrity rather than
requiring self-attestation of their own bytes. Reserved evidence paths accept
only evidence schemas: hidden source, executable entries or arbitrary prose
fail classification. Evidence policy and validator source are ordinary content.

Content attestations reference content blobs and explicit relationship inputs.
A normalized content manifest excludes evidence bytes from content-tree digests.
Topology judgments use names, classifications, exposed boundaries and edges;
implementation judgments retain their own byte inputs. A descendant's internal
edit does not stale an unchanged ancestor navigation claim. The full inventory
still detects every entry; these scopes are not enumeration exclusions.

Attestations record the reviewed source base, not their eventual containing
commit SHA. Final CI recomputes the manifest on the integration commit, validates
its evidence artifacts and emits an external binding of commit, manifest,
policy and command results. Evidence-only edits still require artifact validation.
This avoids both ledger self-hashing and storing a commit's identity inside itself.

Stable shards hold sorted file, boundary and documentation attestations, with
protocol version/blob, actual model/configuration, invocation identity, supplied
context, observed reads, cold/informed judgments, exact inputs, checks, findings
and unresolved/external relationships. Retain raw responses as referenced
artifacts with content identities and explicit retention. Raw responses live
outside the tracked tree or in a declared evidence schema whose provenance
envelope wraps an opaque payload. The arbitrary-prose refusal applies to files
without such a schema, not schema-wrapped transcripts. Missing telemetry is
unverified. A hash proves byte identity, not the honesty of a review's author.

## Freshness and behavioral confidence

- Changed content invalidates that file's content judgment.
- Changed resolved public declarations invalidate structural consumer evidence,
  including re-exported/transitive types behind an unchanged barrel.
- Changed semantic contract selectors (selected specs, invariants and
  conformance tests) invalidate judgments relying on them.
- Added/removed reverse edges invalidate provider relationship judgments;
  internal caller edits with the same edge do not.
- Extractor/policy/protocol changes invalidate claims whose meaning or inputs
  changed. Compatible protocol updates retain both identities and a reviewed
  compatibility declaration; a version label alone is no proof.

Stable types cannot establish stable behavior. Implementation edits run the
applicable affected consumer/conformance checks and require impact classification.
Unclassified/unsupported impact requires expanded review under the selected
policy. An "implementation-only" declaration cannot alone skip behavioral
checks. LLM re-review follows changed behavioral/structural review inputs;
deterministic conformance checks may fan out without forcing identical LLM work.

Parsers and Nx produce import edges with extractor/version provenance. Explicit
edge kinds cover dynamic reads, generated artifacts, scripts, CI/hooks, deploy
configuration, environments/ports, tables/migrations, HTTP contracts, document
claims, vendored locks and external consumers. Each declares extraction coverage
and exact selectors. Unsupported relationships remain declared or unresolved;
a partial graph never certifies complete semantic knowledge.

Typed fact references connect current prose to executable facts. Historical
citations are marked and resolve against their historical revision. Lint does
not claim to understand arbitrary prose. Semantic contradiction detection stays
scheduled and non-gating until a specific deterministic rule is proved.

## Review protocol and adoption

A cold diagnostic gives a fresh reviewer a pinned path and protocol, records
purpose/relationship/impact as yes, partial or no before additional context,
then an informed pass follows the indexes, traces consumers/checks and records
its judgment and read cost separately. Cold impact uncertainty can be legitimate
for a module member. Informed success cannot rewrite the cold result to yes or
justify copying module prose into every file.

Reviewers propose corrections without writes. The module's writer applies them
coherently with callers and tests; behavioral or architectural findings open an
OpenSpec change. Fresh post-correction reviews verify revised evidence. Findings
remain unresolved until source/check evidence supports closing them. Fresh
file, directory, project and docs passes are distinct obligations under the
exhaustive policy. Root navigation follows settled child topology.

The exhaustive experiment reviews every content path and all its boundaries,
projects and documentation; evidence artifacts follow their validation path.
Compare risk-based alternatives only with their different coverage and full
costs disclosed. A sampled review is never called exhaustive. Reports name the
policy, reviewed set, unresolved set and unreviewed set.

Select audits reproducibly from a pinned inventory with a stored seed and risk
strata. The initial five-percent sample and ten-percent shard-disagreement
trigger are experiment defaults, not confidence guarantees. Record population
and sample sizes by stratum; exceeding the trigger requires source-based
adjudication and a fresh shard review. Never resolve by majority vote alone.
Record model identity/context overlap when interpreting reviewer agreement.

## Ownership and integration

The minimal enforced core is atomic all-or-nothing canonical path/conflict-group
claims, a generation token, an admission diff boundary check and token validation
at integration. It uses one authority below the shared Git common directory;
multi-clone/multi-host coordination requires a later design. An isolated worktree
and a prompt instruction by themselves provide no write-boundary guarantee.

Pin base, policy/mapping, session, token and worktree. Refuse ancestor/child
overlap, traversal, symlink escape, ambiguous patterns and invalid state. Include
new paths/deletions and both sides of renames. Root contracts/schema/configuration
are explicit shared claims. Acquire every claim atomically to avoid hold-and-wait.

A work packet holds objective/outcome, base, policy, owned paths, read dependencies,
consumed/produced interfaces, invariants, scoped/integration checks and required
evidence. Revalidate read dependencies on the actual integration candidate.
Ports, databases and heavy-work lanes still need their resource locks; file
leases alone do not isolate runtime resources used by tests.

States are working, submitted, integrated, rejected or abandoned. Submission
freezes an immutable patch and fences further publication by that writer.
Admission claims remain until integration or explicit rejection. Release is
idempotent only for the exact session/generation and cannot release a successor's
claim. A retry after rejection requires reacquisition and revalidation.

Heartbeat expiry permits fencing/investigation, not an assertion that a process
stopped. A resumed stale writer is refused at admission/integration. Preventing
all out-of-packet filesystem writes requires a separately proved executor;
until then reports distinguish detection/refusal from prevention during editing.

Batches have maximum size and wait time fixed before measurement. Only the
actual combined candidate can pass integration. Contract, policy, gate or
relationship changes select affected checks again. Record conflicts/failures as
rework; bound retries and expose terminal failure, starvation and queue time.

For additive/versioned contracts, freeze a verified compatible interface commit
before consumers update in parallel. Incompatible transitions require one
coordinated batch integrating contract and consumers atomically. Never publish
an unusable contract-only intermediate state. Recovery addresses exact immutable
submissions and preserves other sessions' work.

## Wiki lint and rollout

The future `tool-wiki:lint` uses full-tree inputs with caching disabled initially.
Wire it into Nx, `bin/h2puni-gate.sh`, CI and whole-tree pre-commit. Staged-path-only
lint misses deleted targets and new reverse edges. Explicitly select working,
staged or committed input: admission attests its actual candidate, not stale HEAD.
Local working checks report untracked content separately so additions cannot
silently disappear from candidate coverage. Cache optimization needs new proofs.

Every mode enumerates the whole tree and applies supported deterministic link,
metadata, classification, evidence-schema and input-coverage checks. Review
obligations roll out as follows:

- **Observe:** report review debt; never claim review certification.
- **Ratchet:** enforce adopted boundaries, refuse regressions there, classify
  every new path, and expose all debt outside the adopted set.
- **Enforce:** require every obligation of the selected policy and refuse unmet
  obligations across its declared coverage.

Bootstrap records a reviewed initial policy/adoption set. Policy changes and
exemptions are reviewed separately from work they could excuse. CI selects its
trusted policy so a candidate cannot weaken its own gate. Observe cannot admit
work requiring enforce. Existing repository gates remain in force throughout.

The implementation's `verify.md` must record observed failures through production
entrypoints before adjacent `Proof:` comments are written. Required fault families:

| Boundary        | Deliberate fault                                                       | Required observation                                                      |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Inventory       | Drop a path, replace one at equal count, omit a candidate addition     | Complete tuple/candidate mismatch                                         |
| Classification  | Hide executable content under reserved evidence                        | Classification failure                                                    |
| Evidence        | Delete coverage, stale a blob, orphan a path, forge an edge/invocation | Named unmet coverage/currency/provenance obligation                       |
| Finite evidence | Change evidence bytes only, then change content                        | Artifact validation terminates; only content change stales content review |
| Contracts       | Change a re-exported type; alter behavior with identical types         | Structural invalidation; applicable behavior check fails                  |
| Topology        | Add importer/indexed child                                             | Relevant relationship/navigation judgment becomes stale                   |
| Index           | Missing/deleted child, wrong case/anchor, invalid declaration          | Exact membership/link/metadata failure                                    |
| Facts           | Change a current port, route, table or target                          | Authority-selector mismatch; historical claims distinguished              |
| Policy          | Remove adopted boundary or admit enforced work using observe           | Trusted-policy/mode refusal                                               |
| Leases          | Overlap, partial acquisition, escape, stale token, wrong release       | Atomic refusal preserving other claims                                    |
| Admission       | Out-of-packet rename/new path, changed read dependency, stale writer   | Refusal/revalidation before admission                                     |
| Integration     | Breaking contract-only candidate, changed gate after scoped checks     | Combined acceptance fails/checks are reselected                           |
| Caps/cache      | 121 AGENTS lines; omitted input changed under warm cache               | Cap refusal; target reruns and fails                                      |
| Host gate       | Stale an enforced obligation                                           | Wiki lint fails on that candidate in the full gate                        |
| Measurement     | Split task, omit failed-attempt cost, lose usage or change conditions  | Outcome count stays fixed; incomplete/incomparable report refused         |

These are future test requirements, not observed proofs. Also remove the guard
where appropriate and watch the intended assertion detect the broken behavior.
Test absence and unreadability separately when modeled separately. Do not derive
an assertion's threshold from the faulted value it is meant to constrain.

## Measurement contract

Pin a corpus of benchmark outcomes and acceptance criteria before partitioning
work. Each outcome counts once after integration and acceptance, irrespective
of assignments, retries or commits. Compare the same corpus; heterogeneous task
counts from different corpora are not interchangeable. Keep independent-module
and shared-contract strata visible. Every result names its corpus; changing it
breaks comparability explicitly. Results describe that workload, not development
in general. Use held-out outcomes when tuning policies.

For concurrency N and policy P record accepted outcomes per full elapsed hour,
time to complete the fixed corpus, completion fraction, total usage/spend,
human time, infrastructure allocation, failed attempts and defects within a
predeclared post-acceptance window. Include discovery, review, upkeep, waiting,
integration and gates. Capture raw token categories, actual model/provider and
pricing identity for repricing. Missing required cost telemetry is unverified,
never zero. Retain failed and censored trials.

Pin repository base, corpus/acceptance, policy, actual model/version/effort,
prompts/tools, resource envelope, seeds, retry/time budgets, prices and observation
windows. Start with one varying factor; use repeated randomized trials and
report counts/dispersion and warm/cold conditions for caches actually in play
(Nx, build and model prompt caches). Wiki-lint cache fault proofs apply when
its caching is introduced. Later experiments can measure interactions among
granularity, models and concurrency. Report initial foundation/sweep cost
separately from steady-state upkeep, including ledger churn, so amortization is
visible. Label fixed-total and fixed-per-session resource experiments explicitly.

Report trade-offs among quality, cost and latency. Keep the original hypotheses
of at least 80% linear efficiency through eight simultaneous sessions on a named
independent-work corpus:

```text
Q(2) / Q(1) >= 1.6
Q(4) / Q(1) >= 3.2
Q(8) / Q(1) >= 6.4
```

Secondary hypotheses remain conflict rate <= 5%, integration rework <= 10%,
median discovery <= 5 minutes, ordinary review amplification <= 3 reviews per
changed file, and lease wait <= 10% of aggregate session time. Define each
numerator, denominator and timing boundary in the experiment manifest before
running. Thresholds trigger diagnosis/design review, never dropped verification
or excluded failures. Audit thresholds are pinned similarly. Do not adjust
thresholds after observing a result and report it as the original experiment.

Diagnose contention, contract fan-out, tests, queues, root collisions and
invalidation when hypotheses fail. Distinguish validated tooling, an executed
experiment and a supported scaling claim. An unavailable eight-agent trial is
pending; a completed trial below target is a negative result. Neither proves
eight-agent scaling. Export raw measurements in a documented format independent
of the wiki commands so retiring the system cannot erase its evaluation evidence.

## Delivery sequence

Each operational change has intent, delta specs, ordered TDD slices and observed
verification, with a design only where needed. This is the cross-change design;
those changes use `tasks.md`, not a separate implementation plan artifact.

1. **Baseline and pilot:** pin inventory, acceptance corpus, policies and usage
   capture before broad cleanup. Preserve baseline evidence, select representative
   boundaries and prove outcome/cost accounting with injected faults. Provision
   the required execution capacity.
2. **Knowledge foundation:** create ADDED `index-conventions`, `wiki-ledger`
   and `wiki-lint` capabilities. Build finite evidence, relationship extraction,
   review protocol, indexes and deterministic full-tree lint. Wire observe and
   explicit ratchet adoption. Correct pilot docs/glossary; extract root findings
   and R5 catalogue with a complete destination map.
3. **Ownership/admission:** implement the minimal lease/packet/fencing/diff core
   and combined-candidate validation. Prove recovery, overlap refusal and state
   transitions. Stronger filesystem prevention requires its own executor proof.
4. **Exhaustive sweep/catch-up:** run all file/directory/project/docs obligations,
   owned corrections, fresh post-correction reviews and reproducible audit
   samples. Report unresolved findings and full cost. Catch up to the candidate,
   distinguishing content from evidence edits. Selective policies remain named
   alternatives, never substitutes described as an exhaustive run.
5. **Experiments/adoption:** execute one/two/four/eight cohorts at controlled
   granularities and model/resource settings. Record positive and negative
   hypotheses and limiting factors. Adopt a policy with explicit coverage based
   on that evidence, enable its enforce mode, batch compatible changes and run
   full repository/OpenSpec gates before integration through normal PR checks.

## Completion evidence

### Tooling acceptance

All selected capabilities have implementation, full-tree accounting, correct
finite evidence validation, enforced admission, observed fault proofs and full
repository/OpenSpec gate evidence on the actual candidate. Every explicit future
capability in the sequence must be accounted for; a working pilot alone does
not complete the system. No required check is weakened to make rollout pass.

### Adopted review policy

The adopted policy is identified and its coverage obligations are met. Reports
include current required reviews and explicit unresolved/unreviewed sets outside
that obligation. Unresolved required findings fail enforce. Every content path
and every evidence path is accounted for by its appropriate mechanism. Cold
judgments remain diagnostic, with informed judgments separately reported.

### Experiment reporting

Experiment reporting is complete only after the exhaustive experiment and every
required one/two/four/eight cohort measurement are executed and reported with
pinned configuration, costs, coverage, uncertainty, failures and limiting factors.
Unavailable trials remain pending with their cause, and keep this reporting
obligation incomplete; tooling acceptance can be established separately. A
negative scaling result can complete an experiment; it cannot substantiate the
target. Claims of 80% linear efficiency require measurements meeting the
hypotheses, independently of whether the measurement system is implemented.
