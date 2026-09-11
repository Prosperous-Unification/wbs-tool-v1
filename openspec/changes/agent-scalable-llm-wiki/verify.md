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

## Slice 2.2 Fix Round 3

SQLite validation no longer treats a missing-table semantic error as proof that an ALTER statement's
remaining grammar is valid. Each statement now executes in an isolated in-memory migration sequence,
so tables created earlier in the selected authority provide real schema context. When an ALTER target
belongs to an earlier migration and is consequently absent, the validator creates only that bounded,
safely quoted table and any old column required by a rename/drop form, then executes the exact ALTER.
Any error from that retry is named unsupported before facts are returned. Missing-schema errors from
other statement families are no longer silently admitted. Both an ALTER against a table created in
the authority and one against a table modeled as created by an earlier migration remain supported.

HTTP reference analysis now maps a shorthand property name through TypeScript's
`getShorthandAssignmentValueSymbol` before comparing symbol identity. `{ override }` therefore
exposes the value binding's escape just like `{ saved: override }`, `[override]`, a call argument or a
returned value. These containers, direct writes and aliases are conservatively refused; an object
binding used only by its direct spread remains statically extractable.

The initial focused production-CLI run passed the valid ALTER control but failed both regressions:
the nested shorthand escape expected exit 1 and received 0, and
`CREATE TABLE real(id text); ALTER TABLE missing ADD COLUMN c TEXT NOT NULL GARBAGE;` expected exit 1
and received 0. After GREEN, each prior fault was restored alone:

| Deliberate one-at-a-time fault                     | Observed production-CLI failure                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| use the shorthand property symbol instead of value | nested mutation expected exit 1 and received 0 after 49 assertions     |
| return immediately on ALTER `no such table`        | invalid trailing grammar exited 0; expected exit 1 after 59 assertions |

Each fault was restored and its actual output recorded in an adjacent `Proof:` comment. The focused
restored HTTP/SQL/valid-ALTER/multi-table set passed four tests and 163 assertions in 32.54 seconds.
The post-format selector suite passed 14 tests, zero failures and 487 assertions in 94.06 seconds;
after adding the explicit valid prior-schema ALTER control, its focused run passed with 20 assertions
and the final complete selector suite passed 14 tests, zero failures and 497 assertions in 96.22
seconds. The unchanged Task 2.1 relationship suite passed 14 tests, zero failures and 299 assertions
in 91.22 seconds. The uncached full tool-wiki suite passed 88 tests, zero failures and 1464 assertions
in 260.26 seconds before that final positive-control case was added; no production source changed
afterward.

Direct project ESLint and the solution-style source/spec TypeScript build passed. Pinned OpenSpec
1.3.0 strict validation returned `Change 'agent-scalable-llm-wiki' is valid`; only its optional
PostHog flush failed DNS afterward. Exact changed-file formatting and `git diff --check` passed. No
checkbox changed, Task 2.3 remains untouched, and full repository/browser gates remain with the
parent integration pass.

## Slice 2.3 — Recursive index reading and checking

Version-1 `wbs-index` metadata is decoded once from one ordinary Markdown comment per indexed
`README.md`. It carries a stable module id, exact or directory-prefix membership with bounded
exclusions, relationship selector identities, explicit inapplicability reasons, and external
consumer knowledge limits. The checker expands declarations against immutable candidate tuples and
assigns each selected path to exactly one nearest index. A nested index README remains its parent's
member while the nested index owns its descendants. Concrete members, index identities and the
whole topology identity use Git byte ordering and canonical JSON hashing.

Markdown navigation is parsed as Markdown rather than source text. Candidate-relative links resolve
case-sensitively inside the selected tree, directory links resolve their selected `README.md`, and
heading or explicit HTML anchors must exist. External schemes remain external. Globs, repository
escapes, ambiguous path case and selected-symlink escapes are refused without consulting host
filesystem bytes. Frozen archive proposal members require a link to their proposal entrypoint.
More than forty metadata entries emit review debt while the checker remains read-only.

The initial focused RED was
`bun test src/indexes/indexes.test.ts --preload ../test/scratch/preload.ts`: zero pass, eleven fail
and 88 assertions. Both success cases received the old CLI usage failure; every required negative
failed to reach its named assertion. First GREEN was eleven pass, zero fail and 96 assertions. The
post-format suite, extended with candidate confinement, symlink escape, duplicate identity and
missing-index checks, passed fifteen tests, zero failures and 129 assertions.

Every fault below ran alone through `check-indexes` against a temporary real Git repository and was
restored before the next. Adjacent `Proof:` comments record the observed output.

| Deliberate one-at-a-time fault               | Observed production-CLI oracle failure                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| ignore an absent exact member                | failure moved to `Markdown path absent in README.md: docs/guide.md`               |
| ignore a selected path with no declaration   | CLI exited 0 while `unindexed.txt` was absent from every index                    |
| classify wrong case as ordinary absence      | received `Markdown path absent ... docs/Guide.md`, not the required case mismatch |
| skip the absent-anchor refusal               | CLI exited 0 with all three indexes                                               |
| widen metadata version to any number         | version 2 reached later membership inference                                      |
| widen membership path to arbitrary text      | `../outside.ts` reached an unrelated later anchor failure                         |
| ignore a path matched by two declarations    | overlapping test membership reached a later frozen-proposal failure               |
| skip a Markdown link containing a glob       | `tests/*.ts` disappeared from validation and the CLI exited 0                     |
| raise the direct-entry threshold to 41       | the forty-one-entry report returned `reviewDebt: []`                              |
| substitute empty bytes for failed blob reads | unreadable candidate exited 0 with `indexes: []`                                  |
| omit selected-symlink lexical confinement    | `escape -> ../../outside` exited 0 as a valid member                              |
| read the working path instead of its blob    | dirty host metadata version 99 replaced the selected committed README             |
| omit duplicate module-id detection           | CLI exited 0 with `module.alpha` reported for two indexes                         |
| permit a candidate with no index metadata    | ordinary README exited 0 with empty indexes and review debt                       |

