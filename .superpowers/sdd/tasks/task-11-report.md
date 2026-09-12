# Task 11 Report: OpenSpec 3.4

## Implemented

- Added strict, versioned trusted policy, binding, evidence and compatible-activation records in
  `policy/trust.ts`. Required files are opened once, canonicalized through their descriptor,
  checked for mutation across the read and bound to their exact SHA-256 identities.
- Separated operator path selection from CI authority. `lint-local` accepts an explicit external
  binding but always reports `local-operator` provenance and never certifies. `lint-ci` accepts no
  mode or binding flag, requires its caller's `TOOL_WIKI_CI_TRUSTED_BINDING`, requires CI scope and
  derives its mode from the trusted policy.
- Rejected binding, policy and validator paths that resolve inside the selected candidate,
  including symlink aliases. Bound validator identity covers the exact `cli.ts` and `trust.ts`
  implementation that decides acceptance, rather than a caller-provided label.
- Froze one whole candidate and ran the same deterministic inventory, classification, schema,
  metadata-link and selector-input-coverage engine in observe, ratchet and enforce. Observe exposes
  debt without certification, ratchet refuses unmet obligations on changed adopted exact tuples,
  and enforce refuses every selected unmet obligation.
- Made authority policy, validator and exemption boundaries activation-only. Candidate edits to
  those files cannot select weaker authority even when the candidate updates its own policy claim.
- Added compatible activation validation that retains exact predecessor and successor identities,
  forbids boundary/obligation/adopted/activation/minimum-mode shrink and exemption weakening,
  requires explicit boundary and obligation-coverage declarations, and deterministically reselects
  every affected check and review after policy or executable-validator changes.
- Kept historical validator artifacts verifiable during activation while requiring the successor
  binding to match the currently executing implementation. Trust-only CLI code is loaded through
  narrow dynamic route imports, so existing high-volume CLI commands do not eagerly construct the
  trust engine.

## Failure-proof observations

Each fault was introduced alone on a real production CLI route, observed, restored and recorded in
an adjacent `Proof:` comment.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| remove authority-boundary disposition | policy, validator and exemption edits exited 0 with `accepted: true`, their changed boundaries named and no refusals |
| remove ratchet disposition | an exact application blob-tuple change exited 0 with `accepted: true` while both debt and unmet named `obligation.application` |
| remove evidence-mode comparison | enforce lost the `observe evidence cannot satisfy enforce work` refusal and retained only application debt |
| remove enforce disposition | omitted application evidence exited 0 with `accepted: true` while debt and unmet still named it |
| bypass the whole-tree index check | an unindexed `src/unindexed.ts` candidate exited 0 with `accepted: true` |
| remove external containment | a trusted-binding symlink into the candidate exited 0 with both `accepted` and `certified` true |
| remove executable-validator comparison | a binding omitting `trust.ts` reached ordinary policy evaluation and refused only application debt |
| remove predecessor comparison | an all-zero predecessor identity exited 0 with `compatible: true` and the actual prior identity substituted into the report |
| ignore undeclared evidence fields | candidate `trustedBindingPath` evidence exited 0 with both `accepted` and `certified` true in CI |
| remove explicit addition declaration | undeclared `boundary.docs` exited 0 with `compatible: true` while the report named the addition |
| compare only boundary records | an undeclared added application check exited 0 with `compatible: true` while the report reselected it |
| remove boundary-retention guard | a deleted boundary reached only the later obligation-removal error, losing the boundary-coverage refusal |
| remove minimum-mode monotonicity | enforce-to-observe activation exited 0 with `compatible: true` and only reselected existing checks/reviews |
| remove exemption monotonicity | a newly added exemption exited 0 with `compatible: true` and no removed exemptions |

## Verification

- Focused trusted-policy production CLI: 21 pass, 0 fail, 323 assertions.
- Forced uncached tool-wiki TypeScript build: exit 0.
- Uncached tool-wiki ESLint: exit 0.
- Existing 25-second production CLI decoder matrix: pass, 56 assertions, 24.681 seconds after
  restoring narrow startup imports.
