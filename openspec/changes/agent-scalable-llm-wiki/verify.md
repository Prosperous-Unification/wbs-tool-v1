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

## Slice 1.3 final R5 cleanup

The production CLI refused a non-NUL `0xff` byte at offset 8,001, beyond the bounded NUL sample, as
undeclared binary content. Removing only `fatal: true` from the complete UTF-8 decode made the test
fail on `Expected: 1, Received: 0`; the CLI emitted `src/invalid-utf8.ts` as source. Restoring the
guard returned the focused case to one pass and eight assertions. The full classifier passed 14
tests and 196 assertions. Focused Nx lint, source/spec typecheck and test passed 45 tests and 496
assertions. Pinned strict OpenSpec validation and exact formatting/diff checks passed.

## Slice 1.4 — finite content manifests and artifact validation

`content-manifest` selects and classifies one explicit candidate, binds the exact classification
policy bytes, and emits canonical UTF-8 JSON over content tuples/classifications plus protocol,
relationship-input and extractor identities. Object keys use UTF-8 byte order with a deterministic
code-unit tie-breaker, identity arrays are sorted by their stated ids, semantic arrays retain order,
and one terminal newline is hashed with SHA-256. Evidence tuples, candidate commit and containing
tree are deliberately absent. The same canonical serializer now owns the diagnostic
working-snapshot identities from slice 1.2.

`validate-artifacts` strictly decodes a separately supplied version-1 graph, compares its paths,
Git blobs, SHA-256 byte identities and schema kinds with the complete classified evidence set,
re-reads and decodes every selected artifact, resolves every root/dependency, and refuses unreachable,
self-referential or cyclic obligations. Its iterative traversal has an explicit node-plus-edge bound;
the validation identity normalizes unordered root, artifact and dependency arrays. Missing,
unreadable, malformed and non-UTF-8 graph inputs throw at the JSON boundary without a default.

Initial focused RED:

```text
bun test --preload ../test/scratch/preload.ts src/evidence/content-manifest.test.ts src/evidence/artifacts.test.ts
```

Exit 1: zero passed, six failed, one module-load error, 50 assertions. The manifest test could not
load the absent module; the five artifact cases reached the old CLI usage boundary. First GREEN was
9 passed, zero failed and 105 assertions. A later canonical graph ordering RED received identities
`9b5194...` and `30b837...` for the same reordered graph before normalization.

Every fault below ran through the production CLI in a temporary real Git repository and was restored
before the next. The dependency wrappers changed Git `cat-file` behavior rather than replacing the
production reader.

| Deliberate fault                                 | Observed production-oracle failure                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| include evidence tuples in content digest        | evidence-only edit changed `797015...` to `fa835d...`; expected current identity                         |
| add each evidence artifact as its own dependency | CLI exited 1 on `evidence cannot require itself: ...second.v1.json`; no timeout                          |
| remove cycle diagnosis                           | CLI exited 1 at the explicit finite graph bound; expected named cyclic dependency, not a harness timeout |
| omit selected evidence from graph                | exact-set diagnostic was lost to a later missing-dependency error                                        |
| accept graph path absent from candidate evidence | CLI exited 0 with three reachable artifacts instead of refusing the extra path                           |
| remove root reachability refusal                 | CLI exited 0 with `artifactCount: 2`, `visitedCount: 0`                                                  |
| remove missing-edge boundary                     | diagnostic lost the referring artifact path and named only dependency `999...`                           |
| remove selected descriptor comparison            | forged blob `888...` exited 0 with two validated artifacts                                               |
| remove SHA-256 byte comparison                   | substituted artifact identity `777...` exited 0                                                          |
| remove second-read strict record decode          | changed bytes with `recordKind: unknown` exited 0 with two artifacts                                     |
| widen schema version                             | artifact graph version 99 exited 0 with two artifacts                                                    |
| default an absent or malformed graph to `{}`     | production oracle received missing schema fields instead of the required input-path refusal              |
| decode graph bytes non-fatally                   | byte `0xff` was replaced and misreported as generic malformed JSON                                       |
| duplicate root/ref guards removed                | duplicate root exited 0; duplicate dependency exited 0 with traversal bound 4                            |
| duplicate artifact/path guards removed           | failures moved past the malformed graph boundary to byte/unaccounted-evidence diagnostics                |
| remove policy id or byte binding                 | CLI emitted manifests claiming another policy id or blob `999...`                                        |
| remove relationship/extractor uniqueness         | differently hashed inputs shared `relationship.z` or `extractor.z` and exited 0                          |
| accept malformed reviewed identity               | `not-a-content-identity` exited 0 as ordinary stale currency                                             |