Final uncached project verification was
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static`: exit 0, source/spec TypeScript and lint passed, and 103 tests passed with
zero failures and 1,603 assertions in 277.29 seconds. Nx used its in-process plugin fallback after
the sandbox denied its socket; no target was skipped. The pilot policy and repository README
migration remain Task 2.4 and were not started. Full repository and browser gates remain with the
parent integration pass.

Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0. Its optional PostHog telemetry flush
reported the sandbox's DNS failure afterward without changing validation or its exit status.

## Slice 2.3 Fix Round 1

Reference-style Markdown navigation is now resolved from mdast `linkReference` nodes through their
actual `definition` nodes. Used definitions pass through the same exact path, case, anchor and glob
checks as inline links; a definition naming a missing candidate path is refused. Images and image
references remain non-navigation, while external autolinks remain external. Metadata and explicit
HTML anchors are accepted only from rendered mdast HTML nodes, so fenced examples cannot become an
index envelope or satisfy an anchor.

Every concrete exact or grouped member is now followed through selected symlink blobs before its
claim is accepted, independently of README navigation. Absolute, lexical, absent-target and cyclic
symlink states fail closed. This stronger membership boundary made the old link-only lexical guard
redundant: deleting it permanently left the linked escape test green because it now fails earlier as
`membership symlink escapes candidate ...`.

The initial focused regression run passed the image/autolink control and failed the six observable
gaps: the absent reference target, fenced anchor, fenced metadata, and unlinked exact/grouped member
escapes all expected exit 1 and received 0; an undefined reference spelling was also observed as
ordinary CommonMark text rather than a `linkReference` and was therefore not retained as a false
navigation oracle. The completed post-format suite passed 27 tests, zero failures and 224 assertions.

| Deliberate one-at-a-time fault                     | Observed production-CLI failure                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| omit resolved reference links                      | absent `docs/absent.md` definition target exited 0; expected exit 1                 |
| admit fenced code nodes as metadata                | fenced `module.example` envelope was indexed and CLI exited 0                       |
| admit fenced code nodes as HTML anchors            | fenced `<a id="details">` satisfied the link and CLI exited 0                       |
| bypass effective member-symlink validation         | both unlinked exact and grouped escapes exited 0 as owned members                   |
| omit the absolute-target distinction               | `/outside` moved to the less precise absent-target failure                          |
| omit selected-target membership                    | dangling `missing -> not-selected` exited 0 as an owned member                      |
| return when a selected symlink cycle repeats       | `first -> second -> first` exited 0 with both paths reported as owned               |
| return empty bytes for an unreadable selected blob | failure moved to `selected candidate contains no wbs indexes`, hiding unreadability |
| delete the former link-only lexical symlink guard  | no behavior changed; the stronger membership boundary refused the linked escape     |

Each behavior-changing fault ran alone through `check-indexes` against a temporary real Git
repository and was restored before the next. Adjacent `Proof:` comments record the observed
failures. The dead link-only guard and its inaccurate proof were removed rather than retained.

Direct project ESLint and the solution-style source/spec TypeScript build exited 0. The first
uncached Nx lint/typecheck/test aggregate passed all 112 then-current tool-wiki tests with zero
failures and 1,674 assertions in 284.04 seconds (4m44s Nx duration). The final aggregate after the
three additional symlink-state oracles passed all 115 tests with zero failures and 1,698 assertions
in 286.01 seconds (4m46s Nx duration). Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0; only its optional PostHog flush reported the
sandbox DNS failure afterward. Task 2.4 and its pilot indexes remain untouched.

## Slice 2.3 Fix Round 2

Explicit Markdown HTML anchors are now derived by assembling mdast's rendered HTML and escaped text
leaves into one HTML fragment, then walking actual elements. Parsing the complete fragment preserves
element context across mdast's separate opening and closing HTML nodes. Any rendered element `id`
and legacy `<a name>` are anchors; HTML comments, raw-text contents and inert template contents are
not. This prevents anchor-looking source inside `<!-- ... -->`, `<script>` or `<template>` from
satisfying navigation while retaining real non-anchor element IDs.

Candidate-relative link paths are canonicalized after joining them to the index directory. One
trailing separator is removed after POSIX normalization, and the current-directory forms `.` and
`./` become the index directory. Directory lookup, case folding and absence diagnostics therefore
operate on the same canonical spelling: `docs/` resolves `docs/README.md`, `Docs/` reports its case
mismatch, and `missing/` reports canonical `missing` as absent.

The first focused CLI regression run passed only the initially substring-based absent-directory
oracle and failed the other five cases: comment and script anchor source each exited 0; a rendered
`<section id="details">` was reported absent; `docs/` was reported absent; and `Docs/` was diagnosed
as ordinary absence. Tightening the absent-directory assertion to exact output then reproduced its
retained slash, while a separate `./` self-link also reproduced as absent. A nearby-context audit
then found that parsing mdast HTML leaves separately admitted an anchor inside `<template>`; the
complete-fragment parse closed that gap. The restored post-format index suite passed 35 tests, zero
failures and 285 assertions.

| Deliberate one-at-a-time fault                    | Observed production-CLI failure                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| restore raw `<a>` matching over HTML source       | comment, script and template anchor spellings each exited 0; expected exit 1                      |
| accept element IDs only on `<a>`                  | real `<section id="details">` failed as absent; expected exit 0, received 1                       |
| traverse parsed template `content.childNodes`     | inert `<a id="details">` satisfied navigation; expected exit 1, received 0                        |
| return POSIX normalization without canonicalizing | `docs/` and `./` failed absent, `Docs/` lost its case diagnostic, `missing/` remained uncanonical |

Each fault ran alone through `check-indexes` in temporary real Git repositories and was restored
before the next. Adjacent `Proof:` comments contain the observed failure text. Direct project ESLint
and the solution-style source/spec TypeScript build exited 0. The uncached Nx lint/typecheck/test
aggregate passed all 123 tool-wiki tests with zero failures and 1,759 assertions in 292.79 seconds
(4m53s Nx duration). Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0 and telemetry disabled. Task 2.4 and the Task
2.3 checkbox remain untouched.

## Slice 2.3 Fix Round 3

Heading anchors are now derived in rendered-tree context. Markdown headings inside inert
`<template>` content are excluded, while inline HTML contributes its rendered visible text.
Heading slugs use a documented collision-safe convention: lowercase Unicode letters and numbers,
preserved `_` and `-`, deleted punctuation, whitespace collapsed to `-`, trimmed edge hyphens, and
the lowest unused `-N` suffix. Thus `A`, `A`, `A-1` produce `a`, `a-1`, `a-1-1`. A source-dependent,
case-insensitive internal marker prevents user HTML from creating or suppressing headings.

Selected symlink blobs now retain a leading UTF-8 BOM as an exact path code point; Markdown source
continues to treat a document BOM as encoding syntax. Link and membership resolution share a
component-aware selected-tree walker. It follows bounded selected symlinks, confines every
candidate, permits parent segments only through directories, and refuses regular-file traversal
such as `guide.md/../guide.md` instead of erasing the invalid intermediate component.

The initial focused regressions reproduced every reported gap: an inert-template heading and an
uppercase forged marker each made the production CLI exit 0; rendered inline HTML and the
collision `a-1-1` were reported as missing; a present BOM-prefixed symlink target was incorrectly
decoded without the BOM; the dangling diagnostic omitted it; and both Markdown and membership
`file/../file` paths exited 0. A final adversarial audit reproduced an additional marker collision:
encoded angle brackets with emphasis splitting the marker name exited 0. The completed post-format
suite passed 47 tests, zero failures and 377 assertions.

| Deliberate one-at-a-time fault                    | Observed production-CLI failure                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| collect mdast headings outside rendered context   | inert `<template>` heading satisfied navigation; expected exit 1, received 0           |
| call heading extraction with `includeHtml: false` | rendered inline HTML lost `#release-notes`; expected exit 0, received 1                |
| count collisions only per original base           | `A`, `A`, `A-1` omitted `#a-1-1`; expected exit 0, received 1                          |
| choose the internal marker case-sensitively       | uppercase user marker forged `#forged`; expected exit 1, received 0                    |
| insert rendered heading text as raw HTML          | encoded angles plus emphasis forged `#forged`; expected exit 1, received 0             |
| decode symlink targets with Markdown BOM handling | present target failed as `guide-link -> docs/guide.md`; dangling output omitted U+FEFF |
| return a regular file before later components     | Markdown and member `guide.md/../guide.md` paths exited 0; expected exit 1             |
| stop following selected symlinks                  | valid directory symlink failed as a non-directory component                            |
| reject an implicit-directory symlink at path end  | valid `docs-link -> docs` failed as absent                                             |
| return the pre-canonical directory spelling       | missing anchor reported `docs/#missing` instead of `docs#missing`                      |
| bypass member resolution                          | unlinked exact and grouped escaping symlinks exited 0                                  |
| return when a selected symlink cycle repeats      | `first -> second -> first` exited 0                                                    |
| erase the absolute-target distinction             | `/outside` degraded to an absent-target diagnostic rather than an escape               |
| erase the membership absent-target diagnostic     | `not-selected` degraded to a Markdown-path diagnostic                                  |

Each fault ran alone through `check-indexes` against temporary real Git repositories and was
restored before the next. Adjacent `Proof:` comments record the exact observed boundary failure.
Direct changed-file ESLint and `tsc --build --force tools/tool-wiki/tsconfig.json` exited 0. The
uncached Nx lint/typecheck/test aggregate passed all 135 tool-wiki tests with zero failures and
1,851 assertions in 301.89 seconds (5m2s Nx duration); Nx reported its sandbox socket denial and
used the in-process fallback, with no target skipped. Pinned OpenSpec 1.3.0 strict validation
returned `Change 'agent-scalable-llm-wiki' is valid` with exit 0 and telemetry disabled. Task 2.4
and all task checkboxes remain untouched.

## Slice 2.3 Containment Round

Selected symlink cycles are now bounded by the active expansion stack rather than every path ever
visited. A completion marker removes a symlink from the active set after its target components are
resolved, so finite reuse such as `docs-link/../docs-link/guide.md` is valid while recursive active
expansion still fails. Directory-to-README fallback now queues `README.md` through the same
component resolver, so a selected README symlink is resolved and confined before its Markdown
anchors are read.

The initial two-case production run reproduced both resolver faults: finite reuse failed with
`Markdown symlink cycle in README.md: docs-link`, and a directory README symlink failed with
`Markdown anchor absent in README.md: docs#details`. The broader focused run then exposed a nearby
regression in the first completion-marker implementation: a trailing separator on a regular file
exited 0. Counting every remaining lexical component while ignoring only internal completion
markers restored that existing refusal.

The four metadata guards introduced with Task 2.3 now have isolated production-CLI cases and
adjacent observed proofs: directory exclusions remain below their prefix, relationship selectors
are unique, inapplicable sections are unique, and selectors are present exactly when relationships
are applicable. Both directions of the applicability constraint are covered.

| Deliberate one-at-a-time fault                   | Observed production-CLI failure                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| retain a symlink after its target expansion ends | finite reuse failed with `Markdown symlink cycle in README.md: docs-link`        |
| return the directory README without resolving it | README symlink bytes yielded `Markdown anchor absent in README.md: docs#details` |
| bypass the directory-exclusion constraint        | outside-prefix exclusion exited 0 and reported `docs/guide.md` as owned          |
| bypass unique relationship selectors             | duplicate-selector metadata exited 0 with an index report                        |
| bypass unique inapplicable sections              | duplicate-section metadata exited 0 with an index report                         |
| bypass selector/applicability consistency        | both contradictory metadata fixtures exited 0 with index reports                 |

Each mutation ran alone through `check-indexes` against a temporary real Git repository and was
restored before the next. The post-format focused contracts/indexes run passed 70 tests with zero
failures and 539 assertions in 66.45 seconds. Direct changed-file ESLint and
`tsc --build --force tools/tool-wiki/tsconfig.json` exited 0. The exact-tree uncached Nx
lint/typecheck/test aggregate passed all 142 tool-wiki tests with zero failures and 1,905 assertions
in 307.10 seconds (5m7s Nx duration); Nx used its explicit in-process fallback after the sandbox
denied its socket, with no target skipped. Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0 and telemetry disabled. Task 2.4 and all
task checkboxes remain untouched.

## Slice 2.3 Final Containment

The selected-tree resolver now tracks directory fallback states separately from active symlink
expansions. Once resolution has implicitly queued `README.md` for a directory, returning to that
same directory with no lexical components left is a directory-README cycle. This closes the
non-terminating path where a completed README symlink expansion cleared its active marker before
restarting the same fallback.

The first bounded production runs reproduced both variants with the unguarded implementation:
`docs/README.md -> .` and the mutual `docs/README.md -> ../manuals`,
`manuals/README.md -> ../docs` cycle each reached the process timeout and returned `exitCode: null`
instead of exit 1. After GREEN, removing only the repeated-fallback refusal reproduced both exact
three-second timeouts. The restored CLI refuses each as
`Markdown directory README cycle in README.md: docs`.