- Exact-final-tree uncached full tool-wiki suite: 253 pass, 0 fail, 2,682 assertions across 14
  files in 6m25s; cache skipped and no target skipped.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`.
- Host gate: unavailable, not green. `/home/puni1/.cache` is absent, so the documented host
  preflight exited 70 with `heavy lock: /home/puni1/.cache does not exist`.

## Scope

Only OpenSpec task 3.4 is marked complete. No production trusted binding or gate activation was
added: that authority bootstrap remains task 5.3, and gate/lefthook wiring remains task 3.5. Tasks
2.4 and 2.5 were not changed.

## Astra fix round 1

- Replaced caller-declared obligation `status` with strict Task 3.2 obligation/currency input,
  candidate-bound check observations plus `CheckReceipt` records, and review observations plus
  non-local `ReviewReceipt` provenance. Enforce now compares the exact candidate identity, source
  base, full content tuple population and trusted boundary baselines before any receipt can
  discharge an obligation.
- Corrected candidate containment to recognize `..` only as a complete traversal component, so a
  real child named `..trust` is inside the candidate and cannot host a trusted binding.
- Expanded validator identity from two seed files to the deterministic transitive executable
  import closure rooted at CLI dispatch and `policy/trust.ts`, including literal lazy routes,
  acceptance modules, workspace libraries and resolved runtime packages.
- Made compatible activation monotonic for selector coverage, check/review requirements and exact
  obligation-to-boundary assignments. Existing IDs no longer conceal narrowed content.
- Turned selector-input coverage into an executed validation: each trusted selector must resolve at
  least one exact candidate tuple before its deterministic identity is reported.
- Added exact candidate selection and untracked-path diagnostics to every report. CI checks the
  complete frozen tracked tuple set but always refuses a working selection, even when otherwise
  current receipts cover it; local working output remains diagnostic and non-certifying.

### Fix-round failure proof

Each restored guard below was faulted separately through its production CLI route.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| remove candidate-bound evidence gate | changed `src/app.ts` certified with unchanged evidence; expected exit 1, received 0 |
| accept a check label without its receipt | missing `check.application` receipt certified; expected exit 1, received 0 |
| accept local-cooperative review provenance | local `review.application` certified; expected exit 1, received 0 |
| classify every `..` prefix as traversal | candidate child `..trust/binding.json` certified; expected exit 1, received 0 |
| reduce validator closure to its seed files | binding omitting `indexes/check-indexes.ts` certified; expected exit 1, received 0 |
| omit actual selector resolution | `selector.does-not-exist` certified after its policy digest was updated; expected exit 1, received 0 |
| omit exact obligation boundary assignment | policy moved `obligation.application` only in its record and certified; expected exit 1, received 0 |
| permit selector narrowing | `prefix:src` became `path:src/app.ts` and returned `compatible: true`; expected exit 1, received 0 |
| permit check deletion | activation deleted `check.application` and returned `compatible: true`; expected exit 1, received 0 |
| permit review deletion | activation deleted `review.application` and returned `compatible: true`; expected exit 1, received 0 |
| permit obligation moves | activation moved `obligation.application` to `boundary.policy` and returned `compatible: true`; expected exit 1, received 0 |
| remove working-selection CI refusal | exact working evidence certified while the report exposed `untracked.ts`; expected exit 1, received 0 |

### Fix-round verification

- Focused trusted-policy production CLI: 31 pass, 0 fail, 780 assertions in 50.63 seconds.
- Forced uncached `tool-wiki:typecheck`: exit 0; cache skipped.
- Uncached `tool-wiki:lint`: exit 0; cache skipped.
- Exact final-tree full tool-wiki command (the target's underlying uncached Bun command): 263 pass,
  0 fail, 3,139 assertions across 14 files in 436.51 seconds. The Nx wrapper itself refused a
  nested `tool-wiki:test -> tool-wiki:test` invocation inherited from the controller, so it was not
  reported as green; the exact configured command ran directly instead.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`.
- Whole-workspace format check and `git diff --check`: exit 0.
- Exact-code-commit host gate: unavailable, not green. `bin/h2puni-gate.sh HEAD` exited 70
  because `/home/puni1/.cache` does not exist.

## Astra fix round 2

- Split caller lint disposition from externally selected authority. The CI binding now pins one
  separately located authority artifact by canonical path and digest, plus its authority,
  verifier-scope and journal identities. The artifact owns the complete Task 3.2 obligation
  request, judgments, behavior rules and check receipts; caller evidence can only state report
  mode and exact obligation/check/review IDs.
- Reused `evaluateObligations` over the bound authority request. A changed authority artifact that
  removes a failed rule is rejected at the binding digest before its bytes can decide acceptance.
- Reused `evaluateAudit` for review discharge. Certification requires accepted exhaustive audit
  evidence for the exact candidate and requires every reconciled review receipt to match the
  binding-selected non-local verifier scope and journal. The audit contract checks invocation,
  cold/informed phase, retained response, executor/price/usage, source and reviewed-candidate
  linkage; self-declared receipt labels no longer establish authority.
