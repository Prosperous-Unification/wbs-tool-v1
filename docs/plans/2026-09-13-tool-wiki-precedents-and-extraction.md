# Tool-wiki precedents: Drift, OpenWiki, and extraction

Status: plan, 2026-09-13. Amends [Radical Modularity](2026-09-08-agent-scalable-llm-wiki.md)
and the `agent-scalable-llm-wiki` design. Drafted against `b08423f6`, then reconciled the same
day with what `change/radical-modularity` (PR #416) put on `main`: `tools/tool-wiki` exists
with tasks 1.1 to 5.2 checked, and 5.3, 6, 7 and 8 open. Parts 1 and 2 are not implemented.
Part 3 is a plan against the merged tool, not the design. Each part becomes its own OpenSpec
change with observed negatives before it is believed (repository rules R4, R5).

## Intent

**Problem.** The wiki-ledger's freshness rules, the review protocol and the tool's packaging
were designed without checking what already exists. A survey on 2026-09-13 found two tools
with working pieces of the design and none with the whole. Meanwhile the docs already drift:
of the 46 code paths named in `docs/adr/*.md`, the runbooks, `docs/capacity.md` and
`docs/local-dev.md`, **10 do not exist** in the tree today. Measured with a grep for
backticked `apps/`, `libs/`, `tools/` and `bin/` paths; four of the ten are ADR 0014's
planned library names, which a checker must be able to mark as intended rather than stale.
The merged index lint sees Markdown links only, so none of the ten is a finding today.

**Outcome.** Prose that explains code is anchored to that code and the gate fails when the
code changes. The ledger gains range-level evidence and a sparse reconciliation protocol as
a compatible protocol extension. The tool's extraction into its own project has a named
trigger and a measured list of prerequisites.

**Non-goals.** A second wiki tree. An embedding or search service. Adopting OpenWiki as a
product. Extracting the tool between the exhaustive freeze and policy adoption. Any product
behaviour change. Changing the trusted activation mechanism that already exists.

**Constraints.** Bun and Nx only inside this repo. A missing tool blocks the gate. Every new
check ships a watched negative and a `Proof:` written from the failure output. `LLM_README.md`
stays within 150 lines; `AGENTS.md` rules stay in force. Drift stays outside the reviewed
validator bundle, so a Drift version bump is never an activation change.

## Findings

Measured on 2026-09-13 from each repository's own files and GitHub metadata.

| Tool                       | Licence, state                     | What it does                                                                                                                                         | Verdict                                                                     |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `nashsu/llm_wiki`          | GPL-3, Tauri desktop, v0.6.11      | Karpathy-pattern knowledge base for documents; API only while a window is open; CI builds but runs none of its tests                                 | Rejected. Different job.                                                    |
| `langchain-ai/openwiki`    | MIT, Node 22, pushed 2026-09-12    | Agent-written `openwiki/` tree; "Grounded Claims" bind facts to `repo://path#La-Lb` with a SHA-256 of the range; deterministic recheck before update | Not the product. Port the claims protocol (Part 2).                         |
| `fiberplane/drift`         | MIT, Zig, v0.10.1 of 2026-06-22    | Docs declare anchors to files or symbols; `drift.lock` holds an AST fingerprint per anchor; `drift check` exits 1 when anchored code changed         | Adopt for prose that explains code (Part 1).                                |
| `YawLabs/ctxlint`          | MIT, TypeScript, pushed 2026-09-12 | Lints context files and READMEs against the tree: dead paths, wrong commands, dead hooks, a gate that errored followed by prose claiming it passed   | Precedent for index lint; not adopted.                                      |
| `Arthur920/Staleguard`     | MIT, Rust                          | Deterministic docs-versus-code check with a CI regression baseline                                                                                   | Precedent only.                                                             |
| `clash-sh/clash`           | MIT, Rust                          | `git merge-tree` across worktree pairs plus a PreToolUse hook                                                                                        | Nearest to work-admission; detection only, no claims or leases.             |
| `vouchdev/vouch`           | MIT, Python                        | Review-gated knowledge writes; claims cite content-hashed sources; append-only audit                                                                 | Provenance discipline precedent; agent memory, not review evidence.         |
| Prompt-only Karpathy forks | various                            | `llm-codebase-wiki`, `git-wiki` skill, `agent-devkit`, `codealmanac` (macOS launchd)                                                                 | All build a second tree; their "lint" is a prompt and cannot fail under R5. |

No tool measures one/two/four/eight-session throughput. The admission-authority and
experiment halves of the design have no precedent.

OpenWiki facts that matter for Part 2: the package exposes only a `bin`, no library exports.
Its claims module is about 3,700 lines depending only on `node:crypto`, `node:fs`,
`node:path` and `zod`; the evidence version is `repo-file-v1:sha256:<hex>` or
`repo-lines-v1:sha256:<hex>` over the selected bytes, with a range relocated through its
previous version when surrounding lines move (`src/claims/evidence/repository/resolver.ts`).

Drift facts that matter for Part 1: x86_64 and aarch64 Linux tarballs with `.sha256` files;
syntax-aware comparison for TypeScript, Python, Rust, Go, Zig and Java; every other file
type, Markdown included, falls back to raw content comparison; `drift refs` is a reverse
lookup; `--changed <path>` scopes a run; no JSON output is documented.

Merged-tool facts that matter for Parts 2 and 3, read from `main` at `a1fb5f39`:

- `tools/tool-wiki` is 76 files tagged `scope:infra`, `type:scripts`, `runtime:bun`,
  `ring:adapter`, with targets `test`, `lint`, `lint:source`, `lint:fast`, `typecheck`.
  It imports nothing from `apps/` and one shared library, `@wbs/validation`, at 17 sites:
  141 non-test lines over `arktype`, whose `fixtures/` entry pulls `bun:sqlite` and drizzle.
- Evidence selectors in `contracts/records.ts` are `path`, `prefix`, `segment` and `name`.
  There is no line-range kind. A grep of `review/` and `policy/` for resume or checkpoint
  finds nothing.
- The trust binding is built. `.github/workflows/trusted-wiki.yml` runs on
  `pull_request_target` with `contents: read`, checks out the default branch's
  `bin/tool-wiki-lint.sh`, downloads an activation archive from
  `vars.TOOL_WIKI_ACTIVATION_ARCHIVE_URL`, verifies `vars.TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256`
  before extracting, requires `selected.json`, then checks out the exact candidate head.
  `ci.yml` runs the same launcher from the checkout as a diagnostic on pull requests and, on
  push, reports `inactive` and exits 0 when no activation is provisioned. The archive is the
  closure `prepareActivation` builds, mirrored to a versioned directory on h2puni
  (`docs/runbook-tool-wiki-activation.md`). The required-workflow ruleset is an external
  prerequisite that candidate YAML cannot activate.
- The three repository variables are unset today, so every pull request's `trusted-wiki`
  check fails at "trusted activation archive digest is not configured". PR #423 merged with
  it red on 2026-09-12; this plan's PR did too. That is open task 5.3, not a candidate fault.

## Part 1: Drift anchors in the gate

Goal: an ADR or runbook that names a function is stale the moment that function changes,
and the gate says so. Drift already does exactly this; the work is provisioning, wiring,
a first anchor set and the negatives. The merged index lint does not overlap: it checks
Markdown links, and these references are backticked paths in prose.

1.1 **Scope.** Anchor ADRs 0005 to 0022, the runbooks, `docs/capacity.md` and
`docs/local-dev.md` to the files and symbols they name. Two rules. Never anchor Markdown to
Markdown: the raw-content fallback would stale an index on every child edit, the opposite of
the design's "a child's internal edit does not stale the ancestor". Anchor SQL, YAML, Bash
and Dockerfiles only where whole-file staleness is the intended signal: applied migrations
are frozen, so a stale anchor there is a real fault, and `compose.yml` and the Dockerfiles
change rarely and should re-stale their runbook when they do.

1.2 **Provisioning.** Pin `drift` v0.10.1, `x86_64-linux`, by its published SHA-256 on
h2puni and in CI the way `dagger` v0.21.9 is pinned (`docs/runbook-prod-deploy.md`). The
gate step throws when the binary is absent; it never skips. Negative: rename the binary,
watch the gate fail on the missing tool, restore.

1.3 **Wiring.** One Nx target with `cache:false` and whole-tree inputs, run by
`bin/h2puni-gate.sh`, `.github/workflows/ci.yml` and a whole-tree lefthook step. It is a
plain gate check beside `tool-wiki:lint`, not a member of the reviewed validator closure that
`prepareActivation` packages, so Drift's version is pinned in the gate and never in an
activation. Negatives, each watched through the real gate path: change an anchored symbol
without relinking and see the doc and symbol named; delete an anchored file and see "file not
found"; reformat an anchored TypeScript file with prettier only and see the run stay green,
which proves the AST comparison is what runs; reformat a raw-fallback file and see it go
stale, recorded as accepted noise.

1.4 **First anchor set.** The 36 existing paths from the measurement above become the first
`drift.lock`. The 10 missing paths become findings, resolved one of two ways in the change:
fix the doc, or mark the path as intended future structure with a convention the checker
honours. They are: `libs/domain/effective-label.ts` (ADR 0008),
`apps/be-01/src/service/clock.ts` (ADR 0012), `libs/conformance`, `libs/http-elysia`,
`libs/store-memory`, `libs/store-sqlite` and `libs/core/src/compose.test.ts` (ADR 0014),
`apps/fe-01/src/components/wbs/teams-dialog.tsx` and `apps/libs/domain/src/schedule.ts`
(`docs/capacity.md`), `apps/be-01/src/controller/auth.routes.ts` (`docs/runbook-dev-deploy.md`).

1.5 **Agent rule.** `AGENTS.md` gains one line: changing anchored code means updating the
doc and running `drift link`. The published agent skill is optional; the gate is the rule.

1.6 **Measurement.** For four weeks after wiring, count stale findings per gate run and per
PR from CI logs. This is the ledger's first real number for how often prose goes stale, and
it feeds the currency policy defaults. Record it in the change's `verify.md`.

1.7 **Risk and exit.** One maintainer, no commits since June 2026, a Zig build. The lock
format is TOML with one `sig` per anchor. If an upstream change is needed within the four
weeks and does not land, port `check` for the raw-content mode to Bun, which is trivial, and
accept losing AST awareness or fork. What Drift does not replace and must not be mistaken
for: attestations with provenance, declaration and reverse-edge currency, the trust binding,
and the observe, ratchet and enforce modes.

## Part 2: OpenWiki-derived amendments to the ledger protocol

The contracts froze at slice 1.1, so these are a compatible protocol extension under the
design's "compatible activations retain old and new identities", not an edit to the frozen
records. Timing matters: `freeze-exhaustive` derives every obligation from the protocol and
evidence graph, so the extension lands either before task 6.1 freezes the sweep or after
task 7.5 adopts a policy, never between. Vocabulary stays the repository's: attestation,
evidence, currency.

2.1 **Range-level evidence.** A new selector kind beside `path`, `prefix`, `segment` and
`name`: `repo://<path>#L<a>-L<b>`, versioned as `<scheme>:sha256:<hex>` over the selected
bytes, with a range relocated through its previous version when the lines around it move.
Whole-file judgments keep blob identity. New currency rule: bytes changed outside an
attestation's range do not stale it; bytes changed inside do. This refines "changed content
invalidates that file's content judgment" to the file-level judgment only.

2.2 **Deterministic pre-review resolution.** Before any model is invoked, resolve every
persisted evidence version. Only stale or unresolved attestations reach the reviewer;
current ones are retained by the tool and never re-sent through model turns. Maps to
`evidence/currency.ts` and `review/protocol.ts`.

2.3 **Sparse decisions.** The reviewer returns confirm, revise, add or retract per
attestation. Unchanged attestations are retained deterministically. A retraction must name
its attestation. Finishing is refused until the reconciled state is durable. Maps to the
receipt path in `review/invoker.ts`.

2.4 **Resumable sweep.** Per-unit checkpoints and a durable ordered queue so the task 6.2
exhaustive sweep resumes after an interruption instead of restarting; partial progress is
preserved and reported as partial. Nothing in `review/` or `policy/` does this today.

2.5 **Page-level trust metadata.** OKF v0.2's `generated`, `verified`, `status` and
`stale_after` fields are prior art for the `wbs-index` metadata block. Evaluate field
alignment at the next schema version. Not a decision here.

2.6 **Not adopted.** The `openwiki/` tree; `zod` where this repo uses ArkType through
`@wbs/validation`; model-in-the-loop resolution; connector-sourced facts.

2.7 **Negatives to add to the fault table.** Insert lines above a range with unchanged bytes:
not stale. Change bytes outside the range: not stale. Change bytes inside: stale. Retract
without naming an attestation: refused. Kill a sweep and resume: no unit reviewed twice,
none skipped. An old-protocol attestation under the new activation: still current, its
identity retained.

## Part 3: Extraction plan

3.1 **Decision.** The design's own extraction moment, the trust binding, has passed: it is
built in-repo as an external activation archive selected by repository variables and a
base-owned launcher, and it already packages a reviewed standalone validator bundle outside
the candidate tree. A separate repository therefore adds nothing to trust. What it adds is
reuse. Extract when a second consumer exists, and never between task 6.1 and task 7.5: the
tool's 76 files are inside the exhaustive sweep corpus, and moving them changes the corpus
the measurement contract says must stay fixed. The di-bag rule applies in reverse: this repo
adopts the extracted tool only once it ships standalone at `0.1.0`.

3.2 **Prerequisites, measured on `main`.** The tool imports nothing from `apps/`, so the
existing `scope:infra` boundary rule holds. The one product dependency is `@wbs/validation`:
either ship that library standalone first, or vendor its 141 lines with `arktype` as a peer,
and keep `bun:sqlite` and drizzle out by not taking its `fixtures/` entry. Repo-specific
facts already live in `docs/wiki-policy/`. The Nx project graph and the TypeScript compiler
must sit behind extractor ports with the workspace versions asserted at runtime; today those
are `nx` 23.2.0 and `typescript` resolved as `npm:@typescript/typescript6@6.0.2`, and a
mismatch is a refusal. A deliberate import from an app must be watched failing the
module-boundaries lint before the split is believed to be clean.

3.3 **Toolkit versus programme.**

| Moves to the tool repository                                                                                            | Stays here                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The CLI and its modules: contracts, inventory, relationships, indexes, evidence, review, policy, admission, experiments | `docs/wiki-policy/policy.json`, `bootstrap-policy.json`, `modules.json`, extractor declarations |
| The index metadata block schema and membership grammar                                                                  | The READMEs and their content                                                                   |
| The review protocol and the lint modes                                                                                  | `docs/review-evidence/` and `docs/experiment-evidence/`                                         |
| The admission authority and the experiment runner and exporters                                                         | The experiment corpus, results and any scaling claim                                            |
| Templates for READMEs, ADRs and `CONTEXT.md`, as CLI subcommands                                                        | ADRs 0020 and 0021, the activation runbook, and the phases in `docs/refactoring/tasks.md`       |

The glossary already separates the approach, Radical Modularity, from its instrument; the
tool repository needs its own name, and "LLM wiki" is the term the glossary says to avoid.

3.4 **Trust binding, as built.** The binding lives outside the pull request in both
layouts, which is why extraction was never going to supply it: `trusted-wiki.yml` reads the
launcher from the default branch and the archive location and digest from repository
variables, and h2puni holds the same digest-pinned archive. Extraction changes only what the
activation's validator bundle is built from. What is pending is provisioning, task 5.3: set
the three variables, place the archive, and administer the required-workflow rule. Until
then every pull request carries a red `trusted-wiki` check that certifies nothing.

3.5 **Mechanics.** `git subtree split --prefix tools/tool-wiki` preserving history; publish
`0.1.0`; this repo consumes the pinned version with its integrity hash; every bump runs the
consumer's full gate, because the tool's green is not the consumer's green. The tool
repository carries a fixture Nx workspace for its extractor tests and runs its own lint on
itself. The activation closure is rebuilt from the published package, and that rebuild is a
new reviewed activation, never an edit of an activated one.

3.6 **Nx.** The build system for the tool repository, yes; a runtime requirement for
consumers, no. Keep Nx as one relationship extractor adapter, or the tool cannot dogfood on a
non-Nx repository and the second consumer never arrives. Templates and editing tools are CLI
subcommands: this workspace has no Nx plugins, generators or executors, and every tool is a
project of `nx:run-commands` targets running a Bun script.

3.7 **Peer coupling.** The declaration hashes use the workspace compiler, so the TypeScript
and Nx versions are peer dependencies asserted at runtime, and a mismatch is a refusal, not
a warning.

## Sequencing

1. An OpenSpec change for Part 1. Small, gate-only, measured for four weeks. Independent of
   task 5.3.
2. Task 5.3 provisioning, which is the design's own next step and turns the `trusted-wiki`
   check from red to meaningful.
3. Part 2 as a protocol extension before task 6.1, or after task 7.5 if 6.1 comes first.
4. The extraction change at a second consumer, outside the 6.1 to 7.5 window, carrying 3.2
   to 3.7.