An injected unreadable evidence blob made the production boundary exit 1 with `cannot read selected
blob ... for docs/review-evidence/second.v1.json: injected unreadable artifact`. The graph-file matrix
also observed distinct absent, mode-000 unreadable, malformed JSON and invalid UTF-8 failures.

Focused verification after all implementation and tests used
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static`: exit 0, lint and both source/spec TypeScript projects passed, with 58 tests,
zero failures and 666 assertions. Nx used its in-process fallback after its sandbox socket denial;
no target was skipped. Pinned strict OpenSpec validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0; its optional PostHog flush could not reach
the network after the successful validation. Exact formatting and diff checks run after this final
documentation edit. Full repository/browser gates remain outside this isolated infrastructure slice.

## Slice 1.4 Fix Round 1

The previous case called extraneous graph membership set `roots` to empty and therefore exercised
only the unreachable-artifact guard. Its replacement keeps the valid `first -> second` rooted graph
and adds a third, separately rooted artifact whose path is absent from the selected candidate. All
three nodes are reachable. Replacing only the graph-to-candidate refusal with `continue` made the
production CLI exit 0 with `artifactCount: 3`, `visitedCount: 3` and `traversalBound: 4`; restoring it
returned the exact absent-candidate-evidence diagnostic. The original empty-root mutation had
demonstrated the independent reachability failure, but the replacement no longer retained that
regression; Fix Round 2 restores it separately.

The canonical serializer RED used two objects with reversed `\ud800`/`\ud801` insertion order.
Their distinct keys encode to the same UTF-8 replacement bytes, so byte comparison alone retained
input order: 13 tests passed, one failed and 171 assertions ran. A code-unit tie-breaker after equal
UTF-8 encodings made the focused pair GREEN at 14 tests, zero failures and 172 assertions, while
preserving the keys as finite JSON strings.

Record-embedded artifact-edge reconciliation remains deferred to task 3.1 and no task 2.1 behavior
was added. Focused Nx lint, source/spec typecheck and tests passed 59 tests with zero failures and 668
assertions before the final documentation checks.

## Slice 1.4 Fix Round 2

A separate production CLI regression now supplies the valid selected `first -> second` graph with
`roots: []`, independently of the unchanged extraneous-candidate case. The intact guard passed the
focused case with 10 assertions. Removing only the unreachable-artifact refusal made the CLI exit 0
with `artifactCount: 2`, `visitedCount: 0` and `traversalBound: 3`; the oracle failed at `Expected: 1,
Received: 0` with zero tests passed, one failed and nine assertions. Restoring the guard made all nine
artifact tests pass with 126 assertions.

There is no runtime source change in this round. Focused Nx lint, source/spec typecheck and tests
passed 60 tests with zero failures and 678 assertions before the final documentation checks. No task
2.1 behavior or checkbox changed.

## Slice 2.1 — TypeScript and Nx relationships

Relationship extraction materializes one frozen candidate from its exact Git blobs, then invokes the
installed TypeScript compiler/configuration API and actual installed Nx project-graph CLI. It emits
canonical identities for exact TypeScript import edges, provider reverse-edge sets, transitive emitted
public declarations, Nx project roots, dependency edges and complete target configurations. Every
selector names its extractor id, installed tool version and tool-package identity; the same identities
feed the six relationship inputs accepted by the content-manifest contract.

Initial focused RED:

```text
bun test --preload ../test/scratch/preload.ts src/relationships/relationships.test.ts
```

Exit 1: zero passed, five failed and 37 assertions. Every case reached the production CLI's old usage
boundary because `extract-relationships` and both relationship adapters were absent. First complete
GREEN was six passed, zero failed and 139 assertions. The final fixture resolves an extended nested
`config/tsconfig.json`, a re-exported type with a transitive declaration, Node built-in and installed-
package imports, and two Nx projects with one nested below `packages/apps/`.

Each fault below ran alone through the production CLI and was restored before the next. Adjacent
`Proof:` comments contain the observed failures.

| Deliberate fault                          | Observed production-oracle failure                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| hash only the unchanged public barrel     | initial and changed identities both remained `fc5f9f1d...`; expected stale declaration evidence        |
| omit the newly added importer             | provider topology remained `31bdf67d...`; expected a changed reverse-edge identity                     |
| ignore inline `type` on a named re-export | exact selector received `re-export` instead of `type-re-export`                                        |
| remove Node built-in classification       | CLI failed with unresolved `packages/provider/src/hidden.ts -> 'node:fs'`                              |
| remove absent TypeScript-config preflight | missing config was reported as unreadable rather than absent                                           |
| accept an unresolved relative import      | failure lost the exact source/specifier boundary and fell through to a generic compiler diagnostic     |
| accept TypeScript config read errors      | a directory supplied as config exited 0                                                                |
| accept compiler diagnostics               | the `MissingType` fixture emitted declarations and exited 0                                            |
| remove missing Nx-output check            | exit-zero/no-output was reported as unreadable ENOENT rather than missing                              |
| remove unreadable Nx-output context       | exact diagnostic became bare EACCES                                                                    |
| remove malformed Nx-JSON context          | exact diagnostic became bare `JSON Parse error: Expected '}'`                                          |
| ignore Nx exit 17                         | failed graph generation was misreported as missing output rather than unresolved                       |
| allow no TypeScript configs               | request advanced to public-entrypoint ownership instead of failing at the request boundary             |
| allow no public entrypoints               | production request exited 0                                                                            |
| allow duplicate TypeScript configs        | request advanced to a two-owner public-entrypoint failure instead of rejecting ambiguous configuration |
| allow duplicate public entrypoints        | production request exited 0                                                                            |

Changing the re-exported type behind an unchanged barrel changes both its public-declaration selector
and manifest relationship input; restoring the type restores both exact identities. Editing only an
internal caller's implementation leaves the provider reverse-edge identity current, while adding a
second importer changes it and publishes all three exact callers.

The uncached Nx aggregate ran source/spec typecheck and all 66 tool-wiki tests successfully: zero test
failures and 817 assertions in 95.96 seconds. Its first aggregate exit was nonzero only because ESLint
requested import sorting in the new test. After that mechanical fix, fresh standalone lint and
source/spec typecheck both exited 0, and the relationship suite passed six tests with zero failures and
139 assertions in 34.94 seconds. Pinned strict OpenSpec 1.3.0 validation returned
`Change 'agent-scalable-llm-wiki' is valid`; its optional PostHog flush could not reach the network
after successful validation. Exact changed-file formatting and diff checks run after this final edit.
Full repository and browser gates remain outside this isolated infrastructure slice. Tasks 2.2 and 2.3
were not started.

## Slice 2.1 Fix Round 1

The relationship adapters now normalize a compiler option equal to the materialized workspace root
as `.`; repeated extraction of one commit therefore has one configuration/public identity, and a
change followed by restoration returns to that identity. TypeScript `ImportTypeNode` dependencies
are extracted from source and emitted declaration syntax, become exact import/reverse edges and join
the transitive public closure. Local declaration sources are added to that closure from the compiler
program even though TypeScript does not emit them again.

Nx project selectors now omit absent `sourceRoot` and `projectType` properties instead of presenting
`undefined` to canonical hashing. A real minimal project containing only name, root and targets is
covered. Import declarations with a default value binding plus named type-only bindings are value
edges. Candidate symlinks retain their lexical check and additionally resolve through the completed
materialized tree; effective escape through an intermediate `pivot -> .` is refused before either
compiler/graph extractor runs, while a contained symlink remains supported.

All six regressions were first observed independently through `extract-relationships` on temporary
real Git repositories. Each corrected behavior was then undone alone, observed again and restored.

| Deliberate fault / pre-fix behavior        | Observed production-oracle failure                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| retain temporary absolute `rootDir`        | repeated commit identities differed: `cc163641...` versus `0ec9a7e...`                                |
| omit `ImportTypeNode` dependency           | hidden mutation stayed at `502b6f24...`; public stale assertion failed                                |
| omit local `.d.ts` declaration inputs      | shapes mutation stayed at `d2d5e2d6...`; public stale assertion failed                                |
| retain absent Nx optionals as `undefined`  | minimal real project exited 1 on `canonical JSON cannot serialize undefined`                          |
| decide type-only from named bindings alone | mixed default-value/named-type import received `type` instead of `value`                              |
| omit effective symlink resolution          | `escape -> pivot/../outside` exited 0 even though `pivot -> .` led outside the materialized candidate |

The final focused relationship suite passed 10 tests, zero failures and 217 assertions in 64.32
seconds. The uncached Nx target passed lint, source/spec typecheck and all 70 tool-wiki tests with zero
failures and 895 assertions in 125.43 seconds. Nx used its in-process plugin fallback after the
sandbox denied its socket, and no target was skipped. The
dedicated export/import/dynamic/import-equals AST branches were reviewed; the new ImportType branch
does not overlap or replace them. Pinned strict OpenSpec 1.3.0 validation, exact changed-file
formatting and `git diff --check` passed after the final evidence edit; the optional OpenSpec PostHog
flush could not resolve its host after successful validation. No checkbox changed, and tasks 2.2/2.3
remain untouched.

## Slice 2.1 Fix Round 2

Workspace-local declaration files now participate in the exact import and reverse-edge graph. The
fixture publishes `index.ts -> shapes.d.ts -> hidden.ts`; adding another `.d.ts` importer changes the
hidden provider's topology. Compiler default libraries and external-library source files remain
excluded as local provider nodes.

Declaration traversal also consumes TypeScript's triple-slash directive collections. Path references
resolve through the compiler and join the direct graph and public closure. `types` uses the compiler
type-reference resolver; `lib` must match exactly one compiler default-library source. Both publish
external identities rather than `node_modules` or TypeScript library paths. Missing path, types and
lib references fail at distinct boundaries rather than becoming invented external selectors.

The first focused production-CLI RED was zero passes, three failures and 40 assertions: four expected
`shapes.d.ts` selectors were absent, a new declaration importer left the provider at `cb10d2d3...`,
and changing referenced `GlobalHidden.code` left the public selector at `53ad5864...`. First behavior
GREEN was three passes and 64 assertions; the complete focused set passed four tests and 88 assertions.

| Deliberate fault                                    | Observed production-oracle failure                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| restore unconditional declaration-file exclusion    | hidden provider remained `cb10d2d3...` after `additional.d.ts` was added     |
| omit triple-slash path dependency inclusion         | public selector remained `53ad5864...` after the referenced global changed   |
| classify an unresolved path reference as external   | boundary was lost to the later compiler `File ... not found` diagnostic      |
| classify an unresolved types reference as external  | boundary was lost to `Cannot find type definition file for 'absent-package'` |
| invent an external target for an unresolved lib ref | boundary was lost to `Cannot find lib definition for 'absent-library'`       |

Each fault ran alone through the committed-candidate CLI and was restored. The final relationship
suite passed 13 tests, zero failures and 276 assertions in 78.96 seconds. The uncached Nx
lint/source-plus-spec-typecheck/test aggregate passed all 73 tool-wiki tests with zero failures and
954 assertions in 140.69 seconds. Nx used its in-process plugin fallback after the sandbox denied its
socket; no target was skipped. Tasks 2.2/2.3 and their checkboxes remain untouched. Full
repository/browser gates remain outside this isolated extractor correction. Pinned strict OpenSpec
1.3.0 validation returned `Change 'agent-scalable-llm-wiki' is valid`; only its optional telemetry
flush failed DNS after validation.

## Slice 2.1 Fix Round 3

Public closure traversal now pairs each emitted declaration with its original compiler-program
source and carries that source's compiler-resolved triple-slash path references alongside imports
found in emitted declaration text. This covers TypeScript 6 dropping a source path directive during
declaration emit. It does not carry original-source module imports: the fixture's value import used
only by the function body remains absent from the public closure. Default/external library references
also remain absent because only targets present in the local declaration map can enter the closure.

The exact committed-candidate fixture puts `/// <reference path='./globals.d.ts' />` on `index.ts`,
exports an interface using `GlobalHidden`, and removes every other path from the public surface to
that global. Initial RED was zero passes, one failure and eight assertions: the closure contained
`hidden.ts`, `index.ts`, `public.ts` and `shapes.d.ts`, but not `globals.d.ts`. First GREEN passed one
test and 22 assertions; after pinning the implementation-only exclusion, the focused case passed with
23 assertions.

