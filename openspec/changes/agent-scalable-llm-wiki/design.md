## Context

This packet operationalizes [Radical Modularity](../../../docs/plans/2026-09-08-agent-scalable-llm-wiki.md)
and its [review dispositions](../../../docs/plans/2026-09-08-radical-modularity-review.md).
Inspection at `339708fa` found the design and glossary, but no `tool-wiki`, admission
authority, ledger or experiment implementation. Preparation is not baseline collection,
review certification or scalability evidence.

[ADR 0020](../../../docs/adr/0020-module-identities-and-finite-evidence.md) governs stable
identities and finite evidence. [ADR 0021](../../../docs/adr/0021-shared-git-admission-authority.md)
governs admission authority and trust. Their rationale is not repeated here.

## Goals / Non-Goals

Deliver all five capabilities in `proposal.md` through ordered, individually verifiable
slices. Tooling acceptance, selected-policy coverage and experiment reporting have separate
completion states. A working pilot cannot satisfy the later exhaustive sweep or eight-way
trial. Negative experimental results are reportable completions; absent required trials
remain pending. Nothing in this packet removes R1–R5 or existing CI/browser/release checks.

No embedding/search service, source-per-file prose copies, generic semantic-certainty
claim, deployment/solver redesign, multi-clone authority or claimed prevention of every
filesystem write. Behavioral findings become separately owned changes, with the original
review finding remaining unresolved until their implementation evidence exists.

## Decisions

### Projects and ownership boundaries

Use one infrastructure project initially: `tools/tool-wiki`, Nx identity `tool-wiki`,
tags `scope:infra`, `ring:adapter`, `runtime:bun`. It owns the CLI and deep modules below.
This creates one discoverable boundary without requiring separate Nx projects for every
protocol record. Public module interfaces are the seam; later measured coupling can
change grouping without renaming logical identities.