- Reused the production relationship extractor for README selector validation. A trusted
  relationship request is decoded with the Task 2.2 contract, executed against the frozen
  candidate, and each README selector must identify an extracted relationship input. The resulting
  manifest identity is included in the deterministic selector-input-coverage check.
- Authority paths receive the same stable single-read, canonical external-containment and digest
  treatment as policy and validator artifacts. No production binding or CI activation was added;
  the fixtures remain the temporary external authority allowed for Task 3.4.

### Fix-round-2 failure proof

Each guard was faulted alone on the production `lint-ci` route, then restored with an adjacent
comment containing the observed failure.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| omit binding-selected verifier scope/journal reconciliation | receipts relabeled with `invocation.never-executed` and `journal.does-not-exist` certified; `Expected: 1, Received: 0` |
| omit trusted-authority digest comparison | deleting failed `check.failed` from the authority behavior rule certified the changed application; `Expected: 1, Received: 0` |
| omit extracted relationship-input membership | README `relationshipSelectors: ["selector.does-not-exist"]` certified; `Expected: 1, Received: 0` |

### Fix-round-2 verification

- Focused trusted-policy production CLI: 35 pass, 0 fail, 895 assertions in 60.10 seconds.
- Forced uncached tool-wiki TypeScript build: exit 0.
- Uncached tool-wiki ESLint: exit 0.
- Exact final-tree full tool-wiki suite: 267 pass, 0 fail, 3,254 assertions across 14 files in
  444.81 seconds.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`; optional
  PostHog telemetry could not resolve `edge.openspec.dev`, but validation exited 0.
- Whole-workspace `nx format:check --all` and `git diff --check`: exit 0.
- Exact-code-commit host gate: unavailable, not green. `bin/h2puni-gate.sh 21007d9f` exited 70
  with `heavy lock: /home/puni1/.cache does not exist`.

## Fix round 3

The final review round closes three integration edges without broadening Task 3.4:

- Review obligations are discharged only by an accepted `enforce` audit with no refusals or
  unmet obligations. An `observe` audit remains useful debt reporting but cannot certify CI.
- The audit selection source base must equal the immutable source base selected for lint. Existing
  audit validation continues to bind every review to that audit source base, candidate identity,
  generation, invocation, retained response, and verifier journal.
- The common trust loader now reads, externally contains, hashes, decodes, and evaluates the
  authority artifact for lint and for both sides of compatible activation. Predecessor identities
  retain authority identity, journal, and scope. Compatible activation cannot remove existing
  authority behavior rules, check/review requirements, or judgments, and any authority change is
  explicitly declared and deterministically reselects both policy and authority checks/reviews.

### Fix-round-3 failure proof

Each guard was faulted alone on its production CLI or activation path, then restored with an
adjacent comment containing the observed failure.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| omit enforce-mode/refusal/debt audit guard | an observe audit with `reviews: []` certified; `Expected: 1, Received: 0` |
| omit audit source-base reconciliation | an all-zero audit/review source base certified the real committed candidate; `Expected: 1, Received: 0` |
| skip successor authority loading | `authority.does-not-exist.json` activated as compatible with empty reselection; `Expected: 1, Received: 0` |
| skip authority monotonicity | removal of `check.application` reached only the weaker `authority change declaration does not match` refusal |
| omit authority check reselection | `check.authority.new` was absent from the exact production activation report array |
| omit authority review reselection | `review.authority.new` was absent from the exact production activation report array |

### Fix-round-3 verification

- Focused trusted-policy production CLI: 40 pass, 0 fail, 1,000 assertions in 67.24 seconds.
- Forced uncached tool-wiki TypeScript build: exit 0.
- Uncached tool-wiki ESLint: exit 0 after its first run exposed and autofix corrected an import
  ordering error.
- Exact final-tree full tool-wiki suite: 272 pass, 0 fail, 3,359 assertions across 14 files in
  453.16 seconds.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`.
- Whole-workspace `nx format:check --all` and `git diff --check`: exit 0.
- Exact-code-commit host gate: unavailable, not green. `bin/h2puni-gate.sh 8df0c8b7` exited 70
  with `heavy lock: /home/puni1/.cache does not exist`.

## Fix round 4