Removing only the carried original-source references kept the public selector at `1fcc9f4f...` after
`GlobalHidden.code` changed from string to number. The production stale assertion failed with zero
passes, one failure and 12 assertions. Restoring the carry-forward returned change/restoration and
the exact closure checks to green; the adjacent `Proof:` records that observed identity.

The final relationship suite passed 14 tests, zero failures and 299 assertions in 86.37 seconds. The
uncached Nx lint/source-plus-spec-typecheck/test aggregate passed all 74 tool-wiki tests with zero
failures and 977 assertions in 148.89 seconds. Nx used its in-process plugin fallback after the
sandbox denied its socket; no target was skipped. Tasks 2.2/2.3 and all checkboxes remain untouched.
Full repository/browser gates remain outside this isolated extractor correction. Strict OpenSpec,
source/spec typecheck, focused lint and exact formatting checks passed. OpenSpec's optional telemetry
reported DNS failure after validation, without changing its successful exit.

## Slice 2.2 — Declared relationships and typed facts

Version-1 relationship declarations now select exact package scripts, GitHub Actions steps,
lefthook commands, Docker instructions, generated blobs, environment values and ports, Drizzle
tables, migration table operations, HTTP endpoint shapes, Nx targets and vendored lock blobs.
External-consumer facts and non-derivable edges remain explicitly declared provenance; source-backed
facts are explicitly extracted provenance. Coverage is `selected-facts-only`, so the report does not
claim that undeclared relationships were discovered or certified. Named unresolved edges and their
reasons are retained as a separate manifest input as well as in the edge set.

