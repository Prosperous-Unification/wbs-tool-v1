# Verification

## Slice 1.1 — baseline and contracts

Baseline `7851161bf96312750d07b933ca5d42b75ce575c7` / tree
`b661e693e9c6656986fd431f4654df6db8dc3afc` contains 2,805 tracked entries. A Bun comparison
of every stored path/mode/blob tuple against `git ls-tree -r -z` reported
`exact tuple match: 2805 entries; referenced schema hashes match`.

The initial focused RED was `bun test src/contracts/contracts.test.ts` in
`tools/tool-wiki`: 0 pass, 9 fail after the wished-for API existed as an explicit
not-implemented boundary. The first full GREEN was 9 pass, 0 fail, 66 assertions; the
final suite extends that production-boundary matrix.

Every decoder fault below was injected separately, run through the real
`bun run src/cli.ts validate ...` subprocess used by the test, observed accepting the malformed
record, and restored. Each failed with `Expected: 1, Received: 0` after printing the shown line.

| Fault                                            | Observed malformed acceptance                         |
| ------------------------------------------------ | ----------------------------------------------------- |
| committed selection tree made optional           | `valid candidate-inventory`                           |
| schema version widened                           | `valid candidate-entry`                               |
| relative membership grammar widened              | `valid granularity-policy`                            |
| integration mapping made optional                | `valid granularity-policy`                            |
| duplicate mapping-group guard removed            | `valid granularity-policy`                            |
| duplicate module guard removed                   | `valid module-mapping`                                |
| duplicate corpus/manifest outcome guards removed | `valid benchmark-corpus`; `valid experiment-manifest` |
| acceptance nonempty guard removed                | `valid benchmark-corpus`                              |
| three-seed minimum removed                       | `valid experiment-manifest`                           |
| raw usage or price identity made optional        | `valid invocation-receipt`                            |
| elapsed receipt duration made optional           | `valid elapsed-receipt`                               |
| receipt undeclared-key rejection removed         | `valid invocation-receipt` with `receiptBlob`         |
| exact-entry unique/sorted guards removed         | `valid candidate-inventory`                           |

`NX_DAEMON=false bunx nx typecheck tool-wiki --skip-nx-cache` rejected a deliberate source
error at `records.ts(4,7)` and a separate deliberate test error at
`contracts.test.ts(7,7)`, both TS2322 (`string` not assignable to `number`).
`NX_DAEMON=false bunx nx lint tool-wiki --skip-nx-cache` rejected an unused source binding;
direct ESLint output named `@typescript-eslint/no-unused-vars`. All faults were restored.

Nx could not create its sandbox socket and explicitly ran plugins in-process. This warning did
not skip targets. No full repository or browser gate was run for this isolated contract slice.

## Slice 1.1 fix round 1

The fixed corpus replaces `outcome.event-log-conformance`, whose event-log behavior already
existed at the baseline, with `outcome.source-certification-execution` from approved
`source-conformance-completion` task 7.2. Its acceptance runs the SQLite and memory source
certification targets separately. A Bun check parsed each source's `project.json` directly from
baseline `7851161b`; both lacked `test:conformance`, proving the outcome unmet at that revision.

New production CLI tests were RED before implementation: all four noncanonical path records,
all four invalid-instant/interval records, all four empty/blank outcome records, and a completed
invocation with `rawUsage: []` printed `valid ...` and returned exit 0. The fixed-corpus test was
also RED because the replacement outcome was absent. Individual restored fault injections then
observed these precise failures:

| Removed check                       | Production oracle observation                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| canonical path narrow               | `[0, 0, 0, 0]`; three `valid candidate-entry`, one `valid granularity-policy` |
| real-instant narrow                 | invalid February instant returned 0 at position 1                             |
| invocation interval order           | reversed invocation returned 0 at position 2                                  |
| elapsed exact wall-clock difference | `elapsedMs: 59999` returned 0 at position 3                                   |
| check exact wall-clock difference   | `elapsedMs: 60001` returned 0 at position 4                                   |
| whitespace acceptance refusal       | corpus and manifest blank criteria returned 0 at positions 3/4                |
| benchmark nonempty outcome guard    | empty benchmark corpus returned 0 at position 1                               |
| manifest nonempty outcome guard     | empty manifest corpus returned 0 at position 2                                |
| completed raw-usage guard           | `valid invocation-receipt`; expected 1, received 0                            |