Compatible activation now retains every authority audit obligation as one exact, schema-decoded
record rather than retaining its ID alone. The comparison covers the risk stratum and the complete
review subject tuple: subject ID, kind, path, and content identity. A successor therefore cannot
narrow `review.application` from project `src` to file `src/app.ts`, even when it changes its review
evidence consistently enough for its own authority to certify downstream CI.

One shared policy/validator/authority-change predicate now drives all trust-requirement reselection.
When any of those three artifacts changes, the activation report includes every current policy
obligation plus the complete authority-derived check and review sets, with the existing canonical
deduplication and ordering.

### Fix-round-4 failure proof

Each guard was faulted alone on the production activation path, then restored with an adjacent
comment containing the observed failure.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| remove retained audit-obligation exact-record comparison | the successor changed `review.application` from project `src` to file `src/app.ts`; its production `lint-ci` still exited 0 with `accepted: true` and `certified: true`, while activation returned compatible and the test reported `Expected: 1, Received: 0` |
| gate authority check reselection on authority-byte changes alone | both the policy-only and validator-only activation reports omitted `check.authority.extra` from their exact check arrays |
| gate authority review reselection on authority-byte changes alone | both the policy-only and validator-only activation reports omitted `review.authority.extra` from their exact review arrays |

### Fix-round-4 verification

- Focused trusted-policy production CLI: 43 pass, 0 fail, 1,064 assertions in 73.44 seconds.
- Forced uncached `tool-wiki:typecheck`: exit 0; cache skipped and no target skipped.
- Uncached `tool-wiki:lint`: exit 0; cache skipped and no target skipped.
- Exact configured full tool-wiki suite: 275 pass, 0 fail, 3,423 assertions across 14 files in
  458.77 seconds. The first attempt had one fixed-25-second contract matrix time out at 25.005
  seconds; the exact case then passed alone at 24.754 seconds, and the complete exact command passed
  on its immediate rerun.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`.
- Whole-workspace `bunx nx format:check --all` and `git diff --check`: exit 0.
- Exact-code-commit host gate: unavailable, not green. `bin/h2puni-gate.sh <round-4 commit>`
  exited 70 immediately because required heavy-lock path `/home/puni1/.cache` does not exist; no
  host-gate step ran.

Task 3.4 remains complete. Task 3.5 and all later task checkboxes remain untouched.

## Astra fix round 5

Compatible activation now compares every referenced, strictly decoded audit risk stratum by
semantic enforcement strength. A successor's sample rate may stay level or rise, while its
disagreement trigger may stay level or fall. Reusing a stratum ID can no longer hide either weaker
setting. The strength map is exhaustive over the decoded `AuditStratum` settings, so a future schema
field requires an explicit compatibility direction before typecheck can pass.

The disagreement negative uses four obligations in one stratum and one disputed obligation. At the
predecessor's 2,500-basis-point trigger, the audit requires fresh review of all four obligations and
refuses the evidence. At a weakened 10,000-basis-point trigger, the same evidence requires only the
disputed obligation's fresh review and the successor certifies through production `lint-ci`.
Activation now refuses that transition. An independent production activation negative covers a
sample-rate reduction, and positive controls retain compatible strengthening in both directions.

### Fix-round-5 failure proof

Each absent strength rule was first observed through the production activation route and restored
with an adjacent `Proof:` comment.

| Deliberate one-at-a-time fault | Observed production-path failure |
| --- | --- |
| accept a higher disagreement trigger for the retained stratum | one dispute among four required one fresh review instead of four, production `lint-ci` certified the successor, and activation returned compatible; `Expected: 1, Received: 0` |
| accept a lower sample rate for the retained stratum | the successor changed `sampleRateBps` from 10,000 to 2,500 under the same `risk.fixture` ID and activation returned compatible; `Expected: 1, Received: 0` |

### Fix-round-5 verification

- Focused trusted-policy production CLI: 46 pass, 0 fail, 1,148 assertions in 79.84 seconds.
- Uncached tool-wiki lint and forced source/spec typecheck: exit 0; cache skipped and no target
  skipped.
- Exact configured full tool-wiki suite: 278 pass, 0 fail, 3,507 assertions across 14 files in
  464.07 seconds.
- Strict pinned OpenSpec 1.3.0 validation: `Change 'agent-scalable-llm-wiki' is valid`.
- Whole-workspace `bunx nx format:check --all` and `git diff --check`: exit 0.
- `bin/h2puni-gate.sh HEAD` — unavailable, exit 70 immediately because required heavy-lock path
  `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Task 3.4 remains complete. Task 3.5 and every later task remain untouched.