The selectors run through `extract-relationships` against the already-frozen candidate. Current
path authorities come from that materialized candidate; historical path authorities use `git show`
at the declaration's exact, preflighted commit. The existing Nx graph supplies current target
configuration. Historical Nx targets are refused with a named unsupported-selector diagnostic
instead of substituting current configuration. Declaration documents and authorities distinguish
absence, unreadability and malformed content, and unavailable Git history fails before path lookup.

Initial focused RED was zero passes, five failures: every production invocation rejected the new
`declarationPaths` field at the old strict request boundary. The first bounded selector GREEN passed
one test with 20 assertions. The complete final selector suite passed seven tests, zero failures and
231 assertions in 44.67 seconds. The unchanged Task 2.1 relationship suite separately passed 14
tests and 299 assertions in 91.09 seconds, proving that an omitted declaration set preserves its
extractor and manifest-input shape.

| Deliberate one-at-a-time fault                         | Observed production-CLI failure                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| bypass expected/actual fact comparison                 | forged selector exited 0; the oracle expected exit 1                         |
| bypass fact endpoint validation                        | forged fact edge exited 0; the oracle expected exit 1                        |
| bypass selected path endpoint validation               | forged path edge exited 0; the oracle expected exit 1                        |
| drop unresolved projection                             | expected named `dynamic-shell-read` and reason; received `[]`                |
| resolve historical facts from the current checkout     | `port.backend-historical` expected 3100 and received 3200                    |
| bypass historical commit preflight                     | unavailable history was misreported as authority absent at `ffff...`         |
| remove current-authority existence diagnosis           | missing authority was misreported as unreadable `ENOENT`                     |
| rethrow unreadable current authority raw               | expected fact/path diagnosis; received bare `EISDIR`                         |
| skip a malformed env line                              | expected malformed authority; received selector mismatch with `<unresolved>` |
| remove declaration existence diagnosis                 | missing declaration was misreported as unreadable `ENOENT`                   |
| rethrow unreadable declaration raw                     | expected declaration/path diagnosis; received bare `EISDIR`                  |
| rethrow malformed declaration JSON raw                 | lost the `relationship declaration malformed` boundary name                  |
| widen declaration selector version                     | selector version 99 exited 0; the oracle expected exit 1                     |
| bypass within-document fact/edge uniqueness            | each duplicate invocation exited 0; each oracle expected exit 1              |
| bypass duplicate request-path diagnosis                | failure moved to duplicate declaration ids instead of the request boundary   |
| bypass cross-document declaration/fact/edge uniqueness | each corresponding invocation exited 0; each oracle expected exit 1          |