Receipt elapsed time now means exactly `Date.parse(endedAt) - Date.parse(startedAt)` in UTC
milliseconds, with real canonical UTC instants required. Invocation intervals require nondecreasing
end time. Completed invocation receipts require at least one raw usage entry; failed/censored
statuses remain distinct, and aggregation remains task 7.1.

## Slice 1.2 — candidate inventory reader

`read-candidate` now requires an explicit committed, staged or working selection and a repository
path. Committed mode resolves an immutable commit/tree before `git ls-tree -r -z`. Staged mode
freezes the index with `git write-tree`, inventories that tree and refuses if a second tree differs.
Working mode is explicitly diagnostic: two temporary-index snapshots freeze tracked working bytes,
untracked paths remain a separate sorted set, and either index or working-tree movement refuses the
selection. Exact path/mode/blob tuples retain executable modes and symlink blobs without following
links.

Initial RED on
`NX_DAEMON=false bunx nx test tool-wiki --skip-nx-cache --output-style=static` was exit 1: the
existing 16 tests passed, the seven new CLI cases failed against the old `validate`-only usage, and
`inventory/read-candidate.test.ts` could not load the absent module. First GREEN was 23 pass, zero
fail, 202 assertions. After extending both race modes and malformed Git-output coverage, the final
focused Nx run is recorded in the task report.

All mutations below ran through `src/cli.test.ts`, which spawns the production CLI against temporary
real Git repositories. Each fault was restored before the next.

| Deliberate fault                                         | Observed production-oracle failure                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| omit the staged addition                                 | complete tuple/selection mismatch; `added.txt` absent                     |
| drop another selected path                               | complete tuple/selection mismatch; `link` absent                          |
| substitute `deleted.txt` for `link` at equal count       | one-path complete tuple mismatch                                          |
| inventory the base tree instead of the staged index tree | addition/deletion, both rename sides and executable mode all mismatched   |
| remove staged index recheck                              | race CLI exited 0; expected 1                                             |
| remove working index recheck                             | working race CLI exited 0 with stale tracked snapshot; expected 1         |
| remove double working-tree snapshot comparison           | tracked-byte race CLI exited 0; expected 1                                |
| remove required-index preflight                          | absent index became Git's empty tree with `entries: []`; expected refusal |
| classify EACCES as malformed                             | exact unreadable diagnostic was absent                                    |
| substitute Git's empty tree on malformed index           | CLI exited 0 with `entries: []`; expected 1                               |
| replace ls-tree failure/parsing with `return []`         | failed ls-tree CLI exited 0 with `entries: []`; expected 1                |

The malformed-output fixture also broke the Git dependency with an exit 17, missing NUL terminator,
missing path separator, invalid header and mode/type conflict; every case exited 1 at its named
boundary. No tuple-count minimum or zero-entry error fallback is used: a legitimately empty selected
tree is distinct from failed required state.