| Deliberate one-at-a-time fault       | Observed production-CLI failure                            |
| ------------------------------------ | ---------------------------------------------------------- |
| permit a repeated directory fallback | both bounded cycle cases reached 3 s with `exitCode: null` |

The nearby audit kept finite symlink reuse and a directory README symlink to a regular Markdown
file green. A new `docs/README.md -> ..` control also exits 0 after resolving the repository README
and its anchor, showing that a parent-directory README target is not mistaken for a cycle.

The post-format focused index run passed 57 tests with zero failures and 454 assertions in 42.01
seconds. Direct changed-file ESLint and `tsc --build --force tools/tool-wiki/tsconfig.json` exited 0. The exact-tree uncached
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` aggregate passed all 145 tool-wiki tests with zero failures and 1,928
assertions in 308.62 seconds (5m9s Nx duration). Nx used its in-process plugin fallback after the
sandbox denied its socket; no target was skipped. `OPENSPEC_TELEMETRY=0 bunx
@fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict` returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0. Task 2.4 and all task checkboxes remain
untouched.

## Slice 3.1 Review Invocation and Provenance

The structured review boundary now registers canonical request bytes in an fsynced, read-back
invocation journal before process launch. The terminal journal preserves raw stdout bytes,
operator-reported model/provider/effort, tool identities in exact order with duplicates, raw usage,
price identity, charged micros, elapsed milliseconds, protocol evidence and retained raw response.
Completion is idempotent only for the exact same terminal observation. A completed invocation with
missing telemetry or a failed invocation status produces an explicit `unverified` result and no
review evidence; it never manufactures zero usage, price, charge or elapsed values.

Cold judgments are sequence-one evidence and the sequence-two expansion binds their canonical
identity before sequence-three informed judgment. The production provenance CLI compares submitted
evidence with the separately retained journal observation, rejects incomplete or unverified
entries, and classifies configured provenance scope. It may enforce an explicit external
requirement, but does not select the later trust policy: `local-cooperative` is recorded and cannot
satisfy `require-external`.

The initial RED run had zero passes and two module-resolution failures for the absent `protocol`
and `invoker` modules. The restored post-format focused command passed 16 tests, zero failures and
71 assertions in 12.62 seconds.

| Deliberate one-at-a-time fault                                                                | Observed focused or production-CLI failure                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| accept a different cold artifact                                                              | cold-binding negative failed with `Received function did not throw`                                 |
| accept a forged raw-response artifact                                                         | response-identity negative failed with `Received function did not throw`                            |
| permit verified telemetry without elapsed receipts                                            | elapsed negative failed with `Received function did not throw`                                      |
| widen external retention time to any non-empty string                                         | invalid February date was accepted; negative failed with `Received function did not throw`          |
| permit fabricated fields in unverified telemetry                                              | `chargedAmountMicros: 0` was accepted; negative failed with `Received function did not throw`       |
| accept rewritten stdin or stdout identities                                                   | each exact-byte negative failed separately with `Received function did not throw`                   |
| move journal registration after process spawn                                                 | harness exited 19: `invocation was not durably registered before launch`                            |
| accept a different durable-registration identity                                              | invocation reached `Executable not found` instead of refusing the acceptance                        |
| permit duplicate registration                                                                 | test received the later unique-entry schema failure instead of `already registered`                 |
| permit completion of an unknown invocation                                                    | test received `undefined is not an object` instead of `unknown invocation`                          |
| return from a different terminal completion                                                   | terminal negative failed with `Received function did not throw`                                     |
| permit completed telemetry without evidence                                                   | terminal test reached `different terminal completion` instead of the evidence invariant             |
| accept duplicate journal invocation identities                                                | duplicate persisted entry was accepted; negative failed with `Received function did not throw`      |
| accept a changed journal identity                                                             | `journal.replaced` was returned; negative failed with `Received function did not throw`             |
| remove contextual read and JSON failures                                                      | tests received raw ENOENT and `JSON Parse error` rather than the modeled journal errors             |
| alter output invocation, protocol/subject, telemetry invocation, stdin identity or start time | each harness-boundary case failed separately with `Received function did not throw`                 |
| make evidence for a failed invocation                                                         | completion failed the verified-completed evidence invariant                                         |
| fall back to the first journal entry                                                          | forged invocation reported generic evidence difference instead of `unknown invocation`              |
| bypass raw-response provenance comparison                                                     | altered response reported generic evidence difference                                               |
| bypass observed-read comparison                                                               | erased reads reported cold-judgment difference                                                      |
| bypass frozen-cold comparison                                                                 | rewritten cold reported generic evidence difference                                                 |
| bypass final evidence comparison                                                              | forged tools exited 0 with status `verified`                                                        |
| accept incomplete or unverified journal entries                                               | CLI received `undefined is not an object` or `null is not an object` instead of the modeled refusal |
| permit local scope for an external requirement                                                | CLI exited 0 with `local-cooperative` and `satisfiesExternal: false`                                |
| reverse tools, truncate raw usage or alter price model                                        | exact retention assertions showed the changed order, missing input usage or `altered-model`         |

Each fault ran alone and was restored before the next. One initially written output-invocation
negative was itself vacuous because it altered only the telemetry invocation. A distinct
wrong-output mode was added, the boundary was bypassed again, and the test then failed at the
intended `differs from registered` assertion. Adjacent `Proof:` comments record the observed
failures.

Fresh uncached standalone lint and typecheck targets exited 0. The exact-tree uncached
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` aggregate passed all 161 tool-wiki tests with zero failures and 1,999
assertions in 342.56 seconds (5m43s Nx duration). Nx used its in-process plugin fallback after the
sandbox denied its socket; no target was skipped. Pinned OpenSpec 1.3.0 strict validation returned
`Change 'agent-scalable-llm-wiki' is valid` with exit 0 and telemetry disabled. Only task 3.1 is
marked complete; task 3.2 and all later task checkboxes remain untouched.

## Slice 3.1 Fix Round 1

This round supersedes the earlier 3.1 implementation details where they differ. Cold and informed
review are now two process attempts separated by a durably persisted cold acknowledgement. Cold
stdin contains the pinned protocol and subject but no informed-context identities or resolvable
informed payload. Only a successful, protocol-reconciled cold completion with verified telemetry
permits the informed process to launch. Cold and informed usage, price, charge, elapsed receipts and
exact tool sequences remain separate; the combined tool sequence preserves phase order and
duplicates.

The journal retains exact canonical registration and phase stdin, raw stdout and raw stderr bytes,
their SHA-256 identities, process start/end/status, decoded output when available and the decode
failure otherwise. Nonzero exits, launch failure, malformed output, protocol mismatch and telemetry
mismatch are terminal unverified observations with no review evidence. Known partial provider,
model, usage, price, charge, time and elapsed-receipt observations survive in the discriminated
unverified telemetry state alongside explicit missing requirements; no absent value becomes zero.

Every file-journal transition holds an owner-token lock across its full read-modify-fsync-rename-
readback operation. A contender cannot release another owner's lock, and an existing or stale lock
times out without age-based stealing. Registration is durable before cold launch; the complete cold
attempt is durable before informed launch; repeated identical completion is idempotent while a
different terminal or a cold acknowledgement after terminal is refused.

All retained review evidence is re-derived from the canonical registered request and decoded exact
phase stdout by one reconciliation implementation at completion, journal read and provenance
validation. Submitted forged invocation ids, altered raw-response references, erased observed
reads and rewritten cold judgments fail through the production CLI. The only accepted journal
scope is `local-cooperative`; relabeling it is invalid, and local evidence always reports
`satisfiesExternal: false`. Independently authenticated external provenance and trust selection
remain deferred to later slices.

Focused TDD began with the revised tests failing on the missing `FileJournalLock` and
`decodeColdHarnessOutput` exports (zero pass, two failures). The final focused command passed 21
tests with zero failures and 92 assertions in 9.03 seconds before the aggregate.

| Deliberate one-at-a-time fault                                        | Observed focused or production-boundary failure                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| bypass external-provenance refusal                                    | production CLI returned 0; `Expected: 1, Received: 0`                                                    |
| accept a relabeled local journal                                      | production CLI returned 0 for `trusted-harness`; `Expected: 1, Received: 0`                              |
| launch cold without durable registration                              | completion failed on `cannot complete unknown invocation: invocation.integration-test`                   |
| launch informed without durable cold acknowledgement                  | production path failed on `informed terminal has no cold acknowledgement`                                |
| include informed context identities in cold stdin                     | harness exited 31 with `review harness exited 31`                                                        |
| accept unverified cold telemetry                                      | informed launched; retained terminal telemetry was `verified`, not cold `unverified`                     |
| move semantic protocol rejection into byte reconciliation             | terminal persistence threw `cold output protocol, subject or invocation differs from registered request` |
| accept a foreign telemetry invocation id                              | invocation returned `verified` instead of `unverified`                                                   |
| omit cold or informed terminal persistence                            | each focused failure threw `expected unverified terminal`                                                |
| trust retained payload or charge fields without exact stdout decoding | journal read did not throw for either rewrite                                                            |
| accept forged registration/phase stdin, stdout or stderr identities   | negatives did not throw, or reached only the later telemetry mismatch                                    |
| swap cold and informed phase receipts                                 | cold charge was 14000 µUSD instead of 11000 µUSD                                                         |
| drop a repeated tool observation                                      | combined sequence had two entries instead of the exact three                                             |
| bypass full evidence reconciliation                                   | altered raw-response evidence made the production CLI return 0                                           |
| fall back to the first journal entry                                  | forged id produced a generic evidence mismatch instead of `unknown invocation`                           |
| accept all repeated terminal completions                              | changed `completedAt` returned durable; the test reported that the function did not throw                |
| acknowledge cold after terminal                                       | method returned durable; the test reported that the function did not throw                               |
| bypass the journal lock                                               | both registration workers exited while held: `[0, 0]` instead of `[null, null]`                          |
| steal an existing lock                                                | completion workers produced `[1, 0]` instead of remaining blocked at `[null, null]`                      |
| release after owner-token replacement                                 | release did not throw at the ownership assertion                                                         |
| discard known partial telemetry                                       | decoded `observed` became `{}` instead of retaining provider/model/usage/charge/time                     |
| widen external retention time to any string                           | invalid 30 February was accepted; decoder did not throw                                                  |
| reverse raw-response identity comparison                              | a mismatched output artifact decoded; the test did not throw                                             |