Every fault above ran alone through a temporary real Git repository and the production CLI, was
observed failing its intended oracle, and was restored before the next fault. Adjacent `Proof:`
comments record those observed outputs. The fixtures use the repository's actual authority shapes:
package/Nx JSON, GitHub Actions and lefthook YAML, staged Docker instructions, env examples, exported
Drizzle and HTTP-shape calls, SQL migrations, generated bytes and lock bytes.

The first uncached project aggregate exposed one integration regression: the generic decoder sweep's
many cold CLI processes reached its old 15-second whole-loop timeout and returned a killed child's
`null` exit. Raising that behavioral loop's timeout to 25 seconds made its focused run pass in 17.17
seconds. The final uncached Nx lint/source-plus-spec-typecheck/test aggregate passed all 81 tool-wiki
tests with zero failures and 1208 assertions in 210.45 seconds (3m30s target duration). Nx used its
in-process plugin fallback after the sandbox denied its socket; no target was skipped. Full
repository and browser gates remain outside this isolated infrastructure slice. Task 2.3 indexes
were not started. Pinned OpenSpec 1.3.0 strict validation returned one valid change with zero issues;
only its optional PostHog flush failed DNS after successful validation.

## Slice 2.2 Fix Round 1

HTTP endpoint facts now evaluate bounded static object semantics in source order. Direct properties,
object-literal or unique top-level `const` spreads, static shorthand values and literal or static
`const` computed names participate in last-write-wins resolution. A spread, computed name or selected
method/path value that cannot be resolved statically fails as a named unsupported selector; an
earlier route is never certified in its place.

