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