Every fault was restored before the next. Adjacent `Proof:` comments quote the observed failure.
The first uncached project aggregate
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` exited 0 with 166 tests, zero failures and 2,020 assertions in 374.86 seconds
(6m15s Nx duration). Nx used its in-process plugin fallback after the sandbox denied its socket; no
target was skipped. After formatting the source, the exact-source rerun also exited 0 with 166
tests, zero failures and 2,020 assertions in 374.29 seconds (6m14s Nx duration), with the same
documented fallback and no skipped target. `bunx nx format:check --all` exited 0. Pinned
`OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`
exited 0 with `Change 'agent-scalable-llm-wiki' is valid`.

## Slice 3.1 Fix Round 2

Bun 1.4.2 was reproduced returning `{ exitCode: null, signalCode: "SIGTERM" }` from
`Bun.spawnSync` after the child wrote exact stdout and stderr. The old broad catch then interpreted
the schema rejection for null `exitCode` as a launch failure and replaced both returned streams
with empty bytes. The process observation now discriminates numeric exits, exact returned signal
codes, unresolved returned exit state and actual throw-before-return launch failures. Signal and
unresolved attempts are terminal unverified observations and cannot release a later phase.

The initial focused RED had 16 passes and two failures. Both cold and informed production harness
cases retained `launch failed: Validation failed: exit.exitCode must be a number (was null)` rather
than SIGTERM. The restored formatted focused protocol/provenance command passed 25 tests with zero
failures and 123 assertions.

| Deliberate one-at-a-time fault                             | Observed production-path failure                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| route a returned signal through launch-failure recovery    | cold expected `Y29sZCBzdGRvdXQgYmVmb3JlIFNJR1RFUk0K`, received empty stdout; informed observed the same loss     |
| classify a returned SIGTERM as unresolved                  | both exact-exit assertions received `{ kind: "unresolved", exitCode: null }` instead of `signaled`               |
| bypass explicit signal refusal                             | both terminal reasons became `null is not an object (evaluating 'output.telemetry')` instead of naming SIGTERM   |
| treat null exit plus absent/empty signal as a numeric exit | production invocation escaped on `exit.exitCode must be a number (was null)` instead of durably retaining output |

Every fault was restored before the next. Adjacent `Proof:` comments name the observed failures.
The impossible returned state was exercised for both absent and empty signal codes through the
production invoker, using a complete captured Bun subprocess observation with only those runtime
fields altered; both retained exact stdout/stderr and persisted an unverified cold terminal.
Standalone Bun probes confirmed SIGINT and SIGKILL use the same null exit plus exact signal string,
with both streams retained. The adapter supplies no abort signal, timeout or maximum-output bound,
so no additional termination representation was added.

The exact-source uncached
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` aggregate exited 0 with 170 tests, zero failures and 2,051 assertions in
377.38 seconds (6m17s Nx duration). Nx used its documented in-process fallback after sandbox socket
denial and skipped no target. Only OpenSpec task 3.1 remains marked complete; task 3.2 and all later
checkboxes remain untouched. Repository-wide `bunx nx format:check --all` exited 0. Pinned
`OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`
exited 0 with `Change 'agent-scalable-llm-wiki' is valid`.

## Slice 3.1 Fix Round 3

The registration transition previously validated its outer `InvocationRegistration` and exact
stdin hash, then persisted the new entry before the readback path first decoded the embedded
`ReviewInvocationRequest`. A semantically invalid request therefore replaced a healthy journal and
made subsequent reads fail. Registration now calls the existing canonical `decodeRegistration`
before lock acquisition; semantic refusal cannot enter the write transaction.

The production `FileInvocationJournal` test preseeds a valid record, snapshots exact journal bytes
and submits independently constructed invalid registrations for malformed JSON, request-schema
failure, valid but noncanonical bytes, mismatched invocation identity and mismatched receipt
identity. Every outer record has a unique invocation id and the matching recomputed stdin hash.
Each rejection leaves the exact bytes unchanged, keeps `readInvocationJournal` valid, leaves no
lock directory and permits a later valid registration.

| Deliberate one-at-a-time fault         | Observed production-path failure                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| bypass registration semantic preflight | the malformed entry was durably appended; byte equality reported `Expected - 0 / Received + 306` |

The initial RED and explicit post-GREEN mutation produced the same failure, and the mutation was
restored. The unchanged-byte assertion ran after the expected malformed-JSON rejection, proving
the invalid entry reached persistence rather than duplicate or outer-schema validation. The
adjacent audit found no analogous write-before-semantic-validation path: cold acknowledgement
reconciles before persistence, completion reconciles its full next entry before persistence,
idempotent branches do not write, create has no embedded entry, and open/read are read-only.

The restored focused protocol/provenance command passed 26 tests with zero failures and 144
assertions. The formatted exact-source uncached
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` aggregate exited 0 with 171 tests, zero failures and 2,072 assertions in
391.34 seconds (6m31s Nx duration). Nx used its documented in-process fallback after sandbox socket
denial and skipped no target. Only OpenSpec task 3.1 remains marked complete; task 3.2 and all later
checkboxes remain untouched. Repository-wide `bunx nx format:check --all`, pinned
`OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`
and `git diff --check` exited 0; OpenSpec reported `Change 'agent-scalable-llm-wiki' is valid`.

## Slice 3.1 Canonical Harness Number Containment

`JSON.parse` accepts exponent overflow as positive or negative infinity and preserves negative
zero. The harness ArkType schemas rejected negative infinity in nonnegative usage but admitted
positive infinity for `number>=0` and negative zero for every nonnegative numeric field. Those
values previously reached canonical hashing during completion reconciliation, which threw before
the unverified terminal could replace the registered entry.

Cold and informed harness outputs now pass through one non-mutating canonical JSON value assertion
immediately after strict schema decoding. The assertion reuses the canonical serializer's value
model and recursively covers verified and partial telemetry. Reconciliation short-circuits a null
decoded output, retaining its exact process bytes/hashes without trying to interpret the known
invalid stdout again.

| Deliberate one-at-a-time fault                 | Observed production-path failure                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| omit the shared harness canonical-value check  | eight cold/informed Infinity or negative-zero tests threw `canonical JSON requires a finite number other than negative zero` during journal completion |
| supply `-1e999` rather than canonical overflow | both phase controls persisted unverified with a `quantity` schema reason and no `canonical JSON` text, distinguishing the nonnegative-schema rejection |

The pre-fix focused RED passed 24 tests and failed the eight Infinity/negative-zero cases at
`journal.complete`. The explicit post-GREEN one-line bypass passed both negative-infinity controls
and failed the same eight cases. With the assertion restored, the focused protocol/provenance
command passed 37 tests, zero failures and 252 assertions. Each failed-process test compares the
journal's stdout bytes against the independent harness sidecar, checks exact deterministic stderr,
recomputes both SHA-256 identities, requires a readable terminal and verifies that a cold failure
never launches informed. Positive zero in usage, charge and elapsed fields remained verified and
was distinguished from negative zero with `Object.is`.

The adjacent audit found the structured outputs contain only schema/sequence literals and the
three telemetry numeric families exercised above: usage quantity, charged micro-units and elapsed
milliseconds. Schema/sequence literals already require their exact values. Other
`hashCanonical` entrypoints consume locally constructed validated records or fail closed during
journal/CLI validation; none has the same external-output-to-durable-transition gap.

Verification on the restored source:

- `bun test --preload ../test/scratch/preload.ts src/review/invocation-provenance.test.ts src/review/protocol.test.ts` — exit 0; 37 pass, 0 fail, 252 assertions.
- `bunx eslint src/evidence/content-manifest.ts src/review/protocol.ts src/review/invoker.ts src/review/invocation-provenance.test.ts` — exit 0.
- `bunx tsc --build --force tsconfig.json` from `tools/tool-wiki` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static` — exit 0; 182 pass, 0 fail, 2,180 assertions in 388.75 seconds (6m29s Nx duration), cache skipped, no target skipped.

Only task 3.1 remains marked complete. Task 3.2 and all later task checkboxes were not changed.

## Slice 3.2 Evidence Currency and Obligations

Currency now compares four explicitly tagged input axes: content, structural, semantic and
topology. Each judgment carries typed bindings to only the inputs that support it, with navigation
and relationship as distinct judgment kinds. Selector identity comparisons include complete
declared or extracted provenance. Candidate selectors remain comparable across candidate source
bases, while historical selector provenance includes its exact revision. Impact classifications
separately pin both reviewed/current source bases and reviewed/current candidate identities.

Obligation evaluation selects consumer and conformance checks for every changed implementation,
including same-type changes. A missing, stale or unknown impact classification is a named refusal
and selects the rule's expanded reviews. Current check, review and known impact evidence can
discharge the corresponding named obligation after an earlier failed or unknown observation;
writer-supplied `implementation-only` labels are retained as claims but never consulted as waivers.

