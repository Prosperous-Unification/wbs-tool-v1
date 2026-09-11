# Task 8 Report — OpenSpec 3.1

## Outcome

Implemented the structured review process harness, cold/informed protocol, durable invocation
journal ports and production provenance validation CLI. The implementation preserves exact
canonical stdin and raw stdout identities; actual executor, tool, usage, price, charge and elapsed
receipts; raw-response identity/retention; and separately frozen cold judgments. Missing telemetry
and non-completed invocation receipts are explicit unverified states without synthetic zeroes.

The protocol types classify provenance scope but do not select trust policy. A caller can require
external provenance, in which case a local cooperative journal is rejected. `trusted-harness` and
`external-verifier` remain configured claims whose provisioning is outside this slice.

## Files

- `tools/tool-wiki/src/review/protocol.ts` and `protocol.test.ts`
- `tools/tool-wiki/src/review/invoker.ts`, `invocation-provenance.test.ts` and `index.ts`
- `tools/tool-wiki/src/cli.ts`
- `tools/tool-wiki/src/contracts/records.ts` (exports existing shared validators only)
- OpenSpec `tasks.md` and `verify.md`

## TDD and R5

Initial RED: focused Bun test command reported zero passes and two missing-module failures. Final
focused run: 16 pass, 0 fail, 71 assertions. All new provenance checks were bypassed or their
dependency deliberately broken one at a time through the production invoker/journal/CLI paths.
The exact observations are in `verify.md` and adjacent `Proof:` comments. A vacuous first version
of the output-invocation negative was corrected before acceptance.

## Verification

- `bun test --preload ../test/scratch/preload.ts src/review/protocol.test.ts src/review/invocation-provenance.test.ts` — 16 pass, 0 fail, 71 assertions.
- `NX_DAEMON=false bunx nx lint tool-wiki --skip-nx-cache --output-style=static` — exit 0.
- `NX_DAEMON=false bunx nx typecheck tool-wiki --skip-nx-cache --output-style=static` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static` — exit 0; 161 pass, 0 fail, 1,999 assertions; 5m43s.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict` — exit 0; change is valid.

## Assumptions and Limits

- Tool identity arrays preserve operator order and duplicates; no sorting or deduplication is
  inferred.
- Existing receipt contracts define token, micro-currency and millisecond units and are reused
  unchanged.
- `local-cooperative` receipts remain cooperative evidence, not externally trusted evidence.
- Trusted harness/CI receipt provisioning and trust-policy selection belong to later OpenSpec
  slices and were not implemented.
- No task 3.2 code or checkbox was changed.

## Fix Round 1

This round replaces the earlier single-process/self-hash shape with two independently launched
process phases. A complete cold attempt is fsynced and read back before informed context is
released; cold cannot see the informed identities. Separate cold/informed receipts retain actual
token categories, micro-currency charge, millisecond elapsed receipts and exact tool order including
duplicates.

The invocation journal serializes cross-process read-modify-write transitions with an owner-token
lock. Existing locks fail closed without age-based stealing. Exact registration/phase stdin, raw
stdout and raw stderr bytes and identities are retained. Nonzero, malformed, launch, protocol and
telemetry failures become terminal unverified records, while known partial telemetry remains
present with named missing requirements.

One canonical reconciliation derives review evidence from the registered request and exact decoded
phase stdout at completion, journal reading and later validation. Local journal labels cannot be
upgraded: `local-cooperative` is the only accepted scope, it never satisfies an external
requirement, and independently authenticated binding remains outside 3.1. This supersedes the
earlier report sentence describing `trusted-harness` and `external-verifier` as accepted configured
claims.

Focused lint and source-plus-spec typecheck exited 0. The final focused suite passed 21 tests with
zero failures and 92 assertions. After source formatting, the final uncached exact-source tool-wiki
aggregate exited 0 with 166 tests, zero failures and 2,020 assertions in 374.29 seconds (6m14s Nx
duration); Nx used its documented in-process fallback after sandbox socket denial, and no target
was skipped. Repository-wide format checking and pinned strict OpenSpec validation exited 0. The
complete mutation table and command evidence are in `verify.md`.

