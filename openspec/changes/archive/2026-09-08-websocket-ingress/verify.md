## Verification

R4 only, branch `refactor/planned-project`; R7 untouched. No commits or deployment in this slice.

- Initial controller regressions: **16 pass / 18 fail**. Null raised TypeError; malformed controls forwarded or resumed instead of refusing.
- Initial real-socket regression: **1 pass / 1 fail**, receiving only pong with the expected invalid_payload frame missing.
- First schema-only fix passed **40 controller/contracts tests**, but the real socket still failed: an embedded JSON command string became a command on the second parse and returned two pongs. Removing that second parse fixed the real boundary.
- Final review scope: `bun test ./apps/gw-01/src ./libs/contracts` with loopback permission — **337 pass / 0 fail**, 3,770 assertions across 32 files, 2.32s. Includes all gateway integration suites and contracts/solver tests.
- `bunx tsc --build --force apps/gw-01/tsconfig.json libs/contracts/tsconfig.json` — **exit 0**, no diagnostics. The gateway root references both source and spec projects, so this compiled its production code and tests.
- Scoped ESLint on the six changed TypeScript files (including new `ws-wire.ts`, covered by the gateway lint target’s whole `src` directory) — **exit 0**. Prettier applied after import sorting; strict OpenSpec validation (`OPENSPEC_TELEMETRY=0 bunx openspec validate websocket-ingress --strict --json`) — **exit 0**, valid with zero issues.
- Full workspace/browser gates deferred to parent integration.

Controller callers in tests now supply decoded values; their existing wire expectations were not rewritten. Real-socket tests cover null, numbers, strings, arrays, invalid JSON, embedded serialized commands, malformed controls, invalid resume maps, ping after every refusal, and valid forwarding/resume. The Bun adapter preserves raw frames before Elysia’s automatic parser; the route parse hook decodes complete JSON text exactly once. The controller does not reinterpret a decoded string as a frame. Binary frames are refused, preserving the old controller’s unsupported binary behavior.

## Failure-proof table

| Injected fault                                     | Production-path test                                                 | Observed failure                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bypass schema with unchecked cast                  | `refuses null before dispatch`; real-socket malformed-frame case     | TypeError on `msg.type`; real socket receives only pong, missing invalid_payload; 8 pass / 28 fail |
| Forward generic envelopes before validation        | Malformed subscribe/unsubscribe/resume carrying message; real socket | Expected refusal absent; real socket receives only pong; 29 pass / 7 fail                          |
| Remove non-array resume-map refinement             | Empty and nonempty resume arrays; real socket                        | resume_ack instead of invalid_payload; 33 pass / 3 fail                                            |
| Replace safe sequence constraint with plain number | Negative, fractional, infinite, unsafe points; real socket           | resume_ack instead of invalid_payload; 31 pass / 5 fail                                            |
| Parse decoded strings a second time                | Real-socket malformed-frame case, embedded ping JSON string          | Two pongs instead of invalid_payload followed by pong; 35 pass / 1 fail                            |

Each original mutation ran the controller and real-socket files together, failed with exit 1, and was restored before the next. Proof comments use these observed outputs. Restored complete scoped run passed afterward. Logs: `/tmp/refactoring-r4-*.log`; temporary mutation script `/tmp/refactoring-r4-mutations.py`.

## Review round 1: whitespace decoding

The reviewer found Elysia 1.4.28’s first-character parser leaving whitespace-prefixed JSON undecoded. The custom parse API runs after that automatic parser, so reparsing strings there would confuse raw text and decoded string values. The isolated public Bun adapter wrapper preserves raw frames in a private envelope before Elysia dispatch.

- Added space/tab/newline real-socket cases exercising ping, forwarding, resume and quoted-command refusal. Before the fix: **2 pass / 3 fail**, each prefix received `invalid_payload` instead of `pong` (`/tmp/refactoring-r4-whitespace-red.log`).
- Fixed focused run: **5 pass / 0 fail**, 74 assertions. Subsequent full scoped run above includes an additional binary-frame refusal assertion group.
- Deliberately parse the decoded string a second time: **1 pass / 4 fail**, two pongs instead of `invalid_payload` followed by pong in the original malformed case and all three whitespace cases (`/tmp/refactoring-r4-wire-reparse-fault.log`).
- Deliberately omit the Bun wire envelope: **0 pass / 1 fail**, space-prefixed production socket case reports `WebSocket wire envelope missing` through the Elysia parser/adapter/dispatcher in 40.86ms, without a timeout (`/tmp/refactoring-r4-envelope-fault.log`). Both mutations restored before the final scoped checks.
- An intermediate `bun test apps/gw-01/src libs/contracts` (without `./`) also discovered generated `dist/out-tsc` test copies after typecheck: **379 pass / 26 fail**, 26 unresolved-alias errors in those emitted copies. Explicit directory paths in the final command exclude generated output; no source failure was hidden or artifact deleted.
- Fresh source+spec build and scoped six-file ESLint both exited **0** after the wire fix. Full workspace/browser gates remain deferred to parent integration.

## Archive reconciliation, 2026-09-08

Current `main` at `5516d453` retains the validated controller boundary and raw
Bun wire envelope. The current gateway/contracts selection passed **504/504 tests
with 4,516 assertions across 56 files**, including the six real-socket ingress
cases. Fresh `gw-01:typecheck`, `gw-01:lint`, `contracts:typecheck` and
`contracts:lint`, all with `--skip-nx-cache`, passed.

No `realtime` main spec existed before this sync. This delta introduces two
requirements and six scenarios. `scoped-presence` remains active and will append
its three requirements; the complete expected union is recorded in
`docs/refactoring/r1-r9-spec-inventory.md`.