Focused TDD began with `currency.test.ts` failing because `./currency` did not exist (zero pass,
one failure), then with the obligation slice failing because `../policy/obligations` did not exist
(zero pass, one failure). Later RED steps observed the stale selector review missing, an absent
classification being accepted, and earlier negative evidence shadowing later positive evidence.
The restored focused command passed 12 tests with zero failures and 26 assertions.

| Deliberate one-at-a-time fault                        | Observed focused production-path failure                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| broaden navigation currency to every changed child    | ancestor navigation received `stale` with a content change instead of `current` with no changes                      |
| omit structural and semantic binding axes             | both changed consumer judgments received `current` with no changes instead of `stale`                                |
| omit the topology binding axis                        | reverse-edge relationship and index navigation judgments both received `current` instead of `stale`                  |
| compare selector text without provenance              | changed extractor and declaration versions both received `current` instead of `stale`                                |
| accept duplicate inputs or an absent reviewed binding | duplicate input returned a report; absent structural binding returned `current` instead of throwing the named errors |
| delete consumer/conformance selection                 | the same-type behavior-change case received `accepted: true` instead of `false`                                      |
| skip checks for writer `implementation-only`          | required checks were empty instead of containing `check.consumer`                                                    |
| treat a missing classification as success             | the missing-classification case received `accepted: true` instead of `false`                                         |
| treat a bound unknown classification as success       | the unknown-impact case received `accepted: true` instead of `false`                                                 |
| select the first check observation                    | later passing evidence remained refused as `required check failed`                                                   |
| select the first review observation                   | later current evidence retained `expanded review failed`                                                             |
| select the first impact classification                | later exact known evidence retained unknown-impact and missing-expanded-review refusals                              |
| omit current-candidate classification binding         | a foreign candidate produced no refusals instead of the named `does not bind` refusal                                |

Every deliberate fault was restored before the next. Adjacent `Proof:` comments reproduce the
observed mismatch. Verification on the restored source:

- `bun test --preload ../test/scratch/preload.ts src/evidence/currency.test.ts` from
  `tools/tool-wiki` — exit 0; 12 pass, 0 fail, 26 assertions.
- `bunx eslint src/evidence/currency.ts src/evidence/currency.test.ts
src/policy/obligations.ts` — exit 0.
- `bunx tsc --build --force tsconfig.json` from `tools/tool-wiki` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 194 pass, 0 fail, 2,206 assertions in 374.30 seconds
  (6m14s Nx duration), cache skipped, no target skipped. Nx used the documented main-process
  plugin fallback after sandbox socket denial.
- `bunx nx format:check --all` — exit 0.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `git diff --check` — exit 0.

Only task 3.2 was newly marked complete. Task 3.3 and all later task checkboxes remain untouched.

## Slice 3.2 Review Fix Round 1

Currency now compares the byte-sorted union of reviewed and current content identities and emits
an explicit discriminated `added`, `changed` or `removed` change. An absent side has no synthetic
or nullable selector identity: added obligations bind the current content identity, removed
obligations bind the reviewed identity, and every classification also pins both source bases and
both candidate identities.

The public currency and obligation entrypoints now strictly decode their complete inputs before
evaluation. Missing or unrecognized impact classifications cannot become known classifications.
Duplicate input IDs on every currency axis, duplicate behavior rules, duplicate judgment IDs and
duplicate IDs in each evidence family fail closed. Check, review and classification evidence is
matched only to its exact subject and current candidate; status selection is set-like and
independent of observation order. Writer labels remain retained claims and cannot remove an
obligation.

| Deliberate one-at-a-time fault                | Observed focused production-path failure                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| enumerate only reviewed content               | the current-only `content.added` change became `[]`                                            |
| enumerate only current content                | the reviewed-only `content.child` removal became `[]`                                          |
| refuse all added classification bindings      | the added case gained impact and expanded-review refusals beside its failed check              |
| refuse all removed classification bindings    | the removed case gained impact and expanded-review refusals beside its failed check            |
| delete duplicate behavior-rule refusal        | an accepted report selected only `check.consumer` instead of throwing                          |
| delete duplicate judgment refusal             | two differently scoped `judgment.duplicate` currency entries were returned                     |
| omit each evidence-ID family in turn          | duplicate classification, label, check and review observations each reached an accepted report |
| widen the classification enum                 | `implementation-only` was accepted as known with no refusals                                   |
| make classification optional                  | an absent classification was accepted with no refusals                                         |
| widen snapshot source base to any string      | a report retained `working-tree` as its reviewed source base                                   |
| omit current-candidate classification binding | a foreign classification removed the expected `does not bind` refusal                          |
| omit current-candidate check binding          | a foreign passed check removed the missing-current-check refusal                               |
| omit current-candidate review binding         | a foreign current review removed the missing expanded-review refusal                           |

Every fault was restored before the next. Adjacent `Proof:` comments name the test and observed
mismatch. Verification on the restored source:

- `bun test tools/tool-wiki/src/evidence/currency.test.ts` — exit 0; 25 pass, 0 fail, 48
  assertions.
- `bunx eslint tools/tool-wiki/src/evidence/currency.ts
tools/tool-wiki/src/policy/obligations.ts tools/tool-wiki/src/evidence/currency.test.ts` — exit 0.
- `bunx tsc --build --force tools/tool-wiki/tsconfig.json` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 207 pass, 0 fail, 2,228 assertions in 385.34 seconds (6m25s
  Nx duration), cache skipped and no target skipped. Nx used its documented main-process fallback
  after sandbox socket denial.
- `bunx nx format:check --all` — exit 0.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `git diff --check` — exit 0.

Task 3.2 remains complete. Task 3.3 and all later task checkboxes remain untouched.

## Slice 3.3 Review Fix Round 2

Audit accounting now rejects a repeated receipt identity before aggregation across the complete
audit receipt set: review summaries, both cold/informed invocation receipts, every elapsed receipt,
all reviews, and even collisions between receipt kinds. Invocation receipts are the authoritative
records for their exact price identity, raw usage and charged amount, so zero-charge phases remain
subject to the same identity rule.

The former cross-currency scalar is replaced atomically by `currencyCharges`. Each bucket retains
the receipt's exact native currency, uses checked safe-integer addition independently, and is
returned in canonical byte order. Review cost rows still retain the original review and phase
receipts, including their native currency and complete price identities.

| Deliberate one-at-a-time fault        | Observed public `evaluateAudit` failure                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| remove whole-audit receipt uniqueness | a zero-charge invocation receipt identified both phases; the test reported `Received function did not throw` |
| force every native currency into USD  | the report returned USD 50 instead of EUR 25 and USD 25                                                      |
| remove canonical currency ordering    | the report returned USD then EUR instead of the required EUR then USD                                        |

Every fault ran alone and the production guard was restored before verification. Verification on
the restored code commit `49ce8230`:

- `bun test --preload ../test/scratch/preload.ts src/review/audit.test.ts` from `tools/tool-wiki`
  — exit 0; 19 pass, 0 fail, 119 assertions.
- `bunx eslint src/review/audit.ts src/review/audit.test.ts` and
  `bunx tsc --build --force tsconfig.json` from `tools/tool-wiki` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 232 pass, 0 fail, 2,359 assertions in 386.86 seconds (6m27s
  Nx duration), cache skipped and no target skipped. The existing production CLI matrix remained
  below its unchanged ceiling at 24.7685 seconds. Nx used its documented main-process fallback
  after sandbox socket denial.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict`, `bunx nx format:check --all`, and `git diff --check` — exit 0.
- `bin/h2puni-gate.sh 49ce8230` — unavailable, exit 70 in under 0.01 seconds: required heavy-lock
  path `/home/puni1/.cache` does not exist, so no host-gate step ran.

Task 3.3 remains the only completed checkbox in this slice. Task 3.4 remains untouched, and this
fix does not elevate local cooperative provenance to external trust.

## Slice 3.3 Review Fix Round 1

Disagreements are now evaluated independently for every current, discharge-capable review round.
An adjudication names its exact round and exact conflicting review set; a second conflict in a
later round creates a new adjudication and fresh-review duty instead of inheriting an earlier
resolution. Threshold expansion still widens each conflict to its risk shard, and every applicable
adjudication must explicitly name a completed fresh review later than the conflict it resolves.

Only reviews with verified evidence and completed cold and informed invocation receipts discharge
ordinary coverage, participate in disagreement, satisfy fresh work or close a corrected finding.
Failed and censored attempts remain in the complete cost/receipt report. Unverified phase evidence
is rejected by the audit boundary and cannot become a review.

Review-receipt context and read summaries are reconciled exactly with the protocol blob, subject,
informed expansion and both phases' observed reads. Empty or duplicated summary entries therefore
cannot hide or inflate model/context overlap.

| Deliberate one-at-a-time fault                | Observed production-path failure                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| inspect only the earliest review round        | the later-round test received no adjudication obligations instead of `review.directory.src`                      |
| ignore the adjudication's round               | a round-1 adjudication erased both duties for the round-2 conflict                                               |
| bypass exact conflicting review IDs           | `review.later.round-one` erased both duties for the round-2 conflict                                             |
| check only the first conflict's fresh work    | a new round-4 conflict lost `fresh-review:review.directory.src`                                                  |
| remove semantic adjudication-round uniqueness | two IDs for one obligation/round reached an ordinary report; the test reported `function did not throw`          |
| check only cold completion                    | censored informed work discharged `review.project.tool-wiki`                                                     |
| check only informed completion                | failed cold work discharged `review.directory.src`                                                               |
| omit completion from fresh review             | a failed cold attempt erased `fresh-review:review.directory.src`                                                 |
| omit completion from post-correction review   | a failed cold attempt closed `finding.alpha`                                                                     |
| omit supplied-context reconciliation          | empty and duplicated summaries each reported `function did not throw`                                            |
| omit observed-read reconciliation             | empty and duplicated summaries each reported `function did not throw`                                            |
| make adjudication round optional              | a roundless adjudication reached an ordinary refused report; the boundary test reported `function did not throw` |

Every fault ran alone through `evaluateAudit`, was restored before the next, and has an adjacent
`Proof:` comment written from the observed failure. Verification on restored source:

- `bun test --preload ../test/scratch/preload.ts src/review/audit.test.ts` from `tools/tool-wiki`
  — exit 0; 17 pass, 0 fail, 109 assertions.
- `bunx eslint src/review/audit.ts src/review/audit.test.ts` from `tools/tool-wiki` — exit 0.
- `bunx tsc --build --force tsconfig.json` from `tools/tool-wiki` — exit 0.
- The unchanged production CLI contract matrix passed twice: 56 assertions, 24.665 and 24.675
  seconds test duration (24.98 seconds process duration each).
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 230 pass, 0 fail, 2,349 assertions in 386.20 seconds (6m26s Nx,
  386.72 seconds wall), cache skipped and no target skipped. Nx used its documented main-process
  fallback after sandbox socket denial.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` and `git diff --check` — exit 0.