Migration facts now use a bounded SQL lexer instead of matching raw text. It separates comments,
strings, quoted identifiers, symbols and words; refuses unterminated lexical forms, unbalanced
parentheses and statement families outside its declared subset; and extracts CREATE/ALTER/DROP or
REFERENCES table identifiers only from executable statements. Every migration-table fact carries a
positive `occurrence`, so the four CREATE statements in the real
`20260806190000_add_teams_and_assignees` migration select `service_team`, `person`, `person_team` and
`assignment` independently. An absent occurrence remains unresolved and a wrong expected table is a
named mismatch. This lexer is deliberately bounded and does not claim general SQL parser coverage.

Current file authorities must be exact non-Gitlink candidate entries before bytes are read. Their
effective resolved target must independently be an exact non-Gitlink candidate entry. The
compiler-materialization `node_modules` symlink can therefore support TypeScript without becoming
an authority: selecting its host `typescript/package.json` fails at the source candidate boundary.
A selected symlink to a selected regular file remains supported; a selected symlink resolving to a
Gitlink fails at the resolved-target boundary. Missing paths remain named absent, while a directory
prefix such as `src` is now correctly named unselected rather than being opened to manufacture an
`EISDIR` result.

Initial production-CLI RED observations were: HTTP spread override expected exit 1 and received 0;
the host `node_modules/typescript/package.json` authority expected exit 1 and received 0;
`SELECT 'CREATE TABLE ghost'` expected exit 1 and received 0; and the new migration occurrence was
rejected by the strict schema as undeclared. Focused GREEN passed the HTTP case with 30 assertions,
the candidate-boundary case with 33 assertions, and both SQL/migration cases with 33 assertions.

| Deliberate one-at-a-time fault             | Observed production-CLI failure                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| skip a statically resolvable object spread | `/api/work-items` was certified after `/changed`; expected exit 1, received 0         |
| ignore a computed property name            | `/api/work-items` was certified after `/computed`; expected exit 1, received 0        |
| ignore a dynamic object spread             | the unsupported selector was certified; expected exit 1, received 0                   |
| bypass exact source candidate membership   | host authority lost its source-boundary name to the resolved-target diagnostic        |
| bypass exact resolved-target membership    | symlink-to-Gitlink lost its boundary name to `authority unreadable ... EISDIR`        |
| restore the raw-source CREATE regex        | `SELECT 'CREATE TABLE ghost'` certified `ghost`; expected exit 1, received 0          |
| accept an unknown trailing statement root  | `CREATE TABLE real; invalid SQL after;` certified `real`; expected exit 1, received 0 |
| always select the first CREATE occurrence  | `migration.teams.person` expected `person` and received `service_team`                |