| Owner within `tools/tool-wiki/src` | Public interface and responsibility                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contracts/`                       | ArkType schemas for inventory, policies, mappings, attestations, packets, authority state and experiment receipts; validate external input once  |
| `inventory/`                       | `readCandidate(selection)` and `classifyEntries(entries, policy)`; exact Git tuples, explicit untracked set, symlink handling                    |
| `relationships/`                   | `extractRelationships(candidate, extractors)`; typed selectors, resolved public declarations, provenance and unsupported sets                    |
| `indexes/`                         | `readIndexes(candidate, policy)` and `checkIndexes(...)`; membership, links, metadata, typed fact references and caps                            |
| `evidence/`                        | `buildContentManifest(...)`, `validateArtifacts(...)`, `classifyCurrency(...)`; finite evidence and scoped invalidation                          |
| `review/`                          | `prepareReview(...)`, `recordReview(receipt)`, `selectAudit(...)`; cold/informed protocol, read sets, findings and fresh post-correction reviews |
| `policy/`                          | `loadTrustedPolicy(binding)` and `evaluateObligations(...)`; observe/ratchet/enforce and compatible policy transitions                           |
| `admission/`                       | Claim state machine, packet boundary/read checks, immutable submissions and integration token validation                                         |
| `experiments/`                     | Manifest validation, fixed-outcome accounting, invocation adapter, trial scheduling and portable exports                                         |
| `cli.ts`                           | Thin argument/input boundary; drives the production modules and produces structured reports with nonzero failure exit                            |

Root files, contract schemas, gate wiring and shared policy activation have one coordinator.
After `contracts/` is frozen with fixtures and decoder tests, disjoint module owners can
implement consumers. Incompatible contract changes integrate atomically with all consumers.
Only observed independent work is scheduled in parallel; file leases do not reserve ports,
databases or the heavy-work lane.

### Candidate selection and exact inventory

`CandidateSelection` is a tagged union: committed `{revision}`, staged `{indexTree}`, or
working `{base, trackedSnapshot, untracked}`. Use `git ls-tree -r -z` for committed/index
trees and preserve `{path, mode, blob}` exactly. Snapshot the index once and fail if it
changes during selection. Working mode freezes tracked working bytes in a manifest and
reports untracked paths separately; it is diagnostic, never an admission attestation.
Admission creates its immutable candidate tree from the approved base plus submitted
patches and inventories that tree, including additions, deletions and both rename sides.

Every selected entry has one content class or evidence schema class. Symlink blobs are
inventoried as symlinks; a link check resolves allowed repository-relative targets without
following an escape or silently reading external bytes. Tracked binaries declare their
format, consumer and regeneration authority. Gitlinks require a pinned object and declared
external boundary; inaccessible content is unresolved, never counted as reviewed source.

Use `docs/wiki-policy/` for ordinary content: `policy.json`, `modules.json`, protocol,
extractor declarations and documentation. Reserved machine evidence lives only under
`docs/review-evidence/` and `docs/experiment-evidence/`, each file matching an allowlisted
schema. These are evidence locations, not a duplicate knowledge tree. Unknown schemas,
executable file modes, hidden source or free prose without an envelope fail classification.
Raw responses use a schema envelope carrying an opaque payload and provenance, or a
content-addressed external artifact with an explicit retention contract.

### Finite manifests and record contracts

Use canonical UTF-8 JSON: recursively sorted object keys, ordered arrays where order is
semantic, otherwise arrays sorted by their specified identity, and one terminal newline.
Hash these bytes with SHA-256. Do not serialize maps, undefined values or implementation
class instances. Decoder tests pin representative bytes and reject duplicate identities.

| Record              | Required fields                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory           | protocol, selection, sorted exact entries, untracked set, classification-policy identity                                                                                                                            |
| Module mapping      | stable opaque module id, mapping version/blob, owned membership declarations, predecessor ids, index path, external-consumer declaration                                                                            |
| Content manifest    | protocol, content tuples/classifications, relationship inputs, policy/extractor identities; excludes evidence bytes                                                                                                 |
| Attestation         | source base, subject id/kind, content/selector identities, protocol blob, invocation receipt, actual model/config/context, observed reads, cold/informed judgments, checks, findings, unresolved/external relations |
| Check receipt       | command argv, cwd identity, start/end, exit/status, candidate manifest, tool identity, resource lane, stdout/stderr artifact identities, skips                                                                      |
| Review receipt      | invocation id, actual model/provider/version/effort, supplied context ids, observed read ids, raw response identity, usage categories and trust binding                                                             |
| Integration binding | actual commit/tree, content manifest, evidence validation digest, trusted policy/validator identity, admission generations and command receipts                                                                     |

Attestations name the source base that was reviewed. They never predict their eventual
containing commit hash. Evidence bytes are validated for schema, provenance and references;
they do not demand another review of themselves. Final CI emits the integration binding
as an external artifact. Evidence-only edits validate again but do not stale unchanged
content reviews. Validator/policy source is ordinary content and cannot evade review by
living under an evidence path.

Invocation provenance is a real boundary: an unknown invocation id or a receipt absent
from the trusted invocation journal is rejected. Hash equality alone is not authorship.
The runner provides `ReviewInvoker`/`InvocationJournal` ports; the first adapter launches
an operator-provisioned review harness with structured JSON input/output and explicit argv,
records its invocation before launch, and binds its actual tool/model/usage receipt at exit.
No receipt is fabricated from a requested model label. Local cooperative-host receipts
declare that trust scope. CI/enforced evidence requires receipts from its trusted harness
or a configured external verifier; a writer-supplied transcript cannot certify itself.

### Review currency and relationship extraction

`ReviewInputs` separates file bytes, navigation topology, public declarations, semantic
selectors and reverse edges. A changed internal child blob stales that child's content
judgment, not an unchanged ancestor navigation judgment. Added/removed indexed child or
importer stales the matching topology/provider relationship judgment. Public declaration
hashes include resolved re-exported/transitive types, using the workspace TypeScript
compiler version and configuration. Stable signatures never certify stable behavior:
changed implementation runs the applicable consumer/conformance checks plus explicit impact
classification. Unknown impact expands required review; a writer's `implementation-only`
label alone cannot waive it.

Initial extractor adapters cover TypeScript imports/public declarations and Nx projects/
targets from their executable authority, Markdown links/anchors, and declared selector
families for scripts/CI/hooks, Docker/build artifacts, ports/environments, table/migration
relationships, HTTP contracts, generated/vendored locks and external consumers. Declarations
hold non-derivable edges only and name exact selectors, extractor version and coverage.
Unsupported facts remain declared/unresolved in reports; no parser claims semantic completeness.

Cold review supplies only the pinned path and protocol. Record yes/partial/no judgments
for purpose, relationship and impact before expansion. Informed review then follows indexes
and callers/checks, recording added reads/cost separately. A later yes never overwrites cold
uncertainty. File, directory, project and documentation passes remain distinct obligations
under exhaustive policy. Findings close only against source/check evidence after an owned
correction and a fresh post-correction review. Select the audit sample deterministically
from the pinned inventory and stored seed/risk strata; disagreement triggers adjudication
and fresh shard review, not a vote count. Record model/context overlap.

### Index format and root migration

`README.md` indexes remain ordinary Markdown with a single versioned metadata block
(`<!-- wbs-index { ... } -->`) decoded by `contracts/index.ts`. It contains module id,
membership declarations, relationship selectors, explicit section inapplicability reasons
and external-consumer knowledge limits. Human content supplies purpose, relative links,
cross-file invariants and authoritative check links; symbols keep JSDoc. Link text itself
does not contain declaration globs.

Membership grammar supports exact relative paths and one directory-prefix set declaration
with explicit exclusions; no `..`, absolute path, ambiguous wildcard or symlink traversal.
Resolve declarations to concrete candidate paths before packet claims. Allowed new paths
must lie below a declared owned directory prefix and be classified before admission.
Indexes verify selected entries in both directions. New/missing child, wrong case, absent
anchor and invalid metadata fail deterministically. More than forty direct entries reports
navigation review debt; it does not force filesystem moves.

The pilot adds indexes for selected project roots, major non-project trees and agreed
cross-file boundaries. Test/fixture/vendor sets can inherit their nearest index; archives
retain their frozen proposal entrypoint. Full enumeration still accounts for excluded sets.
Move root findings to indexed `docs/findings/`; move the R5 catalogue to
`docs/findings/checks-that-cannot-fail.md` with stable incident ids and preserved observed
proof details. Record a complete source-heading/paragraph-to-destination map first. Keep
AGENTS rules within 120 lines and LLM_README within 150 without deleting safeguards.

### Trusted lint and rollout

`tool-wiki:lint` has whole-tree inputs and `cache:false`. Its CLI requires explicit
candidate selection, mode and trusted binding. Local convenience targets can choose working
mode and report untracked content, but admission and CI must pass an immutable candidate.
Every mode runs deterministic inventory/classification/schema/link/input checks. Observe
reports debt without certification; ratchet enforces the separately adopted boundary set,
classifies all new paths and reports remaining debt; enforce refuses every unmet obligation
in its selected coverage. A required enforce packet cannot submit observe evidence.

CI and the authority load policy and validator identity from an operator-reviewed trust
binding outside the candidate under review. The first binding pins a previously reviewed
commit/artifact and policy digest; bootstrap that activation separately. Candidate edits
cannot change the binding, shrink adopted coverage or replace the executable deciding their
own admission. Policy/validator updates are separate reviewed activations that rerun affected
checks. Local command flags cannot impersonate CI trust. The same deterministic engine is
called by Nx, `bin/h2puni-gate.sh`, CI and whole-tree pre-commit with explicit input mode.

### Claim authority and state machine

Resolve the common Git directory through `git rev-parse --git-common-dir`, canonicalize it,
and use `<common-dir>/wbs-wiki/authority.sqlite` for the single-host authority. `bun:sqlite`
transactions provide atomic all-claims admission; SQLite details never leak into packet
records. The authority opens the database fail-closed with integrity/schema checks and
bounded busy behavior. State access is through `AuthorityStore`, with a memory fixture for
deterministic state-machine tests and real SQLite multi-process tests for atomic claims.
This is infra storage, not the product's SQLite source or its deployment migrations.

`acquire(packet)` normalizes all canonical paths and conflict groups, rejects ancestor/child
overlap with current owners and either records all claims with one new generation or none.
Packet binds objective/outcome, base, policy/mapping, session/worktree, owned paths, read
dependencies, consumed/produced interfaces, invariants/checks and evidence requirements.
Conflict-group claims make shared schema/root configuration ownership explicit. Missing or
invalid state never means unclaimed. Heartbeat expiration only permits fencing/investigation.

States are `working -> submitted -> integrated` or `working/submitted -> rejected/abandoned`.
Submission stores an immutable patch, candidate diff and content identities; it fences further
publication under that generation. Claims remain until integration or explicit terminal
rejection/abandonment. Release is idempotent for the exact session/generation, never for a
successor. Resumed stale writers cannot submit or integrate. Retry reacquires a new generation.
Admission compares additions/deletions and both rename sides against owned paths, then checks
read dependencies on the actual combined candidate. Failure preserves other sessions' work.

Integration uses a coordinator worktree, applies exact immutable submissions and reruns
required checks selected from that combined candidate. Contract/policy/gate/relationship edits
reselect checks even after scoped success. Recheck authority generations and branch base while
atomically updating the integration ref; if it moved, rebuild/revalidate the candidate. Failed
integration records rework, preserves submissions and has bounded retry. Reports say detected/
refused out-of-packet publication; preventing every editing-time write needs another executor.

### Measurement and execution adapter

Pin `ExperimentManifest` before partitioning: repository/corpus/acceptance ids, fixed outcome
ids, policy/mapping/protocol, actual model/version/effort, prompt/tool hashes, resource envelope,
seeds, retry/time budgets, price identity and post-acceptance observation window. Every accepted
outcome counts once after integration and acceptance, regardless of assignments/commits/retries.
Keep independent-module and shared-contract strata separate. Held-out outcomes are reserved
before policy tuning. Changing corpus or conditions explicitly breaks comparability.

Use `ExecutionAdapter.start(packet)` returning a process/session id and structured invocation
receipts. The configured harness supplies model execution; the runner does not invent a new
provider SDK or silently substitute models. The runner records actual concurrent active session
intervals. Provision and demonstrate eight overlapping intervals before the eight-way cohort;
two sequential four-session groups are invalid. Unavailable adapter/capacity keeps that trial
pending and has no fabricated zero cost.

Run repeated randomized one/two/four/eight cohorts first varying concurrency alone; then vary
one of knowledge/review/ownership/task/integration grouping or model configuration. Retain raw
input/output/cache/reasoning token categories as supplied, actual model/provider/pricing id,
money, human time and infrastructure allocation. Include discovery, review, upkeep, waiting,
integration, gate time and failed/censored attempts. Missing required telemetry produces an
unverified report that cannot satisfy acceptance. Separate foundation/sweep cost from recurring
upkeep and label fixed-total versus fixed-per-session resources and warm/cold caches.

Before running, set numerical defaults in the manifest: at least three randomized repeats
per concurrency, a 24-hour post-acceptance defect window, at most three attempts per outcome,
and integration batches of at most four submissions or five minutes waiting. These are
explicit initial experiment policies, not optimized values; changing one creates a new trial
condition. Corpus acceptance/time/resource budgets and prices are factual launch inputs,
recorded before execution. Default hypotheses retain Q(2)/Q(1)>=1.6, Q(4)/Q(1)>=3.2,
Q(8)/Q(1)>=6.4; conflict<=5%, integration rework<=10%, median discovery<=5 minutes,
ordinary review amplification<=3 per changed file and aggregate lease wait<=10% of session
time. Pin exact numerators/denominators in the manifest, report dispersion and negative
results, and never drop failures or lower verification to meet them.

Export documented JSONL observations plus CSV outcome/trial tables that an independent reader
can recompute without `tool-wiki`. Scaling claims are tied to corpus/configuration and observed
results. Tooling acceptance, an executed experiment and a supported scaling claim remain three
different statements.

## Risks / Trade-offs

The ledger and broad review can cost more than they save. Measurement includes that upkeep;
the exhaustive run is a specified experiment, not the automatic permanent review policy.
Review agreement is not independent error evidence. Parser coverage is finite and visible.
Single-host claims cannot coordinate independent clones/hosts, and same-user local filesystem
access is not an adversarial security boundary. Enforced attestations therefore name their
trusted harness/verifier scope; cooperative local records alone do not establish CI provenance.

## Migration Plan

Pin baseline and corpus before cleanup. Build schemas/accounting, then pilot index/evidence
and deterministic lint; activate observe/explicit ratchet separately. Add and prove authority,
admission and combined-candidate validation before scheduling mutating cohorts. Complete owned
exhaustive corrections/reviews and catch up to the selected candidate; execute all required
cohorts, report outcomes, select a named adoption policy and enable enforce through reviewed
activation. Preserve legacy gates throughout. Run the full host/browser/OpenSpec gates when
their owned behavior changes; document exact skips rather than substituting a pilot result.

Namespace baseline evidence may pin the old layout. Final module mapping/index catch-up waits
for `repo-namespacing`; its renames change mapping/topology inputs without rewriting historical
packets. Root AGENTS/LLM_README/CI/hooks edits serialize with that change's root owner. Scheduler
runtime and source-conformance tails belong to their own packets, not this tooling programme.

## Open Questions

No architectural decision is delegated to a medium-effort worker. Operator-provisioned harness,
actual model ids/prices, corpus acceptance fixtures and available concurrent capacity are launch
inputs to validate before trials. Unsupported or unavailable inputs produce explicit pending
evidence, without replacing the original experiment or claiming completion.