The host gate remains unavailable in this environment: its heavy-lock preflight requires
`/home/puni1/.cache` and exits 70 before format, repository-wide test/lint/typecheck/build or the
solver image smoke starts. Task 3.3 remains complete; task 3.4 and every later checkbox remain
untouched.

## Slice 3.3 Reproducible Review Audit

Audit selection now derives a canonical SHA-256 score from the candidate, seed, risk stratum,
obligation and subject, then selects the configured fraction independently within each non-empty
stratum. File, directory, project and documentation obligations remain separate typed subjects.
The same population and seed produce the exact same selection regardless of caller order.

Audit evaluation strictly decodes canonical records and reconciles exact candidate, generation,
source-base, current subject content, invocation, executor/model/price, phase usage and retained
response identities. It rejects reused identities before reporting. Sampled coverage leaves
unsampled obligations explicitly unreviewed without failing its own sample contract; exhaustive
coverage requires every obligation and explicitly refuses sampled evidence.

An earliest-round judgment disagreement always creates named adjudication and fresh review duties
for the disputed obligation. The configured threshold may expand fresh work to the whole risk shard
but cannot suppress the disputed obligation. Discharge requires structured current source/check
evidence and a distinct later review. Finding closure likewise requires an authoritative correction
bound to the opening review and current candidate/generation, structured current source/check
evidence, and a fresh post-correction review of the same obligation. Pre-correction evidence cannot
be reused.

Reports preserve every review and both cold/informed phase receipts, raw usage, observed reads and
local trust scope. Checked canonical arithmetic rejects unsafe totals and negative zero. Invocation,
executor, model and context/read overlap are reported separately; duplicate invocation identity is
rejected rather than counted as independent agreement.

| Deliberate one-at-a-time fault                              | Observed production-path failure                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| omit the seed from scoring                                  | `review.documentation.guide` was selected instead of `review.project.tool-wiki`                                                      |
| keep caller order                                           | reversing inputs produced a 40-line report mismatch                                                                                  |
| remove selection identity/stratum guards                    | duplicate populations became 3, unknown work disappeared, or an empty stratum emitted population 0 with sample size 1                |
| remove either canonical boundary assertion                  | negative zero lost its canonical diagnosis, or a non-plain inherited envelope was accepted                                           |
| suppress missing sampled work                               | the report returned `accepted: true`                                                                                                 |
| allow sampled evidence to claim exhaustive coverage         | `coverage.exhaustive` disappeared from the refusals                                                                                  |
| suppress disagreement or its base fresh set                 | the named adjudication or below-threshold fresh-review duty disappeared                                                              |
| accept empty adjudication evidence or reuse its first round | adjudication/fresh-review duties disappeared despite empty source/check evidence or the original review                              |
| remove review/invocation uniqueness                         | duplicate cost rows or duplicated evidence were accepted                                                                             |
| loosen current review bindings                              | a foreign subject/source/content/invocation, stale/future generation, mixed model, omitted cold usage or wrong response was accepted |
| aggregate informed phases only                              | total charge was 28 instead of 50 micro-units                                                                                        |
| remove checked addition                                     | total charge became unsafe integer `9007199254741004`                                                                                |
| remove correction/finding/closure/evidence uniqueness       | duplicate records reached closure/reporting instead of failing closed                                                                |
| accept empty correction evidence                            | `finding.alpha` incorrectly disappeared from unresolved findings                                                                     |
| reuse the opening review after correction                   | `finding.alpha` incorrectly disappeared from unresolved findings                                                                     |

Every fault ran alone and was restored. Adjacent `Proof:` comments name the exact observed
mismatch. Verification on the restored source:

- `bun test --preload ../test/scratch/preload.ts src/review/audit.test.ts` from `tools/tool-wiki`
  — exit 0; 13 pass, 0 fail, 83 assertions.
- `bunx eslint src/cli.ts src/review/audit.ts src/review/audit.test.ts src/review/index.ts` from
  `tools/tool-wiki` — exit 0.
- `bunx tsc --build --force tsconfig.json` from `tools/tool-wiki` — exit 0.
- The existing production CLI contract matrix passed twice under its unchanged 25-second timeout:
  56 assertions at 24.7745 seconds and 24.6882 seconds. The initial aggregate had timed out at
  25.007 seconds because `cli.ts` imported the review barrel and eagerly constructed the new audit
  schemas in every subprocess. A narrow direct 3.1 invoker import restored startup while preserving
  the public review barrel export.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0 in 6m26s; 226 pass, 0 fail, 2,323 assertions; cache skipped and no
  target skipped.
- Changed-file Prettier and implementation `git diff --check` — exit 0.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` — exit 0.

Only task 3.3 is newly marked complete. Task 3.4 and every later task remain untouched; this slice
does not promote local cooperative review evidence to external trust.

## Slice 3.2 Review Fix Round 2

The existing fail-closed behavior-policy branch now has a public `evaluateObligations` regression
for each content-change variant. Added, changed and removed content without a matching behavior rule
each returns the exact named `behavior-policy:content.child` refusal and `accepted: false`.

A narrow audit of the other refusal branches introduced by 3.2 found two analogous paths without
direct production proof: a skipped required check and a failed review. Public cases now pin the
skipped-check refusal and both stale and expanded failed-review refusals. Missing and failed check
evidence, missing stale/expanded review evidence, and missing, foreign or unknown impact
classifications already had direct production cases and adjacent proofs, so they were not
redesigned.

| Deliberate one-at-a-time fault                            | Observed focused production-path failure                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| replace the missing behavior-rule refusal with `continue` | added, changed and removed cases each received `refusals: []` instead of `behavior-policy:content.child`                                           |
| treat a skipped required check as accepted                | the skipped-check case received `refusals: []` instead of `check:check.consumer`                                                                   |
| treat a failed review as accepted                         | the stale-review case received `refusals: []`; the expanded case lost its expanded-review refusal and retained only its independent impact refusal |

Each fault ran alone through `evaluateObligations`, was restored before the next, and has an
adjacent `Proof:` comment written from the observed failure. Verification on the restored source:

- `bun test tools/tool-wiki/src/evidence/currency.test.ts` — exit 0; 31 pass, 0 fail, 60
  assertions.
- `bunx eslint tools/tool-wiki/src/evidence/currency.test.ts
tools/tool-wiki/src/policy/obligations.ts` — exit 0.
- `bunx tsc --build --force tools/tool-wiki/tsconfig.json` — exit 0.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 213 pass, 0 fail, 2,240 assertions in 385.10 seconds (6m25s
  Nx duration), cache skipped and no target skipped. Nx used its documented main-process fallback
  after sandbox socket denial.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` — exit 0.
- `git diff --check` — exit 0.

Task 3.2 remains complete. Task 3.3 and all later task checkboxes remain untouched.

## Slice 3.4 Review Fix Round 4

Compatible activation now compares every retained authority audit obligation as the complete
strictly decoded record, including its risk stratum and exact review subject ID, kind, path, and
content identity. Retaining an obligation ID can no longer conceal narrower review coverage.

Policy, validator, and authority identity changes now share one trust-requirement change predicate.
Any of them deterministically reselects all current policy obligations and the complete current
authority check and review requirements.

| Deliberate one-at-a-time fault                             | Observed production-path failure                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remove the retained audit-obligation record comparison     | `review.application` narrowed from project `src` to file `src/app.ts`; the successor authority certified production CI, and activation returned compatible (`Expected: 1, Received: 0`) |
| select authority checks only for an authority-byte change  | policy-only and validator-only reports each omitted `check.authority.extra` from the exact array                                                                                        |
| select authority reviews only for an authority-byte change | policy-only and validator-only reports each omitted `review.authority.extra` from the exact array                                                                                       |

Every fault ran alone through the production activation command and was restored before final
verification. The downstream lint assertion in the audit-obligation negative establishes that the
successor remained self-consistent and certifiable without the activation guard.

- `bun test --preload ../test/scratch/preload.ts src/policy/trusted-policy.test.ts` from
  `tools/tool-wiki` — exit 0; 43 pass, 0 fail, 1,064 assertions in 73.44 seconds.