Each fault ran alone through `extract-relationships` against a temporary real Git repository, was
observed, and was restored before the next. Adjacent `Proof:` comments record these outputs. The
final selector suite passed 11 tests, zero failures and 327 assertions in 63.20 seconds. The Task
2.1 relationship regression passed 14 tests, zero failures and 299 assertions in 91.56 seconds. The
uncached Nx lint/source-plus-spec-typecheck/test aggregate passed all 85 tool-wiki tests with zero
failures and 1304 assertions in 209.35 seconds (3m29s Nx duration). No task checkbox changed and
Task 2.3 remains untouched.

Pinned OpenSpec 1.3.0 strict validation returned `Change 'agent-scalable-llm-wiki' is valid` after
the fix; only its optional PostHog flush failed DNS. Exact changed-file Prettier checking and
`git diff --check` passed after the final evidence edit.

## Slice 2.2 Fix Round 2

Migration selection now requires every lexically complete statement to belong to the bounded
statement families and to parse with Bun's SQLite parser before any table fact is returned. This
closes both partial-certification forms: a valid CREATE followed by malformed SELECT syntax, and a
CREATE whose recognized prefix is followed by invalid grammar. SQLite errors caused only by absent
schema context (for example, preparing an ALTER for a table that is not present in the parser's
empty validation database) remain modeled so syntactically valid historical migrations can still
be selected. An embedded NUL is refused before parsing because SQLite otherwise stops at that byte.

Qualified table names explicitly support the SQLite `main` and `temp` schemas and select the table
component, including independently quoted schema and table identifiers. Any other schema is a named
unsupported selector. The existing exact positive occurrence continues to disambiguate every table
in a multi-table migration.

HTTP object spreads now resolve identifiers through a TypeScript Program and TypeChecker rather
than matching declaration text. A referenced object binding is accepted only when its symbol has a
single initialized `const` declaration and every other reference is that object's direct spread.
Property writes, assignment through an alias, call escape and other uses therefore fail named
unsupported instead of certifying the initializer's stale value. A static unmodified literal spread
continues to use executable last-write-wins object semantics.

Initial production-CLI RED observations were: a valid CREATE followed by `SELECT invalid SQL after`
expected exit 1 and received 0 after 29 assertions; `CREATE TABLE real unsupported SQL` expected exit
1 and received 0 after 39 assertions; `main.real` was reported as `main`; and a direct
`override.path = '/changed'` left the old initializer value certified, so its oracle expected exit 1
and received 0 after 19 assertions. SQLite's embedded-NUL truncation was also observed as exit 0
where the production oracle expected exit 1 after 49 assertions.

| Deliberate one-at-a-time fault                    | Observed production-CLI failure                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| bypass validation of every SQLite statement       | invalid trailing SELECT exited 0; the oracle expected exit 1               |
| bypass SQLite validation only for CREATE TABLE    | invalid CREATE tail exited 0; the oracle expected exit 1                   |
| return the qualifier from a qualified table name  | expected table `real`; received `main`                                     |
| permit a binding reference outside its own spread | direct mutation retained the old path; expected exit 1, received 0         |
| omit the migration NUL preflight                  | SQLite parsed the prefix and certified `real`; expected exit 1, received 0 |

Every fault ran alone through `extract-relationships` in a temporary real Git repository and was
restored before the next. Adjacent `Proof:` comments record the actual failures. The final
post-format selector suite passed 13 tests, zero failures and 427 assertions in 82.35 seconds. The
Task 2.1 relationship regression passed 14 tests, zero failures and 299 assertions in 91.77 seconds.
The uncached full tool-wiki suite passed 87 tests, zero failures and 1394 assertions in 246.14
seconds before the final arbitrary-schema negative was added; that added production-CLI case passed
its focused run with 30 assertions, and the complete selector suite above includes it.

The exact project lint and solution-style source/spec typecheck commands passed. The Nx wrapper
exited zero but emitted only its sandbox socket fallback notices, so it is not claimed as the static
gate evidence. Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid`; its optional PostHog flush alone failed DNS afterward.
Exact changed-file Prettier and `git diff --check` passed before this evidence append and are rerun
after it. No checkbox changed and Task 2.3 remains untouched.