Final focused verification was
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static`:
exit 0, lint plus source/spec typecheck passed, and 25 tests passed with zero failures and 238
assertions. `openspec validate agent-scalable-llm-wiki --strict` was unavailable (`openspec: command
not found`) and is not represented as passing.

## Slice 1.2 fix round 1

The reader now binds index selection to captured bytes and recaptures the required live index after
the read, preserves leading BOM path code points, normalizes interior repository arguments to the
worktree root, rejects empty untracked records, hashes working manifests with recursively
key-sorted canonical JSON, and checks untracked membership independently of tracked bytes.

Production CLI REDs observed before each behavior fix were: missing index after preflight selected
Git's empty tree and exited 0; BOM/plain paths collapsed; an interior working request omitted root
state; a single NUL became `untracked: [""]`; and removing only the untracked comparison omitted a
path created between passes while exiting 0. The canonical mutation was later found to pass against
the committed pre-sorted reconstruction; Fix Round 2 corrects that proof and its production input.

Final focused verification:

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

Exit 0: lint passed, source and spec typecheck passed, and 30 tests passed with zero failures and 284
assertions. Nx could not create its sandbox socket and explicitly ran plugins in-process; no target
was skipped. `openspec validate agent-scalable-llm-wiki --strict` returned exit 127 because the
OpenSpec executable is unavailable. The full repository/browser gates were not run for this
isolated reader fix.

## Slice 1.2 fix round 2

A production CLI request for a repository named `space ` was RED because the root decoder trimmed
the space and selected a distinct neighboring `space` repository: revision, tree, path and blob all
mismatched. The decoder now removes one exact Git LF terminator. Reinjecting `trim()` reproduced the
neighbor selection. Other text callers were reviewed: path callers now preserve bytes, object IDs
retain strict regex validation, and empty successful command output remains empty.

The canonical negative was first replayed at `1cc3a6c5` and passed (1 pass, 0 fail, 9 assertions),
confirming it was outside the fault window: `hashEntries` reconstructed keys in canonical order.
Hashing now receives the actual parsed `{path,mode,blob}` record with its precise type. Injecting
ordinary JSON then failed through the CLI with tracked hash `4db8d6...` instead of pinned canonical
`da04baf...`; restoring canonical serialization made the focused pair pass (2 pass, zero fail, 25
assertions). The complete CLI file passed 14 tests, zero failed, with 179 assertions.

Final focused gate after all source/test edits:

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

Exit 0: lint passed, source and spec TypeScript projects compiled, and 31 tests passed with zero
failures and 300 assertions. Nx ran plugins in-process after its sandbox socket denial; no target was
skipped. `openspec validate agent-scalable-llm-wiki --strict` returned exit 127 because the
executable is unavailable. Full repository/browser gates remain skipped for this isolated reader
fix.

## Slice 1.3 — entry classification and evidence routing

`classify-candidate` reads an explicit committed/staged/working selection through the existing
candidate reader, retains every selected path/mode/blob tuple, and partitions it with a strict v1
policy. Ordinary UTF-8 content uses exact path/prefix/segment/name/suffix selectors. Declared binary
content retains its format, consumer and regeneration authority; symlink blobs are decoded without
following them; Gitlinks require an exact pinned object and declared external boundary. The only
evidence roots are `docs/review-evidence` and `docs/experiment-evidence`, where mode 100644 JSON must
match exactly one root allowlist schema. `opaque-transcript` provides the positive schema envelope
for prose while leaving invocation trust verification to slice 3.1. Content-manifest behavior from
slice 1.4 is not implemented here.

The initial focused RED was `bun test src/inventory/classification.test.ts`: exit 1, zero pass, two
fail and 24 assertions. The positive exact-tuple oracle received the old CLI usage error and the
negative matrix reached that same missing `classify-candidate` boundary. After implementation, two
fixture faults were corrected before GREEN: `git hash-object <symlink path>` had followed the target
instead of naming the committed symlink blob, and a later `git add --all` had removed the synthetic
Gitlink. The corrected first GREEN was two pass, zero fail and 83 assertions. A separate missing-class
policy RED exited 0 with a document-only candidate; the exact supported-class guard made it GREEN.

Each fault below ran separately through the production CLI subprocess and was restored before the
next. Adjacent `Proof:` comments record only these observed results.

| Deliberate fault                                   | Observed production-oracle failure                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| remove evidence JSON-path guard                    | hidden `.ts` source exited 0 as `opaque-transcript` evidence                              |
| remove reserved-evidence mode guard                | mode 100755 evidence exited 0 as `opaque-transcript` evidence                             |
| remove exact-one evidence schema guard             | unknown schema exited 0 with no `recordKind` in the emitted classification                |
| implicitly wrap JSON parse failures as transcripts | unenveloped prose exited 0 as `opaque-transcript` evidence                                |
| substitute an implicit undeclared Gitlink boundary | `external/tool` exited 0 as `injected.undeclared`                                         |
| remove supported-class-set comparisons             | policy omitting both source class and rule exited 0 and classified its remaining document |

The versioned fixture policy was then exercised against the complete real committed candidate at
`8d726149da9d538e2442489ed3c85acc2e10fba9`; the CLI exited 0 after explicit selectors covered the
tree. No fallback class or count-only acceptance is present. Its new SHA-256 identity
`8eebdfdf6195086735524fc601aba152e1bced5bbdf7c237c6d45485548d1d15` is synchronized into the
baseline inventory evidence.

Focused verification:

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

Exit 0: lint passed, both source/spec TypeScript projects compiled, and 34 tests passed with zero
failures and 395 assertions. Nx ran plugins in-process after its sandbox socket denial; no target was
skipped. `bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict` returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0. Full repository and browser gates were not
run for this isolated classification slice.

## Slice 1.3 fix round 1

Six production-CLI regressions were RED at `caf85a89`: declared minimal WASM was rejected as
ordinary UTF-8; a reserved symlink and a declared reserved Gitlink each exited 0 as content; the
symlink decoder removed a leading BOM from both target fields; the shipped policy classified
`apps/fe-01/src/app.test.tsx` as source; and undeclared minimal WASM at a `.ts` path exited 0 as
source. The focused run was 6 pass, 6 fail and 160 assertions. After the corrections and independent
refusal cases, `classification.test.ts` passed 13 tests and 188 assertions.

The first complete-tree rerun found two literal NULs after the first 149 KiB of
`apps/fe-01/e2e/gantt.spec.ts`, an otherwise valid 243 KiB TypeScript file. Scanning every byte for
NUL therefore refused real source. The final detector uses Git's bounded first-8,000-byte NUL sniff
and rejects invalid UTF-8 across the complete blob. A dedicated CLI regression was RED when the
whole blob was scanned and GREEN with the bounded sniff; minimal WASM remains binary.

Each mutation below ran separately through the production CLI and was restored before the next.
Adjacent `Proof:` comments contain these observed results.

| Deliberate fault                             | Observed production-oracle failure                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| route symlink before reserved-root lookup    | reserved mode 120000 exited 0 as symlink content                                     |
| route Gitlink before reserved-root lookup    | reserved mode 160000 exited 0 as declared Gitlink content                            |
| remove bounded NUL detection                 | declared WASM was rejected as text; undeclared WASM exited 0 as source               |
| scan the entire valid UTF-8 blob for NUL     | late-NUL TypeScript exited 1 as undeclared binary                                    |
| omit symlink `ignoreBOM: true`               | exact `\uFEFFREADME.md` target and resolved target were both received as `README.md` |
| remove shipped TSX test selectors/exclusions | `apps/fe-01/src/app.test.tsx` was received as source                                 |
| remove zero-match refusal                    | contextual failure became `undefined ... matches[0].contentClass`                    |
| remove multiple-match refusal                | a path matching test and source exited 0 as test                                     |
| remove pinned Gitlink-object comparison      | selected object differing from its declaration exited 0 as Gitlink content           |
| remove symlink repository-escape refusal     | `../../outside` exited 0 with resolved target `../outside`                           |
| remove undeclared-binary refusal             | NUL-bearing minimal WASM at `src/undeclared.ts` exited 0 as source                   |

The shipped policy SHA-256 is now
`5e19ae9d54e9f907a9e7cefaa8de69c0f64437b2b1c968661c6fff932a5495f8`, synchronized into the
baseline inventory. Complete committed classification of `caf85a89` exited 0 for 2,832 tuples;
all 52 real `.test.tsx`/`.spec.tsx` paths classified as test, with zero wrong classes.

Focused verification after all source and test edits:

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

Exit 0: lint passed, source/spec TypeScript projects compiled, and 44 tests passed with zero failures
and 488 assertions. Nx ran plugins in-process after its sandbox socket denial; no target was skipped.
`bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict` returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0.
The exact changed-file format check and `git diff --check` both returned exit 0.