- `NX_DAEMON=false bunx nx run tool-wiki:typecheck --skip-nx-cache --output-style=static` — exit 0;
  cache skipped and no target skipped.
- `NX_DAEMON=false bunx nx run tool-wiki:lint --skip-nx-cache --output-style=static` — exit 0;
  cache skipped and no target skipped.
- `bun test --preload ../test/scratch/preload.ts` from `tools/tool-wiki` — exit 0; 275 pass, 0
  fail, 3,423 assertions across 14 files in 458.77 seconds. An initial run had one fixed-25-second
  contract matrix time out at 25.005 seconds; the exact case passed alone at 24.754 seconds, and the
  complete configured command passed on its immediate rerun.
- `OPENSPEC_TELEMETRY=0 /tmp/bunx-1000-@fission-ai/openspec@1.3.0/node_modules/.bin/openspec
validate agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` and `git diff --check` — exit 0.
- `bin/h2puni-gate.sh <round-4 commit>` — unavailable, exit 70 immediately because required
  heavy-lock path `/home/puni1/.cache` does not exist; no host-gate step ran.

Task 3.4 remains complete. Task 3.5 and every later task remain untouched.

## Slice 2.5 Root Knowledge Migration

The versioned root map pins each source section to revision
`7ab67cb0b6d843eca87f587124c0f3c0fbd35e67`, its exact Git blob, a stable source ID, a
heading-or-paragraph locator and a SHA-256 payload identity. Its three source sections contain 58
mapped blocks. The production checker resolves those historical bytes independently of the
candidate, requires every historical block exactly once at a live exact destination, rejects
orphan and duplicate mappings, validates path case and anchors, refuses symlink ambiguity, and
enforces the specified 120-line AGENTS and 150-line LLM_README caps.

Current findings now live under `docs/findings/`. The entire R5 catalogue moved to
`checks-that-cannot-fail.md`; stable R5-01 through R5-27 references route to anchored, byte-identical
historical paragraphs. AGENTS retains the operative R5 rules and gate obligations and links the
catalogue. LLM_README remains an orientation/gate/router index and links the findings owner without
duplicating mutable findings. No applied SQL, frozen archive, or OpenSpec history was moved.

The first focused TDD run had 0 passes and 6 failures because the production
`check-root-migration` CLI did not exist. After implementation and expanded fail-closed coverage,
the focused suite passed 14 tests with 473 assertions. The first uncached whole Tool Wiki run passed
306 of 308 tests: adding the non-pilot findings index exposed two pilot-test assumptions that every
repository index belonged to the six-module pilot. The policy already declares
`selected-boundaries-only`; scoping exact pilot mapping validation to matching pilot boundaries and
updating the deterministic whole-tree oracle made the focused three-case integration run pass with
52 assertions and the final full rerun pass all 308 tests.

| Deliberate one-at-a-time fault                                                    | Observed production-path refusal                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| delete mapped catalogue                                                           | `mapped destination absent: docs/findings/checks-that-cannot-fail.md`                            |
| inject exactly 121 AGENTS lines                                                   | `AGENTS.md exceeds 120 lines: 121`                                                               |
| inject exactly 151 LLM_README lines                                               | `LLM_README.md exceeds 150 lines: 151`                                                           |
| select version 2 or malformed JSON                                                | `root migration schema invalid` / `root migration JSON malformed`                                |
| use `../escape.md` or a selected symlink destination                              | `root migration path escapes candidate` / `mapped destination is not a regular selected blob`    |
| substitute the pinned revision, blob, non-UTF-8 bytes, heading, ordinal or digest | the corresponding historical-source identity, decode, locator or digest refusal named the source |
| duplicate a source entry, source ID, locator or destination                       | the corresponding `duplicate root ...` refusal named the repeated identity                       |
| remove or duplicate an anchor, mapping or exact preserved payload                 | the anchor count, incomplete map or payload count refusal named the destination                  |
| alter Markdown path case, remove a path, or remove/duplicate its anchor           | the exact Markdown path/anchor refusal named the referring document                              |
| restore migrated catalogue/findings headings at either root                       | the root-specific retained-content refusal named AGENTS or LLM_README                            |

Every fault above ran through the production CLI, was observed separately, and was restored. Exact
adjacent `Proof:` comments record the observed failure at each new safety guard.

- `bun test --preload ../test/scratch/preload.ts src/indexes/root-migration.test.ts` from
  `tools/tool-wiki` — exit 0; 14 pass, 0 fail, 473 assertions.
- `bun tools/tool-wiki/src/cli.ts check-root-migration committed . HEAD
docs/findings/root-migration.v1.json` — exit 0; 3 sources, 58 blocks, AGENTS cap 120 and
  LLM_README cap 150. Current files contain 88 and 112 lines respectively.
- `bun tools/tool-wiki/src/cli.ts check-indexes committed . HEAD` — exit 0; the new
  `module.docs.findings` index has three members, exact consumers and no review debt.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; both targets succeeded, cache skipped and no target skipped.
- `NX_DAEMON=false bunx nx reset && NX_DAEMON=false bunx nx run tool-wiki:test
--skip-nx-cache` — exit 0; 308 pass, 0 fail, 4,323 assertions across 16 files in 594.15 seconds
  (9m54s Nx duration), cache skipped and no target skipped.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict --json` — exit 0; one change passed, zero failed.
- `bin/h2puni-gate.sh HEAD` — unavailable, exit 70 immediately because required heavy-lock path
  `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Task 2.5 is complete. No other task checkbox changed.

## Slice 2.5 Astra Fix Round 1

The production executable now fixes the migration ID, exact three-source declaration digest,
source count and 58-block count independently of candidate-selected map contents. A candidate may
describe the expected declaration, but cannot choose, omit or replace its historical authority.
Destination verification parses complete structural blocks: each exact anchor immediately owns
its source marker and full preserved payload, and the reverse marker scan rejects any undeclared
block. Fragment-only links resolve against their referring document and use the same exact anchor
validation as cross-document links.

All six review faults were first run separately through `check-root-migration` and incorrectly
exited 0 before the fix. After implementation, the same production-path negatives refused as
follows:

| Deliberate one-at-a-time fault                                    | Observed production-path refusal                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| replace the declared sources with an empty array                  | `root migration authority mismatch`                                                            |
| replace authority with current `AGENTS.md#Migrations`             | `root migration authority mismatch`                                                            |
| append text to the payload owned by `r5-catalogue-001`            | `mapped destination block mismatch: docs/findings/checks-that-cannot-fail.md#r5-catalogue-001` |
| insert a structurally valid undeclared source-marker block        | `unexpected root source marker: docs/findings/checks-that-cannot-fail.md#r5.catalogue.orphan`  |
| move `r5-catalogue-001` away from its source marker and payload   | `unexpected root source marker: docs/findings/checks-that-cannot-fail.md#r5.catalogue.001`     |
| add a same-document link to `#absent-incident` in `LLM_README.md` | `Markdown anchor must occur once in LLM_README.md: LLM_README.md#absent-incident`              |

The immutable 58-block map, all adjacent anchor/marker/payload triples and existing same-document
catalogue links are the positive controls. Adjacent `Proof:` comments name the injected fault and
the observed production diagnostic.

- Focused root migration: exit 0; 20 pass, 0 fail, 305 assertions.
- Focused pilot integration: exit 0; 3 pass, 0 fail, 52 assertions.
- Uncached Tool Wiki lint/typecheck: exit 0; both targets succeeded and cache was skipped.
- Exact uncached configured Tool Wiki suite: exit 0; 314 pass, 0 fail, 4,155 assertions across 16
  files in 624.25 seconds (10m24s Nx duration); cache skipped and no target skipped.
- Actual committed root-migration CLI at `3c628165`: exit 0; fixed authority reconciled 3 sources
  and 58 blocks with AGENTS cap 120 and LLM_README cap 150.
- Actual committed index CLI at `3c628165`: exit 0; findings index and all selected indexes passed
  with no review debt.