Assumptions retained from the contracts: usage quantities keep their provider units, charges are
micro-units of the `PriceIdentity.currency`, elapsed durations are milliseconds, and tool arrays
are observation sequences rather than sets. Trusted external receipt provisioning and trust-policy
selection remain later work. No 3.2 implementation or checkbox was changed.

## Fix Round 2

The process boundary now distinguishes numeric exit, signal termination, unresolved returned exit
state and launch failure. Bun 1.4.2 returns `exitCode: null` with `signalCode: "SIGTERM"` for a
signaled synchronous child despite its declaration typing `exitCode` as a number. A returned signal
is retained with its exact spelling and exact stdout/stderr bytes and hashes. Only a throw from
`Bun.spawnSync` is a launch failure, so post-return interpretation cannot erase process output.

Cold and informed production-harness SIGTERM cases become terminal unverified attempts; cold never
releases informed context, while informed retains the prior durable cold acknowledgement. Returned
`exitCode: null` with an absent or empty signal also becomes an explicit unresolved terminal with
its streams intact. The adapter configures no abort signal, timeout or maximum-output termination.
Nearby Bun probes showed the same null/code representation and exact stream retention for SIGINT
and SIGKILL.

The initial focused RED reproduced the review defect in both phases: the terminal reason was
`launch failed: Validation failed: exit.exitCode must be a number (was null)` instead of naming
SIGTERM. After GREEN and formatting, the focused protocol/provenance suite passed 25 tests with
zero failures and 123 assertions. The exact-source uncached tool-wiki lint/typecheck/test aggregate
passed 170 tests with zero failures and 2,051 assertions in 377.38 seconds (6m17s Nx duration); Nx
used its documented in-process fallback after sandbox socket denial and skipped no target.
Repository-wide `bunx nx format:check --all` and pinned OpenSpec 1.3.0 strict validation both
exited 0; OpenSpec reported `Change 'agent-scalable-llm-wiki' is valid`.

All signal/unresolved safety mutations ran one at a time and were restored. Routing a returned
signal through launch-failure recovery erased the exact stdout base64; classifying it unresolved
failed the exact signaled union; bypassing the signal refusal replaced the SIGTERM reason with a
null-telemetry error; and treating the no-exit/no-signal state as numeric exit escaped with
`exit.exitCode must be a number (was null)` instead of persisting the streams. No 3.2 code or task
checkbox changed.

## Fix Round 3

`FileInvocationJournal.register` now decodes and reconciles the canonical embedded review request
before acquiring the journal lock. Previously its outer registration shape and byte hash could be
valid while the embedded request was malformed, schema-invalid, noncanonical or bound to different
invocation/receipt identities. The invalid entry was durably renamed over the valid journal before
readback discovered the semantic failure.

The exported file-journal test starts from a valid preseeded record and byte snapshot. Each invalid
class uses a unique outer identity and a recomputed byte hash; after every rejection, the test
requires byte-for-byte unchanged storage, a readable seed record and no lock residue. A later valid
registration must still succeed. The adjacent transition audit found `acknowledgeCold` reconciles
the candidate acknowledgement before persistence and `complete` reconciles the candidate terminal
before persistence. Their idempotent branches compare against already reconciled stored state and
do not write; create has no embedded entry, while open/read do not write.

The initial RED and the later one-at-a-time preflight bypass both durably appended the unique
`invocation.malformed-json` entry. The unchanged-byte assertion reported
`Expected - 0 / Received + 306`; outer validation and duplicate detection had not intercepted it.
The restored focused protocol/provenance suite passed 26 tests with zero failures and 144
assertions. The formatted exact-source uncached tool-wiki lint/typecheck/test aggregate passed 171
tests with zero failures and 2,072 assertions in 391.34 seconds (6m31s Nx duration); Nx used its
documented in-process fallback after sandbox socket denial and skipped no target. No 3.2 code or
task checkbox changed. Repository-wide `bunx nx format:check --all`, pinned OpenSpec 1.3.0 strict
validation and `git diff --check` exited 0; OpenSpec reported
`Change 'agent-scalable-llm-wiki' is valid`.