- Strict pinned OpenSpec 1.3.0 JSON validation: exit 0; one change passed and zero failed.
- Repository-wide Nx format check and `git diff --check`: exit 0.
- `bin/h2puni-gate.sh HEAD`: unavailable, exit 70 immediately because required heavy-lock path
  `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Task 2.5 remains complete. No other task checkbox changed.

## Slice 2.4 Astra Fix Round 2

Five production `lint-local observe` negatives now cover the external pilot module-mapping loader
without changing its behavior: candidate-internal resolution, missing artifact, actually unreadable
artifact, digest mismatch and source-revision mismatch. The unreadable fixture is mode `000`, its
oracle requires `EACCES` and rejects `ENOENT`, and `finally` restores mode `600`.

| Deliberate one-at-a-time fault                                                                                                           | Observed production-path failure                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| remove external-location guard                                                                                                           | candidate-owned mapping returned accepted true; `Expected: 1 / Received: 0`                              |
| make the missing dependency exist                                                                                                        | observe returned accepted true; `Expected: 1 / Received: 0`; restored fault names `ENOENT`               |
| make the unreadable dependency readable                                                                                                  | observe returned accepted true; `Expected: 1 / Received: 0`; restored fault names `EACCES`, not `ENOENT` |
| remove digest comparison                                                                                                                 | wrong digest returned accepted true; `Expected: 1 / Received: 0`                                         |
| remove source-revision comparison after both mapping copies and candidate-bound evidence were regenerated from one wrong-revision commit | observe returned accepted true; `Expected: 1 / Received: 0`                                              |

- New negative selection: 5 pass, 0 fail, 53 assertions in 9.60 seconds.
- Full pilot file after the source-proof correction: 15 pass, 0 fail, 219 assertions in 177.45
  seconds.
- Existing trusted-policy file: 47 pass, 0 fail, 1,272 assertions in 89.00 seconds.
- Uncached lint and forced typecheck: exit 0; cache skipped and no target skipped.
- Exact uncached configured suite: 294 pass, 0 fail, 3,847 assertions across 15 files in 643.27
  seconds (10m43s Nx duration); cache skipped and no target skipped.
- Strict pinned OpenSpec 1.3.0: exit 0, change valid.
- Repository-wide Nx format check and `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 1c98e3a3`: unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist; no host-gate step ran.

The source-revision row is corrected by `56811ee7` and supersedes the prior diagnostic-only
mutation. Both mapping copies, the binding digest and every candidate-bound authority/evidence
field now derive from the same committed wrong-revision candidate.

- Round-3 exact uncached configured suite: 294 pass, 0 fail, 3,850 assertions across 15 files in
  651.15 seconds (10m51s Nx duration); cache skipped and no target skipped.
- Strict pinned OpenSpec 1.3.0: exit 0, change valid.
- Repository-wide Nx format check and `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 56811ee7`: unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist; no host-gate step ran.

Only Task 2.4 remains complete; no activation or later task changed.

## Slice 2.4 Astra Fix Round 1

Applicable checks now require extracted Nx target authority; declared prose facts cannot qualify by
reusing a check ID. Pilot lint also loads a strict externally bound module mapping, pins the exact
candidate proposal identity and reconciles every selected module's predecessor-bearing record,
index, owned candidate paths, exact policy boundary and external consumers. The binding remains an
external local-operator observe input, not candidate-selected CI authority. External-consumer
ownership now includes the README index itself.

| Deliberate one-at-a-time fault                                                            | Observed production-path failure                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| replace all executable check facts with external-consumer facts retaining their IDs       | before the guard, production observe lint returned accepted true; restored lint refuses `check.tool-wiki.test (external-consumer)` at the docs index                                                                                                                            |
| name the saved-plan README as its own external consumer                                   | before index ownership included the README, production observe lint returned accepted true; restored lint refuses the exact owned path                                                                                                                                          |
| change only the candidate predecessor mapping while external trust retains reviewed bytes | before candidate identity reconciliation, production observe lint returned accepted true with regenerated authority/evidence; restored lint refuses the exact mapping identity mismatch                                                                                         |
| delete the mapped saved-plan README                                                       | before mapping reconciliation, production observe lint returned accepted true with regenerated authority/evidence; restored lint names the absent index                                                                                                                         |
| change the externally pinned module ID or ownership                                       | before mapping reconciliation, production observe lint returned accepted true; restored lint names module-ID disagreement, while removing direct ownership comparison moved the ownership negative to the later exact-boundary assertion and failed its own expected diagnostic |
| drop mapped consumers or omit the mapped module                                           | removing each corresponding reconciliation returned accepted true; restored lint names consumer disagreement and the unmapped selected index respectively                                                                                                                       |

- `bun test --preload ../test/scratch/preload.ts src/policy/pilot-policy.test.ts` from
  `tools/tool-wiki` — exit 0; 10 pass, 0 fail, 163 assertions in 274.36 seconds.
- `bun test --preload ../test/scratch/preload.ts src/policy/trusted-policy.test.ts` — exit 0; 47
  pass, 0 fail, 1,272 assertions in 88.35 seconds.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91301 bunx nx run-many -t lint typecheck -p
tool-wiki --skip-nx-cache --output-style=static` — exit 0; cache skipped and no target skipped.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91302 bunx nx test tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 289 pass, 0 fail, 3,794 assertions across 15 files in 757.95
  seconds (12m38s Nx duration), cache skipped and no target skipped.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`: exit 0, change valid.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91304 bunx nx format:check --all`: exit 0.
- `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 29a84723` — unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Only Task 2.4 remains complete. Task 2.5 and production trust activation remain untouched.

## Slice 2.4 Pilot Policy and Owned Indexes

The reviewed pilot proposal pins six representative domain, application, adapter, infrastructure,
documentation and archive boundaries at source revision
`7851161bf96312750d07b933ca5d42b75ce575c7`. Each policy baseline is the exact pre-index
path/mode/blob tuple array observed at that revision and is independently compared to `git ls-tree`
in the production-path test. The README additions therefore cannot define their own membership.

Stable module IDs, index paths, explicit first-version predecessor arrays, known external consumers
and selected applicable checks are recorded through versioned schemas. The candidate-owned policy
and module mapping remain observe-only reviewed proposal data: tests bind them from an external
temporary local-operator trust root, and no production CI authority or Task 5.3 activation was
added.

| Deliberate one-at-a-time fault                        | Observed production-path failure                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| remove an actual saved-plan membership                | observe lint exited 1 with `unindexed candidate path in libs/domain/src/saved-plan/README.md: libs/domain/src/saved-plan/canonical-plan-input.ts` |
| omit external-consumer target validation              | `consumer/absent.ts` certified; expected exit 1, received accepted true                                                                           |
| omit applicable-check resolution                      | `check.does-not-exist` certified; expected exit 1, received accepted true                                                                         |
| omit checks disposition completeness                  | no check and no explicit inapplicability certified; expected exit 1, received accepted true                                                       |
| omit duplicate applicable-check validation            | two `check.fixture` references certified; expected exit 1, received accepted true                                                                 |
| omit non-empty pilot baseline validation              | an empty saved-plan baseline was accepted and only reported changed; expected exit 1, received accepted true                                      |
| omit pilot tuple-selector containment                 | a core replay tuple inside the saved-plan boundary was accepted; expected exit 1, received accepted true                                          |
| inherit parent Nx task markers during graph discovery | configured testing failed with `tool-wiki:test -> tool-wiki:test` recursive task invocation                                                       |

Every fault was observed alone and restored. The applicable-check and external-consumer cases run
through production `lint-local`; the membership case changes a real pilot README and reaches its
own exact index assertion.

- `bun test --preload ../test/scratch/preload.ts src/policy/pilot-policy.test.ts
src/policy/trusted-policy.test.ts` from `tools/tool-wiki` — exit 0; 50 pass, 0 fail, 1,331
  assertions in 150.38 seconds.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91209 bunx nx run-many -t lint typecheck -p
tool-wiki --skip-nx-cache --output-style=static` — exit 0; cache skipped and no target skipped.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91213 bunx nx test tool-wiki --skip-nx-cache
--output-style=static` — exit 0; 282 pass, 0 fail, 3,690 assertions across 15 files in 536.97
  seconds (8m57s Nx duration), cache skipped and no target skipped. The first post-commit run found
  that a byte-identical reviewed overlay left no commit for the temporary candidate; an explicit
  empty immutable commit corrected the harness, and the three pilot cases then passed under the
  reproduced Nx task environment before this full rerun.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` initially named `verify.md`; formatting that evidence and rerunning
  the repository-wide check exited 0. `git diff --check` also exited 0.
- `bin/h2puni-gate.sh cebb1d77` — unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Task 2.4 is complete. Task 2.5 and every production trust activation or gate-wiring task remain
untouched.

## Slice 3.4 Review Fix Round 5

Compatible activation now compares every referenced, schema-decoded audit risk stratum by semantic
strength. `sampleRateBps` must stay level or rise; `disagreementTriggerBps` must stay level or fall.
The comparison map is exhaustive over the decoded `AuditStratum` settings, so an unchanged stratum
ID cannot conceal a weakening and a future enforcement setting cannot enter the schema without a
typechecked compatibility direction.

The threshold negative places four review obligations in `risk.fixture` and disputes one. The
predecessor's 2,500-basis-point trigger expands fresh review to all four and refuses the supplied
evidence. Changing only the successor trigger to 10,000 reduces fresh work to the disputed
obligation, and that successor passes its own audit and production `lint-ci` certification.
Compatible activation now rejects it. A separate production activation negative covers a reduced
sample rate; inverse-direction controls prove stronger settings remain compatible.

| Deliberate one-at-a-time fault                                | Observed production-path failure                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| accept a higher disagreement trigger for the retained stratum | one dispute among four required one fresh review instead of four, production `lint-ci` certified the successor, and activation returned compatible; `Expected: 1, Received: 0` |
| accept a lower sample rate for the retained stratum           | the successor changed `sampleRateBps` from 10,000 to 2,500 under the same `risk.fixture` ID and activation returned compatible; `Expected: 1, Received: 0`                     |

Each fault was first observed through the production activation command, then restored. The
threshold case also asserts the exact downstream audit fresh-review sets and certified lint report,
so the activation failure cannot be satisfied by an independently invalid successor.

- `bun test --preload ../test/scratch/preload.ts src/policy/trusted-policy.test.ts` from
  `tools/tool-wiki` — exit 0; 46 pass, 0 fail, 1,148 assertions in 79.84 seconds.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck -p tool-wiki --skip-nx-cache
--output-style=static` — exit 0; cache skipped and no target skipped.
- `bun test --preload ../test/scratch/preload.ts` from `tools/tool-wiki` — exit 0; 278 pass, 0
  fail, 3,507 assertions across 14 files in 464.07 seconds.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate
agent-scalable-llm-wiki --strict` — exit 0; change valid.
- `bunx nx format:check --all` and `git diff --check` — exit 0.
- `bin/h2puni-gate.sh HEAD` — unavailable, exit 70 immediately because required heavy-lock path
  `/home/puni1/.cache` does not exist; no host-gate step ran and the host gate is not green.

Task 3.4 remains complete. Task 3.5 and every later task remain untouched.
